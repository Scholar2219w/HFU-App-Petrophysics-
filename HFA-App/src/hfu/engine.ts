// RQI / Φz / FZI engine with explicit unit handling. Never calculates silently
// with unconfirmed or inconsistent units.
//   RQI [µm] = C · sqrt(k[mD] / φ[frac]),  C = 0.0314 (default, configurable)
//   Φz        = φ / (1 − φ)
//   FZI [µm] = RQI / Φz
import type { CoreMeta, PermUnit, PhiUnit } from '../types';
import { PERM_TO_MD, PERM_LABEL, phiToFraction } from '../petrophysics/units';
import type { CoreArrays } from '../data-engine/registry';

export interface HfuCalcReport {
  status: 'OK' | 'BLOCKED';
  inputUnits: string; convertedUnits: string;
  equations: string[];
  n: number; nValid: number;
  excluded: { reason: string; n: number }[];
  messages: string[];
}

export function hfuEquations(C: number) {
  return [
    `RQI [µm] = ${C} × √( k[mD] / φ[fraction] )`,
    'Φz = φ / (1 − φ)',
    'FZI [µm] = RQI / Φz',
    'log RQI = log FZI + log Φz  (unit-slope lines on RQI–Φz log-log plot)',
    `k [mD] = φ · (FZI·Φz / ${C})²  (inverse, used for K_PRED)`,
  ];
}

export function computeRqiFzi(phiIn: ArrayLike<number>, kIn: ArrayLike<number>, phiUnit: PhiUnit | null, kUnit: PermUnit | null, C: number, excludedMask?: ArrayLike<number>) {
  const n = phiIn.length;
  const report: HfuCalcReport = { status: 'OK', inputUnits: '', convertedUnits: 'φ: fraction (v/v); k: mD; RQI, FZI: µm', equations: hfuEquations(C), n, nValid: 0, excluded: [], messages: [] };
  if (!phiUnit || !kUnit) {
    report.status = 'BLOCKED';
    report.messages.push(`FZI calculation could not be completed because ${!phiUnit ? 'porosity' : ''}${!phiUnit && !kUnit ? ' and ' : ''}${!kUnit ? 'permeability' : ''} unit${!phiUnit && !kUnit ? 's are' : ' is'} not confirmed. Confirm units before calculating.`);
    return { report } as const;
  }
  report.inputUnits = `φ: ${phiUnit === 'percent' ? '%' : 'fraction'}; k: ${PERM_LABEL[kUnit]}`;
  const pf = phiToFraction(phiUnit), kf = PERM_TO_MD[kUnit];
  const phi = new Float64Array(n), k = new Float64Array(n), rqi = new Float64Array(n), phiz = new Float64Array(n), fzi = new Float64Array(n);
  let nMiss = 0, nPhi = 0, nK = 0, nEx = 0, nValid = 0; let phiMax = 0;
  for (let i = 0; i < n; i++) {
    const p = phiIn[i] * pf, kk = kIn[i] * kf; phi[i] = p; k[i] = kk;
    rqi[i] = phiz[i] = fzi[i] = NaN;
    if (excludedMask && excludedMask[i]) { nEx++; continue; }
    if (p !== p || kk !== kk) { nMiss++; continue; }
    if (p > phiMax) phiMax = p;
    if (!(p > 0 && p < 1)) { nPhi++; continue; }
    if (!(kk > 0)) { nK++; continue; }
    rqi[i] = C * Math.sqrt(kk / p); phiz[i] = p / (1 - p); fzi[i] = rqi[i] / phiz[i]; nValid++;
  }
  if (phiMax > 0.6) report.messages.push(`Converted porosity reaches ${phiMax.toFixed(2)} (> 0.6 v/v). Check that the porosity unit (${phiUnit}) is correct.`);
  if (nEx) report.excluded.push({ reason: 'excluded by QC filter', n: nEx });
  if (nMiss) report.excluded.push({ reason: 'missing φ or k', n: nMiss });
  if (nPhi) report.excluded.push({ reason: 'φ outside (0, 1) after conversion', n: nPhi });
  if (nK) report.excluded.push({ reason: 'k ≤ 0 (log/sqrt undefined)', n: nK });
  if (pf !== 1) report.messages.push('Porosity converted from percent to fraction (÷100).');
  if (kf !== 1) report.messages.push(`Permeability converted from ${PERM_LABEL[kUnit]} to mD (×${kf}).`);
  report.nValid = nValid;
  return { report, phi, k, rqi, phiz, fzi } as const;
}

/** Run on a core dataset and write standardised columns into the core arrays. */
export function computeCoreHfu(meta: CoreMeta, arr: CoreArrays, C: number) {
  const phiCol = meta.map.phi && arr.num.get(meta.map.phi); const kCol = meta.map.k && arr.num.get(meta.map.k);
  if (!phiCol || !kCol) throw new Error('Map porosity and permeability columns in Core Data before running RQI/FZI.');
  const r = computeRqiFzi(phiCol, kCol, meta.phiUnit, meta.kUnit, C, arr.excluded);
  if (r.report.status !== 'OK') return { report: r.report, columns: [] as { name: string; unit: string }[] };
  const logf = Float64Array.from(r.fzi!, (v) => (v > 0 ? Math.log10(v) : NaN));
  const set: [string, Float64Array, string][] = [['PHI', r.phi!, 'v/v'], ['K', r.k!, 'mD'], ['RQI', r.rqi!, 'µm'], ['PHIZ', r.phiz!, 'v/v'], ['FZI', r.fzi!, 'µm'], ['LOG_FZI', logf, 'log10 µm'], ['LOG_RQI', Float64Array.from(r.rqi!, (v) => (v > 0 ? Math.log10(v) : NaN)), 'log10 µm'], ['LOG_PHIZ', Float64Array.from(r.phiz!, (v) => (v > 0 ? Math.log10(v) : NaN)), 'log10'], ['LOG_K', Float64Array.from(r.k!, (v) => (v > 0 ? Math.log10(v) : NaN)), 'log10 mD']];
  for (const [nm, a] of set) arr.num.set(nm, a);
  return { report: r.report, columns: set.map(([name, , unit]) => ({ name, unit })) };
}

export const DERIVED_CORE_COLS = ['PHI', 'K', 'RQI', 'PHIZ', 'FZI', 'LOG_FZI', 'LOG_RQI', 'LOG_PHIZ', 'LOG_K'];

/** Classify FZI into units using ascending thresholds (log10 or linear FZI thresholds given in FZI units). */
export function classifyFzi(fzi: ArrayLike<number>, boundaries: number[]): Int16Array {
  const out = new Int16Array(fzi.length);
  for (let i = 0; i < fzi.length; i++) {
    const v = fzi[i]; if (!(v > 0)) { out[i] = 0; continue; }
    let u = 1; for (const b of boundaries) if (v > b) u++; out[i] = u;
  }
  return out;
}

export const kFromFzi = (fzi: number, phi: number, C: number) => (fzi > 0 && phi > 0 && phi < 1 ? phi * Math.pow((fzi * (phi / (1 - phi))) / C, 2) : NaN);
