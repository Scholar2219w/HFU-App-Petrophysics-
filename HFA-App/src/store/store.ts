import { create } from 'zustand';
import type {
  CoreMeta, CurveMeta, HfuSet, HistoryEntry, PetroState, ProjectMeta, RegressionModel, ReservoirInterval, Top, ValidationRun, WellMeta,
} from '../types';
import { nowIso, uid } from '../util/num';

export type ModuleId =
  | 'home' | 'import' | 'curves' | 'logview' | 'depth' | 'core' | 'calc' | 'hfu' | 'cluster'
  | 'crossplot' | 'regression' | 'validation' | 'prediction' | 'hfutrack' | 'project'
  | 'qc' | 'export' | 'transitions' | 'rq' | 'multiwell' | 'zones' | 'filters' | 'table' | 'audit' | 'advanced'
  | 'reservoir' | 'petro';

export interface CurveDisplay {
  mnem: string;                 // mnemonic or family key (resolved per well)
  color: string;
  width: number;
  scale: 'lin' | 'log';
  min?: number; max?: number;   // undefined → auto
  reverse?: boolean;
  fill?: 'none' | 'left' | 'right' | 'crossover' | 'baseline';
  baseline?: number;            // for fill = 'baseline' (e.g. GR sand/shale baseline)
  fillColor2?: string;          // colour right of the baseline
  fillColor?: string;
  crossWith?: string;           // for crossover fill (second curve mnemonic in same track)
  dash?: boolean;
  core?: { coreId?: string; column: string }; // plot core points instead of a log curve
}
export interface TrackDef {
  id: string;
  title?: string;
  kind: 'depth' | 'curve' | 'hfu' | 'zone' | 'flag';
  flag?: { curve: string; color: string };   // flag track: bars where curve > 0
  width: number;
  curves: CurveDisplay[];
  grid?: boolean; minorGrid?: boolean;
  hfu?: { source: 'curve'; curve: string } | null;
}
export interface Annotation { id: string; wellId: string; depth: number; text: string; color: string; kind: 'annotation' | 'marker' }
export interface Selection { wellId: string; source: 'core' | 'log'; depths: number[]; label: string }
export interface Busy { label: string; progress?: number }
export interface Toast { id: string; level: 'CRITICAL' | 'WARNING' | 'INFO' | 'OK'; text: string }

export interface HfuConfig {
  rqiConst: number;           // 0.0314 for k in mD, RQI in µm
  phiUnitAssumed: 'fraction';
  kUnitAssumed: 'mD';
}

export interface State {
  project: ProjectMeta;
  wells: WellMeta[];
  cores: CoreMeta[];
  tops: Top[];
  hfuSets: HfuSet[];
  models: RegressionModel[];
  validations: ValidationRun[];
  aliases: Record<string, string>;
  layout: TrackDef[];
  hfuConfig: HfuConfig;
  savedFilters: { name: string; expr: string }[];
  annotations: Annotation[];
  zone: string;                 // global analysis scope: '' = whole well · RESERVOIR_KEY · 'RES:<id>' · formation name
  reservoirs: ReservoirInterval[];
  petro: PetroState;
  logTheme: 'light' | 'dark';
  canUndo: number; canRedo: number;

  module: ModuleId;
  activeWellId?: string;
  activeCoreId?: string;
  cursor?: { wellId: string; depth: number; x?: string };
  viewRange?: { wellId: string; top: number; base: number };
  interval?: { wellId: string; top: number; base: number };
  selection?: Selection;
  busy: Busy | null;
  toasts: Toast[];
  history: HistoryEntry[];
  dataVersion: number;
  dirty: boolean;
  crossplotPreset?: { x: string; y: string; logx?: boolean; logy?: boolean; color?: string; source?: 'core' | 'log' };

  set: (p: Partial<State>) => void;
  go: (m: ModuleId) => void;
  log: (msg: string, level?: HistoryEntry['level']) => void;
  notify: (level: Toast['level'], text: string) => void;
  dismiss: (id: string) => void;
  bump: () => void;
  upsertWell: (w: WellMeta) => void;
  updateWell: (id: string, f: (w: WellMeta) => WellMeta) => void;
  upsertCurveMeta: (wellId: string, c: CurveMeta) => void;
  removeCurveMeta: (wellId: string, mnem: string) => void;
  upsertCore: (c: CoreMeta) => void;
  updateCore: (id: string, f: (c: CoreMeta) => CoreMeta) => void;
  upsertHfuSet: (h: HfuSet) => void;
  upsertModel: (m: RegressionModel) => void;
  removeModel: (id: string) => void;
}

export const newProjectMeta = (name = 'Untitled Project'): ProjectMeta => ({
  id: uid('p_'), name, field: '', basin: '', formation: '', operator: '', region: '', analyst: '',
  date: new Date().toISOString().slice(0, 10), notes: '', createdAt: nowIso(),
});

export const DEFAULT_LAYOUT: TrackDef[] = [
  { id: 't_depth', kind: 'depth', width: 56, curves: [] },
  { id: 't_gr', title: 'GR / VSH', kind: 'curve', width: 150, grid: true, curves: [
    { mnem: 'GR', color: '#3ecf8e', width: 1.2, scale: 'lin', min: 0, max: 150, fill: 'left', fillColor: 'rgba(62,207,142,0.15)' },
    { mnem: 'VSH', color: '#8bd450', width: 1, scale: 'lin', min: 0, max: 1, dash: true },
  ] },
  { id: 't_nd', title: 'RHOB / NPHI', kind: 'curve', width: 170, grid: true, curves: [
    { mnem: 'RHOB', color: '#e5534b', width: 1.2, scale: 'lin', min: 1.95, max: 2.95, fill: 'crossover', crossWith: 'NPHI', fillColor: 'rgba(245,166,35,0.35)' },
    { mnem: 'NPHI', color: '#4ea1ff', width: 1.2, scale: 'lin', min: 0.45, max: -0.15 },
  ] },
  { id: 't_dt', title: 'DT / PHIE', kind: 'curve', width: 150, grid: true, curves: [
    { mnem: 'DT', color: '#b083f0', width: 1, scale: 'lin', min: 140, max: 40 },
    { mnem: 'PHIE', color: '#39c5cf', width: 1.2, scale: 'lin', min: 0.3, max: 0, fill: 'right', fillColor: 'rgba(57,197,207,0.18)' },
  ] },
  { id: 't_res', title: 'RT / RXO', kind: 'curve', width: 150, grid: true, curves: [
    { mnem: 'RT', color: '#e5534b', width: 1.2, scale: 'log', min: 0.2, max: 2000 },
    { mnem: 'RXO', color: '#f5a623', width: 1, scale: 'log', min: 0.2, max: 2000, dash: true },
  ] },
  { id: 't_hfu', title: 'RQI / FZI / HFU', kind: 'curve', width: 150, grid: true, curves: [
    { mnem: 'RQI_LOG', color: '#b083f0', width: 1, scale: 'log', min: 0.001, max: 100 },
    { mnem: 'FZI_LOG', color: '#f07db5', width: 1, scale: 'log', min: 0.001, max: 100, dash: true },
    { mnem: 'FZI_PRED', color: '#e8c547', width: 1.3, scale: 'log', min: 0.001, max: 100 },
    { mnem: 'FZI', color: '#ffffff', width: 1, scale: 'log', min: 0.001, max: 100, core: { column: 'FZI' } },
  ] },
  { id: 't_k', title: 'K / Core K', kind: 'curve', width: 150, grid: true, curves: [
    { mnem: 'K', color: '#f5a623', width: 1.2, scale: 'log', min: 0.01, max: 10000 },
    { mnem: 'K_PRED', color: '#ff8c42', width: 1, scale: 'log', min: 0.01, max: 10000, dash: true },
    { mnem: 'K', color: '#ffffff', width: 1, scale: 'log', min: 0.01, max: 10000, core: { column: 'K' } },
  ] },
  { id: 't_hfuband', title: 'HFU', kind: 'hfu', width: 60, curves: [], hfu: null },
];

export const newPetroState = (): PetroState => ({ zonation: 'reservoir', inputs: {}, params: {}, methods: { badhole: true, vsh: true, nd: true, sw: true, cutoff: true } });

/** Conventional petrophysical print (Techlog-style): caliper · bad-hole flags · GR with sand/shale baseline fill · resistivity ·
 *  neutron-density · VSH · porosity with core · reservoir flag · permeability with core · Sw · RQI · HFU. */
export const PETRO_LAYOUT: TrackDef[] = [
  { id: 'p_depth', kind: 'depth', width: 56, curves: [] },
  { id: 'p_zone', kind: 'zone', width: 26, curves: [] },
  { id: 'p_cal', title: 'Caliper / Bit size', kind: 'curve', width: 110, grid: true, curves: [
    { mnem: 'CALI', color: '#c92a2a', width: 1, scale: 'lin', min: 6, max: 16, fill: 'crossover', crossWith: 'BS', fillColor: 'rgba(150,150,150,0.55)' },
    { mnem: 'BS', color: '#000000', width: 1, scale: 'lin', min: 6, max: 16, dash: true },
  ] },
  { id: 'p_bhbs', kind: 'flag', width: 16, curves: [], flag: { curve: 'BH_FL_BS', color: '#e03131' } },
  { id: 'p_gr', title: 'Gamma ray', kind: 'curve', width: 140, grid: true, curves: [
    { mnem: 'GR', color: '#000000', width: 1.1, scale: 'lin', min: 0, max: 150, fill: 'baseline', baseline: 75, fillColor: 'rgba(255,230,0,0.9)', fillColor2: 'rgba(150,75,20,0.9)' },
  ] },
  { id: 'p_res', title: 'Resistivity', kind: 'curve', width: 140, grid: true, curves: [
    { mnem: 'AT90', color: '#1c3ef0', width: 1.2, scale: 'log', min: 0.2, max: 2000 },
    { mnem: 'AT30', color: '#2b8a3e', width: 1, scale: 'log', min: 0.2, max: 2000 },
    { mnem: 'AT10', color: '#e8590c', width: 1, scale: 'log', min: 0.2, max: 2000, dash: true },
  ] },
  { id: 'p_nd', title: 'Neutron-density', kind: 'curve', width: 150, grid: true, curves: [
    { mnem: 'RHOB', color: '#e03131', width: 1.1, scale: 'lin', min: 1.95, max: 2.95, fill: 'crossover', crossWith: 'NPHI', fillColor: 'rgba(255,212,0,0.75)' },
    { mnem: 'NPHI', color: '#1c3ef0', width: 1.1, scale: 'lin', min: 0.45, max: -0.15, dash: true },
  ] },
  { id: 'p_bhdr', kind: 'flag', width: 16, curves: [], flag: { curve: 'BH_FL_DRHO', color: '#e03131' } },
  { id: 'p_vsh', title: 'Shale volume', kind: 'curve', width: 100, grid: true, curves: [
    { mnem: 'VSH_GR', color: '#000000', width: 1.1, scale: 'lin', min: 0, max: 1, fill: 'left', fillColor: 'rgba(92,140,50,0.75)' },
  ] },
  { id: 'p_phi', title: 'Porosity', kind: 'curve', width: 130, grid: true, curves: [
    { mnem: 'PHIT_ND_UNCL', color: '#1c3ef0', width: 1.1, scale: 'lin', min: 0.5, max: 0 },
    { mnem: 'PHIE_ND', color: '#0ca678', width: 1, scale: 'lin', min: 0.5, max: 0, fill: 'right', fillColor: 'rgba(255,236,153,0.8)' },
    { mnem: 'PHI', color: '#e03131', width: 1, scale: 'lin', min: 0.5, max: 0, core: { column: 'PHI' } },
  ] },
  { id: 'p_resflag', kind: 'flag', width: 22, curves: [], flag: { curve: 'RES_FLAG', color: '#ffe600' } },
  { id: 'p_perm', title: 'Permeability', kind: 'curve', width: 130, grid: true, curves: [
    { mnem: 'KSDR', color: '#e8590c', width: 1, scale: 'log', min: 0.01, max: 10000 },
    { mnem: 'K_PRED', color: '#7048e8', width: 1, scale: 'log', min: 0.01, max: 10000, dash: true },
    { mnem: 'K', color: '#e03131', width: 1, scale: 'log', min: 0.01, max: 10000, core: { column: 'K' } },
  ] },
  { id: 'p_sw', title: 'Water saturation', kind: 'curve', width: 110, grid: true, curves: [
    { mnem: 'SW_AR', color: '#000000', width: 1.1, scale: 'lin', min: 1, max: 0, fill: 'right', fillColor: 'rgba(120,210,235,0.75)' },
  ] },
  { id: 'p_rqi', title: 'RQI / FZI', kind: 'curve', width: 120, grid: true, curves: [
    { mnem: 'FZI_PRED', color: '#7048e8', width: 1.1, scale: 'log', min: 0.01, max: 100 },
    { mnem: 'FZI', color: '#e8590c', width: 1, scale: 'log', min: 0.01, max: 100, core: { column: 'FZI' } },
    { mnem: 'RQI', color: '#e03131', width: 1, scale: 'log', min: 0.01, max: 100, core: { column: 'RQI' } },
  ] },
  { id: 'p_hfu', title: 'HFU', kind: 'hfu', width: 50, curves: [], hfu: null },
];

/** Set by store/history.ts — every logged analysis step becomes an undo checkpoint. */
export const hooks = { onLog: (_msg: string) => {} };

export const useStore = create<State>((set, get) => ({
  project: newProjectMeta(),
  wells: [], cores: [], tops: [], hfuSets: [], models: [], validations: [],
  aliases: {}, layout: PETRO_LAYOUT,
  hfuConfig: { rqiConst: 0.0314, phiUnitAssumed: 'fraction', kUnitAssumed: 'mD' },
  savedFilters: [], annotations: [], zone: '', canUndo: 0, canRedo: 0,
  reservoirs: [], petro: newPetroState(), logTheme: 'light',
  module: 'home', busy: null, toasts: [], history: [], dataVersion: 0, dirty: false,

  set: (p) => set(p as any),
  go: (m) => set({ module: m }),
  log: (msg, level = 'info') => { set((s) => ({ history: [...s.history, { t: nowIso(), msg, level }].slice(-500), dirty: true })); hooks.onLog(msg); },
  notify: (level, text) => {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { id, level, text }].slice(-6) }));
    setTimeout(() => get().dismiss(id), level === 'CRITICAL' ? 14000 : 7000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  bump: () => set((s) => ({ dataVersion: s.dataVersion + 1, dirty: true })),
  upsertWell: (w) => set((s) => ({ wells: s.wells.some((x) => x.id === w.id) ? s.wells.map((x) => (x.id === w.id ? w : x)) : [...s.wells, w], dirty: true })),
  updateWell: (id, f) => set((s) => ({ wells: s.wells.map((w) => (w.id === id ? f(w) : w)), dirty: true })),
  upsertCurveMeta: (wellId, c) => get().updateWell(wellId, (w) => ({ ...w, curves: w.curves.some((x) => x.mnemonic === c.mnemonic) ? w.curves.map((x) => (x.mnemonic === c.mnemonic ? c : x)) : [...w.curves, c] })),
  removeCurveMeta: (wellId, mnem) => get().updateWell(wellId, (w) => ({ ...w, curves: w.curves.filter((x) => x.mnemonic !== mnem) })),
  upsertCore: (c) => set((s) => ({ cores: s.cores.some((x) => x.id === c.id) ? s.cores.map((x) => (x.id === c.id ? c : x)) : [...s.cores, c], dirty: true })),
  updateCore: (id, f) => set((s) => ({ cores: s.cores.map((c) => (c.id === id ? f(c) : c)), dirty: true })),
  upsertHfuSet: (h) => set((s) => ({ hfuSets: s.hfuSets.some((x) => x.id === h.id) ? s.hfuSets.map((x) => (x.id === h.id ? h : x)) : [...s.hfuSets, h], dirty: true })),
  upsertModel: (m) => set((s) => ({ models: s.models.some((x) => x.id === m.id) ? s.models.map((x) => (x.id === m.id ? m : x)) : [...s.models, m], dirty: true })),
  removeModel: (id) => set((s) => ({ models: s.models.filter((m) => m.id !== id), dirty: true })),
}));

export const S = () => useStore.getState();
export const activeWell = (s: State = S()) => s.wells.find((w) => w.id === s.activeWellId) ?? s.wells[0];
export const activeCore = (s: State = S()) => s.cores.find((c) => c.id === s.activeCoreId) ?? s.cores.find((c) => c.wellId === activeWell(s)?.id) ?? s.cores[0];
