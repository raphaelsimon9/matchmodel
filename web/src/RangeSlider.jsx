import { useRef } from "react";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Two-handle slider. Drag either handle, click the bar (the nearest handle jumps there) or use the keyboard. */
export default function RangeSlider({ value, onChange, min = 0, max = 100, step = 1, unit = "%", label = "Range" }) {
  const [lo, hi] = value;
  const track = useRef(null);
  const drag = useRef(null);                       // "lo" | "hi" | "pending" (both handles on the same value)
  const pos = (v) => ((v - min) / (max - min)) * 100;

  const valueAt = (clientX) => {
    const r = track.current.getBoundingClientRect();
    if (!r.width) return lo;
    const raw = min + clamp((clientX - r.left) / r.width, 0, 1) * (max - min);
    return clamp(Math.round(raw / step) * step, min, max);
  };
  const set = (which, v) => (which === "lo" ? onChange([clamp(v, min, hi), hi]) : onChange([lo, clamp(v, lo, max)]));

  const down = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const v = valueAt(e.clientX);
    const dl = Math.abs(v - lo), dh = Math.abs(v - hi);
    drag.current = dl < dh ? "lo" : dh < dl ? "hi" : v < lo ? "lo" : v > hi ? "hi" : "pending";
    if (e.currentTarget.setPointerCapture) { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
    if (drag.current !== "pending") set(drag.current, v);
    e.preventDefault();
  };
  const move = (e) => {
    if (!drag.current) return;
    const v = valueAt(e.clientX);
    if (drag.current === "pending") {
      if (v === lo) return;
      drag.current = v < lo ? "lo" : "hi";
    }
    set(drag.current, v);
  };
  const up = () => { drag.current = null; };

  const onKey = (which) => (e) => {
    const cur = which === "lo" ? lo : hi;
    const big = Math.max(step, Math.round((max - min) / 10));
    const next = { ArrowLeft: cur - step, ArrowDown: cur - step, ArrowRight: cur + step, ArrowUp: cur + step,
      PageDown: cur - big, PageUp: cur + big, Home: min, End: max }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    set(which, next);
  };

  return (
    <div className="rs" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} ref={track}>
      <div className="rs-rail" />
      <div className="rs-fill" style={{ left: `${pos(lo)}%`, width: `${pos(hi) - pos(lo)}%` }} />
      {[["lo", lo, "Minimum"], ["hi", hi, "Maximum"]].map(([which, v, word]) => (
        <span key={which} className="rs-thumb" role="slider" tabIndex={0} style={{ left: `${pos(v)}%` }}
          aria-label={`${word} ${label}`} aria-valuemin={which === "lo" ? min : lo} aria-valuemax={which === "lo" ? hi : max}
          aria-valuenow={v} aria-valuetext={`${v}${unit}`} onKeyDown={onKey(which)}>
          <b className="rs-tip">{v}{unit}</b>
        </span>
      ))}
    </div>
  );
}
