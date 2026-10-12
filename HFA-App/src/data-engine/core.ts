// Core ↔ log integration helpers.
import type { CoreMeta, WellMeta } from '../types';
import { applyOpsArray } from '../depth/transforms';
import { registry, type CoreArrays } from './registry';
import { interpAt, isNum, nearestIndex } from '../util/num';

export function coreDepths(meta: CoreMeta, arr: CoreArrays) {
  return { original: arr.depth, shifted: applyOpsArray(meta.depthOps, arr.depth) };
}

/** Resolve logical names (PHI, K, FACIES) to actual columns. */
export function coreCol(meta: CoreMeta, arr: CoreArrays, name: string): Float64Array | undefined {
  const direct = arr.num.get(name); if (direct) return direct;
  const up = name.toUpperCase();
  if ((up === 'PHI' || up === 'CORE_PHI') && meta.map.phi) return arr.num.get(meta.map.phi);
  if ((up === 'K' || up === 'CORE_K') && meta.map.k) return arr.num.get(meta.map.k);
  return undefined;
}
export function coreNumericNames(meta: CoreMeta, arr?: CoreArrays) {
  const a = arr ?? registry.core(meta.id); if (!a) return [];
  return [...a.num.keys()];
}

/** Log curve values at (shifted) core depths; linear interpolation, gaps > 2·step → NaN. */
export function sampleLogAt(well: WellMeta, mnem: string, depths: Float64Array): Float64Array {
  const d = registry.depth(well.id); const c = registry.curve(well.id, mnem);
  const out = new Float64Array(depths.length).fill(NaN); if (!d || !c) return out;
  const gap = Math.abs(well.step) * 2.01 || Infinity;
  for (let i = 0; i < depths.length; i++) out[i] = interpAt(d, c, depths[i], gap);
  return out;
}

/** Sparse projection of a core column onto the well grid (nearest sample; averaged if several). */
export function projectCoreToGrid(well: WellMeta, depths: Float64Array, values: ArrayLike<number>, maxDist?: number): Float32Array {
  const d = registry.depth(well.id)!; const out = new Float32Array(d.length).fill(NaN); const cnt = new Uint16Array(d.length);
  const tol = maxDist ?? Math.abs(well.step) * 0.75;
  for (let i = 0; i < depths.length; i++) {
    const v = values[i]; if (!isNum(v)) continue;
    const j = nearestIndex(d, depths[i]); if (j < 0 || Math.abs(d[j] - depths[i]) > tol) continue;
    out[j] = cnt[j] ? (out[j] * cnt[j] + v) / (cnt[j] + 1) : v; cnt[j]++;
  }
  return out;
}

/** Most frequent value (for facies). */
export function mode<T>(vals: T[]): T | undefined {
  const m = new Map<T, number>(); let best: T | undefined, bc = 0;
  for (const v of vals) { const c = (m.get(v) ?? 0) + 1; m.set(v, c); if (c > bc) { bc = c; best = v; } }
  return best;
}

import type { CoreColumn, PermUnit, PhiUnit } from '../types';
import { nowIso, uid } from '../util/num';
import { S } from '../store/store';
import { guessPermUnit, guessPhiUnit } from '../petrophysics/units';
import { percentiles, basicStats } from '../util/num';

/** 'Permeability (mD)' → 'mD' */
export const unitFromName = (n: string) => /\(([^)]+)\)\s*$/.exec(n)?.[1] ?? '';

export interface NewCoreInput {
  wellId: string; name: string; source: string; depthUnit: string;
  depth: Float64Array;
  num: Record<string, { data: Float64Array; unit: string }>;
  text: Record<string, string[]>;
  map: CoreMeta['map'];
  phiUnit?: PhiUnit | null; kUnit?: PermUnit | null;
}
/** Register a core dataset (drops rows with missing depth, sorts by depth; reports Before/After N). */
export function createCore(inp: NewCoreInput): { meta: CoreMeta; messages: string[] } {
  const messages: string[] = [];
  const keep: number[] = []; for (let i = 0; i < inp.depth.length; i++) if (isNum(inp.depth[i])) keep.push(i);
  if (keep.length < inp.depth.length) messages.push(`Rows without depth removed — Before: N=${inp.depth.length}, After: N=${keep.length}, Removed: N=${inp.depth.length - keep.length}. Reason: missing depth.`);
  keep.sort((a, b) => inp.depth[a] - inp.depth[b]);
  const depth = Float64Array.from(keep, (i) => inp.depth[i]);
  const num = new Map<string, Float64Array>(); const text = new Map<string, string[]>(); const cols: CoreColumn[] = [];
  for (const [k, v] of Object.entries(inp.num)) { num.set(k, Float64Array.from(keep, (i) => v.data[i])); cols.push({ name: k, unit: v.unit, kind: 'num' }); }
  for (const [k, v] of Object.entries(inp.text)) { text.set(k, keep.map((i) => v[i])); cols.push({ name: k, unit: '', kind: 'text' }); }
  const id = uid('c_');
  registry.putCore(id, { depth, num, text, excluded: new Uint8Array(depth.length) });
  let phiUnit = inp.phiUnit, kUnit = inp.kUnit;
  if (phiUnit === undefined && inp.map.phi) { const a = num.get(inp.map.phi)!; const [p95] = percentiles(a, [95]); const g = guessPhiUnit(inp.num[inp.map.phi].unit || unitFromName(inp.map.phi), p95, basicStats(a).max); phiUnit = g.confident ? g.unit : null; messages.push(`Porosity unit: ${g.unit ?? 'unknown'} (${g.reason})${g.confident ? '' : ' — NOT confirmed; confirm in Core Data before RQI/FZI.'}`); }
  if (kUnit === undefined && inp.map.k) { const g = guessPermUnit(inp.num[inp.map.k].unit || unitFromName(inp.map.k)); kUnit = g.confident ? g.unit : null; messages.push(`Permeability unit: ${g.unit ?? 'unknown'} (${g.reason})${g.confident ? '' : ' — NOT confirmed; confirm in Core Data before RQI/FZI.'}`); }
  const meta: CoreMeta = { id, wellId: inp.wellId, name: inp.name, source: inp.source, n: depth.length, depthUnit: inp.depthUnit, columns: cols, map: inp.map, phiUnit: phiUnit ?? null, kUnit: kUnit ?? null, depthOps: [], filterLog: [] };
  S().upsertCore(meta);
  if (!S().activeCoreId) S().set({ activeCoreId: id });
  S().log(`Loaded core dataset "${inp.name}" (${depth.length} samples) → ${S().wells.find((w) => w.id === inp.wellId)?.name}`);
  void nowIso;
  return { meta, messages };
}

/** Core porosity as a fraction (uses the derived PHI column when RQI/FZI was run, else the mapped column with its confirmed / detected unit). */
export function corePhiFraction(meta: CoreMeta, arr: CoreArrays): { v: Float64Array | null; note: string } {
  const d = arr.num.get('PHI'); if (d) return { v: d, note: 'derived PHI (fraction)' };
  const c = meta.map.phi ? arr.num.get(meta.map.phi) : undefined; if (!c) return { v: null, note: 'no core porosity column mapped' };
  let f = meta.phiUnit === 'percent' ? 0.01 : meta.phiUnit === 'fraction' ? 1 : NaN; let note = `${meta.map.phi} (${meta.phiUnit})`;
  if (!isNum(f)) { let mx = 0; for (const x of c) if (isNum(x) && x > mx) mx = x; f = mx > 1.5 ? 0.01 : 1; note = `${meta.map.phi} (unit not confirmed — ${f === 1 ? 'fraction' : 'percent'} inferred from max ${mx.toFixed(2)})`; }
  return { v: f === 1 ? c : Float64Array.from(c, (x) => x * f), note };
}
export function coreKmD(meta: CoreMeta, arr: CoreArrays): Float64Array | null {
  const d = arr.num.get('K'); if (d) return d;
  const c = meta.map.k ? arr.num.get(meta.map.k) : undefined; if (!c) return null;
  const f = meta.kUnit === 'D' ? 1000 : meta.kUnit === 'um2' ? 1013.25 : meta.kUnit === 'm2' ? 1.01325e15 : 1; return f === 1 ? c : Float64Array.from(c, (x) => x * f);
}
