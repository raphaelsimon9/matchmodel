from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from . import basketball, catalog, config, db, fdata, football, oddsapi, oddspapi
from .board import Board
from .util import parse_iso

app = FastAPI(title="Match Model API", version="2.1")
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


MAX_SPAN = timedelta(days=32)     # the calendar allows 31 days; the extra day absorbs daylight-saving shifts


def _window(days: int, start: str | None, end: str | None):
    """[lo, hi) kickoff window. The web app sends the exact instants of the selected local days (start inclusive,
    end exclusive); `days` (from now) is kept for older clients."""
    now = datetime.now(timezone.utc)
    if start is None and end is None:
        return now - timedelta(hours=1), now + timedelta(days=days)
    if start is None or end is None:
        raise HTTPException(422, "start and end must be given together")
    try:
        lo, hi = parse_iso(start), parse_iso(end)
    except ValueError:
        raise HTTPException(422, "start and end must be ISO 8601 timestamps")
    lo = lo if lo.tzinfo else lo.replace(tzinfo=timezone.utc)
    hi = hi if hi.tzinfo else hi.replace(tzinfo=timezone.utc)
    if hi <= lo:
        raise HTTPException(422, "end must be after start")
    if hi - lo > MAX_SPAN:
        raise HTTPException(422, "the date range is limited to 31 days")
    return max(lo, now - timedelta(hours=1)), hi     # matches that kicked off over an hour ago stay hidden, as before


@app.get("/api/matches")
async def matches(sport: str = Query("football", pattern="^(football|basketball)$"), league: str = "PL",
                  days: int = Query(7, ge=1, le=14), start: str | None = None, end: str | None = None):
    lo, hi = _window(days, start, end)
    lg = await catalog.find(sport, league)
    if not lg:
        raise HTTPException(404, f"Unknown {sport} league '{league}'")
    try:
        data = await (football.build(lg, lo, hi) if sport == "football" else basketball.build(lg, lo, hi))
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
