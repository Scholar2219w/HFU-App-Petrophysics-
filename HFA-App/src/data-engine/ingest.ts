// Normalization: ParsedLog → canonical Well model (depth Float64 + Float32 curves).
import { categorize, familyOf, FAMILIES } from '../curves/catalog';
import type { CalcInfo, CurveMeta, SourceFile, WellMeta } from '../types';
import { fullStats, interpAt, nowIso, PALETTE, uid } from '../util/num';
import type { ParsedLog } from '../parsers/types';
import { registry } from './registry';
import { S } from '../store/store';

export function curveMetaFor(mnemonic: string, unit: string, description: string, data: Float32Array, source: string, calc?: CalcInfo, discrete = false): CurveMeta {
  const aliases = S().aliases;
  const fam = familyOf(mnemonic, aliases);
  return {
    mnemonic, unit, description: description || (fam ? FAMILIES[fam]?.label ?? '' : ''),
    category: calc && calc.kind !== 'resample' && !(fam && ['HFU'].includes(fam)) ? (discrete ? 'HFU' : 'Calculated') : categorize(mnemonic, unit, aliases),
    family: fam, source, stats: fullStats(data), calc, discrete,
  };
}

function medianStep(d: Float64Array) {
  const n = Math.min(d.length - 1, 5000); if (n < 1) return 0;
  const s: number[] = []; const stride = Math.max(1, Math.floor((d.length - 1) / n));
  for (let i = 0; i + 1 < d.length; i += stride) s.push(d[i + 1] - d[i]);
  s.sort((a, b) => a - b); return s[Math.floor(s.length / 2)];
}

/** Sort by depth if not monotonic (stable). Returns permutation or null. */
function sortPermutation(d: Float64Array): Uint32Array | null {
  for (let i = 1; i < d.length; i++) if (d[i] < d[i - 1]) {
    const idx = new Uint32Array(d.length); for (let k = 0; k < idx.length; k++) idx[k] = k;
    const arr = Array.from(idx).sort((a, b) => d[a] - d[b] || a - b);
    return Uint32Array.from(arr);
  }
  return null;
}

export interface IngestResult { wellId: string; added: string[]; renamed: string[]; warnings: string[] }

export function ingestLog(p: ParsedLog, target: { mode: 'new' } | { mode: 'merge'; wellId: string }): IngestResult {
  const warnings = [...p.warnings];
  // drop rows with NaN depth
  let depth = p.depth; let curves = p.curves;
  let nanD = 0; for (let i = 0; i < depth.length; i++) if (depth[i] !== depth[i]) nanD++;
  if (nanD) {
    const keep: number[] = []; for (let i = 0; i < depth.length; i++) if (depth[i] === depth[i]) keep.push(i);
    depth = Float64Array.from(keep, (i) => p.depth[i]);
    curves = curves.map((c) => ({ ...c, data: Float32Array.from(keep, (i) => c.data[i]) }));
    warnings.push(`${nanD} samples with missing depth were removed (Before N=${p.depth.length}, After N=${depth.length}).`);
  }
  const perm = sortPermutation(depth);
  if (perm) {
    depth = Float64Array.from(perm, (i) => depth[i]);
    curves = curves.map((c) => ({ ...c, data: Float32Array.from(perm, (i) => c.data[i]) }));
    warnings.push('Depth index was not monotonic; samples were sorted by depth.');
  }
  const step = medianStep(depth);
  let regular = true;
  for (let i = 1; i < depth.length && regular; i += Math.max(1, Math.floor(depth.length / 2000))) if (Math.abs(depth[i] - depth[i - 1] - step) > Math.abs(step) * 0.02 + 1e-6) regular = false;
  const src: SourceFile = {
    name: p.fileName, size: p.fileSize, format: p.format, importedAt: nowIso(), lasVersion: p.lasVersion, nullValue: p.nullValue,
    curves: curves.map((c) => c.mnemonic), depthStart: depth[0], depthStop: depth[depth.length - 1], step, nSamples: depth.length,
  };
  const added: string[] = []; const renamed: string[] = [];
  const st = S();

  if (target.mode === 'new') {
    const id = uid('w_');
    registry.putWell(id, depth);
    const metas: CurveMeta[] = [];
    const used = new Set<string>();
    for (const c of curves) {
      let m = c.mnemonic.trim() || 'CURVE'; if (used.has(m)) { let k = 2; while (used.has(`${m}_${k}`)) k++; renamed.push(`${m}→${m}_${k}`); m = `${m}_${k}`; }
      used.add(m); registry.setCurve(id, m, c.data);
      metas.push(curveMetaFor(m, c.unit, c.description, c.data, p.fileName)); added.push(m);
    }
    const w: WellMeta = {
      id, name: p.wellName.trim() || p.fileName, uwi: p.uwi, field: p.field, depthUnit: p.depthUnit || 'm',
      start: depth[0], stop: depth[depth.length - 1], step, regular, nSamples: depth.length, curves: metas, sources: [src],
      header: p.header, color: PALETTE[st.wells.length % PALETTE.length],
    };
    st.upsertWell(w);
    if (!st.activeWellId) st.set({ activeWellId: id });
    return { wellId: id, added, renamed, warnings };
  }

  // merge into existing well: resample onto the well's reference grid
  const w = st.wells.find((x) => x.id === target.wellId)!;
  const ref = registry.depth(w.id)!;
  if (p.depthUnit && w.depthUnit && p.depthUnit.toLowerCase() !== w.depthUnit.toLowerCase()) {
    throw new Error(`Depth units differ: file uses "${p.depthUnit}", well "${w.name}" uses "${w.depthUnit}". Convert before merging.`);
  }
  const same = ref.length === depth.length && Math.abs(ref[0] - depth[0]) < 1e-4 && Math.abs(ref[ref.length - 1] - depth[depth.length - 1]) < 1e-4;
  const existing = new Set(w.curves.map((c) => c.mnemonic));
  const newMetas: CurveMeta[] = [];
  let outside = 0;
  if (!same) {
    for (let i = 0; i < depth.length; i++) if (depth[i] < ref[0] || depth[i] > ref[ref.length - 1]) outside++;
    warnings.push(`Resampled from ${depth.length} samples (step ${step.toFixed(4)}) onto well grid (${ref.length} samples, step ${w.step.toFixed(4)}) by linear interpolation; gaps > 2 steps left missing.`);
    if (outside) warnings.push(`${outside} samples outside the well's reference depth range (${ref[0].toFixed(2)}–${ref[ref.length - 1].toFixed(2)}) were not merged.`);
  }
  for (const c of curves) {
    let m = c.mnemonic.trim() || 'CURVE';
    if (existing.has(m)) { let k = 2; while (existing.has(`${m}_${k}`)) k++; renamed.push(`${m}→${m}_${k}`); m = `${m}_${k}`; }
    existing.add(m);
    let data = c.data;
    if (!same) {
      data = new Float32Array(ref.length);
      const gap = Math.abs(step) * 2.01;
      for (let i = 0; i < ref.length; i++) data[i] = interpAt(depth, c.data, ref[i], gap);
    }
    registry.setCurve(w.id, m, data);
    newMetas.push(curveMetaFor(m, c.unit, c.description, data, p.fileName, same ? undefined : { kind: 'resample', formula: 'linear interpolation onto well grid', inputs: [c.mnemonic], units: c.unit, version: 1, missing: 'gaps > 2×source step → missing', createdAt: nowIso() }));
    added.push(m);
  }
  st.updateWell(w.id, (x) => ({ ...x, curves: [...x.curves, ...newMetas], sources: [...x.sources, { ...src, note: same ? 'same grid' : 'resampled to well grid' }], header: [...x.header, ...p.header.map((h) => ({ ...h, section: `${p.fileName}:${h.section}` }))] }));
  return { wellId: w.id, added, renamed, warnings };
}

/** Add / replace a calculated curve on a well (single canonical array). */
export function putCalculatedCurve(wellId: string, mnem: string, data: Float32Array, unit: string, description: string, calc: CalcInfo, discrete = false) {
  registry.setCurve(wellId, mnem, data);
  const prev = S().wells.find((w) => w.id === wellId)?.curves.find((c) => c.mnemonic === mnem);
  const version = prev?.calc ? (prev.calc.version || 1) + 1 : calc.version || 1;
  S().upsertCurveMeta(wellId, curveMetaFor(mnem, unit, description, data, calc.kind === 'prediction' ? 'predicted' : 'calculated', { ...calc, version }, discrete));
  S().bump();
}

export function refreshCurveStats(wellId: string, mnem: string) {
  const d = registry.curve(wellId, mnem); if (!d) return;
  S().updateWell(wellId, (w) => ({ ...w, curves: w.curves.map((c) => (c.mnemonic === mnem ? { ...c, stats: fullStats(d) } : c)) }));
}
