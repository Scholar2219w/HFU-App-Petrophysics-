import { DepthPlot } from '../visualization/DepthPlot';
import { useMemo, useState } from 'react';
import { S, useStore, activeCore } from '../store/store';
import { registry } from '../data-engine/registry';
import { coreCol, coreDepths, sampleLogAt } from '../data-engine/core';
import { putCalculatedCurve } from '../data-engine/ingest';
import { evaluate } from '../petrophysics/formula';
import { fit1d } from '../regression/fit1d';
import { findByFamily } from '../curves/catalog';
import { Box, CurvePicker, Empty, Field, ModHead, Msgs, Num, Sel, Tabs, useActiveWell } from './common';
import { CoreSelector } from './CoreManager';
import { XYPlot } from '../visualization/XYPlot';
import { fmt, hfuColor, isNum, nowIso, PALETTE } from '../util/num';

type Tab = 'perm' | 'pc' | 'facies' | 'pressure' | 'rca' | 'roadmap';
export function Advanced() {
  const [tab, setTab] = useState<Tab>('perm');
  return <>
    <ModHead title="Advanced Modules" sub="NMR · permeability transforms · MICP / SCAL / saturation-height · facies · formation pressure · RCA" />
    <Tabs value={tab} onChange={setTab} tabs={[{ v: 'perm', l: 'Permeability transforms & NMR' }, { v: 'pc', l: 'Capillary pressure / Saturation-height' }, { v: 'facies', l: 'Facies integration' }, { v: 'pressure', l: 'Formation pressure' }, { v: 'rca', l: 'Routine core analysis' }, { v: 'roadmap', l: 'Image logs · ML · Future' }]} />
    <div className="mod-b">{tab === 'perm' ? <PermTransforms /> : tab === 'pc' ? <SatHeight /> : tab === 'facies' ? <Facies /> : tab === 'pressure' ? <Pressure /> : tab === 'rca' ? <RCA /> : <Roadmap />}</div>
  </>;
}

// ── Permeability transforms (core φ–k per HFU, Winland R35, NMR Timur-Coates / SDR) ──
function PermTransforms() {
  const core = useStore((s) => activeCore(s)); const well = useActiveWell(); const sets = useStore((s) => s.hfuSets); useStore((s) => s.dataVersion);
  const [setId, setSetId] = useState(sets.find((h) => h.domain === 'core' && h.coreId === core?.id)?.id ?? '');
  const [phiC, setPhiC] = useState(''); const [hfuC, setHfuC] = useState('HFU_PRED'); const [msgs, setMsgs] = useState<{ level: any; text: string }[]>([]);
  const [nmr, setNmr] = useState({ phi: '', ffi: '', bvi: '', t2: '', c: 10, a: 4 });
  const a = core ? registry.core(core.id) : undefined;
  const fits = useMemo(() => {
    if (!core || !a) return null; const phi = coreCol(core, a, 'PHI'), k = coreCol(core, a, 'K'); if (!phi || !k) return null;
    const set = sets.find((h) => h.id === setId); const lab = set?.labels;
    const phiF = a.num.has('PHI') ? phi : Float64Array.from(phi, (v) => (core.phiUnit === 'percent' ? v / 100 : v));
    const X = Array.from(phiF, (v, i) => (a.excluded[i] ? NaN : v)), Y = Array.from(k, (v, i) => (a.excluded[i] ? NaN : v));
    const groups = lab ? [...new Set(lab.filter((l) => l > 0))].sort() : [];
    const global = fit1d(X, Y, 'power');
    const per = groups.map((g) => ({ g, f: fit1d(X.filter((_, i) => lab![i] === g), Y.filter((_, i) => lab![i] === g), 'power') }));
    const r35 = X.map((p, i) => (p > 0 && Y[i] > 0 ? Math.pow(10, 0.732 + 0.588 * Math.log10(Y[i]) - 0.864 * Math.log10(p * 100)) : NaN));
    return { X, Y, global, per, r35, lab };
  }, [core?.id, setId, useStore.getState().dataVersion]);
  const coef = (f: any) => { const m = /y = ([\d.e+-]+)·x\^([\d.e+-]+)/.exec(f.eq.replace('−', '-')); return m ? { a: +m[1], b: +m[2] } : null; };
  const apply = () => {
    if (!well || !fits) return; const nm0 = well.curves.map((c) => c.mnemonic); const phiE = phiC || findByFamily(nm0, 'PHIE') || findByFamily(nm0, 'PHIT') || findByFamily(nm0, 'CMRP') || ''; const phi = registry.curve(well.id, phiE); if (!phi) { setMsgs([{ level: 'CRITICAL', text: 'Select a porosity curve (fraction).' }]); return; }
    const h = registry.curve(well.id, hfuC); const out = new Float32Array(phi.length).fill(NaN);
    const g = fits.global && coef(fits.global); const per = new Map(fits.per.filter((p) => p.f).map((p) => [p.g, coef(p.f)]));
    for (let i = 0; i < phi.length; i++) { const p = phi[i]; if (!(p > 0)) continue; const c = h && isNum(h[i]) && per.get(Math.round(h[i])) ? per.get(Math.round(h[i])) : g; if (c) out[i] = c.a * Math.pow(p, c.b); }
    putCalculatedCurve(well.id, 'K_TRANSFORM', out, 'mD', 'Core φ–k power-law transform', { kind: 'formula', formula: `K = a·φ^b; ${per.size && h ? `per ${hfuC} unit: ${[...per].map(([u, c]) => `[${u}] a=${fmt(c!.a, 4)}, b=${fmt(c!.b, 4)}`).join('; ')}; else ` : ''}global a=${fmt(g?.a, 4)}, b=${fmt(g?.b, 4)}`, inputs: [phiE, ...(h ? [hfuC] : [])], units: 'mD', version: 1, missing: 'NaN where φ ≤ 0 or missing', createdAt: nowIso(), notes: `Fitted on core "${core!.name}"` });
    S().log(`Created K_TRANSFORM on ${well.name} from core φ–k power-law${per.size && h ? ` per ${hfuC} unit` : ''}`); setMsgs([{ level: 'OK', text: 'K_TRANSFORM created.' }]);
  };
  const nmrCurve = (kind: 'coates' | 'sdr', m = nmr) => {
    if (!well) return;
    const expr = kind === 'coates' ? `((${m.phi} * 100) / ${m.c}) ^ 4 * (${m.ffi} / ${m.bvi}) ^ 2` : `${m.a} * ${m.t2} ^ 2 * ${m.phi} ^ 4`;
    const vars = kind === 'coates' ? [m.phi, m.ffi, m.bvi] : [m.t2, m.phi]; if (vars.some((v) => !v)) { setMsgs([{ level: 'CRITICAL', text: 'Select all NMR input curves.' }]); return; }
    const arrs: Record<string, Float32Array> = {}; for (const v of vars) arrs[v] = registry.curve(well.id, v)!;
    const r = evaluate(expr, arrs, well.nSamples, { clip: [0, 1e6] }); const nm = kind === 'coates' ? 'K_COATES' : 'K_SDR';
    putCalculatedCurve(well.id, nm, r.out, 'mD', kind === 'coates' ? 'Timur-Coates NMR permeability' : 'SDR NMR permeability', { kind: 'formula', formula: expr, inputs: vars, units: 'mD', version: 1, missing: 'NaN if any input missing; clipped to [0, 1e6]', createdAt: nowIso(), notes: kind === 'coates' ? 'K = (φ[p.u.]/C)^4 · (FFI/BVI)^2 — calibrate C against core' : 'K = a · T2LM² · φ⁴ (T2LM in ms, φ fraction) — calibrate a against core' });
    S().log(`Created ${nm} on ${well.name}: ${expr}`); setMsgs([{ level: 'OK', text: `${nm} created — compare with core K in the crossplot studio to calibrate.` }]);
  };
  const names = well?.curves.map((c) => c.mnemonic) ?? [];
  return <div className="split w380">
    <div className="col">
      <Box title="Core φ–k transform"><Field label="Core"><CoreSelector /></Field>
        <Field label="HFU set (per-unit fits)"><select value={setId} onChange={(e) => setSetId(e.target.value)}><option value="">— global only —</option>{sets.filter((h) => h.domain === 'core').map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></Field>
        {fits ? <table className="t"><thead><tr><th>Group</th><th>K = a·φ^b</th><th>R² (log)</th><th>N</th></tr></thead><tbody>
          {fits.global && <tr><td>global</td><td className="mono">{fits.global.eq}</td><td className="num">{fmt(fits.global.r2, 3)}</td><td className="num">{fits.global.n}</td></tr>}
          {fits.per.map((p) => <tr key={p.g}><td><span className="pill" style={{ background: hfuColor(p.g) }} />{p.g}</td><td className="mono">{p.f?.eq ?? 'too few samples'}</td><td className="num">{fmt(p.f?.r2, 3)}</td><td className="num">{p.f?.n ?? 0}</td></tr>)}
        </tbody></table> : <span className="hint">Needs a core dataset with mapped φ and k (run RQI/FZI to standardise units).</span>}
        {well && <><Field label="Apply: porosity curve"><CurvePicker wellId={well.id} value={phiC || findByFamily(names, 'PHIE') || ''} onChange={setPhiC} /></Field>
          <Field label="HFU curve (optional)"><CurvePicker wellId={well.id} value={hfuC} onChange={setHfuC} allowNone="— none —" filter={(m) => !!well.curves.find((c) => c.mnemonic === m)?.discrete} /></Field>
          <button className="btn pri" onClick={apply}>Create K_TRANSFORM</button></>}
      </Box>
      <Box title="NMR permeability (well)">
        {well ? <>{(['phi', 'ffi', 'bvi', 't2'] as const).map((k) => <Field key={k} label={{ phi: 'NMR porosity (v/v)', ffi: 'Free fluid (FFI/CMFF)', bvi: 'Bound fluid (BVI/BFV)', t2: 'T2 log-mean (ms)' }[k]}><select value={nmr[k] || ({ phi: findByFamily(names, 'CMRP') ?? findByFamily(names, 'TCMR'), ffi: findByFamily(names, 'CMFF'), bvi: findByFamily(names, 'BFV'), t2: findByFamily(names, 'T2LM') } as any)[k] || ''} onChange={(e) => setNmr({ ...nmr, [k]: e.target.value })}><option value="">—</option>{names.map((m) => <option key={m}>{m}</option>)}</select></Field>)}
          <Field label="Coates C"><Num value={nmr.c} onChange={(v) => setNmr({ ...nmr, c: v })} /></Field><Field label="SDR a"><Num value={nmr.a} onChange={(v) => setNmr({ ...nmr, a: v })} /></Field>
          <div className="row"><button className="btn" onClick={() => { const auto = { phi: nmr.phi || findByFamily(names, 'CMRP') || findByFamily(names, 'TCMR') || '', ffi: nmr.ffi || findByFamily(names, 'CMFF') || '', bvi: nmr.bvi || findByFamily(names, 'BFV') || '', t2: nmr.t2 || findByFamily(names, 'T2LM') || '' }; setNmr({ ...nmr, ...auto }); nmrCurve('coates', { ...nmr, ...auto }); }}>Timur-Coates → K_COATES</button><button className="btn" onClick={() => { const auto = { phi: nmr.phi || findByFamily(names, 'CMRP') || findByFamily(names, 'TCMR') || '', t2: nmr.t2 || findByFamily(names, 'T2LM') || '' }; setNmr({ ...nmr, ...auto }); nmrCurve('sdr', { ...nmr, ...auto }); }}>SDR → K_SDR</button></div></> : <Empty>No well.</Empty>}
      </Box>
      <Msgs items={msgs} />
    </div>
    {fits && <div className="grid2" style={{ height: 420 }}>
      <div className="box"><XYPlot title="Core K vs φ with power-law fits" logY xLabel="φ (v/v)" yLabel="K (mD)" series={[{ kind: 'scatter', x: fits.X, y: fits.Y, colors: fits.X.map((_, i) => (fits.lab?.[i] ? hfuColor(fits.lab[i]) : '#9aa4b2')), size: 2.8 }, ...(fits.global ? [{ kind: 'line' as const, x: fits.global.curve.x, y: fits.global.curve.y, color: '#fff', width: 1.6 }] : []), ...fits.per.filter((p) => p.f).map((p) => ({ kind: 'line' as const, x: p.f!.curve.x, y: p.f!.curve.y, color: hfuColor(p.g), width: 1.4 }))]} /></div>
      <div className="dcol" style={{ minHeight: 0 }}><DepthPlot title="Winland R35 vs depth — log R35 = 0.732 + 0.588 log k − 0.864 log φ(%)" wellId={core!.wellId} tracks={[{ width: 220, series: [{ depth: Array.from(coreDepths(core!, a!).shifted), values: Array.from(fits.r35), label: 'R35', unit: 'µm', color: '#7048e8', kind: 'dots', log: true, colors: fits.X.map((_, i) => (fits.lab?.[i] ? hfuColor(fits.lab[i]) : undefined)) }] }]} /></div>
    </div>}
  </div>;
}

// ── Capillary pressure: Leverett J, per-HFU Sw(J) fit, saturation-height curve ──
function SatHeight() {
  const core = useStore((s) => activeCore(s)); const well = useActiveWell(); const sets = useStore((s) => s.hfuSets); useStore((s) => s.dataVersion);
  const a = core ? registry.core(core.id) : undefined; const cols = a ? [...a.num.keys()] : [];
  const guess = (re: RegExp) => cols.find((c) => re.test(c)) ?? '';
  const [pcC, setPcC] = useState(guess(/^(PC|CAP|PRESS|MICP|PC_)/i)); const [swC, setSwC] = useState(guess(/^(SW|SHG|SNW|SAT)/i)); const [pcU, setPcU] = useState<'psi' | 'kPa' | 'bar'>('psi'); const [swPct, setSwPct] = useState(false);
  const [labS, setLabS] = useState(367); const [resS, setResS] = useState(26); const [setId, setSetId] = useState(sets.find((h) => h.domain === 'core' && h.coreId === core?.id)?.id ?? '');
  const [fwl, setFwl] = useState(0); const [rw, setRw] = useState(1.05); const [rh, setRh] = useState(0.75); const [kC, setKC] = useState(''); const [phiC, setPhiC] = useState(''); const [hfuC, setHfuC] = useState('HFU_PRED');
  const [msgs, setMsgs] = useState<{ level: any; text: string }[]>([]);
  const res = useMemo(() => {
    if (!core || !a || !pcC || !swC) return null; const pc = a.num.get(pcC), sw = a.num.get(swC), k = coreCol(core, a, 'K'), ph = coreCol(core, a, 'PHI'); if (!pc || !sw || !k || !ph) return null;
    const f = pcU === 'kPa' ? 0.145038 : pcU === 'bar' ? 14.5038 : 1; const lab = sets.find((h) => h.id === setId)?.labels;
    const phiF = (v: number) => (a.num.has('PHI') ? v : core.phiUnit === 'percent' ? v / 100 : v);
    const J: number[] = [], S2: number[] = [], G: number[] = [], R: number[] = [];
    for (let i = 0; i < core.n; i++) { const p = pc[i] * f, s = swPct ? sw[i] / 100 : sw[i], kk = k[i], pp = phiF(ph[i]); if (!(p > 0 && s > 0 && kk > 0 && pp > 0) || a.excluded[i]) continue; J.push((0.2166 * p / labS) * Math.sqrt(kk / pp)); S2.push(s); G.push(lab?.[i] ?? 0); R.push(107 / p); }
    const groups = [...new Set(G.filter((g) => g > 0))].sort();
    return { J, S: S2, G, R, global: fit1d(J, S2, 'power'), per: groups.map((g) => ({ g, f: fit1d(J.filter((_, i) => G[i] === g), S2.filter((_, i) => G[i] === g), 'power') })) };
  }, [core?.id, pcC, swC, pcU, swPct, labS, setId, useStore.getState().dataVersion]);
  const coef = (f: any) => { const m = /y = ([\d.e+-]+)·x\^([\d.e+-]+)/.exec(f.eq.replace('−', '-')); return m ? { a: +m[1], b: +m[2] } : null; };
  const apply = () => {
    if (!well || !res) return; const d = registry.depth(well.id)!; const nm0 = well.curves.map((c) => c.mnemonic); const kE = kC || (nm0.includes('K_PRED') ? 'K_PRED' : findByFamily(nm0, 'K') || ''); const phiE = phiC || findByFamily(nm0, 'PHIE') || findByFamily(nm0, 'PHIT') || findByFamily(nm0, 'CMRP') || ''; const k = registry.curve(well.id, kE), ph = registry.curve(well.id, phiE); if (!k || !ph) { setMsgs([{ level: 'CRITICAL', text: 'Select permeability (mD) and porosity (fraction) curves.' }]); return; }
    const h = registry.curve(well.id, hfuC); const g = res.global && coef(res.global); const per = new Map(res.per.filter((p) => p.f).map((p) => [p.g, coef(p.f)]));
    const out = new Float32Array(d.length).fill(NaN);
    for (let i = 0; i < d.length; i++) { const ht = fwl - d[i]; if (ht <= 0) { out[i] = 1; continue; } const pcRes = (rw - rh) * 0.433 * ht * 3.28084; const J = (0.2166 * pcRes / resS) * Math.sqrt(k[i] / ph[i]); if (!(J > 0)) continue; const c = h && isNum(h[i]) && per.get(Math.round(h[i])) ? per.get(Math.round(h[i])) : g; if (c) out[i] = Math.min(1, c.a * Math.pow(J, c.b)); }
    putCalculatedCurve(well.id, 'SW_SH', out, 'v/v', 'Saturation-height (Leverett J) water saturation', { kind: 'formula', formula: `Sw = a·J^b; J = 0.2166·Pc/(σcosθ)·√(k/φ); Pc = (ρw−ρh)·0.433 psi/ft · h(FWL=${fwl} ${well.depthUnit}); σcosθ_res=${resS}; ${per.size ? `per ${hfuC} unit` : 'global'} coefficients from core "${core!.name}"`, inputs: [kE, phiE, ...(h ? [hfuC] : [])], units: 'v/v', version: 1, missing: 'NaN where k or φ missing; Sw=1 below FWL', createdAt: nowIso(), notes: `ρw=${rw}, ρh=${rh} g/cc; lab σcosθ=${labS}` });
    S().log(`Created SW_SH on ${well.name} (FWL ${fwl} ${well.depthUnit})`); setMsgs([{ level: 'OK', text: 'SW_SH created. Assumes depth ≈ TVD (use a TVD-based FWL for deviated wells).' }]);
  };
  if (!core || !a) return <Empty>Load a core dataset that contains capillary-pressure data (columns for Pc and Sw per plug; MICP/SCAL tables).</Empty>;
  const names = well?.curves.map((c) => c.mnemonic) ?? [];
  return <div className="split w380">
    <div className="col">
      <Box title="Core Pc data (MICP / SCAL)"><Field label="Core"><CoreSelector /></Field>
        <Field label="Pc column"><select value={pcC} onChange={(e) => setPcC(e.target.value)}><option value="">—</option>{cols.map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Pc unit"><Sel value={pcU} onChange={setPcU} options={['psi', 'kPa', 'bar']} /></Field>
        <Field label="Sw column"><select value={swC} onChange={(e) => setSwC(e.target.value)}><option value="">—</option>{cols.map((c) => <option key={c}>{c}</option>)}</select></Field>
        <label className="cb"><input type="checkbox" checked={swPct} onChange={(e) => setSwPct(e.target.checked)} />Sw in percent</label>
        <Field label="Lab σcosθ (dyn/cm)"><Num value={labS} onChange={setLabS} /></Field><div className="hint">air–Hg ≈ 367 (485·cos140°); air–brine ≈ 72; oil–brine ≈ 26.</div>
        <Field label="HFU set"><select value={setId} onChange={(e) => setSetId(e.target.value)}><option value="">— global only —</option>{sets.filter((h) => h.domain === 'core').map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></Field>
        {res ? <table className="t"><thead><tr><th>Group</th><th>Sw = a·J^b</th><th>R²</th><th>N</th></tr></thead><tbody>{res.global && <tr><td>global</td><td className="mono">{res.global.eq}</td><td className="num">{fmt(res.global.r2, 3)}</td><td className="num">{res.global.n}</td></tr>}{res.per.map((p) => <tr key={p.g}><td>{p.g}</td><td className="mono">{p.f?.eq ?? 'too few'}</td><td className="num">{fmt(p.f?.r2, 3)}</td><td className="num">{p.f?.n ?? 0}</td></tr>)}</tbody></table> : <span className="hint">Select Pc and Sw columns (plug φ/k must be mapped).</span>}
      </Box>
      {well && <Box title="Saturation-height curve">
        <Field label={`FWL (${well.depthUnit})`}><Num value={fwl} onChange={setFwl} /></Field><Field label="ρ water / ρ HC (g/cc)"><div className="row"><Num value={rw} onChange={setRw} style={{ width: 60 }} /><Num value={rh} onChange={setRh} style={{ width: 60 }} /></div></Field>
        <Field label="Reservoir σcosθ"><Num value={resS} onChange={setResS} /></Field>
        <Field label="K curve (mD)"><CurvePicker wellId={well.id} value={kC || (names.includes('K_PRED') ? 'K_PRED' : '')} onChange={setKC} allowNone="—" /></Field>
        <Field label="φ curve (v/v)"><CurvePicker wellId={well.id} value={phiC || findByFamily(names, 'PHIE') || ''} onChange={setPhiC} allowNone="—" /></Field>
        <Field label="HFU curve"><CurvePicker wellId={well.id} value={hfuC} onChange={setHfuC} allowNone="— none —" filter={(m) => !!well.curves.find((c) => c.mnemonic === m)?.discrete} /></Field>
        <button className="btn pri" onClick={apply}>Create SW_SH</button>
      </Box>}
      <Msgs items={msgs} />
    </div>
    {res && <div className="grid2" style={{ height: 420 }}>
      <div className="box"><XYPlot title="Leverett J vs Sw" logX xLabel="Sw (v/v)" yLabel="J" logY series={[{ kind: 'scatter', x: res.S, y: res.J, colors: res.G.map((g) => (g ? hfuColor(g) : '#9aa4b2')), size: 2.8 }]} /></div>
      <div className="box"><XYPlot title="Pore-throat radius r = 107/Pc (air–Hg, µm) vs Sw" logY xLabel="Sw" yLabel="r (µm)" series={[{ kind: 'scatter', x: res.S, y: res.R, colors: res.G.map((g) => (g ? hfuColor(g) : '#9aa4b2')), size: 2.8 }]} /></div>
    </div>}
  </div>;
}

// ── Facies ↔ HFU contingency ──
function Facies() {
  const core = useStore((s) => activeCore(s)); const sets = useStore((s) => s.hfuSets);
  const [setId, setSetId] = useState(sets.find((h) => h.domain === 'core' && h.coreId === core?.id)?.id ?? '');
  const a = core ? registry.core(core.id) : undefined; const fac = core?.map.facies ? a?.text.get(core.map.facies) : undefined; const lab = sets.find((h) => h.id === setId)?.labels;
  if (!core || !a) return <Empty>No core dataset.</Empty>;
  if (!fac) return <Empty>Map a facies column in Core Data first.</Empty>;
  const fl = [...new Set(fac.filter(Boolean))]; const us = lab ? [...new Set(lab.filter((l) => l > 0))].sort() : [];
  const tab = fl.map((f) => us.map((u) => fac.filter((x, i) => x === f && lab![i] === u && !a.excluded[i]).length));
  const N = tab.flat().reduce((s, v) => s + v, 0); const rs = tab.map((r) => r.reduce((s, v) => s + v, 0)); const cs = us.map((_, j) => tab.reduce((s, r) => s + r[j], 0));
  let chi = 0; tab.forEach((r, i) => r.forEach((o, j) => { const e = (rs[i] * cs[j]) / (N || 1); if (e > 0) chi += (o - e) ** 2 / e; }));
  const V = N ? Math.sqrt(chi / (N * Math.max(1, Math.min(fl.length, us.length) - 1))) : NaN;
  return <div className="col">
    <div className="row"><CoreSelector /><select value={setId} onChange={(e) => setSetId(e.target.value)}><option value="">— HFU set —</option>{sets.filter((h) => h.domain === 'core').map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></div>
    {lab ? <Box title={`Facies × HFU contingency (N=${N}) · χ² = ${fmt(chi, 4)} · Cramér's V = ${fmt(V, 3)}`}>
      <table className="t heat"><thead><tr><th>Facies \ unit</th>{us.map((u) => <th key={u} style={{ textAlign: 'center' }}><span className="pill" style={{ background: hfuColor(u) }} />{u}</th>)}<th>Total</th></tr></thead><tbody>
        {fl.map((f, i) => <tr key={f}><td><span className="pill" style={{ background: PALETTE[i % PALETTE.length] }} />{f}</td>{tab[i].map((v, j) => <td key={j} style={{ background: v ? `rgba(78,161,255,${0.1 + 0.8 * (v / (rs[i] || 1))})` : undefined }}>{v || ''}{v ? <span className="dim"> ({((100 * v) / (rs[i] || 1)).toFixed(0)}%)</span> : ''}</td>)}<td>{rs[i]}</td></tr>)}
      </tbody></table>
      <div className="hint">Row percentages. Cramér's V measures association strength (0–1) between facies and HFU; it does not imply that facies causes flow behaviour. Use it when validating statistical clusters as geological HFUs.</div>
    </Box> : <span className="hint">Select an HFU set that belongs to this core dataset.</span>}
  </div>;
}

// ── Formation pressure gradients ──
function Pressure() {
  const well = useActiveWell(); const cores = useStore((s) => s.cores);
  const [src, setSrc] = useState<string>(''); const [col, setCol] = useState(''); const [unit, setUnit] = useState<'psi' | 'kPa' | 'bar'>('psi'); const [split, setSplit] = useState(0);
  if (!well) return <Empty>No well.</Empty>;
  const names = well.curves.map((c) => c.mnemonic);
  const data = (() => {
    const f = unit === 'kPa' ? 0.145038 : unit === 'bar' ? 14.5038 : 1; const D: number[] = [], P: number[] = [];
    if (src.startsWith('core:')) { const c = cores.find((x) => x.id === src.slice(5)); const a = c && registry.core(c.id); const p = a?.num.get(col); if (c && a && p) { const { shifted } = coreDepths(c, a); for (let i = 0; i < c.n; i++) if (isNum(p[i])) { D.push(shifted[i]); P.push(p[i] * f); } } }
    else if (src) { const d = registry.depth(well.id), p = registry.curve(well.id, src); if (d && p) for (let i = 0; i < d.length; i++) if (isNum(p[i])) { D.push(d[i]); P.push(p[i] * f); } }
    return { D, P };
  })();
  const fitSeg = (sel: (d: number) => boolean) => { const x: number[] = [], y: number[] = []; data.D.forEach((d, i) => { if (sel(d)) { x.push(d); y.push(data.P[i]); } }); return x.length >= 2 ? fit1d(x, y, 'linear') : null; };
  const up = fitSeg((d) => !split || d < split), lo = split ? fitSeg((d) => d >= split) : null;
  const grad = (f: any) => { const m = /\+ ([-\d.e]+)·x|− ([\d.e]+)·x/.exec(f?.eq ?? ''); const g = m ? (m[1] ? +m[1] : -m[2]) : NaN; return g; };
  const perM = (g: number) => (well.depthUnit === 'ft' ? g : g / 3.28084); // psi/ft
  const fluid = (gft: number) => (gft > 0.42 ? 'water' : gft > 0.28 ? 'oil' : gft > 0 ? 'gas' : '?');
  const g1 = perM(grad(up)), g2 = lo ? perM(grad(lo)) : NaN;
  let contact = NaN; if (up && lo) { const a1 = +(/y = ([-\d.e]+)/.exec(up.eq)?.[1] ?? NaN), a2 = +(/y = ([-\d.e]+)/.exec(lo.eq)?.[1] ?? NaN); const b1 = grad(up), b2 = grad(lo); contact = (a2 - a1) / (b1 - b2); }
  return <div className="split w380">
    <Box title="Pressure data">
      <Field label="Source"><select value={src} onChange={(e) => { setSrc(e.target.value); setCol(''); }}><option value="">—</option>{names.filter((m) => /PRES|PRESS|FPRS|MDT|RFT|P$/i.test(m) || well.curves.find((c) => c.mnemonic === m)?.category === 'Pressure').map((m) => <option key={m} value={m}>log: {m}</option>)}{cores.filter((c) => c.wellId === well.id).map((c) => <option key={c.id} value={`core:${c.id}`}>table: {c.name}</option>)}</select></Field>
      {src.startsWith('core:') && <Field label="Pressure column"><select value={col} onChange={(e) => setCol(e.target.value)}><option value="">—</option>{[...(registry.core(src.slice(5))?.num.keys() ?? [])].map((c) => <option key={c}>{c}</option>)}</select></Field>}
      <Field label="Unit"><Sel value={unit} onChange={setUnit} options={['psi', 'kPa', 'bar']} /></Field>
      <Field label={`Gradient break (${well.depthUnit}, 0 = none)`}><Num value={split} onChange={setSplit} /></Field>
      <div className="kv" style={{ marginTop: 6 }}><span>Points</span><span>{data.D.length}</span><span>Upper gradient</span><span>{fmt(g1, 4)} psi/ft ({fmt(g1 / 0.433, 3)} g/cc) — {fluid(g1)}?</span>{lo && <><span>Lower gradient</span><span>{fmt(g2, 4)} psi/ft ({fmt(g2 / 0.433, 3)} g/cc) — {fluid(g2)}?</span><span>Intersection (contact)</span><span>{fmt(contact, 6)} {well.depthUnit}</span></>}</div>
      <div className="hint" style={{ marginTop: 4 }}>Fluid labels are indicative (water ≈ 0.43–0.50, oil ≈ 0.30–0.38, gas &lt; 0.15 psi/ft). Depths are MD — use TVD for deviated wells. Load MDT/RFT tables via Import → Auxiliary/Core.</div>
    </Box>
    <div className="box" style={{ height: 460 }}><XYPlot title="Formation pressure vs depth" invertY xLabel="pressure (psi)" yLabel={`depth (${well.depthUnit})`} series={[{ kind: 'scatter', x: data.P, y: data.D, color: '#39c5cf', size: 3.5 }]} refLines={[up, lo].filter(Boolean).map((f: any, i) => ({ x1: f.curve.y[0], y1: f.curve.x[0], x2: f.curve.y[f.curve.y.length - 1], y2: f.curve.x[f.curve.x.length - 1], color: i ? '#f5a623' : '#3ecf8e', dash: true }))} /></div>
  </div>;
}

// ── RCA summary ──
function RCA() {
  const core = useStore((s) => activeCore(s)); useStore((s) => s.dataVersion);
  const a = core ? registry.core(core.id) : undefined;
  if (!core || !a) return <Empty>No core dataset.</Empty>;
  const fac = core.map.facies ? a.text.get(core.map.facies) : undefined; const gd = core.map.grainDensity ? a.num.get(core.map.grainDensity) : undefined;
  const phi = coreCol(core, a, 'PHI'), k = coreCol(core, a, 'K');
  const groups = fac ? [...new Set(fac.filter(Boolean))] : ['all'];
  const stat = (v: number[]) => { const s = v.filter(isNum).sort((x, y) => x - y); return { n: s.length, mean: s.reduce((x, y) => x + y, 0) / (s.length || 1), med: s[Math.floor(s.length / 2)] ?? NaN, geo: Math.pow(10, s.filter((x) => x > 0).reduce((x, y) => x + Math.log10(y), 0) / (s.filter((x) => x > 0).length || 1)) }; };
  return <div className="col"><div className="row"><CoreSelector /></div>
    <Box title={`Routine core analysis summary — ${core.name}${fac ? ' (by facies)' : ''}`}>
      <table className="t"><thead><tr><th>Group</th><th>N</th><th>Mean φ</th><th>Median φ</th><th>Geo-mean k</th><th>Median k</th><th>Mean grain density</th></tr></thead><tbody>
        {groups.map((g) => { const sel = (i: number) => !a.excluded[i] && (!fac || fac[i] === g); const f = (arr?: Float64Array) => (arr ? Array.from(arr).filter((_, i) => sel(i)) : []); const p = stat(f(phi)), kk = stat(f(k)), gg = stat(f(gd)); return <tr key={g}><td>{g}</td><td className="num">{p.n}</td><td className="num">{fmt(p.mean, 3)}</td><td className="num">{fmt(p.med, 3)}</td><td className="num">{fmt(kk.geo, 3)}</td><td className="num">{fmt(kk.med, 3)}</td><td className="num">{gd ? fmt(gg.mean, 4) : '—'}</td></tr>; })}
      </tbody></table>
      <div className="hint">φ/k shown in the units of the mapped columns{a.num.has('PHI') ? ' (standardised after RQI/FZI calculation)' : ''}. Excluded QC samples are omitted.</div>
    </Box>
    {gd && <div style={{ height: 520 }}><DepthPlot title="Grain density vs depth" wellId={core.wellId} tracks={[{ width: 200, series: [{ depth: Array.from(coreDepths(core, a).shifted), values: Array.from(gd), label: 'Grain density', unit: 'g/cc', color: '#7048e8', kind: 'dots', min: 2.55, max: 2.85 }] }]} /></div>}
  </div>;
}

function Roadmap() {
  const items: [string, string, string][] = [
    ['Image-log derived features', 'Available', 'Import image-log derived curves (fracture density, dip magnitude, textural indices, resistivity-image porosity) as depth-indexed auxiliary data; they appear as normal curves (category “Image”) and can be used as clustering features and regression predictors.'],
    ['ML-based HFU classification', 'Available', 'FZI Regression Studio → target “HFU class” trains a random-forest classifier on log predictors; Predicted FZI / HFU writes HFU_PRED directly from it (with extrapolation flags).'],
    ['NMR integration', 'Available', 'NMR curves (CMRP, TCMR, T2LM, CMFF, BFV, KTIM, KSDR) are recognised, usable as features, summarised per HFU in Reservoir Quality and turned into Timur-Coates / SDR permeability here.'],
    ['SCAL / MICP integration', 'Available', 'Capillary pressure tab: Leverett-J normalisation, per-HFU Sw(J) fits, pore-throat radius and saturation-height curve.'],
    ['Seismic integration', 'Future', 'Planned: import of seismic attributes at well locations (SEG-Y trace extraction) as additional HFU predictors.'],
    ['Well correlation', 'Future', 'Planned: flattened multi-well correlation panel on tops with HFU band correlation.'],
    ['3D reservoir visualization', 'Future', 'Planned: WebGL well-path + HFU display in 3D.'],
    ['Geostatistical HFU propagation', 'Future', 'Planned: indicator variograms of HFU and SIS/kriging between wells.'],
  ];
  return <Box title="Additional modules">{items.map(([t, s, d]) => <div key={t} style={{ padding: '5px 0', borderBottom: '1px solid var(--bd)' }}><b>{t}</b> <span className={'tag ' + (s === 'Available' ? 'ok' : '')}>{s}</span><div className="hint">{d}</div></div>)}</Box>;
}
void sampleLogAt;
