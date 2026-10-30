/* Local-calendar helpers. A "day" is a local YYYY-MM-DD string, so the selected day is the day the person sees on
   their own clock; it is converted to exact UTC instants only when asking the API. */
const pad = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };

export const MAX_AHEAD = 30;   // furthest selectable day, counted from today (the API caps a window at 31 days)

/** from/to are inclusive local days -> [start, end) as UTC ISO strings. */
export const toWindow = ({ from, to }) => ({
  start: parseYmd(from).toISOString(),
  end: addDays(parseYmd(to), 1).toISOString(),
});

export const nextDays = (n) => ({ from: ymd(today()), to: ymd(addDays(today(), n - 1)) });

export function labelRange({ from, to }) {
  const f = (s) => parseYmd(s).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  const t = ymd(today());
  if (from === to) return from === t ? `Today · ${f(from)}` : f(from);
  const short = (s) => parseYmd(s).toLocaleDateString([], { day: "numeric", month: "short" });
  return `${short(from)} – ${short(to)}`;
}
