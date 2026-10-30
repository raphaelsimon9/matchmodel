"""Small shared helpers: cache with stale fallback, team-name matching, probability maths."""
import asyncio
import difflib
import math
import re
import time
import unicodedata
from datetime import datetime
from statistics import NormalDist

import httpx

_cache: dict = {}
_inflight: dict = {}
ND = NormalDist()


def client(**kw):
    return httpx.AsyncClient(timeout=30, **kw)


async def _refresh(key, fn, stale):
    try:
        val = await fn()
    except Exception:
        if stale:
            return stale[1]
        raise
    _cache[key] = (time.time(), val)
    return val


def _settle(task):
    if not task.cancelled():
        task.exception()      # mark as retrieved so a failure nobody awaits is not logged as "never retrieved"


async def cached(key, ttl, fn):
    """Cache `fn()` for ttl seconds. If refreshing fails, serve the stale value rather than erroring.

    Identical calls that arrive while one is already running share it, so quickly changing the dates or loading
    many leagues never pays twice for the same upstream request (matters for the metered Odds API)."""
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    task = _inflight.get(key)
    if task is None:
        task = asyncio.ensure_future(_refresh(key, fn, hit))
        _inflight[key] = task
        task.add_done_callback(lambda t, k=key: (_inflight.pop(k, None), _settle(t)))
    return await asyncio.shield(task)


# ───────────── team-name matching ─────────────
STOP = {"fc", "afc", "cf", "ac", "as", "sc", "calcio", "ssc", "rc", "rcd", "ud", "the", "and", "1"}
ALIAS = {"man": "manchester", "utd": "united", "nottm": "nottingham", "wolves": "wolverhampton wanderers",
         "spurs": "tottenham hotspur", "psg": "paris saint germain"}


def canon(name: str) -> frozenset:
    s = unicodedata.normalize("NFKD", name.lower().replace("&", " and "))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    toks = []
    for t in s.split():
        toks.extend(ALIAS.get(t, t).split())
    return frozenset(t for t in toks if t not in STOP)


def same(a: str, b: str) -> bool:
    ta, tb = canon(a), canon(b)
    if not ta or not tb:
        return False
    if ta == tb or ta <= tb or tb <= ta:
        return True
    return difflib.SequenceMatcher(None, " ".join(sorted(ta)), " ".join(sorted(tb))).ratio() >= 0.82


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def match_fixture(fixtures, home: str, away: str, when: str | None = None):
    for f in fixtures:
        if not (same(f["home"], home) and same(f["away"], away)):
            continue
        if when:
            try:
                if abs((parse_iso(when) - parse_iso(f["kickoff"])).total_seconds()) > 36 * 3600:
                    continue
            except ValueError:
                pass
        return f["id"]
    return None


# ───────────── probability maths ─────────────
def poisson_pmf(k: int, lam: float) -> float:
    return math.exp(-lam) * lam ** k / math.factorial(k)


def poisson_over(line: float, lam: float) -> float:
    """P(X > line) for X ~ Poisson(lam), line like 2.5."""
    k = int(math.floor(line))
    return 1 - sum(poisson_pmf(i, lam) for i in range(k + 1))


def fit_poisson_total(line: float, p_over: float) -> float:
    """Total-goals mean that reproduces a market probability for Over `line`."""
    lo, hi = 0.2, 9.0
    for _ in range(50):
        mid = (lo + hi) / 2
        if poisson_over(line, mid) < p_over:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def devig(prices: list[float]) -> list[float] | None:
    if not prices or any(p is None or p <= 1.0 for p in prices):
        return None
    inv = [1 / p for p in prices]
    s = sum(inv)
    return [i / s for i in inv]
