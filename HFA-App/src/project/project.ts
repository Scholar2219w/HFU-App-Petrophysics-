// Local project persistence (IndexedDB) + portable .hfaproj export/import.
// Stores normalized metadata + canonical arrays (NOT the original raw files).
import { S, useStore, newProjectMeta, newPetroState, DEFAULT_LAYOUT, PETRO_LAYOUT } from '../store/store';
import { registry } from '../data-engine/registry';
import { idbCopyPrefix, idbDelPrefix, idbEntriesPrefix, idbGet, idbKeys, idbPut, idbDel } from '../data-engine/idb';
import { resetHistory } from '../store/history';
import type { ProjectMeta } from '../types';
import { nowIso, uid } from '../util/num';

const DOMAIN_KEYS = ['project', 'wells', 'cores', 'tops', 'hfuSets', 'models', 'validations', 'aliases', 'layout', 'hfuConfig', 'history', 'savedFilters', 'annotations', 'zone', 'reservoirs', 'petro', 'logTheme'] as const;

function snapshot() { const s = S() as any; const o: any = {}; for (const k of DOMAIN_KEYS) o[k] = s[k]; return o; }

export async function saveProject() {
  const st = S(); const id = st.project.id;
  registry.setProject(id);
  st.set({ busy: { label: 'Saving project…' } });
  try {
    const n = await registry.flush(id);
    // purge arrays of wells / cores that were removed from the project
    const liveW = new Set(st.wells.map((w) => w.id)), liveC = new Set(st.cores.map((c) => c.id));
    for (const k of (await idbKeys('arrays')) as string[]) { if (!k.startsWith(`${id}/`)) continue; const p = k.split('/'); if ((p[1] === 'w' && !liveW.has(p[2])) || (p[1] === 'c' && !liveC.has(p[2]))) await idbDel(k); }
    const meta = { ...snapshot(), project: { ...st.project, savedAt: nowIso() } };
    await idbPut(id, meta, 'projects');
    st.set({ project: meta.project, dirty: false });
    st.log(`Saved project "${st.project.name}" (${n} arrays written)`);
    st.notify('OK', `Project saved locally (${n} arrays updated). Raw files are not stored.`);
  } finally { st.set({ busy: null }); }
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const ks = (await idbKeys('projects')) as string[];
  const out: ProjectMeta[] = [];
  for (const k of ks) { const m = await idbGet(k, 'projects'); if (m?.project) out.push({ ...m.project, _wells: m.wells?.length ?? 0 } as any); }
  return out.sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''));
}

export async function loadProject(id: string) {
  const m = await idbGet(id, 'projects'); if (!m) throw new Error('Project not found in local storage.');
  registry.clear(); registry.setProject(id);
  const st = S();
  st.set({ ...m, module: 'home', activeWellId: m.wells?.[0]?.id, activeCoreId: m.cores?.[0]?.id, viewRange: undefined, interval: undefined, selection: undefined, dirty: false, layout: m.layout ?? DEFAULT_LAYOUT });
  st.set({ busy: { label: 'Loading project arrays…' } });
  try {
    for (const w of m.wells ?? []) await registry.ensureWell(w.id);
    for (const c of m.cores ?? []) await registry.ensureCore(c.id);
  } catch (e: any) { st.notify('CRITICAL', e.message); }
  finally { st.set({ busy: null }); }
  st.log(`Opened project "${m.project.name}" (curves load lazily on demand)`);
  st.bump(); st.set({ dirty: false, annotations: m.annotations ?? [], zone: m.zone ?? '', reservoirs: m.reservoirs ?? [], petro: m.petro ?? newPetroState(), logTheme: m.logTheme ?? 'light' });
  resetHistory(`Opened project "${m.project.name}"`);
}

export async function deleteProject(id: string) { await idbDel(id, 'projects'); await idbDelPrefix(`${id}/`); }

export async function duplicateProject(id: string, newName: string) {
  const m = await idbGet(id, 'projects'); if (!m) throw new Error('Project not found');
  const nid = uid('p_'); await idbCopyPrefix(`${id}/`, `${nid}/`);
  await idbPut(nid, { ...m, project: { ...m.project, id: nid, name: newName, createdAt: nowIso(), savedAt: nowIso() } }, 'projects');
  return nid;
}

export function newProject(meta: Partial<ProjectMeta>) {
  registry.clear();
  const p = { ...newProjectMeta(meta.name || 'Untitled Project'), ...meta, id: uid('p_') } as ProjectMeta;
  registry.setProject(p.id);
  useStore.setState({ project: p, wells: [], cores: [], tops: [], hfuSets: [], models: [], validations: [], history: [], module: 'import', activeWellId: undefined, activeCoreId: undefined, viewRange: undefined, interval: undefined, selection: undefined, layout: PETRO_LAYOUT, dirty: false });
  S().log(`Created project "${p.name}"`);
  useStore.setState({ annotations: [], zone: '', reservoirs: [], petro: newPetroState() });
  resetHistory(`Created project "${p.name}"`);
}

// ── portable export: "HFAPROJ1" | u32 jsonLen | json | binary ──
export async function exportProject() {
  const st = S(); st.set({ busy: { label: 'Exporting project…' } });
  try {
    const manifest: { key: string; kind: 'f32' | 'f64' | 'u8'; off: number; len: number }[] = []; const parts: ArrayBuffer[] = []; let off = 0;
    const add = (key: string, kind: 'f32' | 'f64' | 'u8', a: Float32Array | Float64Array | Uint8Array) => { const b = a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength) as ArrayBuffer; manifest.push({ key, kind, off, len: b.byteLength }); parts.push(b); off += b.byteLength; };
    const coresJson: Record<string, any> = {};
    for (const w of st.wells) {
      const arr = await registry.ensureCurves(w.id, w.curves.map((c) => c.mnemonic));
      add(`w/${w.id}/depth`, 'f64', registry.depth(w.id)!);
      for (const [m, a] of Object.entries(arr)) add(`w/${w.id}/c/${m}`, 'f32', a);
    }
    for (const c of st.cores) {
      const a = await registry.ensureCore(c.id);
      add(`c/${c.id}/depth`, 'f64', a.depth); add(`c/${c.id}/excluded`, 'u8', a.excluded);
      for (const [n, v] of a.num) add(`c/${c.id}/num/${n}`, 'f64', v);
      coresJson[c.id] = Object.fromEntries(a.text);
    }
    const json = new TextEncoder().encode(JSON.stringify({ meta: snapshot(), manifest, coreText: coresJson, exportedAt: nowIso(), app: 'HFA Suite 0.1' }));
    const head = new Uint8Array(12); head.set(new TextEncoder().encode('HFAPROJ1')); new DataView(head.buffer).setUint32(8, json.byteLength, true);
    const blob = new Blob([head, json, ...parts], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `${st.project.name.replace(/[^\w.-]+/g, '_')}.hfaproj`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    st.log(`Exported project (${(blob.size / 1048576).toFixed(2)} MB)`);
  } catch (e: any) { st.notify('CRITICAL', `Export failed: ${e.message}`); }
  finally { st.set({ busy: null }); }
}

export async function importProject(file: File) {
  const buf = await file.arrayBuffer(); const u8 = new Uint8Array(buf);
  if (new TextDecoder().decode(u8.subarray(0, 8)) !== 'HFAPROJ1') throw new Error('Not an HFA project file (.hfaproj).');
  const jl = new DataView(buf).getUint32(8, true); const j = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + jl)));
  const base = 12 + jl; const nid = uid('p_');
  const cores: Record<string, any> = {};
  for (const m of j.manifest) {
    const slice = buf.slice(base + m.off, base + m.off + m.len);
    const parts = m.key.split('/');
    if (parts[0] === 'w') await idbPut(`${nid}/${m.key}`, slice);
    else { const cid = parts[1]; cores[cid] ??= { num: {}, text: j.coreText?.[cid] ?? {} }; if (parts[2] === 'depth') cores[cid].depth = slice; else if (parts[2] === 'excluded') cores[cid].excluded = slice; else cores[cid].num[parts.slice(3).join('/')] = slice; }
  }
  for (const [cid, c] of Object.entries(cores)) await idbPut(`${nid}/c/${cid}`, c);
  await idbPut(nid, { ...j.meta, project: { ...j.meta.project, id: nid, name: j.meta.project.name + ' (imported)', savedAt: nowIso() } }, 'projects');
  await loadProject(nid);
}

export async function storageSummary() {
  const e = await idbEntriesPrefix(`${S().project.id}/`); let b = 0; for (const [, v] of e) b += v?.byteLength ?? 0; return { n: e.length, bytes: b };
}
