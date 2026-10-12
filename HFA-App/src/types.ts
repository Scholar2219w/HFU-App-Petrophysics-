// ─────────────────────────────────────────────────────────────────────────────
// Canonical data model. Metadata lives in the (reactive) store; numerical
// arrays live ONLY in the data-engine registry as TypedArrays (one canonical
// representation, never duplicated as JS arrays / JSON / chart datasets).
// ─────────────────────────────────────────────────────────────────────────────

export type CurveCategory =
  | 'Depth' | 'Gamma Ray' | 'Resistivity' | 'Density' | 'Neutron' | 'Sonic'
  | 'Porosity' | 'Permeability' | 'NMR' | 'Image' | 'Caliper' | 'Pressure'
  | 'Core' | 'Calculated' | 'Photoelectric' | 'SP' | 'Saturation' | 'Shale'
  | 'HFU' | 'Flag' | 'Other';

export interface CalcInfo {
  kind: 'formula' | 'hfu' | 'prediction' | 'cluster' | 'resample' | 'core-projection';
  formula: string;
  inputs: string[];
  units: string;
  version: number;
  missing: string;        // missing-data handling statement
  createdAt: string;
  model?: string;         // model id for predictions
  notes?: string;
}

export interface CurveStats { min: number; max: number; mean: number; nullPct: number; nValid: number; p05?: number; p95?: number }

export interface CurveMeta {
  mnemonic: string;
  unit: string;
  description: string;
  category: CurveCategory;
  family?: string;        // canonical alias (e.g. AT90 → RT)
  source: string;         // file name | 'calculated' | 'predicted' ...
  stats: CurveStats;
  calc?: CalcInfo;
  discrete?: boolean;     // HFU / cluster / flag curves
}

export interface HeaderItem { section: string; mnem: string; unit: string; value: string; desc: string }

export interface SourceFile {
  name: string; size: number; format: string; importedAt: string;
  lasVersion?: string; nullValue?: number; curves: string[]; note?: string;
  depthStart?: number; depthStop?: number; step?: number; nSamples?: number;
}

export interface WellMeta {
  id: string;
  name: string;
  uwi: string;
  field: string;
  depthUnit: string;
  start: number;
  stop: number;
  step: number;           // nominal (median) sampling interval
  regular: boolean;
  nSamples: number;
  curves: CurveMeta[];
  sources: SourceFile[];
  header: HeaderItem[];
  color: string;
  demo?: boolean;
}

// ── Depth transformations (reversible, stored as operations) ────────────────
export type DepthOpType = 'shift' | 'linear' | 'poly' | 'tie';
export interface DepthOp {
  id: string;
  type: DepthOpType;
  active: boolean;
  interval?: [number, number];   // applies only to ORIGINAL depths inside [top, base]
  amount?: number;               // shift
  a?: number; b?: number;        // linear: d' = a·d + b
  coeffs?: number[];             // poly:   d' = Σ c_i·d^i
  pairs?: [number, number][];    // tie points: [original, target]
  confidence?: 'High' | 'Medium' | 'Low';
  marker?: string;               // reference marker
  note?: string;
  createdAt: string;
  method?: string;               // 'manual' | 'auto-correlation' | 'tie-points'
}

// ── Core ────────────────────────────────────────────────────────────────────
export type PhiUnit = 'fraction' | 'percent';
export type PermUnit = 'mD' | 'D' | 'um2' | 'm2';

export interface CoreColumn { name: string; unit: string; kind: 'num' | 'text' }

export interface FilterRecord { at: string; op: string; before: number; after: number; removed: number; reason: string }

export interface CoreMeta {
  id: string;
  wellId: string;
  name: string;
  source: string;
  n: number;
  depthUnit: string;
  columns: CoreColumn[];
  map: { phi?: string; k?: string; facies?: string; grainDensity?: string; sampleId?: string };
  phiUnit: PhiUnit | null;   // null = not confirmed → calculations blocked
  kUnit: PermUnit | null;
  depthOps: DepthOp[];
  filterLog: FilterRecord[];
}

// ── Tops ────────────────────────────────────────────────────────────────────
export interface Top { id: string; wellId: string; name: string; md: number; tvd?: number; tvdss?: number; color: string }

// ── Reservoir intervals (analysis scope) ─────────────────────────────────────
/** The analyst's reservoir interval(s). HFU / petrophysical analysis runs only inside these by default. */
export interface ReservoirInterval { id: string; wellId: string; name: string; top: number; base: number; source: string; active: boolean }

// ── Petrophysical evaluation (Techlog-style workflow: method → inputs → zonation → parameters) ──
export type PetroZonation = 'reservoir' | 'tops' | 'well';
export type VshMethod = 'linear' | 'larionov_tertiary' | 'larionov_older' | 'clavier' | 'steiber';
export interface PetroZoneParams {
  // bad hole
  bitSize: number; caliThr: number; drhoThr: number;
  // shale volume
  vshMethod: VshMethod; grClean: number; grShale: number;
  // neutron-density
  rhoMa: number; rhoFl: number; nphiMa: number; nphiFl: number; nphiShift: number; rhoSh: number; nphiSh: number; phiMax: number;
  hcCorr: boolean; hcDensity: number; mudSalinity: number; temperature: number; tempUnit: 'degC' | 'degF'; hiGas: number; hiFluid: number; excavation: boolean; invasionFactor: number;
  // Archie
  a: number; m: number; n: number; rw: number; rwTemp: number;
  // cut-offs
  vshCut: number; phiCut: number; swCut: number;
}
export interface PetroInputs { gr: string; rhob: string; nphi: string; rt: string; cali: string; bs: string; drho: string; rxo: string; vsh: string; phit: string }
export interface PetroState {
  zonation: PetroZonation;
  resOnly?: boolean;            // with formation/well zonation: evaluate only inside the reservoir intervals
  inputs: Record<string, Partial<PetroInputs>>;                        // per well
  params: Record<string, Record<string, Partial<PetroZoneParams>>>;    // well → zone key → overrides
  methods: { badhole: boolean; vsh: boolean; nd: boolean; sw: boolean; cutoff: boolean };
  lastRun?: string;
}

// ── HFU / clusters ──────────────────────────────────────────────────────────
export type UnitStatus = 'Statistical Cluster' | 'Hydraulic Flow Unit';
export interface HfuUnit {
  id: number;          // 1..K
  label: string;
  status: UnitStatus;
  color: string;
  fziMin?: number; fziMax?: number;
  stats?: Record<string, number>;
}
export interface HfuSet {
  id: string;
  name: string;
  domain: 'core' | 'log';
  wellId: string;
  coreId?: string;
  method: string;            // e.g. 'A: FZI grouping'
  algorithm?: string;
  params: Record<string, any>;
  features: string[];
  scaling?: string;
  units: HfuUnit[];
  labels?: number[];         // core domain: per core row (0 = unassigned)
  curve?: string;            // log domain: curve name on well grid
  boundaries?: number[];     // FZI thresholds (ascending) for classifying FZI → unit
  createdAt: string;
}

// ── Regression ──────────────────────────────────────────────────────────────
export type Algo = 'MLR' | 'LogLinear' | 'Poly2' | 'Ridge' | 'Lasso' | 'ElasticNet' | 'RandomForest' | 'GBT' | 'RFClassifier';
export interface Metrics { n: number; p: number; r2: number; adjR2: number; rmse: number; mae: number; medae: number; mape?: number; aic?: number; bic?: number }
export interface CoefRow { name: string; coef: number; se?: number; t?: number; p?: number; vif?: number }
export interface SubModel {
  group: string;                // 'ALL' | 'HFU 1' ...
  groupId: number;              // 0 for global
  n: number;
  features: string[];
  kind: 'linear' | 'forest' | 'gbt' | 'classifier';
  intercept?: number;
  coefs?: number[];             // on (possibly expanded / scaled) design
  scaleMu?: number[]; scaleSd?: number[];
  expand?: 'none' | 'poly2';
  forest?: any;                 // serialized trees
  table?: CoefRow[];
  metrics: Metrics;
  equation: string;
  featureRanges: [number, number][];
  residual: { mean: number; sd: number; p05: number; p95: number };
  warnings: string[];
  classes?: number[];
}
export interface RegressionModel {
  id: string;
  name: string;
  target: string;               // 'FZI' | 'LOG_FZI' | 'RQI' | 'LOG_K' | 'K' | 'HFU'
  targetTransform: 'none' | 'log10';
  algorithm: Algo;
  params: Record<string, any>;
  domain: 'core' | 'log';
  wellIds: string[];
  coreId?: string;
  targetCurve?: string;          // log domain target curve
  hfuSetId?: string;
  groupBy: 'global' | 'hfu';
  interval?: [number, number];
  features: string[];
  selectionMethod: string;
  subModels: SubModel[];
  createdAt: string;
  notes?: string;
}

export interface ValidationRun {
  id: string; modelId: string; method: string; params: Record<string, any>;
  metrics: Metrics; folds: { name: string; metrics: Metrics }[];
  createdAt: string;
  // arrays for plots kept small (≈ core sample count)
  actual: number[]; predicted: number[]; depth: number[]; fold: number[];
  warnings: string[];
}

export interface HistoryEntry { t: string; msg: string; level?: 'info' | 'warn' | 'error' }

export interface ProjectMeta {
  id: string; name: string; field: string; basin: string; formation: string;
  operator: string; region: string; analyst: string; date: string; notes: string;
  createdAt: string; savedAt?: string;
}

export interface Message { id: string; level: 'CRITICAL' | 'WARNING' | 'INFO' | 'OK'; text: string }
