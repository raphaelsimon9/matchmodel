"""Date-window loading: calendar days/ranges, the credit-saving checks that make "all leagues" affordable,
request de-duplication and football-data pacing."""
import asyncio
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app import basketball, config, fdata, football, oddsapi, oddspapi, util
from tests.test_model import synth

UTC = timezone.utc
NOW = datetime.now(UTC)
iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
DAY = lambda n, hour=15: iso((NOW + timedelta(days=n)).replace(hour=hour, minute=0, second=0, microsecond=0))


@pytest.fixture(autouse=True)
def fresh_cache():
    util._cache.clear()
    util._inflight.clear()
    yield
    util._cache.clear()


def day_window(n_from, n_to):
    """Whole UTC days [today+n_from, today+n_to+1) like the web app sends for a selected range."""
    base = NOW.replace(hour=0, minute=0, second=0, microsecond=0)
    return base + timedelta(days=n_from), base + timedelta(days=n_to + 1)


def q(lo, hi):
    return f"start={iso(lo)}&end={iso(hi)}"


# ───────────── API validation ─────────────
def test_window_parameter_validation(monkeypatch):
    from app.main import app
    monkeypatch.setattr(config, "ODDS_API_KEY", "")
    c = TestClient(app)
    base = "/api/matches?sport=basketball&league=basketball_nba"
    lo, hi = day_window(1, 1)
    assert c.get(f"{base}&start={iso(lo)}").status_code == 422                 # start without end
    assert c.get(f"{base}&end={iso(hi)}").status_code == 422                   # end without start
    assert c.get(f"{base}&start=nope&end=nope").status_code == 422             # not timestamps
    assert c.get(f"{base}&start={iso(hi)}&end={iso(lo)}").status_code == 422   # reversed
    assert c.get(f"{base}&start={iso(lo)}&end={iso(lo)}").status_code == 422   # empty
    assert c.get(f"{base}&start={iso(lo)}&end={iso(lo + timedelta(days=40))}").status_code == 422
    assert c.get(f"{base}&{q(*day_window(0, 30))}").status_code == 200         # the longest range the calendar allows
    assert c.get(f"{base}&start={lo.strftime('%Y-%m-%dT%H:%M:%S.000Z')}&end={hi.strftime('%Y-%m-%dT%H:%M:%S.000Z')}").status_code == 200  # JS toISOString()
    assert c.get(f"{base}&days=3").status_code == 200                          # older clients still work


# ───────────── football: model league ─────────────
def _model_setup(monkeypatch, calls):
    hist = [{**m, "id": i} for i, m in enumerate(synth())]
    fixtures = [{"id": 1, "kickoff": DAY(1), "home": "Strong FC", "away": "Weak FC"},
                {"id": 2, "kickoff": DAY(3), "home": "Weak FC", "away": "Strong FC"},
                {"id": 3, "kickoff": DAY(10), "home": "Strong FC", "away": "Weak FC"}]

    async def sched(comp): calls.append("sched"); return fixtures
    async def fin(comp): calls.append("fin"); return hist
    async def odds(*a, **k): calls.append("odds"); return []
    monkeypatch.setattr(fdata, "scheduled", sched)
    monkeypatch.setattr(fdata, "finished_matches", fin)
    monkeypatch.setattr(fdata.config, "FOOTBALL_DATA_KEY", "k")
    monkeypatch.setattr(config, "ODDS_API_KEY", "x")
    monkeypatch.setattr(oddsapi, "events_odds", odds)


def test_model_league_single_day_and_range(monkeypatch):
    from app.main import app
    calls = []
    _model_setup(monkeypatch, calls)
    c = TestClient(app)
    one = lambda a, b: [m["id"] for m in c.get(f"/api/matches?sport=football&league=PL&{q(*day_window(a, b))}").json()["matches"]]
    assert one(1, 1) == [1]                      # one selected day
    assert one(3, 3) == [2]
    assert one(1, 3) == [1, 2]                   # a range
    assert one(0, 30) == [1, 2, 3]
    assert one(5, 8) == []


def test_model_league_without_fixtures_spends_nothing(monkeypatch):
    from app.main import app
    calls = []
    _model_setup(monkeypatch, calls)
    d = TestClient(app).get(f"/api/matches?sport=football&league=PL&{q(*day_window(5, 6))}").json()
    assert d["matches"] == [] and calls == ["sched"]            # no history download, no Odds API call
    assert all(s["ok"] for s in d["status"] if s["provider"] != "OddsPapi")      # (OddsPapi has no key in tests)


# ───────────── football (odds-only) + basketball ─────────────
def _events(home="A", away="B"):
    return [{"id": f"e{n}", "home_team": f"{home}{n}", "away_team": f"{away}{n}", "commence_time": DAY(n), "bookmakers": [
        {"key": "pinnacle", "markets": [{"key": "h2h", "outcomes": [
            {"name": f"{home}{n}", "price": 1.6}, {"name": f"{away}{n}", "price": 2.4}]}]}]} for n in (1, 3, 10)]


def test_odds_only_league_uses_free_check_first(monkeypatch):
    from app.main import app
    paid = []

    async def odds(key, markets): paid.append(key); return _events()
    async def none_in_window(*a): return False
    monkeypatch.setattr(config, "ODDS_API_KEY", "x")
    monkeypatch.setattr(oddsapi, "events_odds", odds)
    c = TestClient(app)
    url = f"/api/matches?sport=football&league=soccer_usa_mls&{q(*day_window(1, 3))}"

    monkeypatch.setattr(oddsapi, "events_in_range", none_in_window)
    d = c.get(url).json()
    assert d["matches"] == [] and paid == []                    # no credits spent on a league with nothing on

    async def has_events(*a): return True
    monkeypatch.setattr(oddsapi, "events_in_range", has_events)
    ids = [m["id"] for m in c.get(url).json()["matches"]]
    assert paid == ["soccer_usa_mls"] and len(ids) == 2         # day+1 and day+3, not day+10
    assert [m["id"] for m in c.get(f"/api/matches?sport=football&league=soccer_usa_mls&{q(*day_window(3, 3))}").json()["matches"]] == ["e3"]

    async def unknown(*a): return None
    monkeypatch.setattr(oddsapi, "events_in_range", unknown)    # check unavailable: behave exactly as before
    paid.clear()
    assert len(c.get(url).json()["matches"]) == 2 and paid == ["soccer_usa_mls"]


def test_basketball_window(monkeypatch):
    from app.main import app
    paid = []

    async def odds(key, markets): paid.append(key); return _events("H", "V")

    async def has_events(*a): return True
    monkeypatch.setattr(config, "ODDS_API_KEY", "x")
    monkeypatch.setattr(oddsapi, "events_odds", odds)
    monkeypatch.setattr(oddsapi, "events_in_range", has_events)
    c = TestClient(app)
    got = c.get(f"/api/matches?sport=basketball&league=basketball_nba&{q(*day_window(1, 1))}").json()
    assert [m["home"] for m in got["matches"]] == ["H1"]
    got = c.get(f"/api/matches?sport=basketball&league=basketball_nba&{q(*day_window(0, 12))}").json()
    assert len(got["matches"]) == 3
    assert got["matches"][0]["result"]["home"]["prob"] > 0.5


def test_empty_window_never_calls_providers(monkeypatch):
    async def boom(*a, **k): raise AssertionError("provider called")
    monkeypatch.setattr(config, "ODDS_API_KEY", "x")
    monkeypatch.setattr(oddsapi, "events_odds", boom)
    monkeypatch.setattr(oddsapi, "events_in_range", boom)
    lg = {"key": "k", "name": "n", "country": "c", "model": False, "oa": "soccer_usa_mls", "op": None, "fd": None}
    # lo >= hi (e.g. a day in the past was chosen): both sports return an empty list without any provider call
    assert asyncio.run(basketball.build(lg, NOW, NOW))["matches"] == []
    assert asyncio.run(football.build(lg, NOW, NOW))["matches"] == []


# ───────────── oddsapi.events_in_range (free endpoint) ─────────────
def _mock_client(monkeypatch, handler):
    monkeypatch.setattr(oddsapi, "client", lambda **kw: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(config, "ODDS_API_KEY", "x")


def test_events_in_range(monkeypatch):
    seen = []

    def handler(req):
        seen.append(str(req.url))
        return httpx.Response(200, json=[{"id": "1", "commence_time": DAY(2)}], headers={"x-requests-remaining": "480"})
    _mock_client(monkeypatch, handler)
    lo, hi = day_window(2, 2)
    assert asyncio.run(oddsapi.events_in_range("soccer_usa_mls", lo, hi)) is True
    assert asyncio.run(oddsapi.events_in_range("soccer_usa_mls", *day_window(4, 4))) is False
    assert len(seen) == 1 and "/sports/soccer_usa_mls/events" in seen[0]     # second answer came from the cache
    assert oddsapi.quota["remaining"] == 480


def test_events_in_range_unknown_on_failure(monkeypatch):
    _mock_client(monkeypatch, lambda req: httpx.Response(500, text="boom"))
    assert asyncio.run(oddsapi.events_in_range("soccer_x", *day_window(1, 2))) is None


# ───────────── util.cached: shared in-flight calls + stale fallback ─────────────
def test_cached_shares_inflight_calls():
    runs = []

    async def slow():
        runs.append(1)
        await asyncio.sleep(0.05)
        return "v"

    async def go():
        return await asyncio.gather(*(util.cached("k", 60, slow) for _ in range(5)))
    assert asyncio.run(go()) == ["v"] * 5 and len(runs) == 1
    assert asyncio.run(util.cached("k", 60, slow)) == "v" and len(runs) == 1        # now served from cache


def test_cached_stale_fallback_and_errors():
    async def ok(): return 1
    async def bad(): raise RuntimeError("down")
    assert asyncio.run(util.cached("s", 0, ok)) == 1
    assert asyncio.run(util.cached("s", 0, bad)) == 1                              # refresh failed -> stale value
    with pytest.raises(RuntimeError):
        asyncio.run(util.cached("never", 0, bad))                                  # nothing stale -> error surfaces

    async def go():
        res = await asyncio.gather(*(util.cached("e", 0, bad) for _ in range(3)), return_exceptions=True)
        return res
    assert all(isinstance(r, RuntimeError) for r in asyncio.run(go()))
    assert util._inflight == {}


# ───────────── football-data pacing ─────────────
def test_fd_throttle_waits_instead_of_failing(monkeypatch):
    import time
    monkeypatch.setattr(fdata, "RATE_LIMIT", 3)
    monkeypatch.setattr(fdata, "RATE_WINDOW", 0.3)
    fdata._calls.clear()

    async def go():
        t0 = time.monotonic()
        for _ in range(3):
            await fdata._throttle()
        quick = time.monotonic() - t0
        await fdata._throttle()                 # 4th call has to wait for the window to slide
        return quick, time.monotonic() - t0
    quick, total = asyncio.run(go())
    assert quick < 0.1 and total >= 0.3
    fdata._calls.clear()


def test_oddspapi_skips_request_when_nothing_to_price(monkeypatch):
    monkeypatch.setattr(config, "ODDSPAPI_KEY", "k")

    async def boom(*a, **k): raise AssertionError("request made")
    monkeypatch.setattr(oddspapi, "participants", boom)
    info = asyncio.run(oddspapi.ingest({"op": 17}, "football", [], {}))
    assert info["ok"] is True and info["matched"] == 0
