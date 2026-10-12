// Clustering algorithms (pure functions, run inside the analysis worker).
// X is row-major Float64Array n×d with no missing values (rows filtered upstream).

export type Scaling = 'none' | 'standard' | 'minmax' | 'robust' | 'log';

export interface ScaleParams { method: Scaling; a: number[]; b: number[]; logCols: boolean[] }

export function rng(seed = 42) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** Scale columns. 'log' = log10 on strictly positive columns, then standardize. */
export function scaleMatrix(X: Float64Array, n: number, d: number, method: Scaling, logMask?: boolean[]): { Z: Float64Array; params: ScaleParams } {
  const Z = new Float64Array(X);
  const logCols = new Array(d).fill(false);
  if (method === 'log') {
    for (let j = 0; j < d; j++) {
      let pos = true; for (let i = 0; i < n; i++) if (!(X[i * d + j] > 0)) { pos = false; break; }
      if (pos && (logMask ? logMask[j] : true)) { logCols[j] = true; for (let i = 0; i < n; i++) Z[i * d + j] = Math.log10(X[i * d + j]); }
    }
  }
  const a = new Array(d).fill(0), b = new Array(d).fill(1);
  for (let j = 0; j < d; j++) {
    const col = new Float64Array(n); for (let i = 0; i < n; i++) col[i] = Z[i * d + j];
    if (method === 'standard' || method === 'log') {
      let m = 0; for (let i = 0; i < n; i++) m += col[i]; m /= n;
      let v = 0; for (let i = 0; i < n; i++) v += (col[i] - m) ** 2; const sd = Math.sqrt(v / Math.max(1, n - 1)) || 1;
      a[j] = m; b[j] = sd;
    } else if (method === 'minmax') {
      let mn = Infinity, mx = -Infinity; for (let i = 0; i < n; i++) { if (col[i] < mn) mn = col[i]; if (col[i] > mx) mx = col[i]; }
      a[j] = mn; b[j] = mx - mn || 1;
    } else if (method === 'robust') {
      const s = Float64Array.from(col).sort(); const q = (p: number) => s[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
      a[j] = q(0.5); b[j] = q(0.75) - q(0.25) || 1;
    }
    if (method !== 'none') for (let i = 0; i < n; i++) Z[i * d + j] = (Z[i * d + j] - a[j]) / b[j];
  }
  return { Z, params: { method, a, b, logCols } };
}

const dist2 = (Z: Float64Array, i: number, C: Float64Array, c: number, d: number) => {
  let s = 0; for (let j = 0; j < d; j++) { const t = Z[i * d + j] - C[c * d + j]; s += t * t; } return s;
};

export interface ClusterResult { labels: Int32Array; k: number; centroids?: Float64Array; inertia?: number; prob?: Float64Array; bic?: number; noise?: number; notes: string[] }

export function kmeans(Z: Float64Array, n: number, d: number, k: number, nInit = 8, maxIter = 200, seed = 7): ClusterResult {
  let best: ClusterResult | null = null;
  const R = rng(seed);
  for (let run = 0; run < nInit; run++) {
    // k-means++ init
    const C = new Float64Array(k * d);
    const first = Math.floor(R() * n); for (let j = 0; j < d; j++) C[j] = Z[first * d + j];
    const D = new Float64Array(n).fill(Infinity);
    for (let c = 1; c < k; c++) {
      let tot = 0; for (let i = 0; i < n; i++) { const v = dist2(Z, i, C, c - 1, d); if (v < D[i]) D[i] = v; tot += D[i]; }
      let r = R() * tot, pick = n - 1; for (let i = 0; i < n; i++) { r -= D[i]; if (r <= 0) { pick = i; break; } }
      for (let j = 0; j < d; j++) C[c * d + j] = Z[pick * d + j];
    }
    const L = new Int32Array(n); let inertia = 0;
    for (let it = 0; it < maxIter; it++) {
      let changed = 0; inertia = 0;
      for (let i = 0; i < n; i++) {
        let bc = 0, bd = Infinity; for (let c = 0; c < k; c++) { const v = dist2(Z, i, C, c, d); if (v < bd) { bd = v; bc = c; } }
        if (L[i] !== bc || it === 0) { changed++; L[i] = bc; } inertia += bd;
      }
      const S = new Float64Array(k * d), N = new Float64Array(k);
      for (let i = 0; i < n; i++) { N[L[i]]++; for (let j = 0; j < d; j++) S[L[i] * d + j] += Z[i * d + j]; }
      for (let c = 0; c < k; c++) if (N[c]) for (let j = 0; j < d; j++) C[c * d + j] = S[c * d + j] / N[c];
      else { const p = Math.floor(R() * n); for (let j = 0; j < d; j++) C[c * d + j] = Z[p * d + j]; }
      if (!changed && it > 0) break;
    }
    if (!best || inertia < best.inertia!) best = { labels: L, k, centroids: C, inertia, notes: [] };
  }
  best!.notes.push(`K-Means (k-means++ init, ${nInit} restarts, best inertia kept).`);
  return best!;
}

// ── Gaussian Mixture (full covariance, EM) ──
function cholesky(A: number[][]): number[][] | null {
  const n = A.length; const L = A.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    if (i === j) { if (s <= 0) return null; L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
  }
  return L;
}
export function gmm(Z: Float64Array, n: number, d: number, k: number, maxIter = 200, seed = 7): ClusterResult {
  const init = kmeans(Z, n, d, k, 4, 100, seed);
  const mu = Array.from({ length: k }, (_, c) => Array.from({ length: d }, (_, j) => init.centroids![c * d + j]));
  const cov: number[][][] = []; const w = new Array(k).fill(1 / k);
  const reg = 1e-6;
  for (let c = 0; c < k; c++) {
    const S = Array.from({ length: d }, () => new Array(d).fill(0)); let cnt = 0;
    for (let i = 0; i < n; i++) if (init.labels[i] === c) { cnt++; for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) S[a][b] += (Z[i * d + a] - mu[c][a]) * (Z[i * d + b] - mu[c][b]); }
    for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) S[a][b] = S[a][b] / Math.max(1, cnt) + (a === b ? reg + 1e-3 : 0);
    cov.push(S); w[c] = Math.max(cnt, 1) / n;
  }
  const Rsp = new Float64Array(n * k); let ll = -Infinity; let prevLL = -Infinity;
  for (let it = 0; it < maxIter; it++) {
    // E step
    const Ls = cov.map((S) => cholesky(S) ?? cholesky(S.map((r, i) => r.map((v, j) => v + (i === j ? 1e-2 : 0))))!);
    const logdet = Ls.map((L) => 2 * L.reduce((s, r, i) => s + Math.log(r[i]), 0));
    ll = 0;
    const tmp = new Float64Array(d);
    for (let i = 0; i < n; i++) {
      let mx = -Infinity;
      for (let c = 0; c < k; c++) {
        const L = Ls[c];
        for (let a = 0; a < d; a++) { let s = Z[i * d + a] - mu[c][a]; for (let b = 0; b < a; b++) s -= L[a][b] * tmp[b]; tmp[a] = s / L[a][a]; }
        let m2 = 0; for (let a = 0; a < d; a++) m2 += tmp[a] * tmp[a];
        const lp = Math.log(w[c] + 1e-300) - 0.5 * (d * Math.log(2 * Math.PI) + logdet[c] + m2);
        Rsp[i * k + c] = lp; if (lp > mx) mx = lp;
      }
      let s = 0; for (let c = 0; c < k; c++) { Rsp[i * k + c] = Math.exp(Rsp[i * k + c] - mx); s += Rsp[i * k + c]; }
      for (let c = 0; c < k; c++) Rsp[i * k + c] /= s;
      ll += mx + Math.log(s);
    }
    // M step
    for (let c = 0; c < k; c++) {
      let Nc = 0; for (let i = 0; i < n; i++) Nc += Rsp[i * k + c];
      Nc = Math.max(Nc, 1e-9); w[c] = Nc / n;
      for (let a = 0; a < d; a++) { let s = 0; for (let i = 0; i < n; i++) s += Rsp[i * k + c] * Z[i * d + a]; mu[c][a] = s / Nc; }
      for (let a = 0; a < d; a++) for (let b = 0; b <= a; b++) {
        let s = 0; for (let i = 0; i < n; i++) s += Rsp[i * k + c] * (Z[i * d + a] - mu[c][a]) * (Z[i * d + b] - mu[c][b]);
        cov[c][a][b] = cov[c][b][a] = s / Nc + (a === b ? reg : 0);
      }
    }
    if (Math.abs(ll - prevLL) < 1e-6 * Math.abs(ll)) break;
    prevLL = ll;
  }
  const labels = new Int32Array(n); const prob = new Float64Array(n);
  for (let i = 0; i < n; i++) { let bc = 0; for (let c = 1; c < k; c++) if (Rsp[i * k + c] > Rsp[i * k + bc]) bc = c; labels[i] = bc; prob[i] = Rsp[i * k + bc]; }
  const nParams = k - 1 + k * d + (k * d * (d + 1)) / 2;
  const C = new Float64Array(k * d); for (let c = 0; c < k; c++) for (let j = 0; j < d; j++) C[c * d + j] = mu[c][j];
  return { labels, k, centroids: C, prob, bic: -2 * ll + nParams * Math.log(n), notes: [`GMM full covariance, EM from K-Means init; log-likelihood ${ll.toFixed(2)}.`] };
}

// ── Agglomerative / hierarchical (Lance–Williams) ──
export type Linkage = 'ward' | 'single' | 'complete' | 'average';
export const MAX_HIER_N = 2500;
export function agglomerative(Z: Float64Array, n: number, d: number, k: number, linkage: Linkage): ClusterResult {
  if (n > MAX_HIER_N) throw new Error(`Hierarchical clustering is O(n²) in memory; ${n} samples exceeds the ${MAX_HIER_N} limit. Use K-Means/GMM or restrict the interval.`);
  const D = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { let s = 0; for (let a = 0; a < d; a++) { const t = Z[i * d + a] - Z[j * d + a]; s += t * t; } D[i * n + j] = D[j * n + i] = linkage === 'ward' ? s : Math.sqrt(s); }
  const size = new Int32Array(n).fill(1); const active = new Uint8Array(n).fill(1);
  const parent = new Int32Array(n); for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  // nearest-neighbour cache
  const nn = new Int32Array(n), nd = new Float64Array(n);
  const upd = (i: number) => { let b = -1, bd = Infinity; for (let j = 0; j < n; j++) if (j !== i && active[j] && D[i * n + j] < bd) { bd = D[i * n + j]; b = j; } nn[i] = b; nd[i] = bd; };
  for (let i = 0; i < n; i++) upd(i);
  let clusters = n; const heights: number[] = [];
  while (clusters > k) {
    let a = -1, bd = Infinity; for (let i = 0; i < n; i++) if (active[i] && nd[i] < bd) { bd = nd[i]; a = i; }
    const b = nn[a]; heights.push(bd);
    // merge b into a
    for (let j = 0; j < n; j++) if (active[j] && j !== a && j !== b) {
      const dai = D[a * n + j], dbi = D[b * n + j], dab = D[a * n + b];
      let v: number;
      if (linkage === 'single') v = Math.min(dai, dbi);
      else if (linkage === 'complete') v = Math.max(dai, dbi);
      else if (linkage === 'average') v = (size[a] * dai + size[b] * dbi) / (size[a] + size[b]);
      else { const s = size[a] + size[b] + size[j]; v = ((size[a] + size[j]) * dai + (size[b] + size[j]) * dbi - size[j] * dab) / s; }
      D[a * n + j] = D[j * n + a] = v;
    }
    size[a] += size[b]; active[b] = 0; parent[b] = a; clusters--;
    for (let i = 0; i < n; i++) if (active[i] && (i === a || nn[i] === a || nn[i] === b)) upd(i);
    for (let i = 0; i < n; i++) if (active[i] && i !== a && D[i * n + a] < nd[i]) { nd[i] = D[i * n + a]; nn[i] = a; }
  }
  const roots = new Map<number, number>(); const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) { const r = find(i); if (!roots.has(r)) roots.set(r, roots.size); labels[i] = roots.get(r)!; }
  return { labels, k, notes: [`Agglomerative clustering, ${linkage} linkage${linkage === 'ward' ? ' (squared Euclidean, Lance–Williams)' : ''}.`] };
}

// ── DBSCAN ──
export function dbscan(Z: Float64Array, n: number, d: number, eps: number, minPts: number): ClusterResult {
  if (n > 30000) throw new Error(`DBSCAN (brute-force neighbours) limited to 30,000 samples; got ${n}.`);
  const e2 = eps * eps; const labels = new Int32Array(n).fill(-2); // -2 unvisited, -1 noise
  const neigh = (i: number) => { const out: number[] = []; for (let j = 0; j < n; j++) { let s = 0; for (let a = 0; a < d; a++) { const t = Z[i * d + a] - Z[j * d + a]; s += t * t; if (s > e2) break; } if (s <= e2) out.push(j); } return out; };
  let c = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -2) continue;
    const N = neigh(i); if (N.length < minPts) { labels[i] = -1; continue; }
    labels[i] = c; const q = [...N];
    for (let t = 0; t < q.length; t++) {
      const j = q[t]; if (labels[j] === -1) labels[j] = c; if (labels[j] !== -2) continue;
      labels[j] = c; const Nj = neigh(j); if (Nj.length >= minPts) q.push(...Nj);
    }
    c++;
  }
  let noise = 0; for (let i = 0; i < n; i++) if (labels[i] === -1) noise++;
  return { labels, k: c, noise, notes: [`DBSCAN eps=${eps}, minPts=${minPts}: ${c} clusters, ${noise} noise samples (label 0 / unassigned).`] };
}
/** k-distance curve to help pick eps (sorted distance to minPts-th neighbour). */
export function kDistance(Z: Float64Array, n: number, d: number, kk: number, maxN = 3000): number[] {
  const step = Math.max(1, Math.floor(n / maxN)); const out: number[] = [];
  for (let i = 0; i < n; i += step) {
    const ds: number[] = []; for (let j = 0; j < n; j += step) if (j !== i) { let s = 0; for (let a = 0; a < d; a++) { const t = Z[i * d + a] - Z[j * d + a]; s += t * t; } ds.push(s); }
    ds.sort((a, b) => a - b); out.push(Math.sqrt(ds[Math.min(ds.length - 1, kk - 1)] ?? 0));
  }
  return out.sort((a, b) => a - b);
}

// ── internal validity metrics ──
export function clusterMetrics(Z: Float64Array, n: number, d: number, labels: Int32Array, maxSil = 2500) {
  const ks = [...new Set(Array.from(labels).filter((l) => l >= 0))];
  const k = ks.length; const idx = new Map(ks.map((l, i) => [l, i]));
  const C = new Float64Array(k * d), N = new Float64Array(k); const g = new Float64Array(d);
  let m = 0;
  for (let i = 0; i < n; i++) { const l = labels[i]; if (l < 0) continue; m++; const c = idx.get(l)!; N[c]++; for (let j = 0; j < d; j++) { C[c * d + j] += Z[i * d + j]; g[j] += Z[i * d + j]; } }
  for (let c = 0; c < k; c++) for (let j = 0; j < d; j++) C[c * d + j] /= N[c] || 1;
  for (let j = 0; j < d; j++) g[j] /= m || 1;
  let W = 0, B = 0; const sc = new Float64Array(k);
  for (let i = 0; i < n; i++) { const l = labels[i]; if (l < 0) continue; const c = idx.get(l)!; let s = 0; for (let j = 0; j < d; j++) s += (Z[i * d + j] - C[c * d + j]) ** 2; W += s; sc[c] += Math.sqrt(s); }
  for (let c = 0; c < k; c++) { let s = 0; for (let j = 0; j < d; j++) s += (C[c * d + j] - g[j]) ** 2; B += N[c] * s; sc[c] /= N[c] || 1; }
  const ch = k > 1 && m > k ? (B / (k - 1)) / (W / (m - k)) : NaN;
  let db = 0; for (let a = 0; a < k; a++) { let mx = 0; for (let b = 0; b < k; b++) if (a !== b) { let s = 0; for (let j = 0; j < d; j++) s += (C[a * d + j] - C[b * d + j]) ** 2; mx = Math.max(mx, (sc[a] + sc[b]) / Math.sqrt(s)); } db += mx; }
  db = k > 1 ? db / k : NaN;
  // silhouette on (sub)sample
  const step = Math.max(1, Math.ceil(m / maxSil)); const sampleIdx: number[] = [];
  for (let i = 0, c = 0; i < n; i++) if (labels[i] >= 0) { if (c % step === 0) sampleIdx.push(i); c++; }
  let sil = 0, cnt = 0;
  for (const i of sampleIdx) {
    const sums = new Float64Array(k), cn = new Float64Array(k);
    for (const j of sampleIdx) if (j !== i) { let s = 0; for (let a = 0; a < d; a++) s += (Z[i * d + a] - Z[j * d + a]) ** 2; const c = idx.get(labels[j])!; sums[c] += Math.sqrt(s); cn[c]++; }
    const own = idx.get(labels[i])!; if (cn[own] < 1) continue;
    const a = sums[own] / cn[own]; let b = Infinity; for (let c = 0; c < k; c++) if (c !== own && cn[c]) b = Math.min(b, sums[c] / cn[c]);
    if (b < Infinity) { sil += (b - a) / Math.max(a, b); cnt++; }
  }
  return { k, inertia: W, silhouette: cnt ? sil / cnt : NaN, ch, db, silhouetteN: cnt };
}

export type Algorithm = 'kmeans' | 'gmm' | 'ward' | 'agglomerative' | 'dbscan';
export function runCluster(Z: Float64Array, n: number, d: number, algo: Algorithm, p: { k: number; linkage?: Linkage; eps?: number; minPts?: number; seed?: number }): ClusterResult {
  switch (algo) {
    case 'kmeans': return kmeans(Z, n, d, p.k, 8, 200, p.seed ?? 7);
    case 'gmm': return gmm(Z, n, d, p.k, 200, p.seed ?? 7);
    case 'ward': return agglomerative(Z, n, d, p.k, 'ward');
    case 'agglomerative': return agglomerative(Z, n, d, p.k, p.linkage ?? 'average');
    case 'dbscan': return dbscan(Z, n, d, p.eps ?? 0.5, p.minPts ?? 5);
  }
}

export function scanK(Z: Float64Array, n: number, d: number, algo: Algorithm, kMin: number, kMax: number, p: { linkage?: Linkage; seed?: number }) {
  const rows: { k: number; inertia: number; silhouette: number; ch: number; db: number; bic?: number }[] = [];
  for (let k = kMin; k <= kMax; k++) {
    if (k >= n) break;
    const r = runCluster(Z, n, d, algo === 'dbscan' ? 'kmeans' : algo, { k, ...p });
    const m = clusterMetrics(Z, n, d, r.labels);
    rows.push({ k, inertia: m.inertia, silhouette: m.silhouette, ch: m.ch, db: m.db, bic: r.bic });
  }
  return rows;
}

// ── 1-D helpers for FZI-based HFU methods ──
/** Jenks natural breaks on sorted values → k-1 thresholds. O(k·n²), n capped by sampling. */
export function jenks(values: number[], k: number): number[] {
  let v = [...values].sort((a, b) => a - b);
  if (v.length > 1500) { const s = v.length / 1500; v = Array.from({ length: 1500 }, (_, i) => v[Math.floor(i * s)]); }
  const n = v.length; if (k < 2 || n <= k) return [];
  const mat1 = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(0));
  const mat2 = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(Infinity));
  for (let j = 1; j <= k; j++) { mat1[1][j] = 1; mat2[1][j] = 0; }
  for (let l = 2; l <= n; l++) {
    let s1 = 0, s2 = 0, w = 0, vv = 0;
    for (let m = 1; m <= l; m++) {
      const i3 = l - m + 1; const val = v[i3 - 1]; s2 += val * val; s1 += val; w++;
      vv = s2 - (s1 * s1) / w; const i4 = i3 - 1;
      if (i4 !== 0) for (let j = 2; j <= k; j++) if (mat2[l][j] >= vv + mat2[i4][j - 1]) { mat1[l][j] = i3; mat2[l][j] = vv + mat2[i4][j - 1]; }
    }
    mat1[l][1] = 1; mat2[l][1] = vv;
  }
  const breaks: number[] = []; let kk = n;
  for (let j = k; j >= 2; j--) { const id = mat1[kk][j] - 2; breaks.unshift((v[id] + v[id + 1]) / 2); kk = mat1[kk][j] - 1; }
  return breaks;
}

/** Inverse standard normal CDF (Acklam). */
export function probit(p: number) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Normal-probability-plot segmentation of log10(FZI): fit k straight-line
 * segments to (quantile, logFZI) by dynamic programming → k-1 thresholds.
 */
export function probabilityBreaks(logFzi: number[], k: number) {
  const v = [...logFzi].sort((a, b) => a - b); const n = v.length;
  const q = v.map((_, i) => probit((i + 0.5) / n));
  if (n < k * 3) return { breaks: [] as number[], q, v };
  // prefix sums for O(1) segment SSE of linear fit
  const P = (f: (i: number) => number) => { const a = new Float64Array(n + 1); for (let i = 0; i < n; i++) a[i + 1] = a[i] + f(i); return a; };
  const Sx = P((i) => q[i]), Sy = P((i) => v[i]), Sxx = P((i) => q[i] * q[i]), Sxy = P((i) => q[i] * v[i]), Syy = P((i) => v[i] * v[i]);
  const sse = (a: number, b: number) => { // [a,b)
    const m = b - a; if (m < 2) return 0;
    const sx = Sx[b] - Sx[a], sy = Sy[b] - Sy[a], sxx = Sxx[b] - Sxx[a], sxy = Sxy[b] - Sxy[a], syy = Syy[b] - Syy[a];
    const vx = sxx - (sx * sx) / m; if (vx <= 0) return syy - (sy * sy) / m;
    const beta = (sxy - (sx * sy) / m) / vx; return Math.max(0, syy - (sy * sy) / m - beta * (sxy - (sx * sy) / m));
  };
  const minSeg = 3;
  const dp = Array.from({ length: k + 1 }, () => new Float64Array(n + 1).fill(Infinity));
  const arg = Array.from({ length: k + 1 }, () => new Int32Array(n + 1));
  dp[0][0] = 0;
  for (let s = 1; s <= k; s++) for (let e = s * minSeg; e <= n; e++) for (let b = (s - 1) * minSeg; b <= e - minSeg; b++) {
    const c = dp[s - 1][b] + sse(b, e); if (c < dp[s][e]) { dp[s][e] = c; arg[s][e] = b; }
  }
  const cuts: number[] = []; let e = n; for (let s = k; s >= 1; s--) { const b = arg[s][e]; if (s > 1) cuts.unshift(b); e = b; }
  return { breaks: cuts.map((c) => (v[c - 1] + v[c]) / 2), q, v };
}
