// Vertical HFU behaviour (spec §21).
import { registry } from '../data-engine/registry';
import { zoneMask } from '../data-engine/zones';
import { isNum } from '../util/num';

export interface Interval { top: number; base: number; thick: number; unit: number }
export interface TransitionStats {
  intervals: Interval[]; units: number[]; nTransitions: number; transitionDepths: number[];
  meanThick: number; medianThick: number; thickByUnit: Record<number, { n: number; mean: number; total: number; max: number }>;
  continuity: number; persistence: Record<number, number>; // P(next sample same unit)
  matrix: number[][]; matrixProb: number[][]; // interval-to-interval transitions (rows from, cols to)
  sampleMatrix: number[][]; span: number; perHundred: number;
}

export function transitionStats(wellId: string, curve: string, zone = '', minThick = 0): TransitionStats | null {
  const d = registry.depth(wellId); const h = registry.curve(wellId, curve); if (!d || !h) return null;
  const mask = zoneMask(wellId, zone) ?? new Uint8Array(d.length).fill(1);
  const step = d.length > 1 ? (d[d.length - 1] - d[0]) / (d.length - 1) : 0;
  const val = (i: number) => (mask[i] && isNum(h[i]) && h[i] > 0 ? Math.round(h[i]) : 0);
  let intervals: Interval[] = []; let cur: Interval | null = null;
  const units = new Set<number>();
  for (let i = 0; i < d.length; i++) {
    const v = val(i);
    if (cur && v === cur.unit && i > 0 && d[i] - d[i - 1] <= step * 1.6) { cur.base = d[i] + step / 2; continue; }
    if (cur && cur.unit > 0) intervals.push(cur);
    cur = v ? { top: d[i] - step / 2, base: d[i] + step / 2, thick: 0, unit: v } : null; if (v) units.add(v);
    if (!v) cur = null;
  }
  if (cur && cur.unit > 0) intervals.push(cur);
  intervals.forEach((q) => (q.thick = q.base - q.top));
  if (minThick > 0) { // merge thin beds into the thicker neighbour (display/statistics option, explicit)
    const merged: Interval[] = [];
    for (const q of intervals) { const last = merged[merged.length - 1]; if (last && (q.thick < minThick) && Math.abs(q.top - last.base) < step * 1.6) { last.base = q.base; last.thick = last.base - last.top; } else merged.push({ ...q }); }
    intervals = merged;
  }
  const U = [...units].sort((a, b) => a - b); const K = U.length ? Math.max(...U) : 0;
  const matrix = Array.from({ length: K }, () => new Array(K).fill(0)); const tDepths: number[] = []; let nT = 0;
  for (let i = 1; i < intervals.length; i++) { const a = intervals[i - 1], b = intervals[i]; if (Math.abs(b.top - a.base) > step * 1.6) continue; if (a.unit !== b.unit) { nT++; tDepths.push(b.top); matrix[a.unit - 1][b.unit - 1]++; } }
  const sampleMatrix = Array.from({ length: K }, () => new Array(K).fill(0)); let same = 0, pairs = 0;
  for (let i = 1; i < d.length; i++) { const a = val(i - 1), b = val(i); if (!a || !b) continue; sampleMatrix[a - 1][b - 1]++; pairs++; if (a === b) same++; }
  const persistence: Record<number, number> = {}; for (const u of U) { const row = sampleMatrix[u - 1]; const s = row.reduce((x, y) => x + y, 0); persistence[u] = s ? row[u - 1] / s : NaN; }
  const thickByUnit: TransitionStats['thickByUnit'] = {};
  for (const u of U) { const t = intervals.filter((q) => q.unit === u).map((q) => q.thick); thickByUnit[u] = { n: t.length, mean: t.reduce((x, y) => x + y, 0) / (t.length || 1), total: t.reduce((x, y) => x + y, 0), max: Math.max(0, ...t) }; }
  const th = intervals.map((q) => q.thick).sort((a, b) => a - b);
  const span = intervals.length ? intervals[intervals.length - 1].base - intervals[0].top : 0;
  return {
    intervals, units: U, nTransitions: nT, transitionDepths: tDepths, meanThick: th.reduce((x, y) => x + y, 0) / (th.length || 1), medianThick: th[Math.floor(th.length / 2)] ?? NaN, thickByUnit,
    continuity: pairs ? same / pairs : NaN, persistence, matrix, matrixProb: matrix.map((r) => { const s = r.reduce((x, y) => x + y, 0); return r.map((v) => (s ? v / s : NaN)); }), sampleMatrix, span, perHundred: span ? (100 * nT) / span : NaN,
  };
}
