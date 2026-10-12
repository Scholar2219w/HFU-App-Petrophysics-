// Model fitting, feature selection and validation (pure; runs in analysis worker).
import type { Algo, CoefRow, Metrics, SubModel } from '../types';
import { conditionNumber, elasticNet, expandPoly2, lambdaMax, metricsFrom, ols, standardize, vif } from './linear';
import { forestSpread, gradientBoost, predictForest, randomForest } from './trees';
import { rng } from '../clustering/core';

export interface Dataset {
  X: Float64Array; y: Float64Array; n: number; p: number; names: string[];
  depth: Float64Array; well: Int32Array; group: Int32Array; // group 0 = none
  wellNames: string[];
}
export interface FitSpec { algorithm: Algo; params: Record<string, any>; minN: number; targetLabel: string; classes?: number[] }

const r4 = (v: number) => (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(4) : v.toFixed(4));

function subset(d: Dataset, rows: number[], cols?: number[]): Dataset {
  const c = cols ?? Array.from({ length: d.p }, (_, j) => j); const p = c.length; const n = rows.length;
  const X = new Float64Array(n * p); const y = new Float64Array(n); const depth = new Float64Array(n); const well = new Int32Array(n); const group = new Int32Array(n);
  rows.forEach((r, i) => { c.forEach((j, k) => (X[i * p + k] = d.X[r * d.p + j])); y[i] = d.y[r]; depth[i] = d.depth[r]; well[i] = d.well[r]; group[i] = d.group[r]; });
  return { X, y, n, p, names: c.map((j) => d.names[j]), depth, well, group, wellNames: d.wellNames };
}

function featureRanges(d: Dataset): [number, number][] {
  return d.names.map((_, j) => { let mn = Infinity, mx = -Infinity; for (let i = 0; i < d.n; i++) { const v = d.X[i * d.p + j]; if (v < mn) mn = v; if (v > mx) mx = v; } return [mn, mx] as [number, number]; });
}

function resStats(y: ArrayLike<number>, yhat: ArrayLike<number>) {
  const r = Array.from(y, (v, i) => v - yhat[i]).sort((a, b) => a - b); const n = r.length;
  const m = r.reduce((s, v) => s + v, 0) / (n || 1); const sd = Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, n - 1));
  return { mean: m, sd, p05: r[Math.floor(0.05 * (n - 1))] ?? NaN, p95: r[Math.floor(0.95 * (n - 1))] ?? NaN };
}

/** Fit one model on a dataset. Returns a serialisable SubModel. */
export function fitSub(d: Dataset, spec: FitSpec, group = 'ALL', groupId = 0): SubModel {
  const warnings: string[] = [];
  if (d.n < spec.minN) throw new Error(`Regression requires at least ${spec.minN} valid samples (group ${group} has ${d.n}).`);
  const ranges = featureRanges(d);
  const a = spec.algorithm;
  const base: Partial<SubModel> = { group, groupId, n: d.n, features: d.names, featureRanges: ranges };
  if (a === 'RandomForest' || a === 'GBT' || a === 'RFClassifier') {
    let F; let yhat: Float64Array;
    if (a === 'RFClassifier') {
      const classes = spec.classes ?? [...new Set(Array.from(d.y))].sort((x, y) => x - y);
      const yi = Float64Array.from(d.y, (v) => classes.indexOf(v));
      F = randomForest(d.X, yi, d.n, d.p, { nTrees: spec.params.nTrees ?? 150, maxDepth: spec.params.maxDepth ?? 14, minLeaf: spec.params.minLeaf ?? 1, classes: classes.length });
      yhat = Float64Array.from({ length: d.n }, (_, i) => classes[predictForest(F, d.X, i * d.p)]);
      let ok = 0; for (let i = 0; i < d.n; i++) if (yhat[i] === d.y[i]) ok++;
      const m: Metrics = { n: d.n, p: d.p, r2: NaN, adjR2: NaN, rmse: NaN, mae: NaN, medae: NaN, mape: undefined };
      (m as any).accuracy = ok / d.n; (m as any).oobAccuracy = F.oobAcc;
      return { ...base, kind: 'classifier', forest: F, classes, metrics: m, equation: `${spec.targetLabel} = RF-classifier(${d.names.join(', ')}) — ${F.trees.length} trees; training acc ${(100 * ok / d.n).toFixed(1)}%, OOB acc ${(100 * (F.oobAcc ?? NaN)).toFixed(1)}%`, table: d.names.map((nm, j) => ({ name: nm, coef: F.importance[j] })), residual: { mean: 0, sd: 0, p05: 0, p95: 0 }, warnings } as SubModel;
    }
    F = a === 'RandomForest'
      ? randomForest(d.X, d.y, d.n, d.p, { nTrees: spec.params.nTrees ?? 150, maxDepth: spec.params.maxDepth ?? 12, minLeaf: spec.params.minLeaf ?? 3 })
      : gradientBoost(d.X, d.y, d.n, d.p, { nRounds: spec.params.nRounds ?? 250, lr: spec.params.lr ?? 0.08, maxDepth: spec.params.maxDepth ?? 3 });
    yhat = Float64Array.from({ length: d.n }, (_, i) => predictForest(F, d.X, i * d.p));
    const m = metricsFrom(d.y, yhat, d.p); m.aic = undefined; m.bic = undefined;
    if (F.oobR2 !== undefined) { (m as any).oobR2 = F.oobR2; if (m.r2 - F.oobR2 > 0.25) warnings.push(`Training R² (${m.r2.toFixed(2)}) ≫ out-of-bag R² (${F.oobR2.toFixed(2)}): the forest memorises training data — rely on validation metrics.`); }
    return { ...base, kind: a === 'RandomForest' ? 'forest' : 'gbt', forest: F, metrics: m, table: d.names.map((nm, j) => ({ name: nm, coef: F.importance[j] })), equation: `${spec.targetLabel} = ${a === 'RandomForest' ? 'RandomForest' : 'GradientBoostedTrees'}(${d.names.join(', ')}) — ${F.trees.length} trees (non-parametric; no closed-form equation)`, residual: resStats(d.y, yhat), warnings } as SubModel;
  }
  // linear family
  let X = d.X, p = d.p, names = d.names; let expand: 'none' | 'poly2' = 'none';
  if (a === 'Poly2') { const e = expandPoly2(d.X, d.n, d.p, d.names); X = e.X; p = e.q; names = e.names; expand = 'poly2'; }
  if (d.n <= p + 1) throw new Error(`Group ${group}: ${d.n} samples is not enough for ${p + 1} parameters.`);
  let intercept: number, coefs: number[], table: CoefRow[] | undefined; let yhat: Float64Array;
  if (a === 'Ridge' || a === 'Lasso' || a === 'ElasticNet') {
    const alpha = a === 'Ridge' ? 0 : a === 'Lasso' ? 1 : spec.params.alpha ?? 0.5;
    let lambda = spec.params.lambda;
    if (lambda === undefined || lambda === 'cv') lambda = cvLambda(X, d.y, d.n, p, alpha, d.depth);
    const f = elasticNet(X, d.y, d.n, p, lambda, alpha);
    intercept = f.intercept; coefs = f.coefs;
    yhat = Float64Array.from({ length: d.n }, (_, i) => { let s = intercept; for (let j = 0; j < p; j++) s += coefs[j] * X[i * p + j]; return s; });
    const vifs = vif(X, d.n, p);
    table = [{ name: 'Intercept', coef: intercept }, ...names.map((nm, j) => ({ name: nm, coef: coefs[j], vif: vifs[j] }))];
    const nz = coefs.filter((c) => Math.abs(c) > 1e-12).length;
    const m = metricsFrom(d.y, yhat, nz);
    warnings.push(`${a}: λ = ${r4(lambda)}${spec.params.lambda === undefined || spec.params.lambda === 'cv' ? ' (chosen by 5-fold depth-blocked CV)' : ''}; standard errors/p-values are not defined for penalised estimators.`);
    if (a !== 'Ridge') { const zero = names.filter((_, j) => Math.abs(coefs[j]) <= 1e-12); if (zero.length) warnings.push(`Coefficients shrunk to zero: ${zero.join(', ')}`); }
    const sub: SubModel = { ...(base as any), kind: 'linear', intercept, coefs, expand, table, metrics: m, equation: equation(spec.targetLabel, intercept, coefs, names), residual: resStats(d.y, yhat), warnings };
    (sub as any).lambda = lambda;
    return sub;
  }
  const f = ols(X, d.y, d.n, p, names);
  intercept = f.intercept; coefs = f.coefs; table = f.table; yhat = f.yhat;
  const maxVif = Math.max(...(table.slice(1).map((r) => r.vif ?? 1)));
  if (maxVif > 10) warnings.push(`Multicollinearity: max VIF = ${maxVif.toFixed(1)} (> 10). Coefficients are unstable; consider removing correlated predictors.`);
  else if (maxVif > 5) warnings.push(`Moderate multicollinearity: max VIF = ${maxVif.toFixed(1)} (> 5).`);
  const cn = conditionNumber(X, d.n, p); if (cn > 30) warnings.push(`Condition number ${cn.toFixed(1)} (> 30) indicates collinear predictors.`);
  const insignificant = table.slice(1).filter((r) => (r.p ?? 0) > 0.05).map((r) => r.name);
  if (insignificant.length) warnings.push(`Not significant at 5%: ${insignificant.join(', ')}.`);
  const sub: SubModel = { ...(base as any), kind: 'linear', intercept, coefs, expand, table, metrics: f.metrics, equation: equation(spec.targetLabel, intercept, coefs, names), residual: resStats(d.y, yhat), warnings };
  (sub as any).conditionNumber = cn;
  return sub;
}

function equation(t: string, b0: number, b: number[], names: string[]) {
  return `${t} = ${r4(b0)}` + b.map((c, j) => (Math.abs(c) <= 1e-12 ? '' : ` ${c >= 0 ? '+' : '−'} ${r4(Math.abs(c))}·${names[j]}`)).join('');
}

/** Predict a SubModel for a raw feature row (features in the model's order). */
export function predictSub(m: SubModel, x: ArrayLike<number>, off = 0): number {
  if (m.kind === 'forest' || m.kind === 'gbt') return predictForest(m.forest, x, off);
  if (m.kind === 'classifier') return m.classes![predictForest(m.forest, x, off)];
  const p = m.features.length; let s = m.intercept!; let k = 0;
  for (let j = 0; j < p; j++) s += m.coefs![k++] * x[off + j];
  if (m.expand === 'poly2') for (let a = 0; a < p; a++) for (let b = a; b < p; b++) s += m.coefs![k++] * x[off + a] * x[off + b];
  return s;
}
export function spreadSub(m: SubModel, x: ArrayLike<number>, off = 0) { return m.kind === 'forest' ? forestSpread(m.forest, x, off) : NaN; }

// ── lambda selection ──
function cvLambda(X: Float64Array, y: Float64Array, n: number, p: number, alpha: number, depth: Float64Array) {
  const lmax = lambdaMax(X, y, n, p, Math.max(alpha, 0.01)) || 1;
  const grid = Array.from({ length: 25 }, (_, i) => lmax * Math.pow(10, -4 * (i / 24)));
  const folds = blockFolds(depth, 5);
  let best = grid[grid.length - 1], bestE = Infinity;
  for (const lam of grid) {
    let e = 0;
    for (const f of folds) {
      const tr = f.train, te = f.test; if (tr.length < p + 2 || !te.length) continue;
      const Xt = new Float64Array(tr.length * p), yt = new Float64Array(tr.length);
      tr.forEach((r, i) => { for (let j = 0; j < p; j++) Xt[i * p + j] = X[r * p + j]; yt[i] = y[r]; });
      const m = elasticNet(Xt, yt, tr.length, p, lam, alpha, 2000);
      for (const r of te) { let s = m.intercept; for (let j = 0; j < p; j++) s += m.coefs[j] * X[r * p + j]; e += (y[r] - s) ** 2; }
    }
    if (e < bestE) { bestE = e; best = lam; }
  }
  return best;
}

// ── folds ──
export interface Fold { name: string; train: number[]; test: number[] }
export function blockFolds(depth: Float64Array, k: number): Fold[] {
  const order = Array.from(depth.keys()).sort((a, b) => depth[a] - depth[b]); const n = order.length;
  return Array.from({ length: k }, (_, f) => {
    const lo = Math.floor((f * n) / k), hi = Math.floor(((f + 1) * n) / k);
    const test = order.slice(lo, hi); const ts = new Set(test);
    return { name: `Block ${f + 1} (${depth[order[lo]]?.toFixed(1)}–${depth[order[hi - 1]]?.toFixed(1)})`, test, train: order.filter((i) => !ts.has(i)) };
  });
}
export function randomFolds(n: number, k: number, seed = 3): Fold[] {
  const R = rng(seed); const idx = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return Array.from({ length: k }, (_, f) => { const test = idx.filter((_, i) => i % k === f); const ts = new Set(test); return { name: `Fold ${f + 1}`, test, train: idx.filter((i) => !ts.has(i)) }; });
}
export function stratifiedFolds(group: Int32Array, k: number, seed = 3): Fold[] {
  const R = rng(seed); const byG = new Map<number, number[]>();
  group.forEach((g, i) => { if (!byG.has(g)) byG.set(g, []); byG.get(g)!.push(i); });
  const assign = new Int32Array(group.length);
  for (const arr of byG.values()) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } arr.forEach((r, i) => (assign[r] = i % k)); }
  return Array.from({ length: k }, (_, f) => { const test: number[] = [], train: number[] = []; assign.forEach((a, i) => (a === f ? test : train).push(i)); return { name: `Stratified fold ${f + 1}`, test, train }; });
}
export function wellFolds(well: Int32Array, names: string[]): Fold[] {
  const ids = [...new Set(Array.from(well))];
  if (ids.length < 2) throw new Error('Leave-One-Well-Out validation requires training data from at least 2 wells.');
  return ids.map((w) => { const test: number[] = [], train: number[] = []; well.forEach((x, i) => (x === w ? test : train).push(i)); return { name: `Leave out ${names[w] ?? w}`, test, train }; });
}
export function trainTest(depth: Float64Array, frac: number, mode: 'random' | 'block', seed = 3): Fold[] {
  const n = depth.length; const nt = Math.max(1, Math.round(n * frac));
  let test: number[];
  if (mode === 'random') { const R = rng(seed); const idx = Array.from({ length: n }, (_, i) => i).sort(() => R() - 0.5); test = idx.slice(0, nt); }
  else { const order = Array.from(depth.keys()).sort((a, b) => depth[a] - depth[b]); test = order.slice(n - nt); }
  const ts = new Set(test); return [{ name: mode === 'random' ? 'Random hold-out' : 'Deepest block hold-out', test, train: Array.from({ length: n }, (_, i) => i).filter((i) => !ts.has(i)) }];
}

export interface ValidationSpec { method: 'split-random' | 'split-block' | 'kfold-random' | 'kfold-block' | 'lowo' | 'stratified' | 'interval'; k: number; testFrac: number; groupBy: 'global' | 'hfu'; testInterval?: [number, number] }
export function validate(d: Dataset, spec: FitSpec, v: ValidationSpec) {
  const folds = v.method === 'split-random' ? trainTest(d.depth, v.testFrac, 'random') : v.method === 'split-block' ? trainTest(d.depth, v.testFrac, 'block')
    : v.method === 'kfold-random' ? randomFolds(d.n, v.k) : v.method === 'kfold-block' ? blockFolds(d.depth, v.k)
    : v.method === 'lowo' ? wellFolds(d.well, d.wellNames)
    : v.method === 'interval' ? (() => { const [a, b] = v.testInterval ?? [0, 0]; const test: number[] = [], train: number[] = []; d.depth.forEach((z, i) => (z >= a && z <= b ? test : train).push(i)); if (!test.length) throw new Error('No samples inside the validation interval.'); return [{ name: `Validation interval ${a}–${b}`, test, train }]; })()
    : stratifiedFolds(d.group, v.k);
  const pred = new Float64Array(d.n).fill(NaN); const foldOf = new Int32Array(d.n).fill(-1);
  const warnings: string[] = []; const foldMetrics: { name: string; metrics: Metrics }[] = [];
  if (v.method === 'split-random' || v.method === 'kfold-random') warnings.push('Random splitting of depth-correlated samples leaks information between neighbouring samples; metrics are likely optimistic. Prefer depth-blocked or well-based validation.');
  folds.forEach((f, fi) => {
    const tr = subset(d, f.train); const te = subset(d, f.test);
    try {
      const pr = new Float64Array(te.n);
      if (v.groupBy === 'hfu') {
        const groups = [...new Set(Array.from(tr.group))].filter((g) => g > 0);
        const models = new Map<number, SubModel>();
        for (const g of groups) { const rows = Array.from(tr.group.keys()).filter((i) => tr.group[i] === g); if (rows.length >= spec.minN) models.set(g, fitSub(subset(tr, rows), spec, `HFU ${g}`, g)); }
        for (let i = 0; i < te.n; i++) { const m = models.get(te.group[i]); pr[i] = m ? predictSub(m, te.X, i * te.p) : NaN; }
        const miss = Array.from(pr).filter((x) => x !== x).length; if (miss) warnings.push(`${f.name}: ${miss} test samples had no group model (group absent or below N threshold in training).`);
      } else {
        const m = fitSub(tr, spec); for (let i = 0; i < te.n; i++) pr[i] = predictSub(m, te.X, i * te.p);
      }
      f.test.forEach((r, i) => { pred[r] = pr[i]; foldOf[r] = fi; });
      const ok = Array.from(pr.keys()).filter((i) => pr[i] === pr[i]);
      if (ok.length > 1) foldMetrics.push({ name: `${f.name} (train ${tr.n} / test ${te.n})`, metrics: metricsFrom(ok.map((i) => te.y[i]), ok.map((i) => pr[i]), d.p) });
    } catch (e: any) { warnings.push(`${f.name}: ${e.message}`); }
  });
  const ok = Array.from(pred.keys()).filter((i) => pred[i] === pred[i]);
  if (ok.length < 2) throw new Error('Validation produced no out-of-fold predictions (check minimum N and fold sizes).');
  const metrics = spec.algorithm === 'RFClassifier'
    ? (() => { const acc = ok.filter((i) => pred[i] === d.y[i]).length / ok.length; const m: any = { n: ok.length, p: d.p, r2: NaN, adjR2: NaN, rmse: NaN, mae: NaN, medae: NaN, accuracy: acc }; return m as Metrics; })()
    : metricsFrom(ok.map((i) => d.y[i]), ok.map((i) => pred[i]), d.p);
  return { metrics, folds: foldMetrics, actual: ok.map((i) => d.y[i]), predicted: ok.map((i) => pred[i]), depth: ok.map((i) => d.depth[i]), fold: ok.map((i) => foldOf[i]), warnings };
}

// ── feature selection ──
export interface SelectionResult { method: string; ranking: { name: string; score: number; note?: string }[]; selected: string[]; log: string[] }

function aicOf(d: Dataset, cols: number[]) {
  if (!cols.length) { const m = d.y.reduce((s, v) => s + v, 0) / d.n; const sse = d.y.reduce((s, v) => s + (v - m) ** 2, 0); return d.n * Math.log(sse / d.n) + 2; }
  const s = subset(d, Array.from({ length: d.n }, (_, i) => i), cols);
  return ols(s.X, s.y, s.n, s.p, s.names).metrics.aic!;
}
function mutualInfo(x: ArrayLike<number>, y: ArrayLike<number>, bins = 10) {
  const n = x.length; const rank = (a: ArrayLike<number>) => { const o = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i] - a[j]); const r = new Int32Array(n); o.forEach((i, k) => (r[i] = Math.min(bins - 1, Math.floor((k * bins) / n)))); return r; };
  const bx = rank(x), by = rank(y); const J = new Float64Array(bins * bins), px = new Float64Array(bins), py = new Float64Array(bins);
  for (let i = 0; i < n; i++) { J[bx[i] * bins + by[i]]++; px[bx[i]]++; py[by[i]]++; }
  let mi = 0; for (let a = 0; a < bins; a++) for (let b = 0; b < bins; b++) { const pj = J[a * bins + b] / n; if (pj > 0) mi += pj * Math.log(pj / ((px[a] / n) * (py[b] / n))); }
  return mi;
}
const corr = (d: Dataset, j: number, y?: ArrayLike<number>) => {
  const a = Float64Array.from({ length: d.n }, (_, i) => d.X[i * d.p + j]); const b = y ?? d.y;
  let ma = 0, mb = 0; for (let i = 0; i < d.n; i++) { ma += a[i]; mb += b[i]; } ma /= d.n; mb /= d.n;
  let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < d.n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
};

export function selectFeatures(d: Dataset, method: string, opts: { threshold?: number; nFeatures?: number; algorithm?: Algo } = {}): SelectionResult {
  const all = Array.from({ length: d.p }, (_, j) => j); const log: string[] = [];
  const nm = (j: number) => d.names[j];
  switch (method) {
    case 'correlation': {
      const thr = opts.threshold ?? 0.85; const ry = all.map((j) => Math.abs(corr(d, j)));
      const keep = new Set(all);
      for (const a of all) for (const b of all) if (a < b && keep.has(a) && keep.has(b)) {
        const colB = Float64Array.from({ length: d.n }, (_, i) => d.X[i * d.p + b]); const r = Math.abs(corr(d, a, colB));
        if (r > thr) { const drop = ry[a] >= ry[b] ? b : a; keep.delete(drop); log.push(`|r(${nm(a)}, ${nm(b)})| = ${r.toFixed(2)} > ${thr} → drop ${nm(drop)} (lower |r| with target)`); }
      }
      return { method: 'Correlation filtering', ranking: all.map((j) => ({ name: nm(j), score: ry[j], note: keep.has(j) ? 'kept' : 'dropped' })).sort((a, b) => b.score - a.score), selected: all.filter((j) => keep.has(j)).map(nm), log };
    }
    case 'vif': {
      const thr = opts.threshold ?? 5; let cols = [...all];
      for (;;) {
        if (cols.length < 2) break;
        const s = subset(d, Array.from({ length: d.n }, (_, i) => i), cols); const v = vif(s.X, s.n, s.p);
        const mx = Math.max(...v); if (mx <= thr) break; const k = v.indexOf(mx); log.push(`VIF(${nm(cols[k])}) = ${mx.toFixed(1)} > ${thr} → drop`); cols.splice(k, 1);
      }
      const s = subset(d, Array.from({ length: d.n }, (_, i) => i), cols); const v = vif(s.X, s.n, s.p);
      return { method: `VIF ≤ ${thr}`, ranking: cols.map((j, k) => ({ name: nm(j), score: v[k] })), selected: cols.map(nm), log };
    }
    case 'forward': {
      const sel: number[] = []; let cur = aicOf(d, sel); const rank: SelectionResult['ranking'] = [];
      for (;;) {
        let best = -1, bestA = cur;
        for (const j of all) if (!sel.includes(j)) { try { const a = aicOf(d, [...sel, j]); if (a < bestA - 1e-9) { bestA = a; best = j; } } catch { /* */ } }
        if (best < 0 || (opts.nFeatures && sel.length >= opts.nFeatures)) break;
        log.push(`+ ${nm(best)}: AIC ${cur.toFixed(2)} → ${bestA.toFixed(2)}`); sel.push(best); rank.push({ name: nm(best), score: bestA, note: `step ${sel.length}` }); cur = bestA;
      }
      return { method: 'Forward selection (AIC)', ranking: rank, selected: sel.map(nm), log };
    }
    case 'backward': {
      let cols = [...all]; const alpha = opts.threshold ?? 0.05;
      for (;;) {
        if (!cols.length) break;
        const s = subset(d, Array.from({ length: d.n }, (_, i) => i), cols); const f = ols(s.X, s.y, s.n, s.p, s.names);
        const rows = f.table.slice(1); let worst = -1, wp = alpha;
        rows.forEach((r, k) => { if ((r.p ?? 0) > wp) { wp = r.p!; worst = k; } });
        if (worst < 0) break; log.push(`− ${nm(cols[worst])}: p = ${wp.toFixed(3)} > ${alpha}`); cols.splice(worst, 1);
      }
      let ranking: SelectionResult['ranking'] = [];
      if (cols.length) { const s = subset(d, Array.from({ length: d.n }, (_, i) => i), cols); ranking = ols(s.X, s.y, s.n, s.p, s.names).table.slice(1).map((r) => ({ name: r.name, score: r.p ?? NaN, note: 'p-value' })); }
      return { method: `Backward elimination (p > ${alpha})`, ranking, selected: cols.map(nm), log };
    }
    case 'rfe': {
      let cols = [...all]; const target = opts.nFeatures ?? Math.max(1, Math.ceil(d.p / 2)); const removed: SelectionResult['ranking'] = [];
      while (cols.length > target) {
        const s = subset(d, Array.from({ length: d.n }, (_, i) => i), cols); const { Z } = standardize(s.X, s.n, s.p);
        const f = ols(Z, s.y, s.n, s.p, s.names); const k = f.coefs.map(Math.abs).reduce((b, v, i, a) => (v < a[b] ? i : b), 0);
        log.push(`remove ${nm(cols[k])} (|standardised β| = ${Math.abs(f.coefs[k]).toFixed(3)})`); removed.unshift({ name: nm(cols[k]), score: Math.abs(f.coefs[k]), note: 'eliminated' }); cols.splice(k, 1);
      }
      return { method: `Recursive feature elimination → ${target}`, ranking: [...cols.map((j) => ({ name: nm(j), score: NaN, note: 'kept' })), ...removed], selected: cols.map(nm), log };
    }
    case 'lasso': {
      const lam = cvLambda(d.X, d.y, d.n, d.p, 1, d.depth); const f = elasticNet(d.X, d.y, d.n, d.p, lam, 1);
      log.push(`λ = ${r4(lam)} by 5-fold depth-blocked CV`);
      return { method: 'LASSO (CV λ)', ranking: all.map((j) => ({ name: nm(j), score: Math.abs(f.stdCoefs[j]), note: Math.abs(f.coefs[j]) > 1e-12 ? 'non-zero' : 'zero' })).sort((a, b) => b.score - a.score), selected: all.filter((j) => Math.abs(f.coefs[j]) > 1e-12).map(nm), log };
    }
    case 'mi': {
      const s = all.map((j) => mutualInfo(Float64Array.from({ length: d.n }, (_, i) => d.X[i * d.p + j]), d.y));
      const k = opts.nFeatures ?? Math.max(1, Math.ceil(d.p / 2));
      const order = all.slice().sort((a, b) => s[b] - s[a]);
      log.push('Mutual information estimated with 10 equal-frequency bins (nats).');
      return { method: 'Mutual information', ranking: order.map((j) => ({ name: nm(j), score: s[j] })), selected: order.slice(0, k).map(nm), log };
    }
    case 'rf': {
      const F = randomForest(d.X, d.y, d.n, d.p, { nTrees: 120 }); const k = opts.nFeatures ?? Math.max(1, Math.ceil(d.p / 2));
      const order = all.slice().sort((a, b) => F.importance[b] - F.importance[a]);
      log.push(`Impurity-based importance, 120 trees, OOB R² = ${(F.oobR2 ?? NaN).toFixed(3)}`);
      return { method: 'Random-forest importance', ranking: order.map((j) => ({ name: nm(j), score: F.importance[j] })), selected: order.slice(0, k).map(nm), log };
    }
    case 'permutation': {
      // permutation importance on depth-blocked held-out folds (model: RF unless linear requested)
      const folds = blockFolds(d.depth, 5); const R = rng(9); const drop = new Float64Array(d.p);
      for (const f of folds) {
        const tr = subset(d, f.train), te = subset(d, f.test); if (te.n < 3) continue;
        const useLin = opts.algorithm && !['RandomForest', 'GBT'].includes(opts.algorithm);
        const m = useLin ? fitSub(tr, { algorithm: 'MLR', params: {}, minN: 3, targetLabel: 'y' }) : fitSub(tr, { algorithm: 'RandomForest', params: { nTrees: 80 }, minN: 3, targetLabel: 'y' });
        const base = (X: Float64Array) => { let e = 0; for (let i = 0; i < te.n; i++) e += (te.y[i] - predictSub(m, X, i * te.p)) ** 2; return e / te.n; };
        const b0 = base(te.X);
        for (let j = 0; j < d.p; j++) { const X = new Float64Array(te.X); const perm = Array.from({ length: te.n }, (_, i) => i).sort(() => R() - 0.5); for (let i = 0; i < te.n; i++) X[i * te.p + j] = te.X[perm[i] * te.p + j]; drop[j] += base(X) - b0; }
      }
      const k = opts.nFeatures ?? Math.max(1, Math.ceil(d.p / 2)); const order = all.slice().sort((a, b) => drop[b] - drop[a]);
      log.push('Increase in held-out MSE when each feature is permuted (5 depth-blocked folds).');
      return { method: 'Permutation importance', ranking: order.map((j) => ({ name: nm(j), score: drop[j] / folds.length })), selected: order.filter((j) => drop[j] > 0).slice(0, k).map(nm), log };
    }
    default:
      return { method: 'Manual / all features', ranking: all.map((j) => ({ name: nm(j), score: corr(d, j), note: 'r with target' })), selected: all.map(nm), log };
  }
}

/** Fit global or per-group models. */
export function fitModel(d: Dataset, spec: FitSpec, groupBy: 'global' | 'hfu', groupLabels: Record<number, string>) {
  const subs: SubModel[] = []; const errors: string[] = [];
  if (groupBy === 'global') subs.push(fitSub(d, spec));
  else {
    const groups = [...new Set(Array.from(d.group))].filter((g) => g > 0).sort((a, b) => a - b);
    for (const g of groups) {
      const rows = Array.from(d.group.keys()).filter((i) => d.group[i] === g);
      try { subs.push(fitSub(subset(d, rows), spec, groupLabels[g] ?? `Group ${g}`, g)); }
      catch (e: any) { errors.push(`${groupLabels[g] ?? g}: ${e.message}`); }
    }
    const n0 = Array.from(d.group).filter((g) => g <= 0).length; if (n0) errors.push(`${n0} samples without an HFU/cluster label were excluded from group-wise fitting.`);
  }
  return { subs, errors };
}
