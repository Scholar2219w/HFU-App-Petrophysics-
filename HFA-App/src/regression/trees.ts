// CART trees, Random Forest (regression & classification) and gradient-boosted
// trees (XGBoost-style second-order-free variant: squared loss, shrinkage,
// row subsampling). Built in-house so everything runs locally in the browser.
import { rng } from '../clustering/core';

export interface Tree { f: number[]; t: number[]; l: number[]; r: number[]; v: number[] } // v = leaf value (or class probs index)
export interface TreeParams { maxDepth: number; minLeaf: number; mtry: number; classes?: number }

function buildTree(X: Float64Array, y: Float64Array, n: number, p: number, idx: Int32Array, prm: TreeParams, R: () => number, imp: Float64Array, cls: boolean): Tree {
  const T: Tree = { f: [], t: [], l: [], r: [], v: [] };
  const K = prm.classes ?? 0;
  const leafVal = (ix: Int32Array) => {
    if (!cls) { let s = 0; for (const i of ix) s += y[i]; return s / ix.length; }
    const c = new Array(K).fill(0); for (const i of ix) c[y[i]]++; let b = 0; for (let k = 1; k < K; k++) if (c[k] > c[b]) b = k; return b;
  };
  const impurity = (sum: number, sq: number, m: number) => sq - (sum * sum) / m;
  const stack: { ix: Int32Array; depth: number; node: number }[] = [];
  const newNode = () => { T.f.push(-1); T.t.push(0); T.l.push(-1); T.r.push(-1); T.v.push(0); return T.f.length - 1; };
  stack.push({ ix: idx, depth: 0, node: newNode() });
  const feats = Array.from({ length: p }, (_, j) => j);
  while (stack.length) {
    const { ix, depth, node } = stack.pop()!;
    const m = ix.length;
    T.v[node] = leafVal(ix);
    if (depth >= prm.maxDepth || m < 2 * prm.minLeaf) continue;
    // candidate features
    for (let j = p - 1; j > 0; j--) { const k = Math.floor(R() * (j + 1)); [feats[j], feats[k]] = [feats[k], feats[j]]; }
    let bestGain = 1e-12, bf = -1, bt = 0;
    let parentImp: number;
    if (!cls) { let s = 0, q = 0; for (const i of ix) { s += y[i]; q += y[i] * y[i]; } parentImp = impurity(s, q, m); }
    else { const c = new Array(K).fill(0); for (const i of ix) c[y[i]]++; parentImp = m - c.reduce((s, v) => s + (v * v) / m, 0); }
    const order = new Int32Array(m);
    for (let fi = 0; fi < Math.min(prm.mtry, p); fi++) {
      const f = feats[fi];
      order.set(ix); const arr = Array.from(order).sort((a, b) => X[a * p + f] - X[b * p + f]);
      if (!cls) {
        let sL = 0, qL = 0, sT = 0, qT = 0; for (const i of arr) { sT += y[i]; qT += y[i] * y[i]; }
        for (let k = 0; k < m - 1; k++) {
          const i = arr[k]; sL += y[i]; qL += y[i] * y[i];
          const xv = X[i * p + f], xn = X[arr[k + 1] * p + f];
          if (k + 1 < prm.minLeaf || m - k - 1 < prm.minLeaf || xv === xn) continue;
          const g = parentImp - impurity(sL, qL, k + 1) - impurity(sT - sL, qT - qL, m - k - 1);
          if (g > bestGain) { bestGain = g; bf = f; bt = (xv + xn) / 2; }
        }
      } else {
        const cL = new Array(K).fill(0), cT = new Array(K).fill(0); for (const i of arr) cT[y[i]]++;
        for (let k = 0; k < m - 1; k++) {
          const i = arr[k]; cL[y[i]]++;
          const xv = X[i * p + f], xn = X[arr[k + 1] * p + f];
          if (k + 1 < prm.minLeaf || m - k - 1 < prm.minLeaf || xv === xn) continue;
          const nL = k + 1, nR = m - nL; let gL = nL, gR = nR;
          for (let c = 0; c < K; c++) { gL -= (cL[c] * cL[c]) / nL; gR -= ((cT[c] - cL[c]) ** 2) / nR; }
          const g = parentImp - gL - gR;
          if (g > bestGain) { bestGain = g; bf = f; bt = (xv + xn) / 2; }
        }
      }
    }
    if (bf < 0) continue;
    imp[bf] += bestGain;
    let nl = 0; for (const i of ix) if (X[i * p + bf] <= bt) nl++;
    const L = new Int32Array(nl), Rr = new Int32Array(m - nl); let a = 0, b = 0;
    for (const i of ix) if (X[i * p + bf] <= bt) L[a++] = i; else Rr[b++] = i;
    T.f[node] = bf; T.t[node] = bt;
    const ln = newNode(), rn = newNode(); T.l[node] = ln; T.r[node] = rn;
    stack.push({ ix: L, depth: depth + 1, node: ln }, { ix: Rr, depth: depth + 1, node: rn });
  }
  return T;
}

export function predictTree(T: Tree, x: ArrayLike<number>, off = 0): number {
  let n = 0; while (T.f[n] >= 0) n = x[off + T.f[n]] <= T.t[n] ? T.l[n] : T.r[n]; return T.v[n];
}

export interface Forest { kind: 'forest' | 'gbt' | 'classifier'; trees: Tree[]; base?: number; lr?: number; classes?: number; importance: number[]; oobR2?: number; oobAcc?: number }

export function randomForest(X: Float64Array, y: Float64Array, n: number, p: number, opts: { nTrees?: number; maxDepth?: number; minLeaf?: number; mtry?: number; seed?: number; classes?: number } = {}): Forest {
  const cls = !!opts.classes;
  const prm: TreeParams = { maxDepth: opts.maxDepth ?? 14, minLeaf: opts.minLeaf ?? (cls ? 1 : 3), mtry: opts.mtry ?? Math.max(1, cls ? Math.round(Math.sqrt(p)) : Math.round(p / 3)), classes: opts.classes };
  const R = rng(opts.seed ?? 11); const imp = new Float64Array(p); const trees: Tree[] = [];
  const nT = opts.nTrees ?? 150;
  const oobSum = new Float64Array(n), oobCnt = new Float64Array(n); const oobVotes = cls ? new Float64Array(n * opts.classes!) : null;
  for (let t = 0; t < nT; t++) {
    const idx = new Int32Array(n); const inBag = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const k = Math.floor(R() * n); idx[i] = k; inBag[k] = 1; }
    const T = buildTree(X, y, n, p, idx, prm, R, imp, cls); trees.push(T);
    for (let i = 0; i < n; i++) if (!inBag[i]) { const v = predictTree(T, X, i * p); if (cls) oobVotes![i * opts.classes! + v]++; else { oobSum[i] += v; oobCnt[i]++; } }
  }
  const tot = imp.reduce((s, v) => s + v, 0) || 1;
  const f: Forest = { kind: cls ? 'classifier' : 'forest', trees, classes: opts.classes, importance: Array.from(imp, (v) => v / tot) };
  if (!cls) {
    let my = 0, m = 0; for (let i = 0; i < n; i++) if (oobCnt[i]) { my += y[i]; m++; } my /= m || 1;
    let sse = 0, sst = 0; for (let i = 0; i < n; i++) if (oobCnt[i]) { sse += (y[i] - oobSum[i] / oobCnt[i]) ** 2; sst += (y[i] - my) ** 2; }
    f.oobR2 = 1 - sse / sst;
  } else {
    let ok = 0, m = 0; for (let i = 0; i < n; i++) { let b = -1, bv = 0; for (let c = 0; c < opts.classes!; c++) if (oobVotes![i * opts.classes! + c] > bv) { bv = oobVotes![i * opts.classes! + c]; b = c; } if (b >= 0) { m++; if (b === y[i]) ok++; } }
    f.oobAcc = m ? ok / m : NaN;
  }
  return f;
}

export function gradientBoost(X: Float64Array, y: Float64Array, n: number, p: number, opts: { nRounds?: number; lr?: number; maxDepth?: number; minLeaf?: number; subsample?: number; seed?: number } = {}): Forest {
  const R = rng(opts.seed ?? 5); const lr = opts.lr ?? 0.08; const nR = opts.nRounds ?? 250;
  const prm: TreeParams = { maxDepth: opts.maxDepth ?? 3, minLeaf: opts.minLeaf ?? 3, mtry: p };
  let base = 0; for (let i = 0; i < n; i++) base += y[i]; base /= n;
  const F = new Float64Array(n).fill(base); const res = new Float64Array(n); const imp = new Float64Array(p); const trees: Tree[] = [];
  const sub = opts.subsample ?? 0.8;
  for (let r = 0; r < nR; r++) {
    for (let i = 0; i < n; i++) res[i] = y[i] - F[i];
    const pick: number[] = []; for (let i = 0; i < n; i++) if (R() < sub) pick.push(i);
    const T = buildTree(X, res, n, p, Int32Array.from(pick.length > prm.minLeaf * 2 ? pick : Array.from({ length: n }, (_, i) => i)), prm, R, imp, false);
    trees.push(T);
    for (let i = 0; i < n; i++) F[i] += lr * predictTree(T, X, i * p);
  }
  const tot = imp.reduce((s, v) => s + v, 0) || 1;
  return { kind: 'gbt', trees, base, lr, importance: Array.from(imp, (v) => v / tot) };
}

export function predictForest(F: Forest, x: ArrayLike<number>, off = 0): number {
  if (F.kind === 'gbt') { let s = F.base!; for (const T of F.trees) s += F.lr! * predictTree(T, x, off); return s; }
  if (F.kind === 'classifier') { const v = new Array(F.classes!).fill(0); for (const T of F.trees) v[predictTree(T, x, off)]++; let b = 0; for (let c = 1; c < v.length; c++) if (v[c] > v[b]) b = c; return b; }
  let s = 0; for (const T of F.trees) s += predictTree(T, x, off); return s / F.trees.length;
}
/** Spread of tree predictions (for RF uncertainty) */
export function forestSpread(F: Forest, x: ArrayLike<number>, off = 0) {
  if (F.kind !== 'forest') return NaN; let s = 0, q = 0; for (const T of F.trees) { const v = predictTree(T, x, off); s += v; q += v * v; } const m = F.trees.length; return Math.sqrt(Math.max(0, q / m - (s / m) ** 2));
}
