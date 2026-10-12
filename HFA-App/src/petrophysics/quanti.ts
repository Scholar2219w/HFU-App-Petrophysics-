// Deterministic petrophysical evaluation (Techlog "Quanti"-style workflow):
//   bad-hole flags → shale volume (GR) → neutron-density porosity → Archie Sw (Pickett) → cut-offs & summation.
// Each method runs per ZONE with its own parameter column (zonation = reservoir intervals | formation tops | whole well).
// Samples outside every zone are left NULL: the evaluation is done on the reservoir, not on the whole well.
// All functions are pure (arrays in → arrays out); the UI stores results as calculated curves with full provenance.
import type { PetroInputs, PetroZoneParams, PetroZonation, VshMethod, WellMeta } from '../types';
import { S } from '../store/store';
import { registry } from '../data-engine/registry';
import { reservoirsForWell, zonesForWell } from '../data-engine/zones';
import { findByFamily } from '../curves/catalog';
import { isNum, percentiles } from '../util/num';

export const DEFAULT_PARAMS: PetroZoneParams = {
  bitSize: 8.5, caliThr: 1.0, drhoThr: 0.15,
  vshMethod: 'linear', grClean: NaN, grShale: NaN,
  rhoMa: 2.65, rhoFl: 1.0, nphiMa: 0, nphiFl: 1, nphiShift: 0, rhoSh: 2.55, nphiSh: 0.30, phiMax: 0.45,
  hcCorr: false, hcDensity: 0.8, mudSalinity: 100000, temperature: 100, tempUnit: 'degC', hiGas: 0.3, hiFluid: 0.3, excavation: false, invasionFactor: 1,
  a: 1, m: 2, n: 2, rw: 0.05, rwTemp: 100,
  vshCut: 0.4, phiCut: 0.08, swCut: 0.6,
};
export const VSH_LABEL: Record<VshMethod, string> = { linear: 'Linear (IGR)', larionov_tertiary: 'Larionov — Tertiary rocks', larionov_older: 'Larionov — older rocks', clavier: 'Clavier', steiber: 'Steiber' };
export const VSH_EQ: Record<VshMethod, string> = {
  linear: 'VSH = IGR',
  larionov_tertiary: 'VSH = 0.083·(2^(3.7·IGR) − 1)',
  larionov_older: 'VSH = 0.33·(2^(2·IGR) − 1)',
  clavier: 'VSH = 1.7 − √(3.38 − (IGR + 0.7)²)',
  steiber: 'VSH = IGR / (3 − 2·IGR)',
};

export interface PetroZone { key: string; name: string; top: number; base: number }
/** Zone columns of the parameter table for a well. */
export function petroZones(wellId: string, zonation: PetroZonation): PetroZone[] {
  const w = S().wells.find((x) => x.id === wellId); if (!w) return [];
  if (zonation === 'reservoir') return reservoirsForWell(wellId).map((r) => ({ key: 'RES:' + r.id, name: r.name, top: r.top, base: r.base }));
  if (zonation === 'tops') { const rv = S().petro.resOnly !== false ? reservoirsForWell(wellId) : []; return zonesForWell(wellId).filter((z) => !rv.length || rv.some((r) => r.top < z.base && r.base > z.top)).map((z) => ({ key: z.name, name: z.name, top: z.top, base: z.base })); }
  return [{ key: 'WELL', name: 'Whole well', top: w.start, base: w.stop + 1e-6 }];
}
export function paramsFor(wellId: string, key: string): PetroZoneParams {
  const p = S().petro.params[wellId] ?? {};
  return { ...DEFAULT_PARAMS, ...(p['*'] ?? {}), ...(p[key] ?? {}) } as PetroZoneParams;
}

export function autoInputs(well: WellMeta): PetroInputs {
  const names = well.curves.map((c) => c.mnemonic); const al = S().aliases;
  const pick = (...f: string[]) => { for (const x of f) { const m = names.includes(x) ? x : findByFamily(names, x, al); if (m) return m; } return ''; };
  return { gr: pick('GR'), rhob: pick('RHOB'), nphi: pick('NPHI'), rt: pick('AT90', 'RT'), cali: pick('CALI'), bs: pick('BS'), drho: pick('DRHO'), rxo: pick('RXO', 'AT10', 'RS'), vsh: 'VSH_GR', phit: 'PHIT_ND' };
}
export function inputsFor(well: WellMeta): PetroInputs { return { ...autoInputs(well), ...(S().petro.inputs[well.id] ?? {}) } as PetroInputs; }

// ── helpers ──
export const toDegC = (t: number, u: 'degC' | 'degF') => (u === 'degF' ? (t - 32) / 1.8 : t);
/** Arps: R2 = R1·(T1 + 21.5)/(T2 + 21.5)  (°C) */
export const arps = (r1: number, t1C: number, t2C: number) => r1 * (t1C + 21.5) / (t2C + 21.5);
/** NaCl brine resistivity from salinity (ppm) at T (°C) — Bateman & Konen: R75°F = 0.0123 + 3647.5/ppm^0.955 */
export function brineRes(ppm: number, tC: number) { const r75 = 0.0123 + 3647.5 / Math.pow(Math.max(1, ppm), 0.955); return arps(r75, 23.9, tC); }
export const brineDensity = (ppm: number) => 1 + 0.73 * ppm / 1e6;       // g/cc, surface approx.
export const brineHI = (ppm: number) => 1 - 0.4 * ppm / 1e6;             // salt displaces hydrogen

export function vshFromIgr(igr: number, m: VshMethod) {
  switch (m) {
    case 'larionov_tertiary': return 0.083 * (Math.pow(2, 3.7 * igr) - 1);
    case 'larionov_older': return 0.33 * (Math.pow(2, 2 * igr) - 1);
    case 'clavier': return 1.7 - Math.sqrt(Math.max(0, 3.38 - Math.pow(igr + 0.7, 2)));
    case 'steiber': return igr / (3 - 2 * igr);
    default: return igr;
  }
}
const clip = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
/** ND combination: arithmetic mean (liquid-filled) or root-mean-square when neutron < density porosity (gas crossover). */
export const ndCombine = (phiD: number, phiN: number) => (phiN >= phiD ? (phiD + phiN) / 2 : Math.sqrt((phiD * phiD + phiN * phiN) / 2));

export interface NpUnitCheck { factor: number; note: string }
/** Neutron may be in p.u. (%) — detect from P95. */
export function neutronUnit(nphi: ArrayLike<number>, unit: string): NpUnitCheck {
  if (/%|pu|p\.u/i.test(unit)) return { factor: 0.01, note: `neutron unit "${unit}" → ÷100 to v/v` };
  const p95 = percentiles(nphi as any, [95])[0];
  if (p95 > 1.5) return { factor: 0.01, note: `neutron P95 = ${p95.toFixed(1)} > 1.5 → treated as p.u., ÷100` };
  return { factor: 1, note: 'neutron in v/v' };
}

export interface ZoneRun { key: string; name: string; top: number; base: number; n: number; p: PetroZoneParams; notes: string[] }
export interface PetroRun {
  wellId: string; zonation: PetroZonation; zones: ZoneRun[]; inputs: PetroInputs;
  out: Record<string, Float32Array>; formulas: Record<string, string>; units: Record<string, string>; warnings: string[]; nIn: number;
}

/** Run the checked methods. Returns new curves; does not touch the store. */
export function runPetro(well: WellMeta, zonation: PetroZonation, methods: { badhole: boolean; vsh: boolean; nd: boolean; sw: boolean; cutoff: boolean }): PetroRun {
  const d = registry.depth(well.id); if (!d) throw new Error('Depth index not loaded.');
  const N = d.length; const inp = inputsFor(well); const warnings: string[] = [];
  const zones = petroZones(well.id, zonation);
  if (!zones.length) throw new Error(zonation === 'reservoir' ? 'No reservoir interval defined for this well. Define it in Reservoir Intervals (or switch zonation).' : 'No formation tops for this well.');
  const get = (m: string) => (m ? registry.curve(well.id, m) : undefined);
  const nanArr = () => new Float32Array(N).fill(NaN);
  const zoneIdx = new Int16Array(N).fill(-1);
  zones.forEach((z, k) => { for (let i = 0; i < N; i++) if (zoneIdx[i] < 0 && d[i] >= z.top && d[i] < z.base) zoneIdx[i] = k; });
  const resIv = zonation !== 'reservoir' && S().petro.resOnly !== false ? reservoirsForWell(well.id) : [];
  if (resIv.length) for (let i = 0; i < N; i++) if (zoneIdx[i] >= 0 && !resIv.some((r) => d[i] >= r.top && d[i] < r.base)) zoneIdx[i] = -1;
  if (resIv.length) warnings.push(`Formation zonation restricted to the reservoir intervals (${resIv.map((r) => `${r.top}–${r.base}`).join(', ')}).`);
  const zr: ZoneRun[] = zones.map((z) => ({ ...z, n: 0, p: paramsFor(well.id, z.key), notes: [] }));
  for (let i = 0; i < N; i++) if (zoneIdx[i] >= 0) zr[zoneIdx[i]].n++;
  const nIn = zr.reduce((a, z) => a + z.n, 0);
  const out: Record<string, Float32Array> = {}; const formulas: Record<string, string> = {}; const units: Record<string, string> = {};
  const P = (i: number) => zr[zoneIdx[i]].p;
  const zoneTxt = (f: (p: PetroZoneParams) => string) => zr.map((z) => `[${z.name}] ${f(z.p)}`).join('; ');

  // ── 1 · bad hole ──
  const cali = get(inp.cali), bs = get(inp.bs), drho = get(inp.drho);
  if (methods.badhole) {
    if (cali) {
      const f = nanArr(); for (let i = 0; i < N; i++) { if (zoneIdx[i] < 0) continue; const c = cali[i]; const b = bs ? bs[i] : P(i).bitSize; if (!isNum(c) || !isNum(b)) continue; f[i] = c - b > P(i).caliThr ? 1 : 0; }
      if (!bs) { const b2 = nanArr(); for (let i = 0; i < N; i++) if (zoneIdx[i] >= 0) b2[i] = P(i).bitSize; out.BS = b2; units.BS = 'in'; formulas.BS = `bit size parameter per zone (no BS curve): ${zoneTxt((p) => `${p.bitSize} in`)}`; }
      out.BH_FL_BS = f; units.BH_FL_BS = ''; formulas.BH_FL_BS = `1 if ${inp.cali} − ${bs ? inp.bs : 'bit size'} > threshold; ${zoneTxt((p) => `${bs ? '' : `BS=${p.bitSize} in, `}thr=${p.caliThr} in`)}`;
    } else warnings.push('Bad hole (caliper): no caliper curve mapped — BH_FL_BS not computed.');
    if (drho) {
      const f = nanArr(); for (let i = 0; i < N; i++) { if (zoneIdx[i] < 0 || !isNum(drho[i])) continue; f[i] = Math.abs(drho[i]) > P(i).drhoThr ? 1 : 0; }
      out.BH_FL_DRHO = f; units.BH_FL_DRHO = ''; formulas.BH_FL_DRHO = `1 if |${inp.drho}| > threshold; ${zoneTxt((p) => `thr=${p.drhoThr} g/cc`)}`;
    } else warnings.push('Bad hole (density correction): no DRHO curve mapped — BH_FL_DRHO not computed.');
  }

  // ── 2 · shale volume ──
  const gr = get(inp.gr);
  let vsh: ArrayLike<number> | undefined = inp.vsh && inp.vsh !== 'VSH_GR' ? get(inp.vsh) : undefined;
  if (methods.vsh) {
    if (!gr) throw new Error('Shale volume: map a gamma-ray curve (Inputs tab).');
    zr.forEach((z, k) => { if (!isNum(z.p.grClean) || !isNum(z.p.grShale)) { const v: number[] = []; for (let i = 0; i < N; i++) if (zoneIdx[i] === k && isNum(gr[i])) v.push(gr[i]); const [p5, p50, p95] = v.length ? percentiles(v, [5, 50, 95]) : [NaN, NaN, NaN]; const pk = { p5, p50, p95 }; z.p = { ...z.p, grClean: pk.p5, grShale: pk.p95 }; z.notes.push(`GR clean/shale not set → P5/P95 of the zone used (${pk.p5.toFixed(1)} / ${pk.p95.toFixed(1)} gAPI)`); } });
    const v = nanArr(); const ig = nanArr();
    for (let i = 0; i < N; i++) { if (zoneIdx[i] < 0 || !isNum(gr[i])) continue; const p = P(i); const igr = clip((gr[i] - p.grClean) / (p.grShale - p.grClean), 0, 1); ig[i] = igr; v[i] = clip(vshFromIgr(igr, p.vshMethod), 0, 1); }
    out.IGR = ig; units.IGR = 'v/v'; formulas.IGR = `(${inp.gr} − GRclean)/(GRshale − GRclean), clipped 0–1; ${zoneTxt((p) => `GRcl=${p.grClean.toFixed(1)}, GRsh=${p.grShale.toFixed(1)}`)}`;
    out.VSH_GR = v; units.VSH_GR = 'v/v'; formulas.VSH_GR = `${zoneTxt((p) => VSH_EQ[p.vshMethod])}; clipped 0–1`; vsh = v;
  } else if (!vsh) { const ex = get('VSH_GR'); if (ex) vsh = ex; }

  // ── 3 · neutron–density porosity ──
  const rhob = get(inp.rhob), nphiRaw = get(inp.nphi), rt = get(inp.rt);
  let phit: ArrayLike<number> | undefined = get(inp.phit && inp.phit !== 'PHIT_ND' ? inp.phit : '');
  if (methods.nd) {
    if (!rhob || !nphiRaw) throw new Error('Neutron-density porosity: map RHOB and NPHI curves (Inputs tab).');
    const nu = neutronUnit(nphiRaw, well.curves.find((c) => c.mnemonic === inp.nphi)?.unit ?? ''); if (nu.factor !== 1) warnings.push(nu.note);
    const unc = nanArr(), pt = nanArr(), pe = nanArr(), pd = nanArr(), pn = nanArr(), hc = nanArr(), sxoA = nanArr();
    const bh = out.BH_FL_DRHO ?? out.BH_FL_BS;
    let nBad = 0;
    for (let i = 0; i < N; i++) {
      if (zoneIdx[i] < 0) continue; const p = P(i); const rb = rhob[i], nn = nphiRaw[i] * nu.factor; if (!isNum(rb) || !isNum(nn)) continue;
      const phiD = (p.rhoMa - rb) / (p.rhoMa - p.rhoFl);
      const phiN = ((nn + p.nphiShift) - p.nphiMa) / (p.nphiFl - p.nphiMa);
      pd[i] = phiD; pn[i] = phiN;
      let phi = ndCombine(phiD, phiN);
      if (p.hcCorr && rt && isNum(rt[i]) && rt[i] > 0) {
        // iterative hydrocarbon correction: flushed-zone fluid = Sxo·mud filtrate + (1 − Sxo)·hydrocarbon
        const tC = toDegC(p.temperature, p.tempUnit), rwT = arps(p.rw, toDegC(p.rwTemp, p.tempUnit), tC);
        const rhoMf = brineDensity(p.mudSalinity), hiMf = brineHI(p.mudSalinity), hiHc = p.hcDensity < 0.45 ? p.hiGas : p.hiFluid;
        let sxo = 1;
        for (let it = 0; it < 12; it++) {
          const sw = clip(Math.pow((p.a * rwT) / (Math.pow(Math.max(phi, 1e-3), p.m) * rt[i]), 1 / p.n), 0, 1);
          sxo = Math.pow(sw, 1 / Math.max(1e-3, p.invasionFactor)); const shr = 1 - sxo;
          const rhoFlEff = sxo * rhoMf + shr * p.hcDensity; const hiEff = sxo * hiMf + shr * hiHc;
          const fD = (p.rhoMa - rb) / (p.rhoMa - rhoFlEff);
          const ex = p.excavation ? (2 * phi * phi * shr + 0.04 * phi) * shr : 0;   // Gaymard excavation term (K = 1)
          const fN = (phiN + ex) / Math.max(0.05, hiEff);
          const nxt = (fD + fN) / 2; if (Math.abs(nxt - phi) < 1e-5) { phi = nxt; break; } phi = nxt;
        }
        hc[i] = phi; sxoA[i] = sxo;
      }
      unc[i] = phi; pt[i] = clip(phi, 0, p.phiMax);
      if (vsh && isNum(vsh[i])) {
        const phiDsh = (p.rhoMa - p.rhoSh) / (p.rhoMa - p.rhoFl), phiNsh = (p.nphiSh - p.nphiMa) / (p.nphiFl - p.nphiMa);
        const e = ndCombine(phiD - vsh[i] * phiDsh, phiN - vsh[i] * phiNsh); pe[i] = clip(e, 0, pt[i]);
      }
      if (bh && bh[i] > 0) nBad++;
    }
    out.PHID_ND = pd; units.PHID_ND = 'v/v'; formulas.PHID_ND = `(ρma − ${inp.rhob})/(ρma − ρfl); ${zoneTxt((p) => `ρma=${p.rhoMa}, ρfl=${p.rhoFl}`)}`;
    out.PHIN_ND = pn; units.PHIN_ND = 'v/v'; formulas.PHIN_ND = `((${inp.nphi}${nu.factor !== 1 ? '/100' : ''} + ΔN) − Nma)/(Nfl − Nma); ${zoneTxt((p) => `ΔN=${p.nphiShift}, Nma=${p.nphiMa}, Nfl=${p.nphiFl}`)}`;
    out.PHIT_ND_UNCL = unc; units.PHIT_ND_UNCL = 'v/v'; formulas.PHIT_ND_UNCL = `PHIN ≥ PHID: (PHID + PHIN)/2 ; PHIN < PHID (gas crossover): √((PHID² + PHIN²)/2)${zr.some((z) => z.p.hcCorr) ? ' ; hydrocarbon-corrected iteratively where enabled' : ''} — unclipped`;
    out.PHIT_ND = pt; units.PHIT_ND = 'v/v'; formulas.PHIT_ND = `PHIT_ND_UNCL clipped to [0, φmax]; ${zoneTxt((p) => `φmax=${p.phiMax}`)}`;
    if (vsh) { out.PHIE_ND = pe; units.PHIE_ND = 'v/v'; formulas.PHIE_ND = `ND combination of shale-corrected PHID − VSH·PHIDsh and PHIN − VSH·PHINsh, clipped to [0, PHIT_ND]; ${zoneTxt((p) => `ρsh=${p.rhoSh}, Nsh=${p.nphiSh}`)}`; }
    if (zr.some((z) => z.p.hcCorr)) { out.PHIT_ND_HC = hc; units.PHIT_ND_HC = 'v/v'; formulas.PHIT_ND_HC = 'Iterative HC correction: ρfl,eff = Sxo·ρmf + (1−Sxo)·ρhc; HIeff = Sxo·HImf + (1−Sxo)·HIhc; Sxo = Sw^(1/invasion factor); Sw Archie on Rt; ρmf, HImf from mud salinity'; out.SXO_ND = sxoA; units.SXO_ND = 'v/v'; formulas.SXO_ND = 'Sxo = SW_AR^(1/invasion factor) (hydrocarbon-correction loop)'; }
    if (nBad) warnings.push(`${nBad} reservoir samples are flagged as bad hole — density-derived porosity there is unreliable (see BH_FL_* tracks). Values are kept, not removed.`);
    phit = pt;
  } else if (!phit) { const ex = get('PHIT_ND'); if (ex) phit = ex; }

  // ── 4 · Archie water saturation ──
  if (methods.sw) {
    if (!rt) throw new Error('Water saturation: map a deep resistivity curve (Inputs tab).');
    if (!phit) throw new Error('Water saturation: total porosity needed (run neutron-density or map a porosity curve).');
    const sw = nanArr(), swu = nanArr(), bvw = nanArr(), rwa = nanArr();
    for (let i = 0; i < N; i++) {
      if (zoneIdx[i] < 0) continue; const p = P(i); const ph = phit[i], r = rt[i]; if (!isNum(ph) || !isNum(r) || r <= 0 || ph <= 0) continue;
      const rwT = arps(p.rw, toDegC(p.rwTemp, p.tempUnit), toDegC(p.temperature, p.tempUnit));
      const s = Math.pow((p.a * rwT) / (Math.pow(ph, p.m) * r), 1 / p.n); swu[i] = s; sw[i] = clip(s, 0, 1); bvw[i] = ph * sw[i]; rwa[i] = r * Math.pow(ph, p.m) / p.a;
    }
    out.SW_AR = sw; units.SW_AR = 'v/v'; formulas.SW_AR = `Archie: Sw = (a·Rw / (φ^m · ${inp.rt}))^(1/n), φ = ${methods.nd ? 'PHIT_ND' : inp.phit}, clipped 0–1; Rw corrected to formation T (Arps); ${zoneTxt((p) => `a=${p.a}, m=${p.m}, n=${p.n}, Rw=${p.rw}@${p.rwTemp}°${p.tempUnit === 'degF' ? 'F' : 'C'}, T=${p.temperature}`)}`;
    out.SW_AR_UNCL = swu; units.SW_AR_UNCL = 'v/v'; formulas.SW_AR_UNCL = 'Archie Sw before clipping';
    out.BVW = bvw; units.BVW = 'v/v'; formulas.BVW = 'PHIT × SW_AR';
    out.RWA = rwa; units.RWA = 'ohm.m'; formulas.RWA = `apparent Rw = ${inp.rt}·φ^m / a`;
  }

  // ── 5 · cut-offs ──
  if (methods.cutoff) {
    const ph = out.PHIE_ND ?? phit, v = vsh, s = out.SW_AR ?? get('SW_AR');
    if (!ph) warnings.push('Cut-offs: no porosity available.');
    else {
      const nr = nanArr(), np = nanArr();
      for (let i = 0; i < N; i++) { if (zoneIdx[i] < 0 || !isNum(ph[i])) continue; const p = P(i); const res = ph[i] >= p.phiCut && (!v || !isNum(v[i]) || v[i] <= p.vshCut); nr[i] = res ? 1 : 0; np[i] = res && s && isNum(s[i]) && s[i] <= p.swCut ? 1 : 0; }
      out.NET_RES = nr; units.NET_RES = ''; formulas.NET_RES = `1 if ${out.PHIE_ND ? 'PHIE_ND' : 'PHIT'} ≥ φcut AND VSH ≤ Vshcut; ${zoneTxt((p) => `φcut=${p.phiCut}, Vshcut=${p.vshCut}`)}`;
      out.NET_PAY = np; units.NET_PAY = ''; formulas.NET_PAY = `NET_RES AND SW_AR ≤ Swcut; ${zoneTxt((p) => `Swcut=${p.swCut}`)}`;
    }
  }
  return { wellId: well.id, zonation, zones: zr, inputs: inp, out, formulas, units, warnings, nIn };
}

/** P5 / P50 / P95 of GR inside [top, base) (and inside the reservoir when resIv is given) — Techlog "GR p5–p95" pick. */
export function grPicks(d: Float64Array, gr: ArrayLike<number>, top: number, base: number, resIv: { top: number; base: number }[] = []) {
  const v: number[] = []; for (let i = 0; i < d.length; i++) if (d[i] >= top && d[i] < base && isNum(gr[i]) && (!resIv.length || resIv.some((r) => d[i] >= r.top && d[i] < r.base))) v.push(gr[i]);
  const [p5, p50, p95] = v.length ? percentiles(v, [5, 50, 95]) : [NaN, NaN, NaN]; return { p5, p50, p95, n: v.length };
}

export interface SumRow { name: string; top: number; base: number; gross: number; netRes: number; ntg: number; netPay: number; phiAvg: number; swAvg: number; vshAvg: number; hcpv: number; phiH: number; n: number }
/** Summation per zone (thickness-weighted averages over net reservoir; Sw weighted by φ·h). */
export function summation(wellId: string, zones: PetroZone[], curves: { phi?: ArrayLike<number>; sw?: ArrayLike<number>; vsh?: ArrayLike<number>; netRes?: ArrayLike<number>; netPay?: ArrayLike<number> }): SumRow[] {
  const d = registry.depth(wellId); if (!d) return [];
  const N = d.length; const step = N > 1 ? Math.abs(d[1] - d[0]) : 0;
  const resIv = zones.some((z) => z.key.startsWith('RES:')) || S().petro.resOnly === false ? [] : reservoirsForWell(wellId);
  return zones.map((z) => {
    let gross = 0, net = 0, pay = 0, ph = 0, phS = 0, swW = 0, vs = 0, hc = 0, n = 0;
    for (let i = 0; i < N; i++) {
      if (d[i] < z.top || d[i] >= z.base) continue; if (resIv.length && !resIv.some((r) => d[i] >= r.top && d[i] < r.base)) continue; gross += step; n++;
      if (!(curves.netRes?.[i]! > 0)) continue; net += step;
      const p = curves.phi?.[i] ?? NaN, s = curves.sw?.[i] ?? NaN, v = curves.vsh?.[i] ?? NaN;
      if (isNum(p)) { ph += p * step; phS += step; if (isNum(s)) { swW += p * s * step; hc += p * (1 - s) * step; } }
      if (isNum(v)) vs += v * step;
      if (curves.netPay?.[i]! > 0) pay += step;
    }
    return { name: z.name, top: z.top, base: z.base, gross, netRes: net, ntg: gross ? net / gross : NaN, netPay: pay, phiAvg: phS ? ph / phS : NaN, swAvg: ph ? swW / ph : NaN, vshAvg: net ? vs / net : NaN, hcpv: hc, phiH: ph, n };
  });
}

/** Pickett: fit Rw (and optionally m) on the wet lower envelope. */
export function fitPickett(rt: number[], phi: number[], a: number, m: number, fitM: boolean, envelopePct = 10) {
  const pts = rt.map((r, i) => ({ r, p: phi[i] })).filter((q) => q.r > 0 && q.p > 0.01);
  if (pts.length < 8) return null;
  let mm = m;
  if (fitM) { // regress log φ on log Rt using the wettest points (lowest Rwa for the current m)
    const rwa = pts.map((q) => q.r * Math.pow(q.p, m) / a).sort((x, y) => x - y); const thr = rwa[Math.floor(rwa.length * 0.25)];
    const wet = pts.filter((q) => q.r * Math.pow(q.p, m) / a <= thr);
    if (wet.length >= 6) { const X = wet.map((q) => Math.log10(q.r)), Y = wet.map((q) => Math.log10(q.p)); const mx = X.reduce((s, x) => s + x, 0) / X.length, my = Y.reduce((s, y) => s + y, 0) / Y.length; let sxy = 0, sxx = 0; X.forEach((x, i) => { sxy += (x - mx) * (Y[i] - my); sxx += (x - mx) ** 2; }); const slope = sxy / sxx; if (slope < -0.2 && slope > -1.2) mm = -1 / slope; }
  }
  const rwa = pts.map((q) => q.r * Math.pow(q.p, mm) / a).sort((x, y) => x - y);
  return { rw: rwa[Math.max(0, Math.floor(rwa.length * envelopePct / 100))], m: mm, n: pts.length };
}

/** Reservoir intervals that restrict a formation / well zonation (empty for reservoir zonation or when switched off). */
export function restrictIv(wellId: string, zonation: PetroZonation) { return zonation !== 'reservoir' && S().petro.resOnly !== false ? reservoirsForWell(wellId) : []; }
