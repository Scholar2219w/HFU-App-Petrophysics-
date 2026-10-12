// Statistical QC engine (spec §23). Pure reads of the canonical arrays.
import { S } from '../store/store';
import { registry } from '../data-engine/registry';
import { coreDepths } from '../data-engine/core';
import { zoneMask } from '../data-engine/zones';
import type { WellMeta } from '../types';
import { fmt, isNum, pearson, percentiles } from '../util/num';

export type Level = 'CRITICAL' | 'WARNING' | 'INFO';
export interface Flag { level: Level; well: string; item: string; text: string }
export interface CurveQC { mnemonic: string; unit: string; family?: string; category: string; nullPct: number; missingPct: number; outlierPct: number; coveragePct: number; top: number; base: number; nValid: number }
export interface WellQC { well: WellMeta; curves: CurveQC[]; gaps: { top: number; base: number }[]; duplicates: number; steps: { step: number; n: number }[]; flags: Flag[] }

const LOGSCALE = /(Resistivity|Permeability)/;
const PHYS: Record<string, [number, number]> = { RHOB: [1.0, 3.3], NPHI: [-0.15, 1.0], GR: [0, 1000], DT: [30, 250], PHIT: [0, 0.6], PHIE: [0, 0.6], VSH: [0, 1], SW: [0, 1], PEF: [0, 20], CALI: [2, 40] };

export function wellQC(well: WellMeta, zone = ''): WellQC {
  const d = registry.depth(well.id)!; const flags: Flag[] = []; const W = well.name;
  const mask = zoneMask(well.id, zone) ?? new Uint8Array(d.length).fill(1);
  const idx: number[] = []; for (let i = 0; i < d.length; i++) if (mask[i]) idx.push(i);
  // depth sampling
  const stepCount = new Map<number, number>(); let dup = 0; const gaps: { top: number; base: number }[] = [];
  for (let k = 1; k < idx.length; k++) { const i = idx[k], j = idx[k - 1]; if (i !== j + 1) continue; const s = +(d[i] - d[j]).toFixed(4); if (s === 0) dup++; else stepCount.set(s, (stepCount.get(s) ?? 0) + 1); if (well.step > 0 && s > well.step * 1.5) gaps.push({ top: d[j], base: d[i] }); }
  const steps = [...stepCount].map(([step, n]) => ({ step, n })).sort((a, b) => b.n - a.n);
  const major = steps.filter((s) => s.n >= Math.max(5, 0.01 * idx.length));
  if (major.length > 1) flags.push({ level: 'WARNING', well: W, item: 'Depth', text: `Depth sampling changes from ${major[0].step} ${well.depthUnit} to ${major[1].step} ${well.depthUnit} (${major.length} distinct sampling intervals).` });
  if (dup) flags.push({ level: 'WARNING', well: W, item: 'Depth', text: `${dup} duplicate depth samples in the index.` });
  if (gaps.length) flags.push({ level: 'INFO', well: W, item: 'Depth', text: `${gaps.length} depth gaps larger than 1.5 × sampling interval.` });
  if (!well.regular) flags.push({ level: 'INFO', well: W, item: 'Depth', text: 'Irregular depth sampling (index kept as recorded; no resampling).' });
  // curves
  const curves: CurveQC[] = [];
  for (const c of well.curves) {
    const a = registry.curve(well.id, c.mnemonic); if (!a) continue;
    let nValid = 0, first = -1, last = -1;
    for (const i of idx) if (isNum(a[i])) { nValid++; if (first < 0) first = i; last = i; }
    const n = idx.length || 1;
    let inside = 0, insideNaN = 0; if (first >= 0) for (const i of idx) if (i >= first && i <= last) { inside++; if (!isNum(a[i])) insideNaN++; }
    const vals: number[] = []; const lg = LOGSCALE.test(c.category);
    for (const i of idx) { const v = a[i]; if (isNum(v) && (!lg || v > 0)) vals.push(lg ? Math.log10(v) : v); }
    let out = 0;
    if (vals.length > 20 && !c.discrete) { const [med] = percentiles(vals, [50]); const mad = percentiles(vals.map((v) => Math.abs(v - med)), [50])[0] * 1.4826 || 1e-9; for (const v of vals) if (Math.abs(v - med) > 5 * mad) out++; }
    const q: CurveQC = { mnemonic: c.mnemonic, unit: c.unit, family: c.family, category: c.category, nullPct: (100 * (n - nValid)) / n, missingPct: inside ? (100 * insideNaN) / inside : 100, outlierPct: vals.length ? (100 * out) / vals.length : 0, coveragePct: first >= 0 ? (100 * (last - first + 1)) / n : 0, top: first >= 0 ? d[first] : NaN, base: last >= 0 ? d[last] : NaN, nValid };
    curves.push(q);
    if (!c.calc && q.nValid === 0) flags.push({ level: 'WARNING', well: W, item: c.mnemonic, text: `${c.mnemonic} contains no valid samples${zone ? ` in zone ${zone}` : ''}.` });
    else if (!c.calc && !c.discrete && q.missingPct > 20) flags.push({ level: 'WARNING', well: W, item: c.mnemonic, text: `${c.mnemonic} has ${q.missingPct.toFixed(0)}% missing values inside its logged interval.` });
    if (q.outlierPct > 2) flags.push({ level: 'INFO', well: W, item: c.mnemonic, text: `${c.mnemonic}: ${q.outlierPct.toFixed(1)}% of samples beyond median ± 5·MAD${lg ? ' (log10)' : ''} — flagged, not removed.` });
    const fam = c.family ?? ''; const range = PHYS[fam];
    if (range && vals.length && !lg) { const [p1, p99] = percentiles(vals, [1, 99]); if (p99 > range[1] * 1.05 || p1 < range[0] - Math.abs(range[0]) * 0.05 - 1e-9) flags.push({ level: 'WARNING', well: W, item: c.mnemonic, text: `${c.mnemonic} values (P1 ${fmt(p1, 3)} – P99 ${fmt(p99, 3)} ${c.unit}) fall outside the physical range expected for ${fam} (${range[0]}–${range[1]}); check units.` }); }
    if (['PHIT', 'PHIE', 'NPHI', 'PHID'].includes(fam) && /%|pu/i.test(c.unit)) flags.push({ level: 'INFO', well: W, item: c.mnemonic, text: `${c.mnemonic} is in ${c.unit}; porosity-based formulas expect fractions.` });
  }
  // duplicate measurements: same family, high correlation
  const byFam = new Map<string, string[]>(); for (const c of well.curves) if (c.family && !c.calc && !c.discrete) byFam.set(c.family, [...(byFam.get(c.family) ?? []), c.mnemonic]);
  for (const [fam, ms] of byFam) for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length && j < i + 6; j++) {
    const a = registry.curve(well.id, ms[i]), b = registry.curve(well.id, ms[j]); if (!a || !b) continue;
    const lg = fam === 'RT' || fam === 'RM' || fam === 'RS' || fam === 'RXO'; const f = (x: number) => (lg ? (x > 0 ? Math.log10(x) : NaN) : x);
    const xa: number[] = [], xb: number[] = []; for (const k of idx) { const u = f(a[k]), v = f(b[k]); if (isNum(u) && isNum(v)) { xa.push(u); xb.push(v); } }
    if (xa.length > 50) { const r = pearson(xa, xb); if (r > 0.98) flags.push({ level: 'INFO', well: W, item: `${ms[i]}/${ms[j]}`, text: `${ms[i]} and ${ms[j]} appear to represent duplicate measurements (${fam}, r = ${r.toFixed(3)}, N = ${xa.length}).` }); }
  }
  // unit consistency inside a family
  for (const [fam, ms] of byFam) { const units = new Set(ms.map((m) => well.curves.find((c) => c.mnemonic === m)!.unit.toLowerCase().replace(/\s/g, ''))); if (units.size > 1) flags.push({ level: 'WARNING', well: W, item: fam, text: `Curves of family ${fam} use different units: ${[...units].join(', ')}.` }); }
  // core coverage
  for (const cm of S().cores.filter((c) => c.wellId === well.id)) {
    const arr = registry.core(cm.id); if (!arr) continue; const { shifted } = coreDepths(cm, arr);
    const inLog = Array.from(shifted).filter((z) => z >= well.start && z <= well.stop).length;
    if (inLog < cm.n) flags.push({ level: 'WARNING', well: W, item: cm.name, text: `${cm.n - inLog} of ${cm.n} core samples lie outside the logged interval.` });
    for (const [role, col] of [['porosity', cm.map.phi], ['permeability', cm.map.k]] as const) {
      if (!col) { flags.push({ level: 'WARNING', well: W, item: cm.name, text: `Core ${role} column not mapped.` }); continue; }
      const a = arr.num.get(col); if (!a) continue; const nn = Array.from(a).filter((v) => !isNum(v)).length;
      if (nn) flags.push({ level: nn / cm.n > 0.1 ? 'WARNING' : 'INFO', well: W, item: cm.name, text: `Core ${role} contains ${((100 * nn) / cm.n).toFixed(0)}% null values.` });
    }
    if (!cm.phiUnit || !cm.kUnit) flags.push({ level: 'CRITICAL', well: W, item: cm.name, text: 'FZI calculation requires consistent porosity and permeability units — confirm them in Core Data.' });
    if (!cm.depthOps.some((o) => o.active)) flags.push({ level: 'INFO', well: W, item: cm.name, text: 'No core-to-log depth shift applied (verify depth match).' });
  }
  return { well, curves, gaps, duplicates: dup, steps, flags };
}

export function projectFlags(zone = ''): Flag[] {
  const st = S(); const flags: Flag[] = [];
  for (const w of st.wells) { try { flags.push(...wellQC(w, zone).flags); } catch { /* arrays not loaded */ } }
  // cross-well unit consistency
  const famUnits = new Map<string, Set<string>>();
  for (const w of st.wells) for (const c of w.curves) if (c.family && !c.calc) { const s = famUnits.get(c.family) ?? new Set(); s.add(c.unit.toLowerCase().replace(/\s/g, '')); famUnits.set(c.family, s); }
  for (const [f, u] of famUnits) if (u.size > 1 && st.wells.length > 1) flags.push({ level: 'INFO', well: '(project)', item: f, text: `Across wells, ${f} curves use units: ${[...u].join(', ')}.` });
  return flags;
}
