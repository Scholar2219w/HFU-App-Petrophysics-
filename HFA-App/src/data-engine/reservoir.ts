// Reservoir interval management. The reservoir is the analyst's decision; the app
// only stores it, draws it (RES_FLAG), and uses it as the default analysis scope.
import { S } from '../store/store';
import { registry } from './registry';
import { putCalculatedCurve } from './ingest';
import { RESERVOIR_KEY, reservoirsForWell } from './zones';
import type { ReservoirInterval } from '../types';
import { nowIso, uid } from '../util/num';

/** Rebuild the RES_FLAG curve (1 inside an active reservoir interval, 0 elsewhere) on the well grid. */
export function rebuildResFlag(wellId: string) {
  const d = registry.depth(wellId); if (!d) return;
  const iv = reservoirsForWell(wellId);
  const well = S().wells.find((w) => w.id === wellId); if (!well) return;
  if (!iv.length) { if (well.curves.some((c) => c.mnemonic === 'RES_FLAG' && c.calc?.formula.startsWith('reservoir intervals'))) { registry.deleteCurve(wellId, 'RES_FLAG'); S().removeCurveMeta(wellId, 'RES_FLAG'); S().bump(); } return; }
  const f = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) for (const r of iv) if (d[i] >= r.top && d[i] < r.base) { f[i] = 1; break; }
  putCalculatedCurve(wellId, 'RES_FLAG', f, '', 'Reservoir flag (analysis scope)', {
    kind: 'formula', formula: `reservoir intervals: ${iv.map((r) => `${r.name} ${r.top}–${r.base}`).join('; ')}`, inputs: [], units: '', version: 1,
    missing: '0 outside the reservoir intervals', createdAt: nowIso(),
  }, true);
}

export function setReservoirs(wellId: string, list: Omit<ReservoirInterval, 'id' | 'wellId' | 'active'>[], mode: 'replace' | 'append', why: string) {
  const st = S();
  const keep = mode === 'replace' ? st.reservoirs.filter((r) => r.wellId !== wellId) : st.reservoirs;
  const add: ReservoirInterval[] = list.filter((r) => isFinite(r.top) && isFinite(r.base) && r.base > r.top).map((r) => ({ ...r, id: uid('r_'), wellId, active: true }));
  st.set({ reservoirs: [...keep, ...add] });
  rebuildResFlag(wellId);
  if (!st.zone && add.length) st.set({ zone: RESERVOIR_KEY });
  const w = st.wells.find((x) => x.id === wellId)?.name ?? wellId;
  st.log(`Reservoir intervals on ${w} (${why}): ${add.map((r) => `${r.name} ${r.top}–${r.base}`).join(', ') || 'none'}${mode === 'replace' ? ' — replaced previous' : ''}`);
}
export function updateReservoir(id: string, patch: Partial<ReservoirInterval>, why?: string) {
  const st = S(); const r = st.reservoirs.find((x) => x.id === id); if (!r) return;
  st.set({ reservoirs: st.reservoirs.map((x) => (x.id === id ? { ...x, ...patch } : x)) }); rebuildResFlag(r.wellId);
  st.log(why ?? `Reservoir interval "${r.name}" edited`);
}
export function removeReservoir(id: string) {
  const st = S(); const r = st.reservoirs.find((x) => x.id === id); if (!r) return;
  st.set({ reservoirs: st.reservoirs.filter((x) => x.id !== id), zone: st.zone === 'RES:' + id ? RESERVOIR_KEY : st.zone }); rebuildResFlag(r.wellId);
  st.log(`Removed reservoir interval "${r.name}" (${r.top}–${r.base})`);
}
