/// <reference lib="webworker" />
// Generic compute worker. Two instances are spawned: one for parsing, one for
// analysis, so large imports never block clustering/regression and neither
// blocks the UI thread. Results containing TypedArrays are transferred (zero-copy).
import { parseLAS } from '../parsers/las';
import { readDLISFrame, scanDLIS } from '../parsers/dlis';
import { parseTable, previewTable } from '../parsers/table';
import { clusterMetrics, jenks, kDistance, probabilityBreaks, runCluster, scaleMatrix, scanK } from '../clustering/core';
import { fitModel, predictSub, selectFeatures, spreadSub, validate } from '../regression/engine';
import type { SubModel } from '../types';
import * as XLSX from 'xlsx';
import { parseLIS } from '../parsers/lis';
import { parseParquet } from '../parsers/parquet';

const fns: Record<string, (...a: any[]) => any> = {
  parseLAS, scanDLIS, readDLISFrame, previewTable, parseTable, parseLIS, parseParquet,
  writeXlsx(sheets: { name: string; rows: any[][] }[]) {
    const wb = XLSX.utils.book_new();
    for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name.replace(/[\\/?*\[\]:]/g, '_').slice(0, 31));
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    return new Uint8Array(out);
  },
  jenks, probabilityBreaks,
  cluster(job: { X: Float64Array; n: number; d: number; scaling: any; logMask?: boolean[]; algo: any; params: any }) {
    const { Z, params } = scaleMatrix(job.X, job.n, job.d, job.scaling, job.logMask);
    const r = runCluster(Z, job.n, job.d, job.algo, job.params);
    const m = r.k > 1 ? clusterMetrics(Z, job.n, job.d, r.labels) : null;
    return { labels: r.labels, prob: r.prob, k: r.k, notes: r.notes, bic: r.bic, noise: r.noise, metrics: m, scale: params };
  },
  scanK(job: { X: Float64Array; n: number; d: number; scaling: any; logMask?: boolean[]; algo: any; kMin: number; kMax: number; linkage?: any }) {
    const { Z } = scaleMatrix(job.X, job.n, job.d, job.scaling, job.logMask);
    return scanK(Z, job.n, job.d, job.algo, job.kMin, job.kMax, { linkage: job.linkage });
  },
  kDistance(job: { X: Float64Array; n: number; d: number; scaling: any; k: number }) {
    const { Z } = scaleMatrix(job.X, job.n, job.d, job.scaling); return kDistance(Z, job.n, job.d, job.k);
  },
  fitModel, selectFeatures, validate,
  predictGrid(subs: SubModel[], X: Float64Array, n: number, p: number, group: Int32Array | null) {
    const out = new Float32Array(n).fill(NaN); const spread = new Float32Array(n).fill(NaN);
    const byG = new Map(subs.map((s) => [s.groupId, s]));
    for (let i = 0; i < n; i++) {
      let ok = true; for (let j = 0; j < p; j++) { const v = X[i * p + j]; if (v !== v) { ok = false; break; } }
      if (!ok) continue;
      const m = group ? byG.get(group[i]) : subs[0]; if (!m) continue;
      out[i] = predictSub(m, X, i * p); spread[i] = spreadSub(m, X, i * p);
    }
    return { out, spread };
  },
};

function transferables(x: any, acc: Set<ArrayBuffer>, depth = 0) {
  if (!x || depth > 5) return;
  if (ArrayBuffer.isView(x)) { acc.add(x.buffer as ArrayBuffer); return; }
  if (Array.isArray(x)) { for (const v of x) transferables(v, acc, depth + 1); return; }
  if (typeof x === 'object') for (const k of Object.keys(x)) transferables(x[k], acc, depth + 1);
}

self.onmessage = async (e: MessageEvent) => {
  const { id, fn, args } = e.data;
  try {
    const f = fns[fn]; if (!f) throw new Error(`Unknown worker function ${fn}`);
    const progress = (p: number) => (self as any).postMessage({ id, progress: p });
    const res = await f(...args, ...(fn === 'parseLAS' ? [progress] : []));
    const acc = new Set<ArrayBuffer>(); transferables(res, acc);
    (self as any).postMessage({ id, ok: true, res }, [...acc]);
  } catch (err: any) {
    (self as any).postMessage({ id, ok: false, err: err?.message ?? String(err) });
  }
};
