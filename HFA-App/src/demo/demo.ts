// Synthetic demo dataset — DEMO DATA — NOT REAL RESERVOIR DATA.
// Petrophysically consistent: FZI per unit → k(φ); logs forward-modelled from
// φ, Vsh, Sw with noise and vertical smoothing; core depths offset to exercise
// depth matching.
import { setReservoirs } from '../data-engine/reservoir';
import { rng } from '../clustering/core';
import { ingestLog } from '../data-engine/ingest';
import { createCore } from '../data-engine/core';
import type { ParsedLog } from '../parsers/types';
import { S } from '../store/store';
import { hfuColor, uid } from '../util/num';

export const DEMO_BANNER = 'DEMO DATA — NOT REAL RESERVOIR DATA';

const UNITS = [ // synthetic "true" flow units
  { fzi: 0.35, phi: 0.085, vsh: 0.38, sw: 0.85, facies: 'Shaly siltstone' },
  { fzi: 1.1, phi: 0.13, vsh: 0.22, sw: 0.6, facies: 'Fine sandstone' },
  { fzi: 3.2, phi: 0.18, vsh: 0.1, sw: 0.35, facies: 'Medium sandstone' },
  { fzi: 8.5, phi: 0.23, vsh: 0.04, sw: 0.2, facies: 'Coarse sandstone' },
];

function gauss(R: () => number) { let u = 0, v = 0; while (u === 0) u = R(); while (v === 0) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function smooth(a: Float64Array, w: number) {
  const out = new Float64Array(a.length); const h = Math.floor(w / 2);
  for (let i = 0; i < a.length; i++) { let s = 0, n = 0; for (let k = -h; k <= h; k++) { const j = i + k; if (j >= 0 && j < a.length) { const wt = 1 - Math.abs(k) / (h + 1); s += a[j] * wt; n += wt; } } out[i] = s / n; }
  return out;
}

function makeWell(name: string, top: number, base: number, seed: number, coreTop: number, coreBase: number, coreShift: number) {
  const R = rng(seed); const step = 0.1524; const n = Math.floor((base - top) / step) + 1;
  const depth = Float64Array.from({ length: n }, (_, i) => +(top + i * step).toFixed(4));
  // layered unit sequence (Markov chain, persistence)
  const unit = new Int8Array(n); let u = 1, left = 0;
  const trans = [[0.5, 0.35, 0.1, 0.05], [0.3, 0.35, 0.25, 0.1], [0.1, 0.3, 0.35, 0.25], [0.05, 0.15, 0.4, 0.4]];
  for (let i = 0; i < n; i++) {
    if (left <= 0) { const r = R(); let c = 0; for (let k = 0; k < 4; k++) { c += trans[u][k]; if (r <= c) { u = k; break; } } left = Math.round((1.5 + R() * 7) / step); }
    // shale-dominated sections above/below the reservoir
    const inRes = depth[i] > top + 60 && depth[i] < base - 50; unit[i] = inRes ? u : 0; left--;
  }
  const phi = new Float64Array(n), vsh = new Float64Array(n), sw = new Float64Array(n), fzi = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const U = UNITS[unit[i]];
    phi[i] = Math.max(0.02, U.phi + 0.02 * gauss(R)); vsh[i] = Math.min(0.9, Math.max(0, U.vsh + 0.06 * gauss(R)));
    sw[i] = Math.min(1, Math.max(0.1, U.sw + 0.06 * gauss(R))); fzi[i] = U.fzi * Math.exp(0.22 * gauss(R));
  }
  const phiS = smooth(phi, 5), vshS = smooth(vsh, 5), swS = smooth(sw, 5);
  const C = 0.0314; const kTrue = Float64Array.from(phi, (p, i) => p * Math.pow((fzi[i] * p) / (1 - p) / C, 2));
  const f32 = (f: (i: number) => number) => Float32Array.from({ length: n }, (_, i) => f(i));
  const GR = f32((i) => 18 + 125 * vshS[i] + 4 * gauss(R));
  const RHOB = f32((i) => 2.65 * (1 - phiS[i] - vshS[i]) + 2.5 * vshS[i] + (swS[i] * 1.03 + (1 - swS[i]) * 0.75) * phiS[i] + 0.012 * gauss(R));
  const NPHI = f32((i) => phiS[i] * (0.85 + 0.15 * swS[i]) + 0.32 * vshS[i] + 0.012 * gauss(R));
  const DT = f32((i) => 55.5 + (189 - 55.5) * 0.72 * phiS[i] + 38 * vshS[i] + 1.5 * gauss(R));
  const Rw = 0.06;
  const RT = f32((i) => { const ct = (Math.pow(phiS[i], 2) * Math.pow(swS[i], 2)) / Rw + vshS[i] / 4; return Math.min(2000, 1 / ct) * Math.exp(0.05 * gauss(R)); });
  const RXO = f32((i) => Math.min(2000, 1 / ((Math.pow(phiS[i], 2) * 0.8) / 0.2 + vshS[i] / 3)) * Math.exp(0.06 * gauss(R)));
  const CALI = f32((i) => 8.5 + (vshS[i] > 0.3 ? 0.6 * vshS[i] : 0) + 0.05 * gauss(R));
  const CMRP = f32((i) => Math.max(0, phiS[i] * 0.95 + 0.01 * gauss(R)));
  const T2LM = f32((i) => 10 * Math.pow(fzi[i], 0.9) * (1 + 0.1 * gauss(R)));
  const parsed: ParsedLog = {
    format: 'DEMO', fileName: `${name}.las (synthetic)`, fileSize: n * 11 * 4, wellName: name, uwi: `DEMO-${seed}`, field: 'Demo Field',
    lasVersion: '2.0', nullValue: -999.25, depthUnit: 'm', depthMnemonic: 'DEPT', depth,
    curves: [
      { mnemonic: 'GR', unit: 'gAPI', description: 'Gamma Ray', data: GR }, { mnemonic: 'CALI', unit: 'in', description: 'Caliper', data: CALI },
      { mnemonic: 'RHOB', unit: 'g/cm3', description: 'Bulk Density', data: RHOB }, { mnemonic: 'TNPH', unit: 'v/v', description: 'Thermal Neutron Porosity', data: NPHI },
      { mnemonic: 'DTCO', unit: 'us/ft', description: 'Compressional Slowness', data: DT }, { mnemonic: 'AT90', unit: 'ohm.m', description: 'Deep Resistivity', data: RT },
      { mnemonic: 'RXOZ', unit: 'ohm.m', description: 'Flushed Zone Resistivity', data: RXO }, { mnemonic: 'CMRP', unit: 'v/v', description: 'NMR Effective Porosity', data: CMRP },
      { mnemonic: 'T2LM', unit: 'ms', description: 'NMR T2 Log-Mean', data: T2LM },
    ],
    header: [{ section: 'WELL', mnem: 'NOTE', unit: '', value: DEMO_BANNER, desc: 'Synthetic dataset' }], warnings: [DEMO_BANNER], reversed: false,
  };
  const { wellId } = ingestLog(parsed, { mode: 'new' });
  S().updateWell(wellId, (w) => ({ ...w, demo: true }));
  // core plugs every ~0.3 m in cored interval, recorded at driller's (core) depth = log depth − shift
  const cd: number[] = [], cphi: number[] = [], ck: number[] = [], cgd: number[] = [], fac: string[] = [], sid: number[] = [];
  let s = 1;
  for (let z = coreTop; z <= coreBase; z += 0.25 + R() * 0.15) {
    const i = Math.round((z - top) / step); if (i < 0 || i >= n) continue;
    const U = UNITS[unit[i]];
    cd.push(+(z - coreShift).toFixed(2)); cphi.push(+(100 * Math.max(0.01, phi[i] * (1 + 0.04 * gauss(R)))).toFixed(1));
    ck.push(+Math.max(0.001, kTrue[i] * Math.exp(0.25 * gauss(R))).toPrecision(3)); cgd.push(+(2.65 + 0.02 * gauss(R)).toFixed(3));
    fac.push(R() < 0.85 ? U.facies : UNITS[Math.min(3, Math.max(0, unit[i] + (R() < 0.5 ? -1 : 1)))].facies); sid.push(s++);
  }
  // inject QC issues: duplicate row, a null, one outlier
  cd.push(cd[5]); cphi.push(cphi[5]); ck.push(ck[5]); cgd.push(cgd[5]); fac.push(fac[5]); sid.push(s++);
  ck[12] = NaN; cgd[20] = 3.4;
  const order = cd.map((_, i) => i).sort((a, b) => cd[a] - cd[b]);
  const pick = <T,>(a: T[]) => order.map((i) => a[i]);
  createCore({
    wellId, name: `${name} RCA plugs`, source: 'synthetic', depthUnit: 'm', depth: Float64Array.from(pick(cd)),
    num: { CORE_PHI: { data: Float64Array.from(pick(cphi)), unit: '%' }, CORE_K: { data: Float64Array.from(pick(ck)), unit: 'mD' }, GRAIN_DENSITY: { data: Float64Array.from(pick(cgd)), unit: 'g/cm3' }, SAMPLE_ID: { data: Float64Array.from(pick(sid)), unit: '' } },
    text: { FACIES: pick(fac) }, map: { phi: 'CORE_PHI', k: 'CORE_K', facies: 'FACIES', grainDensity: 'GRAIN_DENSITY', sampleId: 'SAMPLE_ID' },
  });
  return wellId;
}

export function loadDemo() {
  const a = makeWell('Demo Well A', 2400, 2720, 101, 2475, 2585, 1.8);
  const b = makeWell('Demo Well B', 2430, 2760, 202, 2520, 2630, -1.2);
  const tops = [
    { w: a, name: 'Upper Shale', md: 2400 }, { w: a, name: 'Vulcan Fm (demo)', md: 2461 }, { w: a, name: 'Lower Sand (demo)', md: 2560 }, { w: a, name: 'Basal Shale', md: 2670 },
    { w: b, name: 'Upper Shale', md: 2430 }, { w: b, name: 'Vulcan Fm (demo)', md: 2491 }, { w: b, name: 'Lower Sand (demo)', md: 2598 }, { w: b, name: 'Basal Shale', md: 2710 },
  ];
  S().set({ tops: [...S().tops, ...tops.map((t, i) => ({ id: uid('t_'), wellId: t.w, name: t.name, md: t.md, color: hfuColor((i % 4) + 3) }))] });
  S().log(`Loaded demo dataset (${DEMO_BANNER}): 2 wells, 2 core datasets, 8 tops`);
  setReservoirs(a, [{ name: 'Demo reservoir', top: 2461, base: 2670, source: 'demo' }], 'replace', 'demo');
  setReservoirs(b, [{ name: 'Demo reservoir', top: 2491, base: 2710, source: 'demo' }], 'replace', 'demo');
  S().set({ activeWellId: a });
  S().bump();
}
