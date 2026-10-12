// Depth transformations stored as reversible operations. Original depths are
// never overwritten: shifted depth = apply(ops, original).
import type { DepthOp } from '../types';
import { interpAt, isNum, pearson } from '../util/num';

function tieMap(pairs: [number, number][], d: number) {
  const p = [...pairs].sort((a, b) => a[0] - b[0]);
  if (!p.length) return d;
  if (d <= p[0][0]) return d + (p[0][1] - p[0][0]);
  if (d >= p[p.length - 1][0]) return d + (p[p.length - 1][1] - p[p.length - 1][0]);
  for (let i = 1; i < p.length; i++) if (d <= p[i][0]) {
    const [x0, y0] = p[i - 1], [x1, y1] = p[i];
    return y0 + ((y1 - y0) * (d - x0)) / (x1 - x0);
  }
  return d;
}

export function applyOp(op: DepthOp, d: number): number {
  switch (op.type) {
    case 'shift': return d + (op.amount ?? 0);
    case 'linear': return (op.a ?? 1) * d + (op.b ?? 0);
    case 'poly': return (op.coeffs ?? [0, 1]).reduce((s, c, i) => s + c * Math.pow(d, i), 0);
    case 'tie': return tieMap(op.pairs ?? [], d);
  }
}

/** Forward transform of ORIGINAL depth through the active op chain. Interval tests use original depth. */
export function applyOps(ops: DepthOp[], orig: number): number {
  let d = orig;
  for (const op of ops) {
    if (!op.active) continue;
    if (op.interval && (orig < op.interval[0] || orig > op.interval[1])) continue;
    d = applyOp(op, d);
  }
  return d;
}
export function applyOpsArray(ops: DepthOp[], orig: Float64Array): Float64Array {
  const out = new Float64Array(orig.length);
  for (let i = 0; i < orig.length; i++) out[i] = applyOps(ops, orig[i]);
  return out;
}
/** Numerical inverse (bisection) — demonstrates reversibility; ops are monotonic in practice. */
export function invertOps(ops: DepthOp[], target: number, guessRange = 200): number {
  let lo = target - guessRange, hi = target + guessRange;
  for (let k = 0; k < 80; k++) { const m = (lo + hi) / 2; if (applyOps(ops, m) < target) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

export function describeOp(op: DepthOp, unit = 'm'): string {
  const iv = op.interval ? ` [${op.interval[0]}–${op.interval[1]} ${unit}]` : ' [all]';
  switch (op.type) {
    case 'shift': return `Shift ${op.amount! >= 0 ? '+' : ''}${op.amount!.toFixed(3)} ${unit}${iv}`;
    case 'linear': return `Linear d' = ${op.a!.toFixed(6)}·d ${op.b! >= 0 ? '+' : '−'} ${Math.abs(op.b!).toFixed(3)}${iv}`;
    case 'poly': return `Polynomial d' = ${(op.coeffs ?? []).map((c, i) => `${c.toExponential(4)}·d^${i}`).join(' + ')}${iv}`;
    case 'tie': return `Tie points (${op.pairs?.length ?? 0}): ${(op.pairs ?? []).map(([a, b]) => `${a.toFixed(2)}→${b.toFixed(2)}`).join(', ')}${iv}`;
  }
}

/** Least-squares fit of a stretch/squeeze (linear) from tie points. */
export function fitLinear(pairs: [number, number][]) {
  const n = pairs.length; if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of pairs) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx); const b = (sy - a * sx) / n;
  return { a, b };
}
/** Polynomial fit (degree ≤ 3) on centred depth, returned as raw-depth coefficients. */
export function fitPoly(pairs: [number, number][], deg: number) {
  const n = pairs.length; if (n <= deg) return null;
  const mu = pairs.reduce((s, p) => s + p[0], 0) / n;
  // normal equations on centred x
  const m = deg + 1; const A = Array.from({ length: m }, () => new Array(m).fill(0)); const bb = new Array(m).fill(0);
  for (const [x0, y] of pairs) { const x = x0 - mu; for (let i = 0; i < m; i++) { bb[i] += y * x ** i; for (let j = 0; j < m; j++) A[i][j] += x ** (i + j); } }
  // gaussian elimination
  for (let i = 0; i < m; i++) { let p = i; for (let r = i + 1; r < m; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r; [A[i], A[p]] = [A[p], A[i]]; [bb[i], bb[p]] = [bb[p], bb[i]]; for (let r = i + 1; r < m; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < m; c++) A[r][c] -= f * A[i][c]; bb[r] -= f * bb[i]; } }
  const cC = new Array(m).fill(0); for (let i = m - 1; i >= 0; i--) { let s = bb[i]; for (let j = i + 1; j < m; j++) s -= A[i][j] * cC[j]; cC[i] = s / A[i][i]; }
  // expand Σ c_i (x-mu)^i into raw coefficients
  const raw = new Array(m).fill(0);
  const binom = (a: number, b: number) => { let r = 1; for (let i = 1; i <= b; i++) r = (r * (a - b + i)) / i; return r; };
  for (let i = 0; i < m; i++) for (let k = 0; k <= i; k++) raw[k] += cC[i] * binom(i, k) * Math.pow(-mu, i - k);
  return raw;
}

export interface CorrelationResult { bestShift: number; r: number; n: number; profile: { shift: number; r: number; n: number }[]; confidence: 'High' | 'Medium' | 'Low'; warnings: string[] }

/**
 * Automatic core-log correlation: find the bulk shift s that maximises Pearson r
 * between core values and log values interpolated at (coreDepth + s).
 */
export function autoCorrelate(logDepth: Float64Array, logVals: Float32Array, coreDepth: Float64Array, coreVals: Float64Array, maxShift: number, stepSize: number, minOverlap = 5): CorrelationResult {
  const profile: CorrelationResult['profile'] = [];
  const warnings: string[] = [];
  const x = new Float64Array(coreDepth.length), y = new Float64Array(coreDepth.length);
  let best = { shift: 0, r: -Infinity, n: 0 };
  for (let s = -maxShift; s <= maxShift + 1e-9; s += stepSize) {
    let n = 0;
    for (let i = 0; i < coreDepth.length; i++) {
      const lv = interpAt(logDepth, logVals, coreDepth[i] + s, stepSize * 4 + 1);
      if (isNum(lv) && isNum(coreVals[i])) { x[n] = coreVals[i]; y[n] = lv; n++; }
    }
    const r = n >= minOverlap ? pearson(x.subarray(0, n), y.subarray(0, n)) : NaN;
    profile.push({ shift: +s.toFixed(6), r, n });
    if (isNum(r) && r > best.r) best = { shift: +s.toFixed(6), r, n };
  }
  if (!isNum(best.r) || best.r === -Infinity) {
    throw new Error('Depth matching cannot be performed because the selected curves have insufficient overlapping depth coverage.');
  }
  // sharpness: difference between peak and median r
  const rs = profile.map((p) => p.r).filter(isNum).sort((a, b) => a - b);
  const med = rs[Math.floor(rs.length / 2)] ?? 0;
  const prom = best.r - med;
  const confidence: CorrelationResult['confidence'] = best.r > 0.7 && prom > 0.2 ? 'High' : best.r > 0.45 && prom > 0.1 ? 'Medium' : 'Low';
  if (Math.abs(Math.abs(best.shift) - maxShift) < stepSize * 1.5) warnings.push('Best shift is at the edge of the search window — widen the window.');
  if (best.n < 15) warnings.push(`Only ${best.n} overlapping samples at the best shift.`);
  if (confidence === 'Low') warnings.push('Correlation peak is weak or broad; verify visually and consider manual tie points.');
  return { bestShift: best.shift, r: best.r, n: best.n, profile, confidence, warnings };
}
