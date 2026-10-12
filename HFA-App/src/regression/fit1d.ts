// Bivariate trend fits for the Crossplot Studio.
import { ols } from './linear';
import { tCrit } from './linear';
import { isNum } from '../util/num';

export type Fit1D = 'linear' | 'poly2' | 'poly3' | 'power' | 'exponential' | 'loglinear';
export const FIT_LABEL: Record<Fit1D, string> = { linear: 'Linear  y = a + b·x', poly2: 'Polynomial (2)', poly3: 'Polynomial (3)', power: 'Power-law  y = a·x^b', exponential: 'Exponential  y = a·e^(b·x)', loglinear: 'Log-linear  y = a + b·log10(x)' };

export interface Fit1DResult { kind: Fit1D; eq: string; r2: number; rmse: number; mae: number; n: number; ci: string; curve: { x: number[]; y: number[]; lo: number[]; hi: number[] }; space: string }

export function fit1d(xs: ArrayLike<number>, ys: ArrayLike<number>, kind: Fit1D): Fit1DResult | null {
  const tx = (x: number) => (kind === 'power' || kind === 'loglinear' ? Math.log10(x) : x);
  const ty = (y: number) => (kind === 'power' || kind === 'exponential' ? Math.log(y) / (kind === 'power' ? Math.LN10 : 1) : y);
  const X: number[] = [], Y: number[] = [], rx: number[] = [], ry: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i]; if (!isNum(x) || !isNum(y)) continue;
    if ((kind === 'power' || kind === 'loglinear') && x <= 0) continue; if ((kind === 'power' || kind === 'exponential') && y <= 0) continue;
    X.push(tx(x)); Y.push(ty(y)); rx.push(x); ry.push(y);
  }
  const deg = kind === 'poly2' ? 2 : kind === 'poly3' ? 3 : 1; const n = X.length;
  if (n < deg + 3) return null;
  const mu = X.reduce((s, v) => s + v, 0) / n; // centre polynomial for conditioning
  const D = new Float64Array(n * deg); for (let i = 0; i < n; i++) for (let d = 0; d < deg; d++) D[i * deg + d] = Math.pow(X[i] - (deg > 1 ? mu : 0), d + 1);
  let f; try { f = ols(D, Float64Array.from(Y), n, deg, Array.from({ length: deg }, (_, d) => `x^${d + 1}`)); } catch { return null; }
  const c0 = deg > 1 ? mu : 0;
  const predT = (xt: number) => { let s = f.intercept; for (let d = 0; d < deg; d++) s += f.coefs[d] * Math.pow(xt - c0, d + 1); return s; };
  const inv = (yt: number) => (kind === 'power' ? Math.pow(10, yt) : kind === 'exponential' ? Math.exp(yt) : yt);
  // original-space errors
  let sse = 0, sae = 0; for (let i = 0; i < n; i++) { const e = ry[i] - inv(predT(X[i])); sse += e * e; sae += Math.abs(e); }
  const t = tCrit(n - deg - 1);
  // confidence band for mean response (transformed space)
  const q = deg + 1; const band = (xt: number) => { const v = [1, ...Array.from({ length: deg }, (_, d) => Math.pow(xt - c0, d + 1))]; let s = 0; for (let a = 0; a < q; a++) for (let b = 0; b < q; b++) s += v[a] * f.XtXi[a * q + b] * v[b]; return t * f.sigma * Math.sqrt(Math.max(0, s)); };
  const xmin = Math.min(...X), xmax = Math.max(...X); const cx: number[] = [], cy: number[] = [], lo: number[] = [], hi: number[] = [];
  for (let k = 0; k <= 80; k++) { const xt = xmin + ((xmax - xmin) * k) / 80; const yt = predT(xt); const b = band(xt); cx.push(kind === 'power' || kind === 'loglinear' ? Math.pow(10, xt) : xt); cy.push(inv(yt)); lo.push(inv(yt - b)); hi.push(inv(yt + b)); }
  const a = f.intercept, b = f.coefs[0]; const seB = f.table[1].se!;
  const r = (v: number) => (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : v.toPrecision(4));
  let eq = '';
  switch (kind) {
    case 'linear': eq = `y = ${r(a)} + ${r(b)}·x`; break;
    case 'loglinear': eq = `y = ${r(a)} + ${r(b)}·log10(x)`; break;
    case 'power': eq = `y = ${r(Math.pow(10, a))}·x^${r(b)}`; break;
    case 'exponential': eq = `y = ${r(Math.exp(a))}·e^(${r(b)}·x)`; break;
    default: eq = `y = ${r(a)}` + f.coefs.map((c, d) => ` ${c >= 0 ? '+' : '−'} ${r(Math.abs(c))}·(x−${r(c0)})^${d + 1}`).join('');
  }
  const bLabel = kind === 'power' ? 'exponent b' : kind === 'exponential' ? 'rate b' : deg > 1 ? 'b₁' : 'slope b';
  return { kind, eq, r2: f.metrics.r2, rmse: Math.sqrt(sse / n), mae: sae / n, n, ci: `95% CI ${bLabel}: ${r(b - t * seB)} … ${r(b + t * seB)}`, curve: { x: cx, y: cy, lo, hi }, space: kind === 'power' ? 'R² in log-log space' : kind === 'exponential' ? 'R² in ln(y) space' : kind === 'loglinear' ? 'R² vs log10(x)' : 'R² in linear space' };
}

export function movingAverage(xs: ArrayLike<number>, ys: ArrayLike<number>, win: number, logX = false) {
  const idx = Array.from({ length: xs.length }, (_, i) => i).filter((i) => isNum(xs[i]) && isNum(ys[i]) && (!logX || xs[i] > 0)).sort((a, b) => xs[a] - xs[b]);
  const x: number[] = [], y: number[] = []; const h = Math.max(1, Math.floor(win / 2));
  for (let k = h; k < idx.length - h; k += Math.max(1, Math.floor(idx.length / 200))) { let sx = 0, sy = 0; for (let j = k - h; j <= k + h; j++) { sx += logX ? Math.log10(xs[idx[j]]) : xs[idx[j]]; sy += ys[idx[j]]; } x.push(logX ? Math.pow(10, sx / (2 * h + 1)) : sx / (2 * h + 1)); y.push(sy / (2 * h + 1)); }
  return { x, y };
}
