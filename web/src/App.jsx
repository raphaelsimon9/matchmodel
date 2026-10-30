import { createContext, memo, useContext, useEffect, useMemo, useState } from "react";
import Results from "./Results.jsx";
import DateRange from "./DateRange.jsx";
import RangeSlider from "./RangeSlider.jsx";
import { nextDays, toWindow } from "./dates.js";
import { makeFilter, matching, outcomes } from "./filter.js";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";
const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const when = (iso) => new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const ALL = "__all__";                       // League dropdown value that loads every league
const RangeCtx = createContext({ active: false, test: () => true });   // the probability-range filter, shared by all cards
const leagueTag = (name, country) => (country && country !== "Other" ? `${name} (${country})` : name);

async function api(path, signal) {
  const r = await fetch(`${API}${path}`, { signal });
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch { /* not json */ } throw new Error(m); }
  return r.json();
}

/* ───────── small pieces ───────── */
function Conf({ c }) {
  if (!c) return null;
  return <span className={`conf conf-${c.label.toLowerCase()}`} title={`Confidence score ${c.score}/100`}>{c.label}</span>;
}

function Cell({ e, tone }) {
  const f = useContext(RangeCtx);
  if (!e) return <td className="cell na">–</td>;
  const p = Math.round(e.prob * 100);
  const rng = f.active ? (f.test(e.prob) ? "hit" : "dim") : "";
  return (
    <td className={`cell ${tone || ""} ${rng}`}>
      <div className="cellrow">
        <b>{p}%</b><Conf c={e.conf} />
      </div>
      <div className="bar"><i style={{ width: `${p}%` }} /></div>
      <div className="sub">
        {e.odds ? <>@ {e.odds.toFixed(2)} <span className="book">{e.book}</span>{e.edge != null && <span className={e.edge >= 0.03 ? "edge pos" : "edge"}> {e.edge >= 0 ? "+" : ""}{(e.edge * 100).toFixed(1)}%</span>}</> : <span className="muted">no price</span>}
        {e.derived && <span className="muted"> · derived</span>}
      </div>
    </td>
  );
}

function PickChips({ picks }) {
  if (!picks?.length) return <p className="muted small">No selection clears the confidence bar for this match.</p>;
  return (
    <div className="chips">
      {picks.map((p) => (
        <div className="chip" key={p.key || p.label}>
          <span className="chiplabel">{p.label}</span>
          <b>{pct(p.prob)}</b>
          <Conf c={p.conf} />
          {p.odds && <span className="sub">@ {p.odds.toFixed(2)}</span>}
        </div>
      ))}
    </div>
  );
}

function RangeChips({ list, f }) {
  return (
    <>
      <div className="muted small chiphead">{list.length} selection{list.length === 1 ? "" : "s"} between {f.lo}% and {f.hi}%</div>
      <div className="chips tight">
        {list.map((o, i) => (
          <div className="chip hit" key={`${i}-${o.label}`}>
            <span className="chiplabel">{o.label}</span>
            <b>{pct(o.e.prob)}</b>
            <Conf c={o.e.conf} />
            {o.e.odds && <span className="sub">@ {o.e.odds.toFixed(2)}</span>}
            {o.e.derived && <span className="muted small">derived</span>}
          </div>
        ))}
      </div>
    </>
  );
}

function ResultBars({ result, order }) {
  const f = useContext(RangeCtx);
  return (
    <div className="bars3">
      {order.map(([k, name]) => {
        const e = result[k];
        if (!e) return null;
        const rng = f.active ? (f.test(e.prob) ? "hit" : "dim") : "";
        return (
          <div className={`rb ${rng}`} key={k}>
            <div className="rbhead"><span>{name}</span><Conf c={e.conf} /></div>
            <div className="rbpct">{pct(e.prob)}</div>
            <div className="bar big"><i style={{ width: `${e.prob * 100}%` }} /></div>
            <div className="sub">{e.odds ? <>best @ {e.odds.toFixed(2)} <span className="book">{e.book}</span>{e.edge != null && <span className={e.edge >= 0.03 ? "edge pos" : "edge"}> {e.edge >= 0 ? "+" : ""}{(e.edge * 100).toFixed(1)}%</span>}</> : <span className="muted">no price</span>}</div>
          </div>
        );
      })}
    </div>
  );
}

function LadderTable({ rows, title }) {
  return (
    <div className="tablewrap">
      <table className="ladder">
        <thead><tr><th>{title}</th><th>Over</th><th>Under</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.line} className={r.main ? "mainline" : ""}>
              <th>{r.line}{r.main && <span className="tag">main</span>}</th>
              <Cell e={r.over} /><Cell e={r.under} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Notice({ status, children }) {
  return <p className="notice">{status}{children}</p>;
}

/* ───────── football card ───────── */
function MarketBlock({ block, label, hint, canFetch, onFetch, busy }) {
  if (block.lines.length) return <LadderTable rows={block.lines} title={`${label} line`} />;
  return (
    <div className="empty">
      <b>No {label.toLowerCase()} lines yet.</b>
      <p className="muted small">
        {block.status === "not_open"
          ? `Bookmakers usually post ${hint} about 3 days before kickoff. Check back closer to the match.`
          : `None of your connected sources is quoting ${hint} for this match.`}
      </p>
      {canFetch && <button className="btn ghost" disabled={busy} onClick={onFetch}>{busy ? "Fetching…" : "Try The Odds API (uses credits)"}</button>}
    </div>
  );
}

export const FootballCard = memo(function FootballCard({ m, league }) {
  const f = useContext(RangeCtx);
  const inRange = useMemo(() => (f.active ? matching(m, "football", f) : null), [m, f]);
  const [tab, setTab] = useState("result");
  const [corners, setCorners] = useState(m.corners);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fetchCorners = async () => {
    setBusy(true); setErr("");
    try { const c = await api(`/api/extra?league=${encodeURIComponent(m._lk || league)}&event=${encodeURIComponent(m.event_id)}`); setCorners(c); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const tabs = [["result", "Result"], ["goals", "Goals"], ["corners", "Corners"], ["shots", "Shots"], ["info", "Info"]];
  const hasShots = m.shots.lines.length || m.sot.lines.length;
  return (
    <article className="card">
      <header className="cardhead">
        <div>
          <div className="muted small">{when(m.kickoff)}{m._ln && <> · <span className="lgname">{leagueTag(m._ln, m._lc)}</span></>}</div>
          <h3>{m.home} <span className="vs">vs</span> {m.away}</h3>
        </div>
        <span className={`basis basis-${m.basis}`}>{m.basis === "blend" ? "Model + market" : m.basis === "model" ? "Model" : m.basis === "market" ? "Market-derived" : "No data"}</span>
      </header>
      {inRange ? <RangeChips list={inRange} f={f} /> : <PickChips picks={m.picks} />}
      <nav className="tabs sub-tabs">
        {tabs.map(([k, n]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{n}</button>)}
      </nav>
      {tab === "result" && (Object.keys(m.result).length
        ? <ResultBars result={m.result} order={[["home", "Home to win"], ["draw", "Draw"], ["away", "Away to win"]]} />
        : <p className="muted">No win/draw/win data for this match yet.</p>)}
      {tab === "goals" && (
        <>
          {m.goals.length ? <LadderTable rows={m.goals} title="Total goals" /> : <p className="muted">No goals data yet.</p>}
          {(m.btts.yes || m.btts.no) && (
            <div className="tablewrap"><table className="ladder"><thead><tr><th>Both teams score</th><th>Yes</th><th>No</th></tr></thead>
              <tbody><tr><th>BTTS</th><Cell e={m.btts.yes} /><Cell e={m.btts.no} /></tr></tbody></table></div>
          )}
        </>
      )}
      {tab === "corners" && (
        <>
          <MarketBlock block={corners} label="Corners" hint="corner lines" canFetch={!!m.event_id && !corners.lines.length} onFetch={fetchCorners} busy={busy} />
          {err && <p className="err small">{err}</p>}
          <p className="muted small">Probabilities are the bookmakers' own prices with the margin removed. No corner statistics are available from your three APIs, so this is not a separate model.</p>
        </>
      )}
      {tab === "shots" && (
        <>
          {m.shots.lines.length > 0 && <MarketBlock block={m.shots} label="Total shots" hint="shot lines" />}
          {m.sot.lines.length > 0 && <MarketBlock block={m.sot} label="Shots on target" hint="shot lines" />}
          {!hasShots && <MarketBlock block={m.shots} label="Shots" hint="team shot lines" />}
          <p className="muted small">Shot lines come from Pinnacle via OddsPapi when posted. The Odds API only offers player shot props, so it cannot fill this tab.</p>
        </>
      )}
      {tab === "info" && (
        <div className="info">
          {m.meta.xg_home != null && <p>Expected goals: <b>{m.meta.xg_home.toFixed(2)}</b> – <b>{m.meta.xg_away.toFixed(2)}</b>{m.meta.scores?.length ? <> · likely scores {m.meta.scores.map((s) => `${s.score} (${pct(s.p)})`).join(", ")}</> : null}</p>}
          {m.meta.form_home && <p>Form: {m.home} <b>{m.meta.form_home.last5.split("").join(" ")}</b> · {m.away} <b>{m.meta.form_away.last5.split("").join(" ")}</b></p>}
          <p>Sources: {m.meta.sources.length ? m.meta.sources.join(", ") : "none"} · bookmakers in consensus: {m.meta.books}</p>
          <p className="muted small">Confidence (0–100) combines how decisive the probability is, how much match history backs the model, whether the market agrees, and how many bookmakers (and Pinnacle) are pricing it. “Derived” lines are extrapolated from the market's main goals line. Edge = probability × best price − 1; treat positive edge as a prompt to double-check, not a guarantee.</p>
        </div>
      )}
    </article>
  );
});

/* ───────── basketball card ───────── */
export const BasketballCard = memo(function BasketballCard({ m }) {
  const f = useContext(RangeCtx);
  const inRange = useMemo(() => (f.active ? matching(m, "basketball", f) : null), [m, f]);
  return (
    <article className="card">
      <header className="cardhead">
        <div>
          <div className="muted small">{when(m.kickoff)}{m._ln && <> · <span className="lgname">{leagueTag(m._ln, m._lc)}</span></>}</div>
          <h3>{m.away} <span className="vs">@</span> {m.home}</h3>
        </div>
        <span className="basis basis-market">Market-derived</span>
      </header>
      {inRange ? <RangeChips list={inRange} f={f} /> : <PickChips picks={m.picks} />}
      {Object.keys(m.result).length
        ? <ResultBars result={m.result} order={[["home", "Home to win"], ["away", "Away to win"]]} />
        : <p className="muted">No moneyline yet.</p>}
      {m.totals.length > 0 && (
        <>
          <h4 className="sect">Points totals{m.meta.mu != null && <span className="muted small"> · projected total ≈ {m.meta.mu}{m.meta.lean ? ` · lean: ${m.meta.lean}` : ""}</span>}</h4>
          <LadderTable rows={m.totals} title="Total points" />
        </>
      )}
      <p className="muted small">Win % is the bookmaker consensus (margin removed, Pinnacle weighted). Lines marked “derived” are extrapolated from the main total with a normal distribution; only observed lines show a price.</p>
    </article>
  );
});

/* ───────── page ───────── */
function Sun() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>; }
function Moon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>; }

const K = (name) => `matchmodel-${name}`;
const read = (name, d) => store.get(K(name), store.get(`edgelab-${name}`, d));   // falls back to settings saved under the old name

export default function App() {
  const [theme, setTheme] = useState(() => read("theme", "light"));
  const [sport, setSport] = useState(() => read("sport", "football"));
  const [league, setLeague] = useState(() => read(`league-${read("sport", "football")}`, ""));
  const [range, setRange] = useState(() => nextDays(7));        // inclusive local days chosen on the calendar
  const [pr, setPr] = useState([0, 100]);                        // probability range filter (%)
  const [tab, setTab] = useState("predictions");
  const [cat, setCat] = useState(null);
  const [feed, setFeed] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => { document.documentElement.dataset.theme = theme; store.set(K("theme"), theme); }, [theme]);
  useEffect(() => { api("/api/leagues").then(setCat).catch((e) => setErr(e.message)); }, []);

  const groups = useMemo(() => cat?.[sport] || [], [cat, sport]);
  const flat = useMemo(() => groups.flatMap((g) => g.leagues.map((l) => ({ ...l, country: g.country }))), [groups]);
  useEffect(() => {
    if (flat.length && league !== ALL && !flat.some((l) => l.key === league)) setLeague(flat[0].key);
  }, [flat, league]);

  const win = useMemo(() => toWindow(range), [range]);

  useEffect(() => {
    if (tab !== "predictions" || !flat.length) return;
    if (league !== ALL && !flat.some((l) => l.key === league)) return;
    const ctrl = new AbortController();
    const live = () => !ctrl.signal.aborted;
    const url = (key) => `/api/matches?sport=${sport}&league=${encodeURIComponent(key)}&start=${encodeURIComponent(win.start)}&end=${encodeURIComponent(win.end)}`;
    setErr("");

    if (league !== ALL) {
      setFeed({ sport, single: true, matches: [], status: null, quota: null, errors: [], notes: [], done: 0, total: 1, running: true });
      api(url(league), ctrl.signal)
        .then((d) => live() && setFeed({ sport, single: true, name: d.name, matches: d.matches, status: d.status, quota: d.quota, errors: [], notes: [], done: 1, total: 1, running: false }))
        .catch((e) => { if (live()) { setErr(e.message); setFeed((f) => f && { ...f, running: false }); } });
      return () => ctrl.abort();
    }

    // All leagues: one request per league, a few at a time, results appear as they arrive.
    // football-data.org (goal-model) leagues are paced by the server, so they get their own small lane.
    const acc = { sport, single: false, matches: [], status: null, quota: null, errors: [], notes: new Set(), done: 0, total: flat.length };
    const publish = () => live() && setFeed({ ...acc, matches: [...acc.matches], errors: [...acc.errors], notes: [...acc.notes], running: acc.done < acc.total });
    publish();
    const one = async (l) => {
      try {
        const d = await api(url(l.key), ctrl.signal);
        if (!live()) return;
        acc.matches.push(...d.matches.map((m) => ({ ...m, _lk: l.key, _ln: l.name, _lc: l.country })));
        if (d.quota?.remaining != null) acc.quota = d.quota;
        const oa = (d.status || []).find((s) => s.provider === "The Odds API");
        if (oa && !oa.ok && oa.note && oa.note !== "not configured") acc.notes.add(oa.note);
      } catch (e) {
        if (!live()) return;
        acc.errors.push({ name: l.name, message: e.message });
      }
      acc.done += 1;
      publish();
    };
    const lane = async (items, size) => {
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
        while (live() && i < items.length) await one(items[i++]);
      }));
    };
    lane(flat.filter((l) => l.model), 2);
    lane(flat.filter((l) => !l.model), 4);
    return () => ctrl.abort();
  }, [sport, league, win, tab, flat]);

  const pickSport = (s) => { setSport(s); store.set(K("sport"), s); setLeague(read(`league-${s}`, "")); setFeed(null); };
  const pickLeague = (l) => { setLeague(l); if (l !== ALL) store.set(K(`league-${sport}`), l); };   // "all" is never restored on reload (it spends API credits)

  const f = useMemo(() => makeFilter(pr[0], pr[1]), [pr]);
  const cur = feed && feed.sport === sport ? feed : null;
  const list = useMemo(() => {
    if (!cur) return [];
    const byTime = cur.single ? cur.matches : [...cur.matches].sort((a, b) => (a.kickoff < b.kickoff ? -1 : a.kickoff > b.kickoff ? 1 : 0));
    return f.active ? byTime.filter((m) => outcomes(m, sport).some((o) => f.test(o.e.prob))) : byTime;
  }, [cur, f, sport]);

  const isAll = league === ALL;
  const found = cur ? cur.matches.length : 0;
  const lgName = cur?.name;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">Match Model</div>
        <div className="seg" role="tablist" aria-label="Sport">
          <button className={sport === "football" ? "on" : ""} onClick={() => pickSport("football")}>⚽ Football</button>
          <button className={sport === "basketball" ? "on" : ""} onClick={() => pickSport("basketball")}>🏀 Basketball</button>
        </div>
        <button className="iconbtn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle night mode" title={theme === "dark" ? "Switch to day mode" : "Switch to night mode"}>
          {theme === "dark" ? <Sun /> : <Moon />}
        </button>
      </header>

      <nav className="tabs main-tabs">
        <button className={tab === "predictions" ? "on" : ""} onClick={() => setTab("predictions")}>Predictions</button>
        {sport === "football" && <button className={tab === "results" ? "on" : ""} onClick={() => setTab("results")}>Results log</button>}
      </nav>

      {tab === "results" && sport === "football" ? <Results /> : (
        <>
          <section className="controls">
            <label>League
              <select value={league} onChange={(e) => pickLeague(e.target.value)}>
                {flat.length > 0 && <option value={ALL}>All leagues ({flat.length})</option>}
                {groups.map((g) => (
                  <optgroup key={g.country} label={g.country}>
                    {g.leagues.map((l) => <option key={l.key} value={l.key}>{l.name}{l.model ? " ★" : ""}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <div className="field">Dates
              <DateRange value={range} onChange={setRange} />
            </div>
            {sport === "football" && <span className="muted small legend">★ = full goal model (football-data.org). Others use bookmaker prices.</span>}
          </section>

          <section className="rangebox" aria-label="Probability filter">
            <div className="rangehead">
              <span className="rl">Probability range</span>
              <b className="rv">{pr[0]}% – {pr[1]}%</b>
              {f.active && <button className="btn sm" onClick={() => setPr([0, 100])}>Reset</button>}
            </div>
            <RangeSlider value={pr} onChange={setPr} label="probability" />
            <div className="rangescale" aria-hidden="true"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
            <p className="muted small">
              {f.active
                ? "Showing only matches that have a selection inside this range; selections outside it are dimmed."
                : "Drag the handles to keep only selections inside a probability range, e.g. 75% – 95%."}
            </p>
          </section>

          {cur && !cur.single && (
            <div className="status">
              <span className={`pill ${cur.running ? "" : "ok"}`}>{cur.running ? `Loading leagues… ${cur.done}/${cur.total}` : `${cur.total - cur.errors.length}/${cur.total} leagues loaded`}</span>
              {cur.quota?.remaining != null && <span className="pill">Odds API credits left: {cur.quota.remaining}</span>}
              {cur.notes.length > 0 && <span className="pill off" title={cur.notes.join("\n")}>Odds paused for some leagues · {cur.notes[0].slice(0, 40)}</span>}
              {cur.errors.length > 0 && (
                <span className="pill off" title={cur.errors.map((x) => `${x.name}: ${x.message}`).join("\n")}>{cur.errors.length} league{cur.errors.length > 1 ? "s" : ""} failed to load</span>
              )}
            </div>
          )}
          {cur?.single && cur.status && (
            <div className="status">
              {cur.status.map((s) => (
                <span key={s.provider} className={`pill ${s.ok ? "ok" : "off"}`} title={s.note}>{s.provider}{s.ok ? ` · ${s.matched}` : ""}{!s.ok && s.note ? ` · ${s.note.slice(0, 40)}` : ""}</span>
              ))}
              {cur.quota?.remaining != null && <span className="pill">Odds API credits left: {cur.quota.remaining}</span>}
            </div>
          )}
          {isAll && cur?.running && <p className="muted small">Each league with matches uses Odds API credits the first time it loads (then it is cached for hours), so loading everything can use a fair share of a free monthly allowance.</p>}
          {isAll && cur && cur.errors.length > 0 && !cur.running && (
            <details className="small muted"><summary>Which leagues failed?</summary>
              <ul>{cur.errors.map((x) => <li key={x.name}>{x.name}: {x.message}</li>)}</ul>
            </details>
          )}

          {err && <p className="err">{err}</p>}
          {cur?.running && found === 0 && <p className="muted">Loading {sport} matches…</p>}
          {cur && !cur.running && found === 0 && !err && (
            <p className="muted">No matches in the selected dates{isAll ? " across any league" : lgName ? ` for ${lgName}` : ""}. Try other dates{isAll ? "" : " or another league"}.</p>
          )}
          {cur && found > 0 && f.active && (
            <p className="muted small">{list.length} of {found} match{found === 1 ? "" : "es"} have a selection between {f.lo}% and {f.hi}%.</p>
          )}
          {cur && found > 0 && list.length === 0 && f.active && !cur.running && <p className="muted">No match has a selection in that range. Widen it or press Reset.</p>}
          <RangeCtx.Provider value={f}>
            <div className="grid">
              {list.map((m) => {
                const lk = m._lk || league;
                return sport === "football"
                  ? <FootballCard key={`${lk}-${m.id}`} m={m} league={lk} />
                  : <BasketballCard key={`${lk}-${m.id}`} m={m} />;
              })}
            </div>
          </RangeCtx.Provider>
        </>
      )}
      <footer className="foot muted small">Probabilities are estimates, not guarantees. Gamble responsibly and only with money you can afford to lose.</footer>
    </div>
  );
}
