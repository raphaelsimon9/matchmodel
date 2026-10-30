/* Probability filter: every selection a match card can show, flattened so one rule can test them all. */
export const pctOf = (p) => Math.round(p * 100);   // the same rounding the cards display

export function outcomes(m, sport) {
  const out = [];
  const add = (e, label) => { if (e && e.prob != null) out.push({ e, label: label || e.label }); };
  if (sport === "football") {
    Object.values(m.result || {}).forEach((e) => add(e));
    (m.goals || []).forEach((r) => { add(r.over, `${r.over?.label} goals`); add(r.under, `${r.under?.label} goals`); });
    Object.values(m.btts || {}).forEach((e) => add(e));
    for (const [blk, noun] of [[m.corners, "corners"], [m.shots, "shots"], [m.sot, "shots on target"]]) {
      (blk?.lines || []).forEach((r) => { add(r.over, `${r.over?.label} ${noun}`); add(r.under, `${r.under?.label} ${noun}`); });
    }
  } else {
    Object.values(m.result || {}).forEach((e) => add(e));
    (m.totals || []).forEach((r) => { add(r.over, `${r.over?.label} pts`); add(r.under, `${r.under?.label} pts`); });
  }
  return out;
}

export const makeFilter = (lo, hi) => ({
  lo, hi,
  active: lo > 0 || hi < 100,
  test: (p) => { const v = pctOf(p); return v >= lo && v <= hi; },
});

/** Selections inside the range, strongest first. */
export const matching = (m, sport, f) =>
  outcomes(m, sport).filter((o) => f.test(o.e.prob)).sort((a, b) => b.e.prob - a.e.prob);
