// Numerical helpers operating directly on TypedArrays (NaN = missing).

export type NumArr = Float32Array | Float64Array | number[];

export const uid = (p = '') => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
export const nowIso = () => new Date().toISOString();
export const isNum = (v: number) => v === v && v !== Infinity && v !== -Infinity;

export function basicStats(a: NumArr) {
  let min = Infinity, max = -Infinity, s = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v === v && v !== Infinity && v !== -Infinity) { if (v < min) min = v; if (v > max) max = v; s += v; n++; }
  }
  return { min: n ? min : NaN, max: n ? max : NaN, mean: n ? s / n : NaN, nValid: n, nullPct: a.length ? 100 * (1 - n / a.length) : 100 };
}

export function validValues(a: NumArr): Float64Array {
  let n = 0; for (let i = 0; i < a.length; i++) if (isNum(a[i])) n++;
  const out = new Float64Array(n); let j = 0;
  for (let i = 0; i < a.length; i++) if (isNum(a[i])) out[j++] = a[i];
  return out;
}

/** percentile on a SORTED Float64Array, p in [0,100], linear interpolation */
export function pctSorted(s: Float64Array | number[], p: number) {
  if (!s.length) return NaN;
  const r = (p / 100) * (s.length - 1), lo = Math.floor(r), hi = Math.ceil(r);
  return s[lo] + (s[hi] - s[lo]) * (r - lo);
}
export function percentiles(a: NumArr, ps: number[]) {
  const v = validValues(a).sort();
  return ps.map((p) => pctSorted(v, p));
}
export function fullStats(a: NumArr) {
  const b = basicStats(a);
  const [p05, p95] = percentiles(a, [5, 95]);
  return { ...b, p05, p95 };
}
export function mean(a: NumArr) { return basicStats(a).mean; }
export function median(a: NumArr) { return percentiles(a, [50])[0]; }
export function std(a: NumArr) {
  const m = mean(a); let s = 0, n = 0;
  for (let i = 0; i < a.length; i++) if (isNum(a[i])) { s += (a[i] - m) ** 2; n++; }
  return n > 1 ? Math.sqrt(s / (n - 1)) : NaN;
}
export function pearson(x: NumArr, y: NumArr) {
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < x.length; i++) if (isNum(x[i]) && isNum(y[i])) { sx += x[i]; sy += y[i]; n++; }
  if (n < 3) return NaN;
  const mx = sx / n, my = sy / n; let cxy = 0, cxx = 0, cyy = 0;
  for (let i = 0; i < x.length; i++) if (isNum(x[i]) && isNum(y[i])) { const dx = x[i] - mx, dy = y[i] - my; cxy += dx * dy; cxx += dx * dx; cyy += dy * dy; }
  return cxy / Math.sqrt(cxx * cyy);
}

/** Linear interpolation of (xs, ys) at x. xs ascending. NaN outside or across gaps > maxGap. */
export function interpAt(xs: Float64Array, ys: NumArr, x: number, maxGap = Infinity): number {
  const n = xs.length; if (!n || x < xs[0] || x > xs[n - 1]) return NaN;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  const x0 = xs[lo], x1 = xs[hi], y0 = ys[lo], y1 = ys[hi];
  if (x === x0) return y0; if (x === x1) return y1;
  if (x1 - x0 > maxGap) return NaN;
  if (!isNum(y0) || !isNum(y1)) { // nearest valid if very close
    const d0 = x - x0, d1 = x1 - x;
    const yn = d0 <= d1 ? y0 : y1; return isNum(yn) ? yn : NaN;
  }
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}
/** Index of nearest sample (xs ascending). */
export function nearestIndex(xs: Float64Array, x: number) {
  const n = xs.length; if (!n) return -1;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
}
export function lowerBound(xs: Float64Array, x: number) {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

export function fmt(v: number | undefined | null, d = 3): string {
  if (v === undefined || v === null || !isNum(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
  if (a >= 1000) return v.toFixed(Math.max(0, d - 3));
  return Number(v.toPrecision(Math.max(d, 1) + (a >= 1 ? 1 : 0))).toString();
}
export function fmtFixed(v: number, d = 2) { return isNum(v) ? v.toFixed(d) : '—'; }
export function fmtBytes(b: number) {
  if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'; return (b / 1073741824).toFixed(2) + ' GB';
}
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!isNum(min) || !isNum(max) || min === max) return [min];
  const span = max - min, step0 = span / count, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const r = step0 / mag, step = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
  const out: number[] = []; for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(12));
  return out;
}
export function median3(a: number[]) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

export const PALETTE = ['#4ea1ff', '#f5a623', '#3ecf8e', '#e5534b', '#b083f0', '#e8c547', '#39c5cf', '#f07db5', '#9aa4b2', '#8bd450', '#ff8c42', '#6c8cff'];
// HFU colours: poor → good reservoir quality ramp is NOT implied; categorical.
export const HFU_COLORS = ['#7f8c99', '#c0504d', '#e39b3b', '#e8d44d', '#6cc24a', '#2fa39b', '#3f7fd6', '#7a5cd6', '#c957b8', '#8a6b4e'];
export const hfuColor = (id: number) => (id <= 0 ? '#333a44' : HFU_COLORS[(id - 1) % HFU_COLORS.length]);
