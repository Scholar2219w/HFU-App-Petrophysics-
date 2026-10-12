// Formation / zone helpers (spec §25) and the ANALYSIS SCOPE.
// A zone runs from its top to the next deeper top in the same well (or to TD).
// The global scope (store.zone) is one of:
//   ''              → whole well
//   RESERVOIR_KEY   → all active reservoir intervals of the well (the analyst's reservoir)
//   'RES:<id>'      → one reservoir interval
//   '<formation>'   → one formation zone (top → next top)
import { S } from '../store/store';
import { registry } from './registry';
import type { ReservoirInterval } from '../types';

export interface Zone { name: string; top: number; base: number }
export const RESERVOIR_KEY = '★RESERVOIR';

export function zonesForWell(wellId: string): Zone[] {
  const st = S(); const w = st.wells.find((x) => x.id === wellId);
  const tops = st.tops.filter((t) => t.wellId === wellId).sort((a, b) => a.md - b.md);
  return tops.map((t, i) => ({ name: t.name, top: t.md, base: tops[i + 1]?.md ?? w?.stop ?? t.md }));
}
export function reservoirsForWell(wellId: string, all = false): ReservoirInterval[] {
  return S().reservoirs.filter((r) => r.wellId === wellId && (all || r.active)).sort((a, b) => a.top - b.top);
}
export function allZoneNames(): string[] { return [...new Set(S().tops.map((t) => t.name))]; }

/** Depth intervals [top, base) covered by a scope key in a well; null when the well has no such scope. */
export function scopeIntervals(wellId: string, zone: string): [number, number][] | null {
  if (!zone) return null;
  if (zone === RESERVOIR_KEY) { const r = reservoirsForWell(wellId); return r.length ? r.map((x) => [x.top, x.base]) : null; }
  if (zone.startsWith('RES:')) { const r = S().reservoirs.find((x) => x.id === zone.slice(4) && x.wellId === wellId); return r ? [[r.top, r.base]] : null; }
  const z = zonesForWell(wellId).find((q) => q.name === zone); return z ? [[z.top, z.base]] : null;
}
/** Legacy single-range accessor (envelope of the scope). */
export function zoneRange(wellId: string, zone: string): [number, number] | null {
  const iv = scopeIntervals(wellId, zone); if (!iv) return null;
  return [Math.min(...iv.map((x) => x[0])), Math.max(...iv.map((x) => x[1]))];
}
export function zoneOf(wellId: string, depth: number): string {
  const zs = zonesForWell(wellId); for (let i = zs.length - 1; i >= 0; i--) if (depth >= zs[i].top) return depth <= zs[i].base ? zs[i].name : ''; return '';
}
export function reservoirOf(wellId: string, depth: number): ReservoirInterval | undefined {
  return reservoirsForWell(wellId).find((r) => depth >= r.top && depth < r.base);
}
const inIv = (iv: [number, number][], d: number) => { for (const [a, b] of iv) if (d >= a && d < b) return true; return false; };

/** 1 where the sample lies in the scope (everywhere when zone is ''). Null when the well has no such scope. */
export function zoneMask(wellId: string, zone: string): Uint8Array | null {
  const d = registry.depth(wellId); if (!d) return null;
  const m = new Uint8Array(d.length);
  if (!zone) { m.fill(1); return m; }
  const iv = scopeIntervals(wellId, zone); if (!iv) return null;
  for (let i = 0; i < d.length; i++) m[i] = inIv(iv, d[i]) ? 1 : 0;
  return m;
}
/** depth-value filter for arbitrary (e.g. core) depths */
export function inZone(wellId: string, zone: string, depth: number) { if (!zone) return true; const iv = scopeIntervals(wellId, zone); return !!iv && inIv(iv, depth); }

export function scopeLabel(zone: string, wellId?: string, short = false): string {
  if (!zone) return 'Whole well';
  if (zone === RESERVOIR_KEY) { const r = wellId ? reservoirsForWell(wellId) : S().reservoirs.filter((x) => x.active); const h = r.reduce((a, x) => a + (x.base - x.top), 0); return short ? `Reservoir · ${r.length} · ${h.toFixed(0)} m` : `Reservoir (${r.length} interval${r.length === 1 ? '' : 's'}, ${h.toFixed(1)} m gross)`; }
  if (zone.startsWith('RES:')) { const r = S().reservoirs.find((x) => x.id === zone.slice(4)); return r ? `Reservoir ${r.name} (${r.top}–${r.base})` : 'Reservoir interval (missing)'; }
  return `Formation ${zone}`;
}

/** Parse a step-flag table (DEPT, FLAG rows: flag switches at each depth — e.g. Techlog RES_FLAG export) into intervals. */
export function flagStepsToIntervals(rows: { d: number; f: number }[]): [number, number][] {
  const r = rows.filter((x) => isFinite(x.d) && isFinite(x.f)).sort((a, b) => a.d - b.d); const out: [number, number][] = [];
  let open: number | null = null;
  for (const x of r) { if (x.f > 0 && open === null) open = x.d; else if (x.f <= 0 && open !== null) { out.push([open, x.d]); open = null; } }
  if (open !== null && r.length) out.push([open, r[r.length - 1].d]);
  return out;
}
/** Intervals where a sampled flag curve is > 0. */
export function curveToIntervals(depth: Float64Array, v: ArrayLike<number>): [number, number][] {
  const out: [number, number][] = []; let open: number | null = null; const step = depth.length > 1 ? Math.abs(depth[1] - depth[0]) : 0;
  for (let i = 0; i < depth.length; i++) { const on = v[i] > 0; if (on && open === null) open = depth[i]; else if (!on && open !== null) { out.push([open, depth[i - 1] + step / 2]); open = null; } }
  if (open !== null) out.push([open, depth[depth.length - 1]]);
  return out;
}
