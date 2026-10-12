// FZI-based HFU identification methods A–E (1-D on log10 FZI).
import { jenks, kmeans, gmm, probabilityBreaks, probit } from '../clustering/core';
import type { HfuUnit } from '../types';
import { hfuColor, isNum, mean, median } from '../util/num';

export type FziMethod = 'A' | 'B' | 'C' | 'D' | 'E';
export const METHOD_LABEL: Record<FziMethod | 'F', string> = {
  A: 'A · FZI grouping (natural breaks in log FZI)',
  B: 'B · Log(FZI) clustering (1-D K-Means / GMM)',
  C: 'C · K–φ flow-zone analysis (probability-plot segmentation)',
  D: 'D · RQI–Φz crossplot (unit-slope bands)',
  E: 'E · User-defined FZI thresholds',
  F: 'F · Machine-learning clustering (multi-feature)',
};

/** Returns ascending FZI thresholds (µm). */
export function fziBoundaries(logFzi: number[], method: FziMethod, k: number, opts: { algo1d?: 'kmeans' | 'gmm'; manual?: number[] } = {}): { boundaries: number[]; notes: string[] } {
  const v = logFzi.filter(isNum);
  const notes: string[] = [];
  if (method === 'E') return { boundaries: [...(opts.manual ?? [])].filter((x) => x > 0).sort((a, b) => a - b), notes: ['Thresholds entered by the analyst.'] };
  if (v.length < k * 3) throw new Error(`Only ${v.length} valid FZI samples — too few for ${k} units.`);
  let lb: number[] = [];
  if (method === 'A') { lb = jenks(v, k); notes.push('Jenks natural breaks on log10(FZI) minimise within-group variance.'); }
  else if (method === 'B' || method === 'D') {
    const X = Float64Array.from(v); const r = opts.algo1d === 'gmm' ? gmm(X, v.length, 1, k) : kmeans(X, v.length, 1, k, 10);
    const groups = Array.from({ length: k }, (_, c) => v.filter((_, i) => r.labels[i] === c)).filter((g) => g.length).sort((a, b) => mean(a) - mean(b));
    for (let c = 1; c < groups.length; c++) lb.push((Math.max(...groups[c - 1]) + Math.min(...groups[c])) / 2);
    notes.push(`1-D ${opts.algo1d === 'gmm' ? 'Gaussian mixture' : 'K-Means'} on log10(FZI); boundaries at gaps between adjacent groups.`);
    if (method === 'D') notes.push('On a log RQI – log Φz plot every unit-slope line has intercept log FZI, so D assigns samples to intercept bands; per-unit fitted slopes (ideal = 1) are reported as a consistency check.');
  } else if (method === 'C') {
    const r = probabilityBreaks(v, k); lb = r.breaks;
    notes.push('Straight-line segments fitted to the normal-probability plot of log10(FZI) (dynamic programming, min SSE); slope breaks mark flow-zone boundaries. Iso-FZI lines are shown on the k–φ plot.');
  }
  return { boundaries: lb.map((x) => Math.pow(10, x)), notes };
}

export function unitStats(labels: ArrayLike<number>, cols: Record<string, ArrayLike<number>>, k: number) {
  return Array.from({ length: k }, (_, u) => {
    const idx: number[] = []; for (let i = 0; i < labels.length; i++) if (labels[i] === u + 1) idx.push(i);
    const s: Record<string, number> = { n: idx.length };
    for (const [nm, a] of Object.entries(cols)) {
      const v = idx.map((i) => a[i]).filter(isNum);
      s[`mean_${nm}`] = mean(v); s[`median_${nm}`] = median(v);
      if (v.length) { const sv = [...v].sort((a2, b) => a2 - b); s[`min_${nm}`] = sv[0]; s[`max_${nm}`] = sv[sv.length - 1]; s[`p10_${nm}`] = sv[Math.floor(0.1 * (sv.length - 1))]; s[`p50_${nm}`] = sv[Math.floor(0.5 * (sv.length - 1))]; s[`p90_${nm}`] = sv[Math.floor(0.9 * (sv.length - 1))]; }
    }
    return s;
  });
}

export function makeUnits(k: number, boundaries: number[] | undefined, prefix: string): HfuUnit[] {
  return Array.from({ length: k }, (_, i) => ({
    id: i + 1, label: `${prefix} ${i + 1}`, status: 'Statistical Cluster' as const, color: hfuColor(i + 1),
    fziMin: boundaries ? (i === 0 ? 0 : boundaries[i - 1]) : undefined, fziMax: boundaries ? (i === k - 1 ? Infinity : boundaries[i]) : undefined,
  }));
}

/** Least-squares slope/intercept/R² of log RQI on log Φz for each unit. */
export function unitSlopeFits(labels: ArrayLike<number>, logPhiz: ArrayLike<number>, logRqi: ArrayLike<number>, k: number) {
  return Array.from({ length: k }, (_, u) => {
    const x: number[] = [], y: number[] = [];
    for (let i = 0; i < labels.length; i++) if (labels[i] === u + 1 && isNum(logPhiz[i]) && isNum(logRqi[i])) { x.push(logPhiz[i]); y.push(logRqi[i]); }
    const n = x.length; if (n < 3) return { n, slope: NaN, intercept: NaN, r2: NaN };
    const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    const slope = sxy / sxx; return { n, slope, intercept: my - slope * mx, r2: (sxy * sxy) / (sxx * syy) };
  });
}

export function probabilityPlotData(logFzi: number[]) {
  const v = logFzi.filter(isNum).sort((a, b) => a - b); const n = v.length;
  return { q: v.map((_, i) => probit((i + 0.5) / n)), v };
}
