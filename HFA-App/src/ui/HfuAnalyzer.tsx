import { DepthPlot } from '../visualization/DepthPlot';
import { useMemo, useState } from 'react';
import { S, useStore, activeCore } from '../store/store';
import { registry } from '../data-engine/registry';
import { coreDepths, projectCoreToGrid, unitFromName } from '../data-engine/core';
import { putCalculatedCurve } from '../data-engine/ingest';
import { computeCoreHfu, computeRqiFzi, classifyFzi, hfuEquations, DERIVED_CORE_COLS, type HfuCalcReport } from '../hfu/engine';
import { fziBoundaries, makeUnits, METHOD_LABEL, probabilityPlotData, unitSlopeFits, unitStats, type FziMethod } from '../hfu/identify';
import { guessPermUnit, guessPhiUnit, PERM_LABEL } from '../petrophysics/units';
import type { CoreMeta, HfuSet, PermUnit, PhiUnit, WellMeta } from '../types';
import { Box, CurvePicker, Empty, Field, Kv, ModHead, Msgs, Num, Sel, Tabs, useActiveWell } from './common';
import { CoreSelector } from './CoreManager';
import { RightPanel } from './RightPanel';
import { XYPlot } from '../visualization/XYPlot';
import { histogram } from './Calculator';
import { fmt, hfuColor, isNum, nowIso, percentiles, uid } from '../util/num';
import { findByFamily } from '../curves/catalog';
import { scopeIntervals, scopeLabel } from '../data-engine/zones';
import { ZoneSelect } from './common';

/** Sparse projection of core results onto the log grid (for the log viewer / crossplots). */
export function projectCoreResults(core: CoreMeta, well: WellMeta, labels?: number[]) {
  const arr = registry.core(core.id)!; const { shifted } = coreDepths(core, arr);
  const put = (name: string, src: string, unit: string) => {
    const a = arr.num.get(src); if (!a) return;
    const v = Float64Array.from(a, (x, i) => (arr.excluded[i] ? NaN : x));
    putCalculatedCurve(well.id, name, projectCoreToGrid(well, shifted, v), unit, `Core ${src} projected to log grid`, { kind: 'core-projection', formula: `nearest log sample to shifted core depth ← ${core.name}.${src}`, inputs: [src], units: unit, version: 1, missing: 'NaN where no core sample within ±0.75 step', createdAt: nowIso() });
  };
  put('PHI_CORE', 'PHI', 'v/v'); put('K_CORE', 'K', 'mD'); put('RQI_CORE', 'RQI', 'µm'); put('FZI_CORE', 'FZI', 'µm');
  if (labels) putCalculatedCurve(well.id, 'HFU_CORE', projectCoreToGrid(well, shifted, labels.map((l, i) => (arr.excluded[i] || !l ? NaN : l))), '', 'HFU / cluster at core samples', { kind: 'hfu', formula: 'core-sample HFU labels projected to log grid', inputs: ['FZI'], units: '', version: 1, missing: 'NaN between core samples', createdAt: nowIso() }, true);
}

export function HfuAnalyzer() {
  const [tab, setTab] = useState<'calc' | 'ident'>('calc');
  const [domain, setDomain] = useState<'core' | 'log'>('core');
  return <>
    <ModHead title="HFA / HFU Analyzer" sub="RQI · Φz · FZI · Hydraulic Flow Unit identification (methods A–E; F in HFU Clustering)">
      <Sel value={domain} onChange={setDomain} options={[{ v: 'core', l: 'Data: core samples' }, { v: 'log', l: 'Data: log curves (φ + k logs)' }]} />
    </ModHead>
    <Tabs value={tab} onChange={setTab} tabs={[{ v: 'calc', l: '1 · RQI / FZI calculation' }, { v: 'ident', l: '2 · HFU identification' }]} />
    <div className="mod-b">{tab === 'calc' ? (domain === 'core' ? <CoreCalc /> : <LogCalc />) : <Identify domain={domain} />}</div>
    <RightPanel><HfuSetsPanel /></RightPanel>
  </>;
}

function StatusView({ r }: { r: HfuCalcReport | null }) {
  if (!r) return <span className="hint">Not calculated yet.</span>;
  return <div className="col">
    <Kv rows={[['Input units', r.inputUnits || '—'], ['Converted units', r.convertedUnits], ['Calculation status', <span className={'tag ' + (r.status === 'OK' ? 'ok' : 'crit')}>{r.status}</span>], ['Samples', `${r.n} total · ${r.nValid} valid`]]} />
    {r.excluded.map((e, i) => <div key={i} className="hint">Excluded N={e.n}: {e.reason}</div>)}
    <Msgs items={r.messages.map((m) => ({ level: r.status === 'OK' ? 'INFO' : 'CRITICAL', text: m }))} />
  </div>;
}

function CoreCalc() {
  const core = useStore((s) => activeCore(s)); const C = useStore((s) => s.hfuConfig.rqiConst); useStore((s) => s.dataVersion);
  const well = useStore((s) => s.wells.find((w) => w.id === core?.wellId));
  const [rep, setRep] = useState<HfuCalcReport | null>(null);
  if (!core || !well) return <Empty>Load a core dataset first (Import Manager → + Add Core Data), or switch to log-curve data.</Empty>;
  const arr = registry.core(core.id)!;
  const run = () => {
    try {
      const r = computeCoreHfu(core, arr, C); setRep(r.report);
      if (r.report.status === 'OK') {
        S().updateCore(core.id, (c) => ({ ...c, columns: [...c.columns.filter((x) => !DERIVED_CORE_COLS.includes(x.name)), ...r.columns.map((x) => ({ ...x, kind: 'num' as const }))] }));
        registry.touchCore(core.id); projectCoreResults(core, well);
        S().log(`Calculated RQI/Φz/FZI for core "${core.name}" (${r.report.nValid} valid; C = ${C}; ${r.report.inputUnits})`);
      } else S().log(`RQI/FZI blocked for "${core.name}": ${r.report.messages[0]}`, 'error');
      S().bump();
    } catch (e: any) { setRep({ status: 'BLOCKED', inputUnits: '', convertedUnits: '', equations: [], n: 0, nValid: 0, excluded: [], messages: [e.message] }); }
  };
  const has = arr.num.has('FZI');
  const phiC = core.map.phi ? arr.num.get(core.map.phi) : undefined;
  const pg = phiC ? guessPhiUnit(core.columns.find((c) => c.name === core.map.phi)?.unit || unitFromName(core.map.phi!), percentiles(phiC, [95])[0]) : null;
  const kg = core.map.k ? guessPermUnit(core.columns.find((c) => c.name === core.map.k)?.unit || unitFromName(core.map.k)) : null;
  const act = (n: string) => Array.from(arr.num.get(n) ?? [], (v, i) => (arr.excluded[i] ? NaN : v));
  return <div className="split w380">
    <div className="col">
      <Box title="Input">
        <Field label="Core dataset"><CoreSelector /></Field>
        <Field label="Porosity column"><span className="mono">{core.map.phi ?? '— map in Core Data —'}</span></Field>
        <Field label="φ representation"><Sel value={(core.phiUnit ?? '') as any} onChange={(v: string) => { S().updateCore(core.id, (c) => ({ ...c, phiUnit: (v || null) as PhiUnit | null })); S().log(`φ unit confirmed: ${v}`); }} options={[{ v: '', l: '— confirm —' }, { v: 'fraction', l: 'fraction (v/v)' }, { v: 'percent', l: 'percent (%)' }]} /></Field>
        {pg && <div className="hint">Detected {pg.unit ?? '?'}: {pg.reason}</div>}
        <Field label="Permeability column"><span className="mono">{core.map.k ?? '— map in Core Data —'}</span></Field>
        <Field label="k unit"><Sel value={(core.kUnit ?? '') as any} onChange={(v: string) => { S().updateCore(core.id, (c) => ({ ...c, kUnit: (v || null) as PermUnit | null })); S().log(`k unit confirmed: ${v}`); }} options={[{ v: '', l: '— confirm —' }, ...(['mD', 'D', 'um2', 'm2'] as PermUnit[]).map((u) => ({ v: u, l: PERM_LABEL[u] }))]} /></Field>
        {kg && <div className="hint">Detected {kg.unit ?? '?'}: {kg.reason}</div>}
        <Field label="RQI constant C"><Num value={C} onChange={(v) => S().set({ hfuConfig: { ...S().hfuConfig, rqiConst: v } })} /></Field>
        <div className="hint">0.0314 converts √(mD) → µm for k in mD and φ as fraction. Change only if you use other unit conventions.</div>
        <button className="btn pri" style={{ marginTop: 6 }} onClick={run}>Calculate RQI / Φz / FZI</button>
      </Box>
      <Box title="Equations used"><div className="formula">{hfuEquations(C).join('\n')}</div></Box>
      <Box title="Status"><StatusView r={rep ?? (has ? { status: 'OK', inputUnits: `φ: ${core.phiUnit}; k: ${core.kUnit}`, convertedUnits: 'φ: fraction; k: mD; RQI, FZI: µm', equations: [], n: core.n, nValid: act('FZI').filter(isNum).length, excluded: [], messages: [] } : null)} /></Box>
    </div>
    <div className="col">
      {has ? <div className="gridD" style={{ height: 640 }}>
        <div className="box"><XYPlot title="log RQI vs log Φz (unit-slope lines = constant FZI)" logX logY xLabel="Φz (v/v)" yLabel="RQI (µm)" series={[{ kind: 'scatter', x: act('PHIZ'), y: act('RQI'), color: '#f5a623', size: 3 }]}
          refLines={[0.1, 0.3, 1, 3, 10].map((f) => ({ x1: 0.01, y1: f * 0.01, x2: 1, y2: f, color: '#3a4a5c', dash: true, label: `FZI ${f}` }))} xRange={[0.01, 1]} yRange={[0.001, 20]} /></div>
        <div className="box"><XYPlot title="Core K vs φ (iso-FZI curves)" logY xLabel="φ (v/v)" yLabel="K (mD)" series={[{ kind: 'scatter', x: act('PHI'), y: act('K'), color: '#4ea1ff', size: 3 }, ...[0.1, 0.3, 1, 3, 10].map((f) => { const x = Array.from({ length: 60 }, (_, i) => 0.01 + i * 0.006); return { kind: 'line' as const, x, y: x.map((p) => p * Math.pow((f * p) / (1 - p) / C, 2)), color: '#3a4a5c', dash: true, width: 1 }; })]} yRange={[0.001, 20000]} /></div>
        <div className="box"><XYPlot title="Histogram of log10 FZI" xLabel="log10 FZI (µm)" yLabel="count" series={[{ kind: 'bars', ...(histogram(act('FZI'), 30, true) ?? { x: [], y: [] }), color: '#b083f0' }]} /></div>
        <div className="dcol" style={{ minHeight: 0 }}><DepthPlot title="FZI / RQI vs depth (shifted core depth)" wellId={core.wellId} tracks={[{ width: 170, series: [{ depth: Array.from(coreDepths(core, arr).shifted), values: act('FZI'), label: 'FZI', unit: 'µm', color: '#d6336c', kind: 'dots', log: true, min: 0.01, max: 100 }] }, { width: 170, series: [{ depth: Array.from(coreDepths(core, arr).shifted), values: act('RQI'), label: 'RQI', unit: 'µm', color: '#7048e8', kind: 'dots', log: true, min: 0.001, max: 10 }] }]} /></div>
      </div> : <Empty>Confirm units and calculate to see RQI/FZI plots.</Empty>}
    </div>
  </div>;
}

function LogCalc() {
  const well = useActiveWell(); const C = useStore((s) => s.hfuConfig.rqiConst); useStore((s) => s.dataVersion);
  const names = well?.curves.map((c) => c.mnemonic) ?? [];
  const [phiC, setPhiC] = useState(() => findByFamily(names, 'PHIE') ?? findByFamily(names, 'CMRP') ?? findByFamily(names, 'PHIT') ?? '');
  const [kC, setKC] = useState(() => findByFamily(names, 'K') ?? findByFamily(names, 'KTIM') ?? findByFamily(names, 'KSDR') ?? '');
  const [pu, setPu] = useState<PhiUnit | ''>(''); const [ku, setKu] = useState<PermUnit | ''>('');
  const [rep, setRep] = useState<HfuCalcReport | null>(null);
  if (!well) return <Empty>No well.</Empty>;
  const pm = well.curves.find((c) => c.mnemonic === phiC), km = well.curves.find((c) => c.mnemonic === kC);
  const pg = pm ? guessPhiUnit(pm.unit, pm.stats.p95, pm.stats.max) : null, kg = km ? guessPermUnit(km.unit) : null;
  const run = () => {
    const p = registry.curve(well.id, phiC), k = registry.curve(well.id, kC); if (!p || !k) { setRep({ status: 'BLOCKED', inputUnits: '', convertedUnits: '', equations: [], n: 0, nValid: 0, excluded: [], messages: ['Select porosity and permeability curves.'] }); return; }
    const r = computeRqiFzi(p, k, (pu || null) as PhiUnit | null, (ku || null) as PermUnit | null, C); setRep(r.report);
    if (r.report.status !== 'OK') return;
    const calc = (f: string) => ({ kind: 'hfu' as const, formula: f, inputs: [phiC, kC], units: 'µm', version: 1, missing: 'NaN where φ∉(0,1), k≤0 or input missing', createdAt: nowIso(), notes: `Input units ${r.report.inputUnits}` });
    putCalculatedCurve(well.id, 'RQI_LOG', Float32Array.from(r.rqi!), 'µm', 'RQI from logs', calc(`${C} * sqrt(${kC}[mD] / ${phiC}[frac])`));
    putCalculatedCurve(well.id, 'PHIZ_LOG', Float32Array.from(r.phiz!), 'v/v', 'Normalized porosity index from logs', { ...calc(`${phiC} / (1 - ${phiC})`), units: 'v/v' });
    putCalculatedCurve(well.id, 'FZI_LOG', Float32Array.from(r.fzi!), 'µm', 'FZI from logs', calc('RQI_LOG / PHIZ_LOG'));
    S().log(`Calculated RQI_LOG / PHIZ_LOG / FZI_LOG on ${well.name} from ${phiC}, ${kC}`);
  };
  return <div className="split w380"><div className="col">
    <Box title="Log inputs">
      <Field label="Porosity curve"><CurvePicker wellId={well.id} value={phiC} onChange={setPhiC} /></Field>
      <Field label="φ unit"><Sel value={pu as any} onChange={setPu as any} options={[{ v: '', l: '— confirm —' }, { v: 'fraction', l: 'fraction' }, { v: 'percent', l: 'percent' }]} /></Field>
      {pg && <div className="hint">Detected {pg.unit ?? '?'}: {pg.reason}</div>}
      <Field label="Permeability curve"><CurvePicker wellId={well.id} value={kC} onChange={setKC} /></Field>
      <Field label="k unit"><Sel value={ku as any} onChange={setKu as any} options={[{ v: '', l: '— confirm —' }, ...(['mD', 'D', 'um2', 'm2'] as PermUnit[]).map((u) => ({ v: u, l: PERM_LABEL[u] }))]} /></Field>
      {kg && <div className="hint">Detected {kg.unit ?? '?'}: {kg.reason}</div>}
      <button className="btn pri" onClick={run}>Calculate RQI_LOG / FZI_LOG</button>
      <div className="hint" style={{ marginTop: 4 }}>Use a log permeability (e.g. NMR KTIM/KSDR, or K from a transform). Units must be confirmed explicitly — the engine never assumes.</div>
    </Box>
    <Box title="Status"><StatusView r={rep} /></Box></div>
    <Box title="Equations"><div className="formula">{hfuEquations(C).join('\n')}</div></Box>
  </div>;
}

function Identify({ domain }: { domain: 'core' | 'log' }) {
  const core = useStore((s) => activeCore(s)); const well0 = useActiveWell(); useStore((s) => s.dataVersion); const C = useStore((s) => s.hfuConfig.rqiConst);
  const well = domain === 'core' ? useStore.getState().wells.find((w) => w.id === core?.wellId) : well0;
  const [method, setMethod] = useState<FziMethod>('A'); const [k, setK] = useState(4); const [algo1d, setAlgo1d] = useState<'kmeans' | 'gmm'>('kmeans');
  const [manual, setManual] = useState('0.5, 1.5, 4'); const [name, setName] = useState('');
  const [msgs, setMsgs] = useState<{ level: any; text: string }[]>([]);
  const src = useMemo(() => {
    if (domain === 'core') { const a = core && registry.core(core.id); if (!a || !a.num.has('FZI')) return null; const g = (n: string) => Float64Array.from(a.num.get(n)!, (v, i) => (a.excluded[i] ? NaN : v)); return { fzi: g('FZI'), rqi: g('RQI'), phiz: g('PHIZ'), phi: g('PHI'), k: g('K'), depth: coreDepths(core!, a).shifted }; }
    if (!well) return null; const f = registry.curve(well.id, 'FZI_LOG'); if (!f) return null;
    const g = (n: string) => Float64Array.from(registry.curve(well.id, n) ?? new Float32Array(f.length).fill(NaN));
    const phiz = g('PHIZ_LOG'); const phi = Float64Array.from(phiz, (z) => z / (1 + z));
    const rqi = g('RQI_LOG'); const kk = Float64Array.from(phi, (p, i) => p * Math.pow(rqi[i] / C, 2));
    return { fzi: Float64Array.from(f), rqi, phiz, phi, k: kk, depth: registry.depth(well.id)! };
  }, [domain, core?.id, well?.id, S().dataVersion]);
  const zone = useStore((s) => s.zone); useStore((s) => s.reservoirs);
  // Analysis scope: only samples inside the reservoir / selected zone are used (others are excluded, counted, not deleted)
  const scoped = useMemo(() => {
    if (!src || !well || !zone) return src ? { ...src, scope: null as null | { label: string; n: number; inside: number } } : null;
    const iv = scopeIntervals(well.id, zone); if (!iv) return { ...src, scope: { label: scopeLabel(zone, well.id) + ' — not defined for this well → whole well used', n: 0, inside: 0 } };
    const keys = ['fzi', 'rqi', 'phiz', 'phi', 'k'] as const; const o: any = { ...src }; for (const k of keys) o[k] = Float64Array.from(src[k]);
    let n = 0, inside = 0;
    for (let i = 0; i < src.depth.length; i++) { if (!isNum(src.fzi[i])) continue; n++; const dd = src.depth[i]; if (iv.some(([t, b]) => dd >= t && dd < b)) { inside++; continue; } for (const k of keys) o[k][i] = NaN; }
    o.scope = { label: scopeLabel(zone, well.id), n, inside }; return o as typeof src & { scope: { label: string; n: number; inside: number } };
  }, [src, zone, well?.id, S().reservoirs]);
  const result = useMemo(() => {
    const src = scoped; if (!src) return null;
    try {
      const lf = Array.from(src.fzi, (v) => (v > 0 ? Math.log10(v) : NaN));
      const { boundaries, notes } = fziBoundaries(lf, method, k, { algo1d, manual: manual.split(/[,\s]+/).map(Number).filter(isNum) });
      const labels = classifyFzi(src.fzi, boundaries); const K = boundaries.length + 1;
      const stats = unitStats(labels, { FZI: src.fzi, PHI: src.phi, K: src.k, RQI: src.rqi }, K);
      const fits = unitSlopeFits(labels, Array.from(src.phiz, (v) => (v > 0 ? Math.log10(v) : NaN)), Array.from(src.rqi, (v) => (v > 0 ? Math.log10(v) : NaN)), K);
      return { boundaries, notes, labels, K, stats, fits, lf };
    } catch (e: any) { return { error: e.message }; }
  }, [scoped, method, k, algo1d, manual]);
  if (!src) return <Empty>{domain === 'core' ? 'Calculate core RQI/FZI first (tab 1).' : 'Calculate FZI_LOG first (tab 1, log data).'}</Empty>;
  if (!result || 'error' in result) return <Msgs items={[{ level: 'CRITICAL', text: (result as any)?.error ?? 'No result' }]} />;
  const { boundaries, notes, labels, K, stats, fits, lf } = result;
  const colors = Array.from(labels, (l) => hfuColor(l));
  const pp = probabilityPlotData(lf);
  const ppColors = pp.v.map((v) => hfuColor(classifyFzi([Math.pow(10, v)], boundaries)[0]));
  const save = () => {
    if (!well) return;
    const id = uid('h_'); const prefix = 'Group';
    const units = makeUnits(K, boundaries, prefix).map((u, i) => ({ ...u, stats: stats[i] }));
    const set: HfuSet = { id, name: name || `${METHOD_LABEL[method].split('·')[0].trim()}-${K} ${domain}`, domain, wellId: well.id, coreId: domain === 'core' ? core!.id : undefined, method: METHOD_LABEL[method], params: { k: K, algo1d, manual: method === 'E' ? manual : undefined, C, scope: (scoped as any)?.scope?.label ?? 'Whole well' }, features: ['FZI'], units, boundaries, createdAt: nowIso(), labels: domain === 'core' ? Array.from(labels) : undefined };
    if (domain === 'log') { set.curve = `HFU_${id.slice(2, 6).toUpperCase()}`; putCalculatedCurve(well.id, set.curve, Float32Array.from(labels, (l) => (l ? l : NaN)), '', `${set.name} (log domain)`, { kind: 'hfu', formula: `classify(FZI_LOG; thresholds ${boundaries.map((b) => b.toPrecision(3)).join(', ')} µm)`, inputs: ['FZI_LOG'], units: '', version: 1, missing: 'NaN where FZI_LOG missing', createdAt: nowIso() }, true); }
    else projectCoreResults(core!, well, Array.from(labels));
    S().upsertHfuSet(set);
    S().log(`Created HFU set "${set.name}" — ${METHOD_LABEL[method]}, ${K} units, thresholds ${boundaries.map((b) => b.toPrecision(3)).join(' / ')} µm (status: Statistical Cluster until validated)`);
    setMsgs([{ level: 'OK', text: `Saved "${set.name}". Units are labelled "Statistical Cluster" until you validate them as Hydraulic Flow Units in the panel on the right.` }]);
  };
  return <div className="split w380">
    <div className="col">
      <Box title="Analysis scope">
        <div className="row"><ZoneSelect /></div>
        {(scoped as any)?.scope ? <div className={'hint'} style={{ marginTop: 4 }}>{(scoped as any).scope.label}: <b>{(scoped as any).scope.inside}</b> of {(scoped as any).scope.n} valid samples used · {(scoped as any).scope.n - (scoped as any).scope.inside} outside the scope excluded (not deleted)</div> : <div className="hint" style={{ marginTop: 4 }}>Whole well — define a reservoir interval to restrict HFU identification to the reservoir.</div>}
      </Box>
      <Box title="Method">
        <Field label="Method"><select value={method} onChange={(e) => setMethod(e.target.value as FziMethod)}>{(['A', 'B', 'C', 'D', 'E'] as FziMethod[]).map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select></Field>
        {method !== 'E' && <Field label="Number of units"><Num value={k} onChange={(v) => setK(Math.max(2, Math.min(10, Math.round(v))))} /></Field>}
        {(method === 'B' || method === 'D') && <Field label="1-D algorithm"><Sel value={algo1d} onChange={setAlgo1d} options={[{ v: 'kmeans', l: 'K-Means' }, { v: 'gmm', l: 'Gaussian mixture' }]} /></Field>}
        {method === 'E' && <Field label="FZI thresholds (µm)"><input value={manual} onChange={(e) => setManual(e.target.value)} /></Field>}
        <div className="hint" style={{ marginTop: 4 }}>{notes.join(' ')}</div>
        <div className="formula" style={{ marginTop: 4 }}>Thresholds (µm): {boundaries.map((b) => b.toPrecision(3)).join('  |  ') || '—'}</div>
        <Field label="Set name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="auto" /></Field>
        <button className="btn pri" onClick={save}>Save HFU set</button>
        <div className="hint">Multi-feature clustering (method F: K-Means, GMM, hierarchical, DBSCAN) is in <a href="#" onClick={(e) => { e.preventDefault(); S().go('cluster'); }}>HFU Clustering</a>.</div>
      </Box>
      <Msgs items={msgs} />
      <Box title="Unit statistics">
        <div className="tbl-wrap"><table className="t"><thead><tr><th>Unit</th><th>N</th><th>FZI range</th><th>Mean FZI</th><th>Mean φ</th><th>Median K</th><th>{method === 'D' ? 'Slope (≈1)' : 'RQI–Φz slope'}</th><th>R²</th></tr></thead>
          <tbody>{stats.map((s, i) => <tr key={i}><td><span className="pill" style={{ background: hfuColor(i + 1) }} />{i + 1}</td><td className="num">{s.n}</td><td className="num">{fmt(i === 0 ? 0 : boundaries[i - 1], 3)}–{i === K - 1 ? '∞' : fmt(boundaries[i], 3)}</td><td className="num">{fmt(s.mean_FZI, 3)}</td><td className="num">{fmt(s.mean_PHI, 3)}</td><td className="num">{fmt(s.median_K, 3)}</td><td className="num">{fmt(fits[i].slope, 3)}</td><td className="num">{fmt(fits[i].r2, 3)}</td></tr>)}</tbody></table></div>
      </Box>
    </div>
    <div className="gridD" style={{ height: 660 }}>
      <div className="box"><XYPlot title="Probability plot of log FZI" xLabel="normal quantile" yLabel="log10 FZI" series={[{ kind: 'scatter', x: pp.q, y: pp.v, colors: ppColors, size: 2.6 }]} refLines={boundaries.map((b) => ({ x1: -4, y1: Math.log10(b), x2: 4, y2: Math.log10(b), color: '#888', dash: true }))} /></div>
      <div className="box"><XYPlot title="RQI vs Φz (log-log) by unit" logX logY xLabel="Φz" yLabel="RQI (µm)" series={[{ kind: 'scatter', x: src.phiz, y: src.rqi, colors, size: 2.6 }]} refLines={stats.map((s, i) => ({ x1: 0.01, y1: s.mean_FZI * 0.01, x2: 1, y2: s.mean_FZI, color: hfuColor(i + 1), dash: true }))} xRange={[0.01, 1]} /></div>
      <div className="box"><XYPlot title="K vs φ with iso-FZI boundaries" logY xLabel="φ (v/v)" yLabel="K (mD)" series={[{ kind: 'scatter', x: src.phi, y: src.k, colors, size: 2.6 }, ...boundaries.map((f) => { const x = Array.from({ length: 60 }, (_, i) => 0.01 + i * 0.006); return { kind: 'line' as const, x, y: x.map((p) => p * Math.pow((f * p) / (1 - p) / C, 2)), color: '#8a95a5', dash: true, width: 1 }; })]} /></div>
      <div className="dcol" style={{ minHeight: 0 }}><DepthPlot title="Units vs depth" wellId={well?.id} tracks={[{ width: 190, series: [{ depth: src.depth, values: result && !('error' in result) ? Array.from(scoped!.fzi) : [], label: 'FZI', unit: 'µm', color: '#333333', kind: 'dots', log: true, min: 0.01, max: 100, size: 2.6, colors }] }]} /></div>
    </div>
  </div>;
}

export function HfuSetsPanel() {
  const sets = useStore((s) => s.hfuSets); const wells = useStore((s) => s.wells);
  if (!sets.length) return <Box title="HFU / cluster sets"><span className="hint">None saved yet.</span></Box>;
  const upd = (id: string, f: (h: HfuSet) => HfuSet) => { const h = sets.find((x) => x.id === id)!; S().upsertHfuSet(f(h)); };
  return <Box title="HFU / cluster sets">
    {sets.map((h) => <div key={h.id} style={{ borderBottom: '1px solid var(--bd)', padding: '4px 0' }}>
      <div className="row"><b>{h.name}</b><span className="dim">{wells.find((w) => w.id === h.wellId)?.name} · {h.domain}</span></div>
      <div className="hint">{h.method}{h.algorithm ? ` · ${h.algorithm}` : ''} · {h.createdAt.slice(0, 16).replace('T', ' ')}</div>
      {h.units.map((u) => <div key={u.id} className="row" style={{ gap: 4, marginTop: 2 }}>
        <span className="pill" style={{ background: u.color }} />
        <input value={u.label} style={{ width: 90, height: 18 }} onChange={(e) => upd(h.id, (x) => ({ ...x, units: x.units.map((q) => (q.id === u.id ? { ...q, label: e.target.value } : q)) }))} />
        <select value={u.status} style={{ height: 18, fontSize: 10.5 }} onChange={(e) => { upd(h.id, (x) => ({ ...x, units: x.units.map((q) => (q.id === u.id ? { ...q, status: e.target.value as any } : q)) })); S().log(`${h.name}: unit ${u.id} marked as ${e.target.value} by analyst`); }}>
          <option>Statistical Cluster</option><option>Hydraulic Flow Unit</option></select>
        <span className="dim mono" style={{ fontSize: 10 }}>n={u.stats?.n ?? '—'}</span>
      </div>)}
      <div className="row" style={{ marginTop: 3 }}>
        <button className="btn sm" onClick={() => { upd(h.id, (x) => ({ ...x, units: x.units.map((q) => ({ ...q, status: 'Hydraulic Flow Unit', label: q.label.replace(/^(Group|Cluster)/, 'HFU') })) })); S().log(`${h.name}: analyst validated all units as Hydraulic Flow Units`); }}>Validate all as HFU</button>
        <button className="btn sm danger" onClick={() => { S().set({ hfuSets: sets.filter((x) => x.id !== h.id) }); S().log(`Deleted HFU set ${h.name}`, 'warn'); }}>Delete</button>
      </div>
    </div>)}
    <div className="hint">A statistical cluster is not automatically a geological HFU — validate and rename after reviewing core, facies and depth continuity.</div>
  </Box>;
}
