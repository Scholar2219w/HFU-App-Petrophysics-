// Analysis history with undo / redo (spec §32).
// Every logged analysis step is a checkpoint. Metadata is immutable in the
// store, so a checkpoint keeps references (cheap). Well arrays are journalled by
// the registry (value before first change); core arrays are small and are
// deep-copied per checkpoint (they are edited in place by QC operations).
import { useStore, hooks, S } from './store';
import { registry, journal, type CoreArrays } from '../data-engine/registry';

const UNDO_KEYS = ['project', 'wells', 'cores', 'tops', 'hfuSets', 'models', 'validations', 'aliases', 'layout', 'hfuConfig', 'annotations', 'savedFilters', 'reservoirs', 'petro'] as const;
const MAX = 60;

interface Entry { label: string; t: string; meta: Record<string, any>; prev: Map<string, any>; next?: Map<string, any>; cores: Map<string, CoreArrays> }
const done: Entry[] = []; const undone: Entry[] = [];
let muted = false;

const copyCore = (c: CoreArrays): CoreArrays => ({ depth: c.depth, num: new Map([...c.num].map(([k, v]) => [k, new Float64Array(v)])), text: new Map(c.text), excluded: new Uint8Array(c.excluded) });
const copyCores = (m: Map<string, CoreArrays>) => new Map([...m].map(([k, v]) => [k, copyCore(v)]));
const metaRefs = () => { const s = useStore.getState() as any; const o: Record<string, any> = {}; for (const k of UNDO_KEYS) o[k] = s[k]; return o; };
const publish = () => useStore.setState({ canUndo: Math.max(0, done.length - 1), canRedo: undone.length });

export function checkpoint(label: string) {
  if (muted) return;
  done.push({ label, t: new Date().toISOString(), meta: metaRefs(), prev: journal.prev, cores: copyCores(registry.allCores()) });
  journal.prev = new Map();
  if (done.length > MAX) done.shift();
  undone.length = 0; publish();
}

/** Reset (new/opened project): current state becomes the baseline. */
export function resetHistory(label = 'Baseline') { done.length = 0; undone.length = 0; journal.prev = new Map(); muted = false; checkpoint(label); }

function restore(meta: Record<string, any>, cores: Map<string, CoreArrays>) {
  useStore.setState({ ...meta, dirty: true });
  registry.replaceCores(copyCores(cores));
  useStore.setState((s) => ({ dataVersion: s.dataVersion + 1 }));
}

export function undo() {
  if (done.length < 2) { S().notify('INFO', 'Nothing to undo.'); return; }
  const e = done.pop()!; const before = done[done.length - 1];
  // uncommitted array changes since the last checkpoint belong to "now": fold them in
  for (const [k, v] of journal.prev) if (!e.prev.has(k)) e.prev.set(k, v);
  journal.prev = new Map();
  journal.active = false;
  e.next = new Map(); for (const [k, v] of e.prev) { e.next.set(k, registry.rawGet(k)); registry.rawSet(k, v); }
  journal.active = true;
  restore(before.meta, before.cores);
  undone.push(e); muted = true; S().log(`↶ Undo: ${e.label}`, 'warn'); muted = false; publish();
}

export function redo() {
  const e = undone.pop(); if (!e) { S().notify('INFO', 'Nothing to redo.'); return; }
  journal.active = false; for (const [k, v] of e.next ?? []) registry.rawSet(k, v); journal.active = true;
  restore(e.meta, e.cores); done.push(e);
  muted = true; S().log(`↷ Redo: ${e.label}`, 'info'); muted = false; publish();
}

export function historyEntries() { return { done: done.map((e) => ({ label: e.label, t: e.t })), undone: [...undone].reverse().map((e) => ({ label: e.label, t: e.t })) }; }

hooks.onLog = (msg: string) => checkpoint(msg);
