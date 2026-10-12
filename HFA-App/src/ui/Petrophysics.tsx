// Petrophysical Evaluation — Techlog-style workflow manager.
// Left: workflow (methods, run order). Right: method settings with Inputs · Zonation · Parameters (one column per zone,
// exactly like the Techlog parameter grid) · interactive picking plot · depth view on the reservoir.
import { useMemo, useState } from 'react';
import { S, useStore } from '../store/store';
import { registry } from '../data-engine/registry';
import { putCalculatedCurve } from '../data-engine/ingest';
import { coreDepths, corePhiFraction, sampleLogAt } from '../data-engine/core';
import { reservoirsForWell } from '../data-engine/zones';
import {
  DEFAULT_PARAMS, restrictIv, VSH_EQ, VSH_LABEL, arps, autoInputs, brineDensity, brineRes, fitPickett, grPicks, inputsFor, paramsFor, petroZones, runPetro, summation, toDegC,
  type PetroRun, type SumRow,
} from '../petrophysics/quanti';
import type { PetroInputs, PetroZoneParams, PetroZonation, VshMethod, WellMeta } from '../types';
import { Box, CurvePicker, Empty, Field, Kv, ModHead, Msgs, Num, Sel, Tabs, download, useActiveWell } from './common';
import { XYPlot } from '../visualization/XYPlot';
import { DepthPlot, type DepthTrack } from '../visualization/DepthPlot';
import { histogram } from './Calculator';
import { fmt, isNum, nowIso, pearson, percentiles } from '../util/num';

type Method = 'badhole' | 'vsh' | 'nd' | 'sw' | 'cutoff';
const METHODS: { id: Method; label: string; out: string }[] = [
  { id: 'badhole', label: 'Bad-hole flags', out: 'BH_FL_BS · BH_FL_DRHO' },
  { id: 'vsh', label: 'Shale volume (GR)', out: 'IGR · VSH_GR' },
  { id: 'nd', label: 'Porosity neutron-density', out: 'PHIT_ND · PHIT_ND_UNCL · PHIE_ND' },
  { id: 'sw', label: 'Water saturation — Archie (Pickett)', out: 'SW_AR · BVW · RWA' },
  { id: 'cutoff', label: 'Cut-offs & summation', out: 'NET_RES · NET_PAY' },
];
type Row = { k: keyof PetroZoneParams; l: string; u?: string; kind?: 'num' | 'bool' | 'vsh' | 'tunit'; group?: string; hint?: string };
const ROWS: Record<Method, Row[]> = {
  badhole: [
    { k: 'bitSize', l: 'Bit size', u: 'in', hint: 'used when no BS curve is mapped' },
    { k: 'caliThr', l: 'CALI − BS threshold', u: 'in' },
    { k: 'drhoThr', l: '|DRHO| threshold', u: 'g/cc' },
  ],
  vsh: [
    { k: 'vshMethod', l: 'Method', kind: 'vsh' },
    { k: 'grClean', l: 'GR clean (sand line)', u: 'gAPI', hint: 'P5 of the zone by default' },
    { k: 'grShale', l: 'GR shale (shale line)', u: 'gAPI', hint: 'P95 of the zone by default' },
  ],
  nd: [
    { k: 'rhoMa', l: 'Matrix density', u: 'g/cc', group: 'Parameters' }, { k: 'rhoFl', l: 'Fluid density', u: 'g/cc' },
    { k: 'nphiMa', l: 'Neutron matrix', u: 'v/v' }, { k: 'nphiFl', l: 'Neutron fluid', u: 'v/v' },
    { k: 'nphiShift', l: 'Neutron matrix shift ΔN', u: 'v/v', hint: 'e.g. +0.04 to bring limestone-calibrated TNPH to sandstone' },
    { k: 'rhoSh', l: 'Shale density', u: 'g/cc' }, { k: 'nphiSh', l: 'Shale neutron', u: 'v/v' }, { k: 'phiMax', l: 'Maximum porosity (clip)', u: 'v/v' },
    { k: 'hcCorr', l: 'Hydrocarbon correction', kind: 'bool', group: 'Hydrocarbon parameters' },
    { k: 'hcDensity', l: 'Hydrocarbon density', u: 'g/cm3' }, { k: 'mudSalinity', l: 'Mud salinity', u: 'ppm' },
    { k: 'temperature', l: 'Temperature' }, { k: 'tempUnit', l: 'Temperature unit', kind: 'tunit' },
    { k: 'hiGas', l: 'HI gas' }, { k: 'hiFluid', l: 'HI fluid' }, { k: 'excavation', l: 'Excavation effect', kind: 'bool' },
    { k: 'm', l: 'm' }, { k: 'n', l: 'n' }, { k: 'invasionFactor', l: 'Invasion factor', hint: 'Sxo = Sw^(1/invasion factor); 1 = no flushing, 5 ≈ classic Sxo = Sw^0.2' },
  ],
  sw: [
    { k: 'a', l: 'Tortuosity a' }, { k: 'm', l: 'Cementation exponent m' }, { k: 'n', l: 'Saturation exponent n' },
    { k: 'rw', l: 'Rw', u: 'ohm.m' }, { k: 'rwTemp', l: 'Rw reference temperature' },
    { k: 'temperature', l: 'Formation temperature' }, { k: 'tempUnit', l: 'Temperature unit', kind: 'tunit' },
  ],
  cutoff: [
    { k: 'vshCut', l: 'VSH cut-off (≤)', u: 'v/v' }, { k: 'phiCut', l: 'Porosity cut-off (≥)', u: 'v/v' }, { k: 'swCut', l: 'Sw cut-off (≤)', u: 'v/v' },
  ],
};

const setParam = (wellId: string, key: string, k: keyof PetroZoneParams, v: any) => {
  const st = S(); const all = { ...(st.petro.params[wellId] ?? {}) }; all[key] = { ...(all[key] ?? {}), [k]: v };
  st.set({ petro: { ...st.petro, params: { ...st.petro.params, [wellId]: all } }, dirty: true });
};
const setPetro = (p: Partial<ReturnType<typeof S>['petro']>) => S().set({ petro: { ...S().petro, ...p }, dirty: true });
/** Techlog-like colour map (clean → shaly): yellow → green → brown */
export function ramp(v: number, a = 0, b = 1) { if (!isNum(v)) return '#999999'; const t = Math.max(0, Math.min(1, (v - a) / (b - a))); const c = [[240, 220, 40], [120, 190, 60], [40, 120, 80], [120, 70, 30]]; const x = t * (c.length - 1); const i = Math.min(c.length - 2, Math.floor(x)), f = x - i; const m = c[i].map((q, k) => Math.round(q + (c[i + 1][k] - q) * f)); return `rgb(${m[0]},${m[1]},${m[2]})`; }

export function Petrophysics() {
  const well = useActiveWell(); const petro = useStore((s) => s.petro); useStore((s) => s.reservoirs); useStore((s) => s.dataVersion); useStore((s) => s.tops);
  const [method, setMethod] = useState<Method>('vsh');
  const [tab, setTab] = useState<'params' | 'inputs' | 'plot' | 'depth'>('params');
  const [run, setRun] = useState<PetroRun | null>(null);
  const [msgs, setMsgs] = useState<{ level: any; text: string }[]>([]);
  if (!well) return <><ModHead title="Petrophysical Evaluation" /><Empty>Load a well first.</Empty></>;
  const zones = petroZones(well.id, petro.zonation);
  const exec = () => {
    try {
      const r = runPetro(well, petro.zonation, petro.methods); setRun(r);
      const inputsUsed = Object.values(r.inputs).filter(Boolean) as string[];
      for (const [name, arr] of Object.entries(r.out)) putCalculatedCurve(well.id, name, arr, r.units[name] ?? '', `Petrophysics: ${name}`, { kind: 'formula', formula: r.formulas[name] ?? name, inputs: inputsUsed, units: r.units[name] ?? '', version: 1, missing: `NaN outside the ${petro.zonation === 'reservoir' ? 'reservoir intervals' : petro.zonation === 'tops' ? 'formation zones' : 'well'} or where an input is missing`, createdAt: nowIso(), notes: `zonation: ${petro.zonation}` }, /^(BH_FL|NET_)/.test(name));
      // persist auto-picked GR lines so the analyst sees (and can edit) them
      r.zones.forEach((z) => { const cur = S().petro.params[well.id]?.[z.key] ?? {}; if (!isNum(cur.grClean as number) && isNum(z.p.grClean)) { setParam(well.id, z.key, 'grClean', +z.p.grClean.toFixed(2)); setParam(well.id, z.key, 'grShale', +z.p.grShale.toFixed(2)); } });
      setPetro({ lastRun: nowIso() });
      // GR sand/shale baseline of the log display = mid-point of the picked GR lines (Techlog "GR/Baseline")
      const mids = r.zones.map((z) => (z.p.grClean + z.p.grShale) / 2).filter(isNum);
      if (mids.length) { const bl = +(mids.reduce((a, b) => a + b, 0) / mids.length).toFixed(1); S().set({ layout: S().layout.map((t) => ({ ...t, curves: t.curves.map((c) => (c.fill === 'baseline' && /^(GR|CGR)$/i.test(c.mnem) ? { ...c, baseline: bl } : c)) })) }); }
      S().log(`Petrophysical evaluation on ${well.name} (${petro.zonation} zonation, ${r.zones.length} zone(s), ${r.nIn} samples): ${Object.keys(r.out).join(', ')}`);
      setMsgs([{ level: 'OK', text: `Computed ${Object.keys(r.out).length} curves in ${r.zones.map((z) => `${z.name} (${z.top}–${z.base})`).join(', ')}. Outside these zones the outputs are NULL (the evaluation is done on the reservoir, not the whole well).` },
        ...r.warnings.map((w) => ({ level: 'WARNING', text: w })), ...r.zones.flatMap((z) => z.notes.map((n) => ({ level: 'INFO', text: `${z.name}: ${n}` })))]);
    } catch (e: any) { setMsgs([{ level: 'CRITICAL', text: e.message }]); }
  };
  const exportParams = () => {
    const keys = Object.keys(DEFAULT_PARAMS) as (keyof PetroZoneParams)[];
    const head = ['Parameter', ...zones.map((z) => z.name)]; const rows = [['Well', ...zones.map(() => well.name)], ['Top', ...zones.map((z) => String(z.top))], ['Bottom', ...zones.map((z) => String(z.base))], ...keys.map((k) => [k, ...zones.map((z) => String(paramsFor(well.id, z.key)[k]))])];
    download([head, ...rows].map((r) => r.join(',')).join('\n'), `${well.name}_petro_parameters.csv`, 'text/csv'); S().log(`Exported petrophysical parameter table (${well.name})`);
  };
  const importParams = (f: File) => f.text().then((t) => {
    const lines = t.split(/\r?\n/).filter(Boolean).map((l) => l.split(',')); const head = lines[0]; let n = 0;
    for (const r of lines.slice(1)) { const k = r[0] as keyof PetroZoneParams; if (!(k in DEFAULT_PARAMS)) continue; head.slice(1).forEach((zn, j) => { const z = zones.find((q) => q.name === zn); if (!z) return; const raw = r[j + 1]; const def = DEFAULT_PARAMS[k]; const v = typeof def === 'number' ? parseFloat(raw) : typeof def === 'boolean' ? raw === 'true' : raw; if (typeof def === 'number' && !isNum(v as number)) return; setParam(well.id, z.key, k, v); n++; }); }
    S().log(`Imported ${n} petrophysical parameters from ${f.name}`); setMsgs([{ level: 'OK', text: `Imported ${n} parameter values (matched by zone name).` }]);
  });
  return <>
    <ModHead title="Petrophysical Evaluation" sub={`${well.name} · Techlog-style workflow · parameters per zone · evaluation restricted to the zones below`}>
      <span className="hint">Zonation</span>
      <Sel value={petro.zonation} onChange={(v: PetroZonation) => setPetro({ zonation: v })} options={[{ v: 'reservoir', l: `Reservoir intervals (${reservoirsForWell(well.id).length})` }, { v: 'tops', l: 'Formation tops' }, { v: 'well', l: 'Whole well' }]} />
      {petro.zonation !== 'reservoir' && reservoirsForWell(well.id).length > 0 && <label className="cb" title="Evaluate the formation zones only inside the reservoir intervals"><input type="checkbox" checked={petro.resOnly !== false} onChange={(e) => setPetro({ resOnly: e.target.checked })} />only inside reservoir</label>}
      <button className="btn" onClick={exportParams}>Export parameters</button>
      <label className="btn">Import parameters<input type="file" accept=".csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importParams(f); e.target.value = ''; }} /></label>
      <button className="btn pri" onClick={exec}>▶ Run workflow</button>
    </ModHead>
    <div className="mod-b">
      {!zones.length && <Msgs items={[{ level: 'WARNING', text: petro.zonation === 'reservoir' ? 'No reservoir interval defined for this well — define it in Reservoir Intervals (Data), or switch zonation.' : 'No formation tops for this well.' }]} />}
      <div className="split" style={{ gridTemplateColumns: '270px 1fr' }}>
        <div className="col">
          <Box title="Workflow overview">
            <ul className="wf-list tree">{METHODS.map((m, i) => <li key={m.id} className={method === m.id ? 'sel' : ''} onClick={() => setMethod(m.id)}>
              <input type="checkbox" checked={petro.methods[m.id]} onClick={(e) => e.stopPropagation()} onChange={(e) => setPetro({ methods: { ...petro.methods, [m.id]: e.target.checked } })} />
              <span>{i + 1}. {m.label}</span></li>)}</ul>
            <div className="hint" style={{ marginTop: 6 }}>Checked methods run top-to-bottom. Outputs: {METHODS.filter((m) => petro.methods[m.id]).map((m) => m.out).join(' · ')}.</div>
            {petro.lastRun && <div className="hint">Last run {petro.lastRun.slice(0, 16).replace('T', ' ')}</div>}
          </Box>
          <Box title="Zonation">
            <table className="t"><thead><tr><th>Zone</th><th>Top</th><th>Bottom</th></tr></thead><tbody>{zones.map((z) => <tr key={z.key}><td>{z.name}</td><td className="num">{fmt(z.top, 6)}</td><td className="num">{fmt(z.base, 6)}</td></tr>)}</tbody></table>
            <div className="hint" style={{ marginTop: 4 }}>{petro.zonation === 'reservoir' ? 'Parameters are picked and applied per reservoir interval only.' : petro.zonation === 'tops' ? 'One parameter column per formation.' : 'One parameter set for the whole well.'}</div>
          </Box>
          <Msgs items={msgs} />
        </div>
        <div className="col" style={{ minWidth: 0 }}>
          <Tabs value={tab} onChange={setTab} tabs={[{ v: 'params', l: 'Parameters' }, { v: 'inputs', l: 'Inputs' }, { v: 'plot', l: method === 'vsh' ? 'GR histogram' : method === 'nd' ? 'ND crossplot · core calibration' : method === 'sw' ? 'Pickett plot' : method === 'cutoff' ? 'Summation' : 'Caliper check' }, { v: 'depth', l: 'Depth view' }]} />
          {tab === 'params' && <ParamGrid well={well} method={method} zones={zones} />}
          {tab === 'inputs' && <InputsPanel well={well} />}
          {tab === 'plot' && (method === 'vsh' ? <VshPick well={well} zones={zones} /> : method === 'nd' ? <NdPick well={well} zones={zones} /> : method === 'sw' ? <Pickett well={well} zones={zones} /> : method === 'cutoff' ? <Summation well={well} zones={zones} /> : <DepthView well={well} which="badhole" />)}
          {tab === 'depth' && <DepthView well={well} which={method} />}
          {run && <Box title="Last run — formulas & provenance"><div className="tbl-wrap" style={{ maxHeight: 200 }}><table className="t"><tbody>{Object.entries(run.formulas).map(([k, f]) => <tr key={k}><td className="mono">{k}</td><td className="dim" style={{ whiteSpace: 'normal' }}>{f}</td></tr>)}</tbody></table></div></Box>}
        </div>
      </div>
    </div>
  </>;
}

function ParamGrid({ well, method, zones }: { well: WellMeta; method: Method; zones: ReturnType<typeof petroZones> }) {
  useStore((s) => s.petro);
  const rows = ROWS[method];
  const cell = (key: string, r: Row) => {
    const p = key === '*' ? { ...DEFAULT_PARAMS, ...(S().petro.params[well.id]?.['*'] ?? {}) } : paramsFor(well.id, key); const v = p[r.k] as any;
    const set = (x: any) => { if (key === '*') { setParam(well.id, '*', r.k, x); zones.forEach((z) => { const cur = { ...(S().petro.params[well.id]?.[z.key] ?? {}) } as any; if (r.k in cur) { delete cur[r.k]; S().set({ petro: { ...S().petro, params: { ...S().petro.params, [well.id]: { ...S().petro.params[well.id], [z.key]: cur } } } }); } }); } else setParam(well.id, key, r.k, x); };
    if (r.kind === 'bool') return <select value={v ? 'yes' : 'no'} onChange={(e) => set(e.target.value === 'yes')}><option>no</option><option>yes</option></select>;
    if (r.kind === 'vsh') return <select value={v} onChange={(e) => set(e.target.value as VshMethod)}>{(Object.keys(VSH_LABEL) as VshMethod[]).map((m) => <option key={m} value={m}>{VSH_LABEL[m]}</option>)}</select>;
    if (r.kind === 'tunit') return <select value={v} onChange={(e) => set(e.target.value)}><option value="degC">degC</option><option value="degF">degF</option></select>;
    return <Num value={isNum(v) ? v : undefined} placeholder={isNum(v) ? '' : 'auto'} onChange={set} />;
  };
  const d = registry.depth(well.id); const gr = registry.curve(well.id, inputsFor(well).gr);
  return <Box title={`Method settings — ${METHODS.find((m) => m.id === method)!.label}`} right={method === 'vsh' && gr && d ? <button className="btn sm" onClick={() => { zones.forEach((z) => { const pk = grPicks(d, gr, z.top, z.base, restrictIv(well.id, S().petro.zonation)); setParam(well.id, z.key, 'grClean', +pk.p5.toFixed(2)); setParam(well.id, z.key, 'grShale', +pk.p95.toFixed(2)); }); S().log(`GR clean/shale set to zone P5/P95 (${well.name})`); }}>Set GR lines = P5 / P95 per zone</button> : undefined}>
    <div className="tbl-wrap"><table className="t ptable">
      <thead>
        <tr><th></th><th className="zone">All zones</th>{zones.map((z) => <th key={z.key} className="zone">{z.name}</th>)}</tr>
        <tr><td className="lab">Well</td><td className="dim">—</td>{zones.map((z) => <td key={z.key}>{well.name}</td>)}</tr>
        <tr><td className="lab">Top</td><td className="dim">—</td>{zones.map((z) => <td key={z.key} className="num">{fmt(z.top, 7)}</td>)}</tr>
        <tr><td className="lab">Bottom</td><td className="dim">—</td>{zones.map((z) => <td key={z.key} className="num">{fmt(z.base, 7)}</td>)}</tr>
      </thead>
      <tbody>{rows.map((r) => [r.group && <tr key={'g' + r.k} className="grp"><td colSpan={zones.length + 2}>{r.group}</td></tr>,
        <tr key={r.k}><td className="lab" title={r.hint}>{r.l}{r.u ? ` (${r.u})` : ''}{r.hint ? ' ⓘ' : ''}</td><td>{cell('*', r)}</td>{zones.map((z) => <td key={z.key}>{cell(z.key, r)}</td>)}</tr>])}</tbody>
    </table></div>
    <div className="hint" style={{ marginTop: 6 }}>"All zones" sets a value for every zone (and clears per-zone overrides of that row); a zone column overrides it. Empty GR lines are picked automatically as the zone's P5 / P95 when the workflow runs.</div>
    {method === 'vsh' && <div className="formula" style={{ marginTop: 6 }}>IGR = (GR − GRclean)/(GRshale − GRclean), clipped 0–1{'\n'}{Object.values(VSH_EQ).join('\n')}</div>}
    {method === 'nd' && <div className="formula" style={{ marginTop: 6 }}>{'PHID = (ρma − RHOB)/(ρma − ρfl)\nPHIN = ((NPHI + ΔN) − Nma)/(Nfl − Nma)\nPHIT_ND = (PHID + PHIN)/2  if PHIN ≥ PHID;  √((PHID² + PHIN²)/2) if PHIN < PHID (gas crossover)\nPHIE_ND = ND(PHID − VSH·PHIDsh, PHIN − VSH·PHINsh)\nHC correction (optional): iterate φ with ρfl,eff = Sxo·ρmf + (1−Sxo)·ρhc, HIeff = Sxo·HImf + (1−Sxo)·HIhc,\n  Sxo = Sw^(1/invasion factor), Sw = Archie(Rt, φ); ρmf = 1 + 0.73·S, HImf = 1 − 0.4·S (S = salinity/10⁶)'}{zones[0] ? `\n→ ${zones[0].name}: ρmf ≈ ${brineDensity(paramsFor(well.id, zones[0].key).mudSalinity).toFixed(3)} g/cc; Rmf(T) ≈ ${brineRes(paramsFor(well.id, zones[0].key).mudSalinity, toDegC(paramsFor(well.id, zones[0].key).temperature, paramsFor(well.id, zones[0].key).tempUnit)).toFixed(4)} ohm.m` : ''}</div>}
    {method === 'sw' && <div className="formula" style={{ marginTop: 6 }}>{'SW_AR = (a·Rw(T) / (PHIT^m · Rt))^(1/n)\nRw(T) = Rw · (Tref + 21.5)/(T + 21.5)  (Arps, °C)\nArchie assumes clean rock — in shaly intervals Sw is pessimistic (too high).'}</div>}
  </Box>;
}

function InputsPanel({ well }: { well: WellMeta }) {
  useStore((s) => s.petro); const inp = inputsFor(well); const auto = autoInputs(well);
  const set = (k: keyof PetroInputs, v: string) => { const st = S(); setPetro({ inputs: { ...st.petro.inputs, [well.id]: { ...(st.petro.inputs[well.id] ?? {}), [k]: v } } }); };
  const rows: [keyof PetroInputs, string][] = [['gr', 'Gamma ray'], ['rhob', 'Bulk density'], ['nphi', 'Neutron porosity'], ['rt', 'Deep resistivity (Rt)'], ['rxo', 'Shallow / Rxo (optional)'], ['cali', 'Caliper'], ['bs', 'Bit size curve (optional)'], ['drho', 'Density correction'], ['vsh', 'Shale volume (if Vsh method off)'], ['phit', 'Total porosity (if ND method off)']];
  return <Box title="Inputs (auto-mapped by curve family — override if needed)">
    <table className="t"><thead><tr><th>Input</th><th>Curve</th><th>Unit</th><th>Auto</th></tr></thead><tbody>{rows.map(([k, l]) => <tr key={k}><td>{l}</td><td><CurvePicker wellId={well.id} value={inp[k]} onChange={(v) => set(k, v)} allowNone="— none —" /></td><td className="dim">{well.curves.find((c) => c.mnemonic === inp[k])?.unit ?? ''}</td><td className="dim mono">{auto[k] || '—'}</td></tr>)}</tbody></table>
    <div className="hint" style={{ marginTop: 4 }}>Deep resistivity prefers AT90 (2-ft AIT, 90-in depth of investigation). Neutron in p.u. is detected and converted to v/v automatically (stated in the run messages).</div>
  </Box>;
}

// ── Vsh: GR histogram with P5 / P95 picks ──
function VshPick({ well, zones }: { well: WellMeta; zones: ReturnType<typeof petroZones> }) {
  useStore((s) => s.petro); const [zk, setZk] = useState(zones[0]?.key ?? '');
  const z = zones.find((q) => q.key === zk) ?? zones[0]; const d = registry.depth(well.id); const gr = registry.curve(well.id, inputsFor(well).gr);
  if (!z || !d || !gr) return <Empty>Map a GR curve and define a zone.</Empty>;
  const rI = restrictIv(well.id, S().petro.zonation); const vals: number[] = []; for (let i = 0; i < d.length; i++) if (d[i] >= z.top && d[i] < z.base && isNum(gr[i]) && (!rI.length || rI.some((r) => d[i] >= r.top && d[i] < r.base))) vals.push(gr[i]);
  const h = histogram(vals, 40); const pk = grPicks(d, gr, z.top, z.base, restrictIv(well.id, S().petro.zonation)); const p = paramsFor(well.id, z.key);
  const sorted = [...vals].sort((a, b) => a - b); const cum = sorted.length ? h!.x.map((x) => sorted.filter((v) => v <= x).length / sorted.length) : [];
  const ymax = Math.max(...(h?.y ?? [1]));
  const gcl = isNum(p.grClean) ? p.grClean : pk.p5, gsh = isNum(p.grShale) ? p.grShale : pk.p95;
  return <Box title={`GR histogram — ${z.name} (${z.top}–${z.base}), N = ${vals.length}`} right={<><Sel value={z.key} onChange={setZk} options={zones.map((q) => ({ v: q.key, l: q.name }))} /><button className="btn sm" onClick={() => { setParam(well.id, z.key, 'grClean', +pk.p5.toFixed(2)); setParam(well.id, z.key, 'grShale', +pk.p95.toFixed(2)); S().log(`${z.name}: GR clean/shale = P5/P95 = ${pk.p5.toFixed(1)}/${pk.p95.toFixed(1)}`); }}>Use P5 / P95</button></>}>
    <div className="grid2" style={{ height: 380 }}>
      <div className="box"><XYPlot light title="Frequency (bars) · cumulative (line, right scale ×max)" xLabel="GR (gAPI)" yLabel="count" series={h ? [{ kind: 'bars', x: h.x, y: h.y, color: '#3b5bdb' }, { kind: 'line', x: h.x, y: cum.map((c) => c * ymax), color: '#000000', width: 1.5 }] : []}
        refLines={[{ x1: gcl, y1: 0, x2: gcl, y2: ymax, color: '#e8a400', label: `clean ${gcl.toFixed(1)}` }, { x1: gsh, y1: 0, x2: gsh, y2: ymax, color: '#8b4513', label: `shale ${gsh.toFixed(1)}` }, { x1: pk.p50, y1: 0, x2: pk.p50, y2: ymax, color: '#888', dash: true, label: 'P50' }]} /></div>
      <div className="col">
        <Kv rows={[['Q1 [P5]', fmt(pk.p5, 5)], ['Q3 [P50]', fmt(pk.p50, 5)], ['Q5 [P95]', fmt(pk.p95, 5)], ['GR clean (used)', fmt(gcl, 5)], ['GR shale (used)', fmt(gsh, 5)], ['Method', VSH_LABEL[p.vshMethod]]]} />
        <div className="hint">Clean/shale lines drive IGR. Picking them inside the reservoir interval (not the whole well) avoids letting thick overburden shales or hot marine shales set the scale. Edit the numbers in the Parameters tab if the P5/P95 are not representative (e.g. no clean sand in the zone).</div>
      </div>
    </div>
  </Box>;
}

// ── ND crossplot with lithology lines, shale point, and core calibration ──
function NdPick({ well, zones }: { well: WellMeta; zones: ReturnType<typeof petroZones> }) {
  useStore((s) => s.petro); useStore((s) => s.dataVersion); const [zk, setZk] = useState(zones[0]?.key ?? ''); const [clickSets, setClickSets] = useState<'none' | 'shale' | 'matrix'>('none');
  const z = zones.find((q) => q.key === zk) ?? zones[0]; const inp = inputsFor(well); const d = registry.depth(well.id);
  const rb = registry.curve(well.id, inp.rhob), np = registry.curve(well.id, inp.nphi), gr = registry.curve(well.id, inp.gr), vs = registry.curve(well.id, 'VSH_GR');
  const cores = useStore((s) => s.cores.filter((c) => c.wellId === well.id));
  const calib = useMemo(() => {
    const phi = registry.curve(well.id, 'PHIT_ND_UNCL') ? 'PHIT_ND_UNCL' : registry.curve(well.id, 'PHIT_ND') ? 'PHIT_ND' : '';
    if (!phi) return null; const X: number[] = [], Y: number[] = [], D: number[] = []; let note = '';
    for (const c of cores) { const a = registry.core(c.id); if (!a) continue; const cp = corePhiFraction(c, a); note = cp.note; if (!cp.v) continue; const sh = coreDepths(c, a).shifted; const lg = sampleLogAt(well, phi, sh);
      for (let i = 0; i < sh.length; i++) if (!a.excluded[i] && isNum(cp.v[i]) && isNum(lg[i]) && (!z || (sh[i] >= z.top && sh[i] < z.base))) { X.push(lg[i]); Y.push(cp.v[i]); D.push(sh[i]); } }
    if (X.length < 3) return { phi, X, Y, D, note, st: null };
    const diff = X.map((x, i) => x - Y[i]); const bias = diff.reduce((s, v) => s + v, 0) / diff.length; const rmse = Math.sqrt(diff.reduce((s, v) => s + v * v, 0) / diff.length);
    return { phi, X, Y, D, note, st: { n: X.length, bias, rmse, r: pearson(X, Y) } };
  }, [well.id, cores.length, z?.key, S().dataVersion]);
  if (!z || !d || !rb || !np) return <Empty>Map RHOB and NPHI and define a zone.</Empty>;
  const p = paramsFor(well.id, z.key); const nu = (inp.nphi && /%|pu/i.test(well.curves.find((c) => c.mnemonic === inp.nphi)?.unit ?? '')) || percentiles(np, [95])[0] > 1.5 ? 0.01 : 1;
  const X: number[] = [], Y: number[] = [], C: string[] = [], I: number[] = [];
  const rI = restrictIv(well.id, S().petro.zonation); const inR = (x: number) => !rI.length || rI.some((r) => x >= r.top && x < r.base);
  for (let i = 0; i < d.length; i++) if (d[i] >= z.top && d[i] < z.base && inR(d[i]) && isNum(rb[i]) && isNum(np[i])) { X.push(np[i] * nu); Y.push(rb[i]); C.push(vs && isNum(vs[i]) ? ramp(vs[i]) : gr && isNum(gr[i]) ? ramp(gr[i], p.grClean || 20, p.grShale || 150) : '#555'); I.push(i); }
  const fl = p.rhoFl; const lines = [{ n: 'Sandstone', ma: [-0.035, 2.65], c: '#d4a017' }, { n: 'Limestone', ma: [0, 2.71], c: '#1c7ed6' }, { n: 'Dolomite', ma: [0.02, 2.87], c: '#7048e8' }];
  const userMa: [number, number] = [p.nphiMa - p.nphiShift, p.rhoMa];
  const ref = [...lines.map((l) => ({ x1: l.ma[0], y1: l.ma[1], x2: l.ma[0] + (1 - l.ma[0]) * 0.45, y2: l.ma[1] + (fl - l.ma[1]) * 0.45, color: l.c, label: l.n })),
    { x1: userMa[0], y1: userMa[1], x2: userMa[0] + (p.nphiFl - userMa[0]) * 0.45, y2: userMa[1] + (fl - userMa[1]) * 0.45, color: '#e03131', dash: true, label: 'your matrix' },
    { x1: userMa[0], y1: userMa[1], x2: p.nphiSh, y2: p.rhoSh, color: '#5c3d1e', dash: true, label: 'shale pt' }];
  const pick = (_s: number, j: number) => { if (clickSets === 'none' || _s !== 0) return; const i = I[j]; if (clickSets === 'shale') { setParam(well.id, z.key, 'nphiSh', +(np[i] * nu).toFixed(4)); setParam(well.id, z.key, 'rhoSh', +rb[i].toFixed(4)); S().log(`${z.name}: shale point set to N=${(np[i] * nu).toFixed(3)}, ρ=${rb[i].toFixed(3)}`); } else { setParam(well.id, z.key, 'rhoMa', +rb[i].toFixed(4)); S().log(`${z.name}: matrix density set to ${rb[i].toFixed(3)}`); } };
  return <div className="col">
    <Box title={`Neutron–density crossplot — ${z.name}, N = ${X.length} (colour = ${vs ? 'VSH_GR' : 'GR'}: yellow clean → brown shaly)`} right={<><Sel value={z.key} onChange={setZk} options={zones.map((q) => ({ v: q.key, l: q.name }))} /><span className="hint">click point sets</span><Sel value={clickSets} onChange={setClickSets} options={[{ v: 'none', l: '—' }, { v: 'shale', l: 'shale point' }, { v: 'matrix', l: 'matrix density' }]} /></>}>
      <div className="grid2" style={{ height: 420 }}>
        <div className="box"><XYPlot light title="RHOB vs NPHI (limestone-unit lithology lines)" xLabel="NPHI (v/v)" yLabel="RHOB (g/cc)" invertY xRange={[-0.15, 0.45]} yRange={[1.9, 3.0]}
          series={[{ kind: 'scatter', x: X, y: Y, colors: C, size: 2.4, tip: (j) => `depth ${d[I[j]].toFixed(2)}` }, { kind: 'scatter', x: [p.nphiSh], y: [p.rhoSh], color: '#5c3d1e', size: 7, symbol: 'diamond', label: 'shale point' }]}
          refLines={ref} onClickPoint={pick} /></div>
        <div className="col">
          <Kv rows={[['Matrix ρma / Nma', `${p.rhoMa} / ${p.nphiMa} (ΔN ${p.nphiShift})`], ['Fluid ρfl / Nfl', `${p.rhoFl} / ${p.nphiFl}`], ['Shale point', `ρ ${p.rhoSh} · N ${p.nphiSh}`], ['Neutron unit', nu === 1 ? 'v/v' : 'p.u. → ÷100']]} />
          <div className="hint">Points on/near the sandstone line with the matrix set to 2.65 → quartz sand. Points plotting above/left of the lines (low density, low neutron) show gas/light hydrocarbon — enable the hydrocarbon correction for those zones. Points drifting toward the shale point are shaly: PHIE_ND removes the shale contribution with VSH.</div>
          <div className="hint">TNPH is normally recorded in limestone units: if the sand points sit ~0.03–0.04 left of your matrix line, set ΔN ≈ +0.04.</div>
        </div>
      </div>
    </Box>
    <Box title={`Core calibration — core φ vs ${calib?.phi || 'PHIT_ND'} (${z.name})`}>
      {!calib ? <Empty>Run the neutron-density method first.</Empty> : <div className="grid2" style={{ height: 360 }}>
        <div className="box"><XYPlot light title={`Core φ vs log ${calib.phi}`} xLabel={`${calib.phi} (v/v)`} yLabel="core φ (v/v)" xRange={[0, 0.35]} yRange={[0, 0.35]} series={[{ kind: 'scatter', x: calib.X, y: calib.Y, color: '#111', size: 3, tip: (i) => `depth ${calib.D[i].toFixed(2)}` }]} refLines={[{ x1: 0, y1: 0, x2: 0.35, y2: 0.35, color: '#e03131', label: '1:1' }]} /></div>
        <div className="col">{calib.st ? <Kv rows={[['N', String(calib.st.n)], ['Bias (log − core)', fmt(calib.st.bias, 3)], ['RMSE', fmt(calib.st.rmse, 3)], ['Pearson r', fmt(calib.st.r, 3)], ['Core φ source', calib.note]]} /> : <span className="hint">Fewer than 3 core samples inside {z.name} (after depth shift).</span>}
          <div className="hint">A systematic bias usually means the matrix density or neutron matrix is off (or core φ is ambient vs. overburden). Large scatter with no bias points to depth mismatch — check Core-Log depth matching first.</div></div>
      </div>}
    </Box>
  </div>;
}

// ── Pickett plot ──
function Pickett({ well, zones }: { well: WellMeta; zones: ReturnType<typeof petroZones> }) {
  useStore((s) => s.petro); useStore((s) => s.dataVersion); const [zk, setZk] = useState(zones[0]?.key ?? ''); const [allZ, setAllZ] = useState(false); const [cleanOnly, setCleanOnly] = useState(true);
  const z = zones.find((q) => q.key === zk) ?? zones[0]; const inp = inputsFor(well); const d = registry.depth(well.id);
  const rt = registry.curve(well.id, inp.rt); const ph = registry.curve(well.id, registry.curve(well.id, 'PHIT_ND') ? 'PHIT_ND' : inp.phit); const vs = registry.curve(well.id, 'VSH_GR');
  if (!z || !d) return <Empty>Define a zone.</Empty>;
  if (!rt || !ph) return <Empty>Pickett needs Rt and total porosity — run the neutron-density method first (or map PHIT in Inputs).</Empty>;
  const p = paramsFor(well.id, z.key); const rwT = arps(p.rw, toDegC(p.rwTemp, p.tempUnit), toDegC(p.temperature, p.tempUnit));
  const R: number[] = [], F: number[] = [], C: string[] = [], D: number[] = [];
  const rI = restrictIv(well.id, S().petro.zonation); const inR = (x: number) => !rI.length || rI.some((r) => x >= r.top && x < r.base);
  for (let i = 0; i < d.length; i++) { if (d[i] < z.top || d[i] >= z.base || !inR(d[i]) || !isNum(rt[i]) || !isNum(ph[i]) || rt[i] <= 0 || ph[i] <= 0.005) continue; if (cleanOnly && vs && isNum(vs[i]) && vs[i] > p.vshCut) continue; R.push(rt[i]); F.push(ph[i]); C.push(vs && isNum(vs[i]) ? ramp(vs[i]) : '#333'); D.push(d[i]); }
  const phis = [0.01, 1]; const sws = [1, 0.75, 0.5, 0.3, 0.2];
  const lines = sws.map((s, k) => { const rAt = (f: number) => (p.a * rwT) / (Math.pow(f, p.m) * Math.pow(s, p.n)); return { x1: rAt(phis[0]), y1: phis[0], x2: rAt(phis[1]), y2: phis[1], color: k === 0 ? '#1864ab' : '#4dabf7', dash: k > 0, label: k === 0 ? 'Sw 100%' : `${Math.round(s * 100)}%` }; });
  const apply = (patch: Partial<PetroZoneParams>) => { for (const key of allZ ? zones.map((q) => q.key) : [z.key]) for (const [k, v] of Object.entries(patch)) setParam(well.id, key, k as keyof PetroZoneParams, v); };
  const fit = (fitM: boolean) => { const f = fitPickett(R, F, p.a, p.m, fitM); if (!f) return; const rwRef = arps(f.rw, toDegC(p.temperature, p.tempUnit), toDegC(p.rwTemp, p.tempUnit)); apply(fitM ? { rw: +rwRef.toPrecision(3), m: +f.m.toFixed(2) } : { rw: +rwRef.toPrecision(3) }); S().log(`Pickett ${z.name}: fitted Rw = ${rwRef.toPrecision(3)} ohm.m${fitM ? `, m = ${f.m.toFixed(2)}` : ''} (lower envelope, N=${f.n})`); };
  const clickPt = (_s: number, j: number) => { if (_s !== 0) return; const rwAt = (R[j] * Math.pow(F[j], p.m)) / p.a; const rwRef = arps(rwAt, toDegC(p.temperature, p.tempUnit), toDegC(p.rwTemp, p.tempUnit)); apply({ rw: +rwRef.toPrecision(3) }); S().log(`Pickett ${z.name}: 100 % Sw line through point at ${D[j].toFixed(2)} → Rw = ${rwRef.toPrecision(3)}`); };
  // sensitivity of average Sw (φ-weighted) in the zone
  const avgSw = (q: PetroZoneParams) => { const rw2 = arps(q.rw, toDegC(q.rwTemp, q.tempUnit), toDegC(q.temperature, q.tempUnit)); let a = 0, b = 0; for (let i = 0; i < R.length; i++) { const s = Math.min(1, Math.pow((q.a * rw2) / (Math.pow(F[i], q.m) * R[i]), 1 / q.n)); a += F[i] * s; b += F[i]; } return b ? a / b : NaN; };
  const sens: [string, number, number][] = [['m ± 0.2', avgSw({ ...p, m: p.m - 0.2 }), avgSw({ ...p, m: p.m + 0.2 })], ['n ± 0.2', avgSw({ ...p, n: p.n - 0.2 }), avgSw({ ...p, n: p.n + 0.2 })], ['Rw ± 20 %', avgSw({ ...p, rw: p.rw * 0.8 }), avgSw({ ...p, rw: p.rw * 1.2 })], ['a ± 0.1', avgSw({ ...p, a: p.a - 0.1 }), avgSw({ ...p, a: p.a + 0.1 })]];
  const base = avgSw(p);
  return <Box title={`Pickett plot — ${z.name}, N = ${R.length}${cleanOnly && vs ? ` (VSH ≤ ${p.vshCut})` : ''}`} right={<><Sel value={z.key} onChange={setZk} options={zones.map((q) => ({ v: q.key, l: q.name }))} /><label className="cb"><input type="checkbox" checked={cleanOnly} onChange={(e) => setCleanOnly(e.target.checked)} />clean points only</label><label className="cb"><input type="checkbox" checked={allZ} onChange={(e) => setAllZ(e.target.checked)} />apply to all zones</label></>}>
    <div className="grid2" style={{ height: 470 }}>
      <div className="box"><XYPlot light title="log PHIT vs log Rt — click a wet point to put the 100 % Sw line through it" logX logY xLabel={`${inp.rt} (ohm.m)`} yLabel="PHIT (v/v)" xRange={[0.1, 2000]} yRange={[0.01, 1]}
        series={[{ kind: 'scatter', x: R, y: F, colors: C, size: 2.6, tip: (i) => `depth ${D[i].toFixed(2)} · Rwa ${fmt(R[i] * Math.pow(F[i], p.m) / p.a, 3)}` }]} refLines={lines} onClickPoint={clickPt} /></div>
      <div className="col">
        <Box title="Water line">
          <Field label="Rw @ Tref (ohm.m)"><Num value={p.rw} onChange={(v) => v > 0 && apply({ rw: v })} /></Field>
          <input type="range" min={-3} max={0.5} step={0.01} value={Math.log10(p.rw)} onChange={(e) => apply({ rw: +Math.pow(10, +e.target.value).toPrecision(3) })} />
          <Field label="m (slope = −1/m)"><Num value={p.m} onChange={(v) => v > 0.5 && apply({ m: v })} /></Field>
          <input type="range" min={1.3} max={3} step={0.01} value={p.m} onChange={(e) => apply({ m: +e.target.value })} />
          <Field label="n (line spacing)"><Num value={p.n} onChange={(v) => v > 0.5 && apply({ n: v })} /></Field>
          <Field label="a"><Num value={p.a} onChange={(v) => v > 0 && apply({ a: v })} /></Field>
          <Kv rows={[['Rw at formation T', `${rwT.toPrecision(3)} ohm.m (T = ${p.temperature}°${p.tempUnit === 'degF' ? 'F' : 'C'})`], ['Rwa P10 / P50', R.length ? percentiles(R.map((r, i) => (r * Math.pow(F[i], p.m)) / p.a), [10, 50]).map((x) => x.toPrecision(3)).join(' / ') : '—']]} />
          <div className="row" style={{ marginTop: 4 }}><button className="btn sm" onClick={() => fit(false)}>Fit Rw (P10 Rwa)</button><button className="btn sm" onClick={() => fit(true)}>Fit m + Rw</button></div>
        </Box>
        <Box title="Sensitivity — φ-weighted mean Sw in zone"><table className="t"><thead><tr><th>Parameter</th><th>low</th><th>base</th><th>high</th></tr></thead><tbody>{sens.map(([l, a, b]) => <tr key={l}><td>{l}</td><td className="num">{fmt(a, 3)}</td><td className="num">{fmt(base, 3)}</td><td className="num">{fmt(b, 3)}</td></tr>)}</tbody></table>
          <div className="hint">Shows which parameter controls the answer — spend picking effort there.</div></Box>
      </div>
    </div>
  </Box>;
}

// ── Cut-offs & summation ──
function Summation({ well, zones }: { well: WellMeta; zones: ReturnType<typeof petroZones> }) {
  useStore((s) => s.dataVersion);
  const g = (m: string) => registry.curve(well.id, m);
  const rows: SumRow[] = summation(well.id, zones, { phi: g('PHIE_ND') ?? g('PHIT_ND'), sw: g('SW_AR'), vsh: g('VSH_GR'), netRes: g('NET_RES'), netPay: g('NET_PAY') });
  if (!g('NET_RES')) return <Empty>Run the workflow with "Cut-offs & summation" checked.</Empty>;
  const tot = rows.reduce((a, r) => ({ gross: a.gross + r.gross, net: a.net + r.netRes, pay: a.pay + r.netPay, hc: a.hc + r.hcpv }), { gross: 0, net: 0, pay: 0, hc: 0 });
  const csv = () => download([['Zone', 'Top', 'Base', 'Gross', 'Net reservoir', 'N/G', 'Net pay', 'Avg phi', 'Avg Sw', 'Avg Vsh', 'HCPV (m)'].join(','), ...rows.map((r) => [r.name, r.top, r.base, r.gross.toFixed(2), r.netRes.toFixed(2), r.ntg.toFixed(3), r.netPay.toFixed(2), r.phiAvg.toFixed(4), r.swAvg.toFixed(4), r.vshAvg.toFixed(4), r.hcpv.toFixed(4)].join(','))].join('\n'), `${well.name}_summation.csv`, 'text/csv');
  return <Box title="Summation per zone (net reservoir: VSH ≤ cut, φ ≥ cut; net pay: + Sw ≤ cut)" right={<button className="btn sm" onClick={csv}>Export CSV</button>}>
    <table className="t"><thead><tr><th>Zone</th><th>Top</th><th>Base</th><th>Gross (m)</th><th>Net res. (m)</th><th>N/G</th><th>Net pay (m)</th><th>Avg φ</th><th>Avg Sw</th><th>Avg VSH</th><th>HCPV φ(1−Sw)h (m)</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.name}><td>{r.name}</td><td className="num">{fmt(r.top, 6)}</td><td className="num">{fmt(r.base, 6)}</td><td className="num">{r.gross.toFixed(2)}</td><td className="num">{r.netRes.toFixed(2)}</td><td className="num">{fmt(r.ntg, 3)}</td><td className="num">{r.netPay.toFixed(2)}</td><td className="num">{fmt(r.phiAvg, 3)}</td><td className="num">{fmt(r.swAvg, 3)}</td><td className="num">{fmt(r.vshAvg, 3)}</td><td className="num">{r.hcpv.toFixed(3)}</td></tr>)}
        <tr style={{ fontWeight: 600 }}><td>Total</td><td /><td /><td className="num">{tot.gross.toFixed(2)}</td><td className="num">{tot.net.toFixed(2)}</td><td className="num">{fmt(tot.gross ? tot.net / tot.gross : NaN, 3)}</td><td className="num">{tot.pay.toFixed(2)}</td><td /><td /><td /><td className="num">{tot.hc.toFixed(3)}</td></tr></tbody></table>
    <div className="hint" style={{ marginTop: 4 }}>Averages are thickness-weighted over net reservoir; Sw is pore-volume (φ·h) weighted. Thickness = sample count × step (measured depth — not true vertical / stratigraphic thickness).</div>
  </Box>;
}

// ── Depth view on the reservoir (conventional tracks) ──
export function DepthView({ well, which }: { well: WellMeta; which: Method | 'all' }) {
  useStore((s) => s.dataVersion); const petro = useStore((s) => s.petro); const inp = inputsFor(well); const d = registry.depth(well.id);
  const zones = petroZones(well.id, petro.zonation); const cores = useStore((s) => s.cores.filter((c) => c.wellId === well.id));
  if (!d) return <Empty>Loading…</Empty>;
  const top = zones.length ? Math.min(...zones.map((z) => z.top)) - 10 : well.start, base = zones.length ? Math.max(...zones.map((z) => z.base)) + 10 : Math.min(well.stop, well.start + 200);
  const c = (m: string) => (m ? registry.curve(well.id, m) : undefined);
  const S_ = (m: string, color: string, extra: any = {}) => { const v = c(m); return v ? [{ depth: d, values: v, label: m, unit: well.curves.find((q) => q.mnemonic === m)?.unit ?? '', color, ...extra }] : []; };
  const coreDots = (() => { const X: number[] = [], D: number[] = []; for (const cm of cores) { const a = registry.core(cm.id); if (!a) continue; const cp = corePhiFraction(cm, a); if (!cp.v) continue; const sh = coreDepths(cm, a).shifted; for (let i = 0; i < sh.length; i++) if (!a.excluded[i]) { X.push(cp.v[i]); D.push(sh[i]); } } return X.length ? [{ depth: D, values: X, label: 'core φ', unit: 'v/v', color: '#e00000', kind: 'dots' as const, min: 0.45, max: 0, size: 3 }] : []; })();
  const tracks: DepthTrack[] = [
    { width: 120, series: [...S_(inp.cali, '#b00000', { min: 6, max: 16 }), ...S_(inp.bs, '#000000', { min: 6, max: 16, dash: true })] },
    { width: 40, series: [...S_('BH_FL_BS', '#e00000', { min: 0, max: 1, fill: 'left', fillColor: '#e00000' })] },
    { width: 150, series: [...S_(inp.gr, '#000000', { min: 0, max: 150 }), ...S_('VSH_GR', '#2b8a3e', { min: 0, max: 1, fill: 'left', fillColor: 'rgba(43,138,62,0.3)' })] },
    { width: 150, series: [...S_(inp.rt, '#1c3ef0', { min: 0.2, max: 2000, log: true }), ...S_(inp.rxo, '#e8590c', { min: 0.2, max: 2000, log: true, dash: true })] },
    { width: 160, series: [...S_(inp.rhob, '#e00000', { min: 1.95, max: 2.95 }), ...S_(inp.nphi, '#1c3ef0', { min: 0.45, max: -0.15, dash: true })] },
    { width: 40, series: [...S_('BH_FL_DRHO', '#e00000', { min: 0, max: 1, fill: 'left', fillColor: '#e00000' })] },
    { width: 160, series: [...S_('PHIT_ND_UNCL', '#1c3ef0', { min: 0.45, max: 0 }), ...S_('PHIE_ND', '#0ca678', { min: 0.45, max: 0, fill: 'right', fillColor: 'rgba(12,166,120,0.18)' }), ...coreDots] },
    { width: 140, series: [...S_('SW_AR', '#000000', { min: 1, max: 0, fill: 'right', fillColor: 'rgba(80,200,230,0.45)' })] },
    { width: 50, series: [...S_('NET_RES', '#e8b400', { min: 0, max: 1, fill: 'left', fillColor: '#ffe066' }), ...S_('NET_PAY', '#c92a2a', { min: 0, max: 1, fill: 'left', fillColor: 'rgba(201,42,42,0.6)' })] },
  ].filter((t) => t.series.length) as DepthTrack[];
  void which;
  return <div style={{ height: 720 }}><DepthPlot title={`${well.name} — petrophysical evaluation (${petro.zonation === 'reservoir' ? 'reservoir intervals' : petro.zonation})`} wellId={well.id} tracks={tracks} range={[top, base]} /></div>;
}
