import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_AHEAD, addDays, labelRange, nextDays, parseYmd, today, ymd } from "./dates.js";

const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const monthOf = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const monthIdx = (d) => d.getFullYear() * 12 + d.getMonth();

function cells(view) {
  const first = monthOf(view);
  const start = addDays(first, -((first.getDay() + 6) % 7));      // weeks start on Monday
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

function Chevron({ dir }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d={dir < 0 ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} /></svg>;
}

/** Calendar picker. Click a day to load just that day; click a second day to load the whole range between them. */
export default function DateRange({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => monthOf(parseYmd(value.from)));
  const [anchor, setAnchor] = useState(null);          // first click of a range, waiting for the second
  const [hover, setHover] = useState(null);
  const box = useRef(null);

  const min = today(), max = addDays(min, MAX_AHEAD);
  const minS = ymd(min), maxS = ymd(max), todayS = minS;

  const close = () => { setOpen(false); setAnchor(null); setHover(null); };
  const toggle = () => { if (open) close(); else { setView(monthOf(parseYmd(value.from))); setOpen(true); } };

  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) close(); };
    const esc = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const pick = (d) => {
    const s = ymd(d);
    if (s < minS || s > maxS) return;
    if (!anchor) { setAnchor(s); onChange({ from: s, to: s }); return; }
    const [from, to] = s < anchor ? [s, anchor] : [anchor, s];
    onChange({ from, to });
    close();
  };
  const preset = (r) => { onChange(r); close(); };

  // range shown on the grid: the pending range while hovering, otherwise the applied one
  const shown = useMemo(() => {
    if (anchor && hover) return hover < anchor ? { from: hover, to: anchor } : { from: anchor, to: hover };
    return value;
  }, [anchor, hover, value]);

  const days = useMemo(() => cells(view), [view]);
  const canPrev = monthIdx(view) > monthIdx(min), canNext = monthIdx(view) < monthIdx(max);
  const presets = [["Today", nextDays(1)], ["Tomorrow", { from: ymd(addDays(min, 1)), to: ymd(addDays(min, 1)) }],
    ["Next 3 days", nextDays(3)], ["Next 7 days", nextDays(7)]];

  return (
    <div className="datepick" ref={box}>
      <button type="button" className="datebtn" onClick={toggle} aria-haspopup="dialog" aria-expanded={open}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4.5" width="18" height="16.5" rx="3" /><path d="M3 10h18M8 2.5v4M16 2.5v4" /></svg>
        <span>{labelRange(value)}</span>
      </button>
      {open && (
        <div className="cal" role="dialog" aria-label="Choose dates">
          <div className="cal-presets">
            {presets.map(([n, r]) => (
              <button type="button" key={n} className={`cal-chip ${value.from === r.from && value.to === r.to ? "on" : ""}`} onClick={() => preset(r)}>{n}</button>
            ))}
          </div>
          <div className="cal-head">
            <button type="button" className="cal-nav" disabled={!canPrev} onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))} aria-label="Previous month"><Chevron dir={-1} /></button>
            <b>{view.toLocaleDateString([], { month: "long", year: "numeric" })}</b>
            <button type="button" className="cal-nav" disabled={!canNext} onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))} aria-label="Next month"><Chevron dir={1} /></button>
          </div>
          <div className="cal-grid" role="group" onMouseLeave={() => setHover(null)}>
            {WEEK.map((w) => <span key={w} className="cal-dow">{w}</span>)}
            {days.map((d) => {
              const s = ymd(d);
              const off = s < minS || s > maxS;
              const inMonth = d.getMonth() === view.getMonth();
              const cls = ["cal-day", !inMonth && "other", off && "off", s === todayS && "today",
                s >= shown.from && s <= shown.to && "inr", s === shown.from && "first", s === shown.to && "last"].filter(Boolean).join(" ");
              return (
                <button type="button" key={s} data-d={s} className={cls} disabled={off} onClick={() => pick(d)} onMouseEnter={() => anchor && setHover(s)}
                  aria-label={d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                  aria-pressed={s >= value.from && s <= value.to}>{d.getDate()}</button>
              );
            })}
          </div>
          <p className="cal-hint">
            {anchor ? "Pick a second day for a range — or tap the same day again to keep just one."
              : "Tap a day to load it. Tap two days to load everything between them."}
          </p>
        </div>
      )}
    </div>
  );
}
