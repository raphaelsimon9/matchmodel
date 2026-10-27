from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from . import basketball, catalog, config, db, fdata, football, oddsapi, oddspapi
from .board import Board

app = FastAPI(title="EdgeLab API", version="2.0")
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])


@app.get("/api/health")
async def health():
    return {"ok": True, "db": db.backend()}


@app.get("/api/health/db")
async def health_db():
    return {"ok": db.ping(), "db": db.backend()}


@app.get("/api/status")
async def status():
    return {"keys": {"football-data.org": fdata.configured(), "The Odds API": oddsapi.configured(),
                     "OddsPapi": oddspapi.configured()},
            "odds_api_quota": dict(oddsapi.quota), "cache_hours": config.ODDS_CACHE_SECONDS / 3600}


@app.get("/api/leagues")
async def leagues():
    cat = await catalog.all_leagues()
    out = {}
    for sport, items in cat.items():
        by_country: dict = {}
        for l in items:
            by_country.setdefault(l["country"], []).append(
                {"key": l["key"], "name": l["name"], "model": l["model"], "pinnacle": bool(l["op"])})
        out[sport] = [{"country": c, "leagues": sorted(v, key=lambda x: (not x["model"], x["name"]))}
                      for c, v in sorted(by_country.items(), key=lambda kv: (kv[0] in ("Other",), kv[0]))]
    return out


@app.get("/api/matches")
async def matches(sport: str = Query("football", pattern="^(football|basketball)$"), league: str = "PL",
                  days: int = Query(7, ge=1, le=14)):
    lg = await catalog.find(sport, league)
    if not lg:
        raise HTTPException(404, f"Unknown {sport} league '{league}'")
    try:
        data = await (football.build(lg, days) if sport == "football" else basketball.build(lg, days))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    except Exception as e:
        raise HTTPException(502, f"Data provider error: {e}")
    if sport == "football" and lg["model"]:
        try:
            db.log_predictions(data)
        except Exception:
            pass   # logging must never break predictions
    return data


@app.get("/api/extra")
async def extra(league: str, event: str):
    """Corner lines straight from The Odds API for one match (costs credits, so only on request)."""
    lg = await catalog.find("football", league)
    if not lg or not oddsapi.configured():
        raise HTTPException(400, "Unknown league or The Odds API key missing")
    try:
        ev = await oddsapi.event_extra(lg["oa"], event, "alternate_totals_corners")
    except Exception as e:
        raise HTTPException(502, str(e)[:200])
    b = {}
    fx = [{"id": "x", "kickoff": ev["commence_time"], "home": ev["home_team"], "away": ev["away_team"]}]
    oddsapi.ingest([ev], fx, b, True)
    return football._ladder(b.get("x", Board()), "corners", ev["commence_time"], datetime.now(timezone.utc))


@app.get("/api/performance")
async def performance(league: str | None = None):
    try:
        for comp in db.competitions_pending():
            try:
                db.settle(comp, await fdata.finished_matches(comp))
            except Exception:
                continue
    except Exception:
        pass
    return db.performance(league)
