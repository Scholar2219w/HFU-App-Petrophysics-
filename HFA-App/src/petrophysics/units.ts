import type { PermUnit, PhiUnit } from '../types';

export const PERM_TO_MD: Record<PermUnit, number> = { mD: 1, D: 1000, um2: 1013.25, m2: 1.01325e15 };
export const PERM_LABEL: Record<PermUnit, string> = { mD: 'mD', D: 'D', um2: 'µm²', m2: 'm²' };

export interface UnitGuess<T> { unit: T | null; confident: boolean; reason: string }

export function guessPhiUnit(unitStr: string, p95?: number, max?: number): UnitGuess<PhiUnit> {
  const u = (unitStr || '').trim().toLowerCase();
  if (/%|pu|percent|p\.u/.test(u)) return { unit: 'percent', confident: true, reason: `unit string "${unitStr}"` };
  if (/v\/v|frac|dec|m3\/m3|ft3\/ft3|cfcf|^1$/.test(u)) {
    if (max !== undefined && max > 1.5) return { unit: null, confident: false, reason: `unit "${unitStr}" says fraction but values reach ${max.toFixed(2)} — inconsistent` };
    return { unit: 'fraction', confident: true, reason: `unit string "${unitStr}"` };
  }
  if (p95 !== undefined && isFinite(p95)) {
    if (p95 > 1.5) return { unit: 'percent', confident: false, reason: `no unit; P95 = ${p95.toFixed(2)} (> 1) suggests percent` };
    return { unit: 'fraction', confident: false, reason: `no unit; P95 = ${p95.toFixed(3)} (≤ 1) suggests fraction` };
  }
  return { unit: null, confident: false, reason: 'no unit information' };
}

export function guessPermUnit(unitStr: string): UnitGuess<PermUnit> {
  const u = (unitStr || '').trim().toLowerCase().replace('μ', 'u').replace('µ', 'u');
  if (/^m?md$|millidarcy|^mdarcy$/.test(u)) return { unit: 'mD', confident: true, reason: `unit string "${unitStr}"` };
  if (/^d$|^darcy/.test(u)) return { unit: 'D', confident: true, reason: `unit string "${unitStr}"` };
  if (/um2|um\^2|um²|micron/.test(u)) return { unit: 'um2', confident: true, reason: `unit string "${unitStr}"` };
  if (/^m2$|^m\^2$/.test(u)) return { unit: 'm2', confident: true, reason: `unit string "${unitStr}"` };
  return { unit: null, confident: false, reason: unitStr ? `unrecognised unit "${unitStr}"` : 'no unit information' };
}

export const phiToFraction = (u: PhiUnit) => (u === 'percent' ? 0.01 : 1);
