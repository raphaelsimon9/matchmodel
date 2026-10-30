"""football-data.org (free tier): finished matches (model training) + upcoming fixtures."""
import asyncio
import time
from collections import deque
from datetime import date

from . import config
from .util import cached, client

FD = "https://api.football-data.org/v4"
RATE_LIMIT, RATE_WINDOW = 9, 60.0      # free tier allows 10 requests/minute; stay one under
_calls: deque = deque()


def configured() -> bool:
    return bool(config.FOOTBALL_DATA_KEY)


async def _throttle():
    """Hold a request back (instead of failing) when the per-minute allowance is used up, e.g. when many leagues load at once."""
    while True:
        now = time.monotonic()
        while _calls and now - _calls[0] >= RATE_WINDOW:
            _calls.popleft()
        if len(_calls) < RATE_LIMIT:
            _calls.append(now)
            return
        await asyncio.sleep(max(0.05, RATE_WINDOW - (now - _calls[0]) + 0.05))


async def _fd(path, params=None):
    await _throttle()
    async with client() as c:
        r = await c.get(f"{FD}{path}", params=params, headers={"X-Auth-Token": config.FOOTBALL_DATA_KEY})
        if r.status_code == 429:
            raise RuntimeError("football-data.org: rate limit (10 requests/minute on the free tier), retry shortly")
        r.raise_for_status()
        return r.json()


def _season_start() -> int:
    today = date.today()
    return today.year if today.month >= 7 else today.year - 1


async def finished_matches(comp: str) -> list:
    """Current + previous season so early-season predictions are not starved of data."""
    async def go():
        out = []
        cur = _season_start()
        for season in (cur - 1, cur):
            try:
                data = await _fd(f"/competitions/{comp}/matches", {"status": "FINISHED", "season": season})
            except Exception:
                if season == cur:
                    raise
                continue
            for m in data["matches"]:
                ft = m["score"]["fullTime"]
                if ft["home"] is None:
                    continue
                out.append({"id": m["id"], "date": m["utcDate"][:10], "home": m["homeTeam"]["name"],
                            "away": m["awayTeam"]["name"], "hg": ft["home"], "ag": ft["away"]})
        return out
    return await cached(f"fd:fin:{comp}", 3600, go)


async def scheduled(comp: str) -> list:
    """Every not-yet-played fixture of the current season. The caller filters by date, so changing the selected
    dates never needs another request (and there is no date-range limit to trip over)."""
    async def go():
        data = await _fd(f"/competitions/{comp}/matches", {"status": "SCHEDULED,TIMED"})
        return [{"id": m["id"], "kickoff": m["utcDate"], "home": m["homeTeam"]["name"],
                 "away": m["awayTeam"]["name"]} for m in data["matches"]
                if m["homeTeam"].get("name") and m["awayTeam"].get("name")]
    return await cached(f"fd:sched:{comp}", 900, go)
