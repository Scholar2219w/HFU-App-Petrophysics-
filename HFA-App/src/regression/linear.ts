// Linear models with full inferential statistics.
import type { CoefRow, Metrics } from '../types';

// ── special functions ──
function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x; const t = x + 5.5 - (x + 0.5) * Math.log(x + 5.5); let s = 1.000000000190015;
  for (const ci of c) s += ci / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}
function betacf(a: number, b: number, x: number) {
  const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300;
  let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m; let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
export function ibeta(a: number, b: number, x: number) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** two-sided p-value for t with df degrees of freedom */
export const tPValue = (t: number, df: number) => (df > 0 && isFinite(t) ? ibeta(df / 2, 0.5, df / (df + t * t)) : NaN);
/** t critical value (two-sided alpha) by bisection */
export function tCrit(df: number, alpha = 0.05) {
  let lo = 0, hi = 100; for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (tPValue(m, df) > alpha) lo = m; else hi = m; } return (lo + hi) / 2;
}

// ── Householder QR least squares ──
/** Solve min ||Xb - y|| for X (n×p row-major). Returns coefficients + (X'X)^-1 diagonal & full. */
export function qrSolve(X: Float64Array, y: Float64Array, n: number, p: number) {
  const A = new Float64Array(X); const b = new Float64Array(y);
  const Rdiag = new Float64Array(p);
  for (let k = 0; k < p; k++) {
    let nrm = 0; for (let i = k; i < n; i++) nrm = Math.hypot(nrm, A[i * p + k]);
    if (nrm === 0) { Rdiag[k] = 0; continue; }
    if (A[k * p + k] < 0) nrm = -nrm;
    for (let i = k; i < n; i++) A[i * p + k] /= nrm;
    A[k * p + k] += 1;
    for (let j = k + 1; j < p; j++) {
      let s = 0; for (let i = k; i < n; i++) s += A[i * p + k] * A[i * p + j];
      s = -s / A[k * p + k]; for (let i = k; i < n; i++) A[i * p + j] += s * A[i * p + k];
    }
    let s = 0; for (let i = k; i < n; i++) s += A[i * p + k] * b[i];
    s = -s / A[k * p + k]; for (let i = k; i < n; i++) b[i] += s * A[i * p + k];
    Rdiag[k] = -nrm;
  }
  let rank = p; const tol = 1e-10 * Math.max(...Array.from(Rdiag, Math.abs));
  for (let k = 0; k < p; k++) if (Math.abs(Rdiag[k]) <= tol) rank--;
  if (rank < p) throw new Error('Design matrix is rank-deficient (perfect multicollinearity or constant predictor). Remove redundant features.');
  const R = (i: number, j: number) => (i === j ? Rdiag[i] : A[i * p + j]);
  const coef = new Float64Array(p);
  for (let k = p - 1; k >= 0; k--) { let s = b[k]; for (let j = k + 1; j < p; j++) s -= R(k, j) * coef[j]; coef[k] = s / Rdiag[k]; }
  // Rinv (upper triangular)
  const Ri = new Float64Array(p * p);
  for (let i = p - 1; i >= 0; i--) { Ri[i * p + i] = 1 / Rdiag[i]; for (let j = i + 1; j < p; j++) { let s = 0; for (let k = i + 1; k <= j; k++) s += R(i, k) * Ri[k * p + j]; Ri[i * p + j] = -s / Rdiag[i]; } }
  const XtXi = new Float64Array(p * p); // Rinv · Rinvᵀ
  for (let i = 0; i < p; i++) for (let j = i; j < p; j++) { let s = 0; for (let k = Math.max(i, j); k < p; k++) s += Ri[i * p + k] * Ri[j * p + k]; XtXi[i * p + j] = XtXi[j * p + i] = s; }
  return { coef, XtXi };
}

export function metricsFrom(y: ArrayLike<number>, yhat: ArrayLike<number>, p: number): Metrics {
  const n = y.length; let my = 0; for (let i = 0; i < n; i++) my += y[i]; my /= n || 1;
  let sst = 0, sse = 0, sae = 0, sape = 0, nape = 0; const ae: number[] = [];
  for (let i = 0; i < n; i++) { const e = y[i] - yhat[i]; sst += (y[i] - my) ** 2; sse += e * e; sae += Math.abs(e); ae.push(Math.abs(e)); if (Math.abs(y[i]) > 1e-12) { sape += Math.abs(e / y[i]); nape++; } }
  ae.sort((a, b) => a - b);
  const r2 = sst > 0 ? 1 - sse / sst : NaN;
  const k = p + 1;
  return {
    n, p, r2, adjR2: n - p - 1 > 0 ? 1 - ((1 - r2) * (n - 1)) / (n - p - 1) : NaN,
    rmse: Math.sqrt(sse / (n || 1)), mae: sae / (n || 1), medae: ae.length ? ae[Math.floor((ae.length - 1) / 2)] : NaN,
    mape: nape ? (100 * sape) / nape : undefined,
    aic: n * Math.log(sse / n) + 2 * k, bic: n * Math.log(sse / n) + k * Math.log(n),
  };
}

export interface OlsFit { intercept: number; coefs: number[]; table: CoefRow[]; metrics: Metrics; sigma: number; XtXi: Float64Array; yhat: Float64Array; resid: Float64Array }

/** OLS with intercept. X: n×p row-major (no intercept column). */
export function ols(X: Float64Array, y: Float64Array, n: number, p: number, names: string[]): OlsFit {
  if (n <= p + 1) throw new Error(`Regression requires more samples (${n}) than parameters (${p + 1}).`);
  const q = p + 1; const A = new Float64Array(n * q);
  for (let i = 0; i < n; i++) { A[i * q] = 1; for (let j = 0; j < p; j++) A[i * q + j + 1] = X[i * p + j]; }
  const { coef, XtXi } = qrSolve(A, y, n, q);
  const yhat = new Float64Array(n), resid = new Float64Array(n); let sse = 0;
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < q; j++) s += A[i * q + j] * coef[j]; yhat[i] = s; resid[i] = y[i] - s; sse += resid[i] ** 2; }
  const df = n - q; const sigma2 = sse / df;
  const table: CoefRow[] = ['Intercept', ...names].map((name, j) => {
    const se = Math.sqrt(sigma2 * XtXi[j * q + j]); const t = coef[j] / se;
    return { name, coef: coef[j], se, t, p: tPValue(t, df) };
  });
  const vifs = vif(X, n, p); vifs.forEach((v, j) => (table[j + 1].vif = v));
  return { intercept: coef[0], coefs: Array.from(coef.slice(1)), table, metrics: metricsFrom(y, yhat, p), sigma: Math.sqrt(sigma2), XtXi, yhat, resid };
}

/** Variance inflation factors: VIF_j = 1/(1-R²_j) regressing X_j on the others. */
export function vif(X: Float64Array, n: number, p: number): number[] {
  if (p < 2) return new Array(p).fill(1);
  const out: number[] = [];
  for (let j = 0; j < p; j++) {
    const Xo = new Float64Array(n * (p - 1)); const yj = new Float64Array(n);
    for (let i = 0; i < n; i++) { let c = 0; for (let k = 0; k < p; k++) if (k !== j) Xo[i * (p - 1) + c++] = X[i * p + k]; yj[i] = X[i * p + j]; }
    try {
      const q = p; const A = new Float64Array(n * q);
      for (let i = 0; i < n; i++) { A[i * q] = 1; for (let k = 0; k < p - 1; k++) A[i * q + k + 1] = Xo[i * (p - 1) + k]; }
      const { coef } = qrSolve(A, yj, n, q);
      let my = 0; for (let i = 0; i < n; i++) my += yj[i]; my /= n;
      let sst = 0, sse = 0; for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < q; k++) s += A[i * q + k] * coef[k]; sse += (yj[i] - s) ** 2; sst += (yj[i] - my) ** 2; }
      const r2 = 1 - sse / sst; out.push(1 / Math.max(1e-12, 1 - r2));
    } catch { out.push(Infinity); }
  }
  return out;
}

/** Condition number of the standardized design (sqrt of eigenvalue ratio via power/inverse iteration on correlation matrix). */
export function conditionNumber(X: Float64Array, n: number, p: number): number {
  if (p < 2) return 1;
  const { Z } = standardize(X, n, p);
  const C = new Float64Array(p * p);
  for (let a = 0; a < p; a++) for (let b = a; b < p; b++) { let s = 0; for (let i = 0; i < n; i++) s += Z[i * p + a] * Z[i * p + b]; C[a * p + b] = C[b * p + a] = s / (n - 1); }
  // Jacobi eigenvalues
  const A = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => C[i * p + j]));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0; for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) off += A[i][j] ** 2; if (off < 1e-18) break;
    for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) {
      if (Math.abs(A[i][j]) < 1e-15) continue;
      const th = (A[j][j] - A[i][i]) / (2 * A[i][j]); const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)); const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < p; k++) { const aki = A[k][i], akj = A[k][j]; A[k][i] = c * aki - s * akj; A[k][j] = s * aki + c * akj; }
      for (let k = 0; k < p; k++) { const aik = A[i][k], ajk = A[j][k]; A[i][k] = c * aik - s * ajk; A[j][k] = s * aik + c * ajk; }
    }
  }
  const ev = A.map((r, i) => r[i]); const mx = Math.max(...ev), mn = Math.max(1e-15, Math.min(...ev));
  return Math.sqrt(mx / mn);
}

export function standardize(X: Float64Array, n: number, p: number) {
  const mu = new Array(p).fill(0), sd = new Array(p).fill(1); const Z = new Float64Array(n * p);
  for (let j = 0; j < p; j++) {
    let m = 0; for (let i = 0; i < n; i++) m += X[i * p + j]; m /= n;
    let v = 0; for (let i = 0; i < n; i++) v += (X[i * p + j] - m) ** 2; const s = Math.sqrt(v / Math.max(1, n - 1)) || 1;
    mu[j] = m; sd[j] = s; for (let i = 0; i < n; i++) Z[i * p + j] = (X[i * p + j] - m) / s;
  }
  return { Z, mu, sd };
}

/** Elastic net by cyclic coordinate descent on standardized X (alpha=1 → Lasso, 0 → Ridge). Returns coefficients on ORIGINAL scale. */
export function elasticNet(X: Float64Array, y: Float64Array, n: number, p: number, lambda: number, alpha: number, maxIter = 5000) {
  const { Z, mu, sd } = standardize(X, n, p);
  let my = 0; for (let i = 0; i < n; i++) my += y[i]; my /= n;
  const r = new Float64Array(n); for (let i = 0; i < n; i++) r[i] = y[i] - my;
  const b = new Float64Array(p);
  const zz = new Float64Array(p); for (let j = 0; j < p; j++) { let s = 0; for (let i = 0; i < n; i++) s += Z[i * p + j] ** 2; zz[j] = s / n; }
  for (let it = 0; it < maxIter; it++) {
    let maxd = 0;
    for (let j = 0; j < p; j++) {
      let rho = 0; for (let i = 0; i < n; i++) rho += Z[i * p + j] * (r[i] + Z[i * p + j] * b[j]); rho /= n;
      const st = Math.sign(rho) * Math.max(0, Math.abs(rho) - lambda * alpha);
      const nb = st / (zz[j] + lambda * (1 - alpha));
      const d = nb - b[j];
      if (d !== 0) { for (let i = 0; i < n; i++) r[i] -= Z[i * p + j] * d; b[j] = nb; maxd = Math.max(maxd, Math.abs(d)); }
    }
    if (maxd < 1e-8) break;
  }
  const coefs = Array.from(b, (v, j) => v / sd[j]);
  const intercept = my - coefs.reduce((s, c, j) => s + c * mu[j], 0);
  return { intercept, coefs, stdCoefs: Array.from(b) };
}

/** Lambda max for lasso path (standardized). */
export function lambdaMax(X: Float64Array, y: Float64Array, n: number, p: number, alpha: number) {
  const { Z } = standardize(X, n, p); let my = 0; for (let i = 0; i < n; i++) my += y[i]; my /= n;
  let mx = 0; for (let j = 0; j < p; j++) { let s = 0; for (let i = 0; i < n; i++) s += Z[i * p + j] * (y[i] - my); mx = Math.max(mx, Math.abs(s / n)); }
  return mx / Math.max(alpha, 1e-3);
}

export function expandPoly2(X: Float64Array, n: number, p: number, names: string[]) {
  const newNames = [...names]; const pairs: [number, number][] = [];
  for (let a = 0; a < p; a++) for (let b = a; b < p; b++) { pairs.push([a, b]); newNames.push(a === b ? `${names[a]}²` : `${names[a]}·${names[b]}`); }
  const q = p + pairs.length; const Y = new Float64Array(n * q);
  for (let i = 0; i < n; i++) { for (let j = 0; j < p; j++) Y[i * q + j] = X[i * p + j]; pairs.forEach(([a, b], k) => (Y[i * q + p + k] = X[i * p + a] * X[i * p + b])); }
  return { X: Y, q, names: newNames };
}
