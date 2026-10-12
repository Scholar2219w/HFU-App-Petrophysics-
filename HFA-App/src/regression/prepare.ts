// Main-thread dataset assembly for regression / validation / prediction.
import { S } from '../store/store';
import { registry } from '../data-engine/registry';
import { coreDepths, sampleLogAt } from '../data-engine/core';
import { resolveMnem } from '../visualization/LogViewer';
import type { Dataset } from './engine';
import { isNum } from '../util/num';
import { inZone } from '../data-engine/zones';

export interface DatasetSpec {
  domain: 'core' | 'log';
  coreIds: string[];            // core domain
  wellIds: string[];            // log domain
  target: string;               // core: FZI|RQI|K|PHI|HFU|<col> ; log: curve
  targetLog: boolean;           // model log10(target)
  features: string[];           // 'GR' or 'LOG10(RT)'
  interval?: [number, number] | null;
  hfuSetId?: string;            // group labels
  groups?: number[];            // restrict to these groups (empty = all)
  zone?: string;                // formation / zone filter
}

export const featBase = (f: string) => (f.startsWith('LOG10(') ? f.slice(6, -1) : f);
export const featIsLog = (f: string) => f.startsWith('LOG10(');
export const targetLabel = (s: DatasetSpec) => (s.target === 'HFU' ? 'HFU class' : s.targetLog ? `log10(${s.target})` : s.target);

const LEAK_RE = /(_CORE$|_PRED$|^FZI|^RQI|^PHIZ|^HFU|^CLUSTER|^LOG_FZI|^LOG_RQI|^LOG_K|^K_FZI)/i;
export function leakageWarnings(spec: DatasetSpec): string[] {
  const w: string[] = [];
  const bad = spec.features.map(featBase).filter((f) => LEAK_RE.test(f));
  if (bad.length) w.push(`Train/test leakage risk: predictor(s) ${bad.join(', ')} are derived from core FZI/RQI/K, from HFU labels or from previous predictions of the target.`);
  if (spec.target !== 'HFU' && spec.features.map(featBase).some((f) => f.toUpperCase() === spec.target.toUpperCase())) w.push('Target is also used as a predictor.');
  return w;
}

export interface Built { ds: Dataset; before: number; dropped: Record<string, number>; groupLabels: Record<number, string>; rowRef: { kind: 'core' | 'log'; id: string; row: number }[]; missingPct: number }

export function buildDataset(spec: DatasetSpec): Built {
  const st = S();
  const hs = spec.hfuSetId ? st.hfuSets.find((h) => h.id === spec.hfuSetId) : undefined;
  const groupLabels: Record<number, string> = {}; hs?.units.forEach((u) => (groupLabels[u.id] = u.label));
  const rowsX: number[][] = []; const ys: number[] = []; const ds: number[] = []; const wl: number[] = []; const gl: number[] = []; const refs: Built['rowRef'] = [];
  const wellNames: string[] = []; const dropped: Record<string, number> = { 'outside scope (reservoir/zone)': 0, 'missing target': 0, 'missing predictor': 0, 'outside interval': 0, 'group filter': 0, 'excluded core sample': 0, 'non-positive under log10': 0 };
  let before = 0;
  const push = (x: number[], y: number, d: number, wi: number, g: number, ref: Built['rowRef'][number], wellId?: string) => {
    before++;
    if (spec.zone && wellId && !inZone(wellId, spec.zone, d)) { dropped['outside scope (reservoir/zone)']++; return; }
    if (spec.interval && (d < spec.interval[0] || d > spec.interval[1])) { dropped['outside interval']++; return; }
    if (spec.groups?.length && !spec.groups.includes(g)) { dropped['group filter']++; return; }
    if (!isNum(y)) { dropped['missing target']++; return; }
    if (spec.targetLog && !(y > 0)) { dropped['non-positive under log10']++; return; }
    if (x.some((v) => !isNum(v))) { dropped['missing predictor']++; return; }
    rowsX.push(x); ys.push(spec.targetLog ? Math.log10(y) : y); ds.push(d); wl.push(wi); gl.push(g); refs.push(ref);
  };
  const featVals = (vals: number[], f: string) => vals.map((v) => (featIsLog(f) ? (v > 0 ? Math.log10(v) : NaN) : v));
  if (spec.domain === 'core') {
    for (const cid of spec.coreIds) {
      const meta = st.cores.find((c) => c.id === cid); const a = registry.core(cid); if (!meta || !a) continue;
      const well = st.wells.find((w) => w.id === meta.wellId); if (!well) continue;
      const wi = wellNames.push(well.name) - 1; const { shifted } = coreDepths(meta, a);
      const fcols = spec.features.map((f) => { const b = featBase(f); const m = resolveMnem(well, b); if (!m) throw new Error(`Predictor ${b} not found in well ${well.name}.`); return sampleLogAt(well, m, shifted); });
      const tcol = spec.target === 'HFU' ? null : a.num.get(spec.target); if (spec.target !== 'HFU' && !tcol) throw new Error(`Target ${spec.target} not available in core "${meta.name}" — run RQI/FZI first.`);
      const labels = hs && hs.domain === 'core' && hs.coreId === cid ? hs.labels : undefined;
      if ((spec.target === 'HFU' || spec.hfuSetId) && !labels && hs) throw new Error(`HFU set "${hs.name}" does not belong to core dataset "${meta.name}".`);
      for (let i = 0; i < meta.n; i++) {
        if (a.excluded[i]) { before++; dropped['excluded core sample']++; continue; }
        const g = labels?.[i] ?? 0;
        push(spec.features.map((f, j) => featVals([fcols[j][i]], f)[0]), spec.target === 'HFU' ? (g > 0 ? g : NaN) : tcol![i], shifted[i], wi, g, { kind: 'core', id: cid, row: i }, well.id);
      }
    }
  } else {
    for (const wid of spec.wellIds) {
      const well = st.wells.find((w) => w.id === wid); if (!well) continue; const wi = wellNames.push(well.name) - 1;
      const d = registry.depth(wid)!; const cols = spec.features.map((f) => { const m = resolveMnem(well, featBase(f)); const c = m && registry.curve(wid, m); if (!c) throw new Error(`Predictor ${featBase(f)} not available in ${well.name}.`); return c; });
      const tMn = spec.target === 'HFU' ? null : resolveMnem(well, spec.target); const t = tMn ? registry.curve(wid, tMn) : null; if (spec.target !== 'HFU' && !t) throw new Error(`Target curve ${spec.target} not available in ${well.name}.`);
      const g = hs?.curve && hs.wellId === wid ? registry.curve(wid, hs.curve) : hs ? registry.curve(wid, 'HFU_PRED') : undefined;
      for (let i = 0; i < d.length; i++) { const gi = g && isNum(g[i]) ? g[i] : 0; push(spec.features.map((f, j) => featVals([cols[j][i]], f)[0]), spec.target === 'HFU' ? (gi > 0 ? gi : NaN) : t![i], d[i], wi, gi, { kind: 'log', id: wid, row: i }, wid); }
    }
  }
  const n = rowsX.length, p = spec.features.length; const X = new Float64Array(n * p);
  rowsX.forEach((r, i) => r.forEach((v, j) => (X[i * p + j] = v)));
  const ds2: Dataset = { X, y: Float64Array.from(ys), n, p, names: spec.features, depth: Float64Array.from(ds), well: Int32Array.from(wl), group: Int32Array.from(gl), wellNames };
  return { ds: ds2, before, dropped, groupLabels, rowRef: refs, missingPct: before ? (100 * (dropped['missing target'] + dropped['missing predictor'])) / before : 0 };
}

export function cloneDs(d: Dataset): Dataset { return { ...d, X: new Float64Array(d.X), y: new Float64Array(d.y), depth: new Float64Array(d.depth), well: new Int32Array(d.well), group: new Int32Array(d.group) }; }
export const dsTransfer = (d: Dataset) => [d.X.buffer, d.y.buffer, d.depth.buffer, d.well.buffer, d.group.buffer];
