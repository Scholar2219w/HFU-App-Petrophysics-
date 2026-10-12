// ─────────────────────────────────────────────────────────────────────────────
// Canonical numerical store. ONE representation per curve (TypedArray).
// The reactive UI store only holds metadata + a version counter.
// Arrays not yet in memory are lazily pulled from IndexedDB on demand.
// ─────────────────────────────────────────────────────────────────────────────
import { idbGet, idbPut, idbDelPrefix } from './idb';

export interface WellArrays { depth: Float64Array; curves: Map<string, Float32Array> }
export interface CoreArrays { depth: Float64Array; num: Map<string, Float64Array>; text: Map<string, string[]>; excluded: Uint8Array }

const wells = new Map<string, WellArrays>();
const cores = new Map<string, CoreArrays>();
const pending = new Map<string, Promise<any>>();
const dirty = new Set<string>();
let projectKey = 'default';
let onLazyLoaded: () => void = () => {};
/** Undo journal: records the value a key had before its first change since the last checkpoint. */
export const journal = { active: true, prev: new Map<string, any>() };
function rec(key: string, prev: any) { if (journal.active && !journal.prev.has(key)) journal.prev.set(key, prev); }

export const registry = {
  setProject(id: string) { projectKey = id; },
  setLazyListener(fn: () => void) { onLazyLoaded = fn; },
  clear() { wells.clear(); cores.clear(); pending.clear(); dirty.clear(); },

  // ── wells ──
  putWell(id: string, depth: Float64Array) {
    rec(`w/${id}`, wells.get(id)); wells.set(id, { depth, curves: new Map() }); dirty.add(`w/${id}/depth`);
  },
  hasWell(id: string) { return wells.has(id); },
  depth(id: string): Float64Array | undefined { return wells.get(id)?.depth; },
  setCurve(wellId: string, mnem: string, data: Float32Array) {
    const w = wells.get(wellId); if (!w) throw new Error(`Well ${wellId} not loaded`);
    if (data.length !== w.depth.length) throw new Error(`Curve ${mnem}: length ${data.length} ≠ depth length ${w.depth.length}`);
    rec(`w/${wellId}/c/${mnem}`, w.curves.get(mnem)); w.curves.set(mnem, data); dirty.add(`w/${wellId}/c/${mnem}`);
  },
  deleteCurve(wellId: string, mnem: string) { rec(`w/${wellId}/c/${mnem}`, wells.get(wellId)?.curves.get(mnem)); wells.get(wellId)?.curves.delete(mnem); dirty.add(`w/${wellId}/c/${mnem}`); },
  renameCurve(wellId: string, a: string, b: string) {
    const w = wells.get(wellId); const d = w?.curves.get(a); if (!w || !d) return;
    w.curves.delete(a); w.curves.set(b, d); dirty.add(`w/${wellId}/c/${a}`); dirty.add(`w/${wellId}/c/${b}`);
  },
  /** synchronous accessor; returns undefined + triggers lazy load when not in memory */
  curve(wellId: string, mnem: string): Float32Array | undefined {
    const w = wells.get(wellId);
    const c = w?.curves.get(mnem);
    if (c) return c;
    this.lazy(`w/${wellId}/c/${mnem}`, (buf) => { const ww = wells.get(wellId); if (ww && buf) ww.curves.set(mnem, new Float32Array(buf)); });
    return undefined;
  },
  async ensureCurves(wellId: string, mnems: string[]): Promise<Record<string, Float32Array>> {
    await this.ensureWell(wellId);
    const out: Record<string, Float32Array> = {};
    for (const m of mnems) {
      let c = wells.get(wellId)?.curves.get(m);
      if (!c) { const buf = await idbGet(`${projectKey}/w/${wellId}/c/${m}`); if (buf) { c = new Float32Array(buf); wells.get(wellId)!.curves.set(m, c); } }
      if (!c) throw new Error(`Curve "${m}" is not available for this well.`);
      out[m] = c;
    }
    return out;
  },
  async ensureWell(wellId: string) {
    if (wells.has(wellId)) return;
    const buf = await idbGet(`${projectKey}/w/${wellId}/depth`);
    if (!buf) throw new Error(`Depth index for well ${wellId} not found in local storage.`);
    wells.set(wellId, { depth: new Float64Array(buf), curves: new Map() });
  },
  lazy(key: string, apply: (buf: ArrayBuffer | undefined) => void) {
    if (pending.has(key)) return;
    const [, wellId] = key.split('/');
    const p = (async () => {
      if (!wells.has(wellId)) { try { await this.ensureWell(wellId); } catch { return; } }
      const buf = await idbGet(`${projectKey}/${key}`);
      apply(buf); onLazyLoaded();
    })().finally(() => setTimeout(() => pending.delete(key), 5000));
    pending.set(key, p);
  },
  loadedCurveNames(wellId: string) { return [...(wells.get(wellId)?.curves.keys() ?? [])]; },
  deleteWell(id: string) { rec(`w/${id}`, wells.get(id)); wells.delete(id); },

  // ── core ──
  putCore(id: string, a: CoreArrays) { cores.set(id, a); dirty.add(`c/${id}`); },
  core(id: string): CoreArrays | undefined { return cores.get(id); },
  touchCore(id: string) { dirty.add(`c/${id}`); },
  async ensureCore(id: string) {
    if (cores.has(id)) return cores.get(id)!;
    const obj = await idbGet(`${projectKey}/c/${id}`);
    if (!obj) throw new Error(`Core dataset ${id} not found in local storage.`);
    const a: CoreArrays = { depth: new Float64Array(obj.depth), num: new Map(Object.entries(obj.num).map(([k, v]: any) => [k, new Float64Array(v)])), text: new Map(Object.entries(obj.text)), excluded: new Uint8Array(obj.excluded) };
    cores.set(id, a); return a;
  },
  deleteCore(id: string) { cores.delete(id); },
  // ── raw access for undo/redo ──
  rawGet(key: string): any { const p = key.split('/'); if (p.length === 2) return wells.get(p[1]); return wells.get(p[1])?.curves.get(p.slice(3).join('/')); },
  rawSet(key: string, v: any) {
    const p = key.split('/');
    if (p.length === 2) { if (v) wells.set(p[1], v); else wells.delete(p[1]); return; }
    const w = wells.get(p[1]); if (!w) return; const m = p.slice(3).join('/');
    if (v) { w.curves.set(m, v); dirty.add(key); } else w.curves.delete(m);
  },
  allCores() { return cores; },
  replaceCores(m: Map<string, CoreArrays>) { cores.clear(); for (const [k, v] of m) { cores.set(k, v); dirty.add(`c/${k}`); } },

  // ── persistence ──
  async flush(projectId = projectKey, all = false) {
    const keys = all ? allKeys() : [...dirty];
    for (const k of keys) {
      const parts = k.split('/');
      if (parts[0] === 'w') {
        const w = wells.get(parts[1]); if (!w) continue;
        if (parts[2] === 'depth') await idbPut(`${projectId}/${k}`, w.depth.buffer.slice(w.depth.byteOffset, w.depth.byteOffset + w.depth.byteLength));
        else { const c = w.curves.get(parts.slice(3).join('/')); if (c) await idbPut(`${projectId}/${k}`, c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength)); }
      } else if (parts[0] === 'c') {
        const c = cores.get(parts[1]); if (!c) continue;
        await idbPut(`${projectId}/${k}`, { depth: c.depth.buffer.slice(0), num: Object.fromEntries([...c.num].map(([n, v]) => [n, v.buffer.slice(0)])), text: Object.fromEntries(c.text), excluded: c.excluded.buffer.slice(0) });
      }
    }
    dirty.clear();
    return keys.length;
  },
  memoryBytes() {
    let b = 0;
    for (const w of wells.values()) { b += w.depth.byteLength; for (const c of w.curves.values()) b += c.byteLength; }
    for (const c of cores.values()) { b += c.depth.byteLength + c.excluded.byteLength; for (const v of c.num.values()) b += v.byteLength; }
    return b;
  },
  /** snapshot used for project export */
  allWellIds() { return [...wells.keys()]; },
  wellArrays(id: string) { return wells.get(id); },
};

function allKeys() {
  const ks: string[] = [];
  for (const [id, w] of wells) { ks.push(`w/${id}/depth`); for (const m of w.curves.keys()) ks.push(`w/${id}/c/${m}`); }
  for (const id of cores.keys()) ks.push(`c/${id}`);
  return ks;
}
