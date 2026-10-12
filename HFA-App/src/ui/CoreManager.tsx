import { DepthPlot, type DepthTrack } from '../visualization/DepthPlot';
import { corePhiFraction, coreKmD } from '../data-engine/core';
import { findByFamily } from '../curves/catalog';
import { useMemo, useState } from 'react';
import { S, useStore, activeCore } from '../store/store';
import { registry } from '../data-engine/registry';
import { coreCol, coreDepths, createCore, unitFromName } from '../data-engine/core';
import { guessPermUnit, guessPhiUnit, PERM_LABEL, PERM_TO_MD } from '../petrophysics/units';
import type { CoreMeta, PermUnit, PhiUnit } from '../types';
import { Box, Empty, Field, ModHead, Msgs, Num, Sel, Tabs } from './common';
import { RightPanel } from './RightPanel';
import { XYPlot } from '../visualization/XYPlot';
import { basicStats, fmt, isNum, nowIso, percentiles } from '../util/num';

export const EXCL_REASON: Record<number, string> = { 0: '', 1: 'duplicate', 2: 'null φ/k', 3: 'outlier', 4: 'manual' };

function useCore() {
  const cores = useStore((s) => s.cores); const cur = useStore((s) => activeCore(s)); useStore((s) => s.dataVersion);
  return { cores, cur, arr: cur ? registry.core(cur.id) : undefined };
}

export function CoreSelector() {
  const { cores, cur } = useCore(); const wells = useStore((s) => s.wells);
  return <select value={cur?.id ?? ''} onChange={(e) => { const c = cores.find((x) => x.id === e.target.value); S().set({ activeCoreId: c?.id, activeWellId: c?.wellId ?? S().activeWellId }); }}>
    {cores.map((c) => <option key={c.id} value={c.id}>{c.name} — {wells.find((w) => w.id === c.wellId)?.name} ({c.n})</option>)}
  </select>;
}

function recordFilter(meta: CoreMeta, op: string, before: number, after: number, reason: string) {
  S().updateCore(meta.id, (c) => ({ ...c, filterLog: [...c.filterLog, { at: nowIso(), op, before, after, removed: before - after, reason }] }));
  S().log(`Core QC "${meta.name}": ${op} — Before N=${before}, After N=${after}, Removed N=${before - after} (${reason})`);
  registry.touchCore(meta.id); S().bump();
}
const activeN = (ex: Uint8Array) => ex.reduce((s, v) => s + (v ? 0 : 1), 0);

export function CoreManager() {
  const { cores, cur, arr } = useCore();
  const [tab, setTab] = useState<'qc' | 'plots' | 'manual'>('qc');
  const [outK, setOutK] = useState(3); const [outMode, setOutMode] = useState<'iqr' | 'mad'>('iqr');
  const [flags, setFlags] = useState<Uint8Array | null>(null);
  const [msgs, setMsgs] = useState<{ level: any; text: string }[]>([]);
  if (!cur || !arr) return <><ModHead title="Core Data Management" /><div className="mod-b"><Tabs value={tab} onChange={setTab} tabs={[{ v: 'manual', l: 'Manual table' }]} /><ManualCore /></div></>;
  const numCols = [...arr.num.keys()];
  const phi = cur.map.phi ? arr.num.get(cur.map.phi) : undefined; const k = cur.map.k ? arr.num.get(cur.map.k) : undefined;
  const phiG = phi ? guessPhiUnit(cur.columns.find((c) => c.name === cur.map.phi)?.unit || unitFromName(cur.map.phi!), percentiles(phi, [95])[0], basicStats(phi).max) : null;
  const kG = k ? guessPermUnit(cur.columns.find((c) => c.name === cur.map.k)?.unit || unitFromName(cur.map.k!)) : null;
  const { original, shifted } = coreDepths(cur, arr);

  const dedupe = () => {
    const before = activeN(arr.excluded); const seen = new Set<string>();
    for (let i = 0; i < cur.n; i++) { if (arr.excluded[i]) continue; const key = [original[i], ...numCols.map((c) => arr.num.get(c)![i])].join('|'); if (seen.has(key)) arr.excluded[i] = 1; else seen.add(key); }
    recordFilter(cur, 'Duplicate removal', before, activeN(arr.excluded), 'identical depth and values');
  };
  const nullFilter = () => {
    if (!phi || !k) { setMsgs([{ level: 'CRITICAL', text: 'Map porosity and permeability columns first.' }]); return; }
    const before = activeN(arr.excluded);
    for (let i = 0; i < cur.n; i++) if (!arr.excluded[i] && (!isNum(phi[i]) || !isNum(k[i]))) arr.excluded[i] = 2;
    recordFilter(cur, 'Null filtering', before, activeN(arr.excluded), 'missing porosity or permeability');
  };
  const detect = () => {
    const f = new Uint8Array(cur.n); const why: string[] = [];
    const test = (name: string, a: Float64Array | undefined, log: boolean) => {
      if (!a) return; const v = Array.from(a).map((x, i) => (arr.excluded[i] || !isNum(x) || (log && x <= 0) ? NaN : log ? Math.log10(x) : x));
      let lo: number, hi: number;
      if (outMode === 'iqr') { const [q1, q3] = percentiles(v, [25, 75]); lo = q1 - outK * (q3 - q1); hi = q3 + outK * (q3 - q1); }
      else { const [med] = percentiles(v, [50]); const mad = percentiles(v.map((x) => Math.abs(x - med)), [50])[0] * 1.4826; lo = med - outK * mad; hi = med + outK * mad; }
      let n = 0; v.forEach((x, i) => { if (isNum(x) && (x < lo || x > hi)) { f[i] = 1; n++; } });
      why.push(`${name}${log ? ' (log10)' : ''}: ${n} outside [${fmt(log ? 10 ** lo : lo, 3)}, ${fmt(log ? 10 ** hi : hi, 3)}]`);
    };
    test(cur.map.phi ?? 'φ', phi, false); test(cur.map.k ?? 'k', k, true); if (cur.map.grainDensity) test(cur.map.grainDensity, arr.num.get(cur.map.grainDensity), false);
    setFlags(f); setMsgs([{ level: 'INFO', text: `Outlier detection (${outMode === 'iqr' ? `Tukey IQR × ${outK}` : `median ± ${outK}·MAD`}) flagged ${f.reduce((s, x) => s + x, 0)} samples — flagged only, NOT removed. ${why.join('; ')}` }]);
  };
  const excludeFlagged = () => { if (!flags) return; const before = activeN(arr.excluded); flags.forEach((x, i) => { if (x && !arr.excluded[i]) arr.excluded[i] = 3; }); recordFilter(cur, 'Outlier exclusion', before, activeN(arr.excluded), `${outMode === 'iqr' ? 'IQR' : 'MAD'} × ${outK} on φ, log k${cur.map.grainDensity ? ', grain density' : ''}`); setFlags(null); };
  const restore = () => { const before = activeN(arr.excluded); arr.excluded.fill(0); recordFilter(cur, 'Restore all', before, activeN(arr.excluded), 'all exclusions cleared'); };
  const convertCol = (col: string, factor: number, newName: string, unit: string) => {
    const a = arr.num.get(col)!; arr.num.set(newName, Float64Array.from(a, (v) => v * factor));
    S().updateCore(cur.id, (c) => ({ ...c, columns: [...c.columns.filter((x) => x.name !== newName), { name: newName, unit, kind: 'num' }] }));
    registry.touchCore(cur.id); S().log(`Core unit conversion: ${newName} = ${col} × ${factor} [${unit}]`); S().bump();
    setMsgs([{ level: 'OK', text: `Created ${newName} = ${col} × ${factor} (${unit}). Original column kept.` }]);
  };

  return (
    <>
      <ModHead title="Core Data Management" sub={`${cur.name} · N=${cur.n} · active ${activeN(arr.excluded)} · depth ops: ${cur.depthOps.filter((o) => o.active).length}`}>
        <CoreSelector />
      </ModHead>
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'qc', l: 'Core QC table' }, { v: 'plots', l: 'Core plots' }, { v: 'manual', l: 'Manual table' }]} />
      <div className="mod-b">
        <Msgs items={msgs} />
        {tab === 'qc' && <div className="tbl-wrap" style={{ height: 'calc(100% - 4px)' }}>
          <table className="t"><thead><tr><th>#</th><th>Status</th><th>Depth (orig)</th><th>Depth (shifted)</th>{numCols.map((c) => <th key={c} style={{ color: c === cur.map.phi || c === cur.map.k ? '#4ea1ff' : undefined }}>{c}<br /><span className="dim">{cur.columns.find((x) => x.name === c)?.unit}</span></th>)}{[...arr.text.keys()].map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{Array.from({ length: cur.n }, (_, i) => (
              <tr key={i} style={{ opacity: arr.excluded[i] ? 0.45 : 1 }}>
                <td className="dim">{i + 1}</td>
                <td>{arr.excluded[i] ? <span className="tag warn">{EXCL_REASON[arr.excluded[i]]}</span> : flags?.[i] ? <span className="tag crit">outlier?</span> : <span className="tag ok">ok</span>}</td>
                <td className="num">{fmt(original[i], 6)}</td><td className="num" style={{ color: shifted[i] !== original[i] ? '#e8c547' : undefined }}>{fmt(shifted[i], 6)}</td>
                {numCols.map((c) => <td key={c} className="num">{fmt(arr.num.get(c)![i], 4)}</td>)}
                {[...arr.text.keys()].map((c) => <td key={c} className="dim">{arr.text.get(c)![i]}</td>)}
              </tr>))}</tbody></table>
        </div>}
        {tab === 'plots' && <CorePlots meta={cur} />}
        {tab === 'manual' && <ManualCore />}
      </div>
      <RightPanel>
        <Box title="Column mapping & units">
          {(['phi', 'k', 'facies', 'grainDensity', 'sampleId'] as const).map((r) => (
            <Field key={r} label={{ phi: 'Porosity', k: 'Permeability', facies: 'Facies', grainDensity: 'Grain density', sampleId: 'Sample ID' }[r]}>
              <select value={cur.map[r] ?? ''} onChange={(e) => S().updateCore(cur.id, (c) => ({ ...c, map: { ...c.map, [r]: e.target.value || undefined }, ...(r === 'phi' ? { phiUnit: null } : r === 'k' ? { kUnit: null } : {}) }))}>
                <option value="">—</option>{(r === 'facies' ? [...arr.text.keys(), ...numCols] : numCols).map((c) => <option key={c}>{c}</option>)}</select>
            </Field>))}
          <Field label="φ unit"><Sel value={(cur.phiUnit ?? '') as any} onChange={(v: string) => { S().updateCore(cur.id, (c) => ({ ...c, phiUnit: (v || null) as PhiUnit | null })); S().log(`Core φ unit set to ${v || 'unconfirmed'}`); }} options={[{ v: '', l: '— unconfirmed —' }, { v: 'fraction', l: 'fraction (v/v)' }, { v: 'percent', l: 'percent (%)' }]} /></Field>
          {phiG && <div className="hint">Detected: {phiG.unit ?? '?'} — {phiG.reason}</div>}
          <Field label="k unit"><Sel value={(cur.kUnit ?? '') as any} onChange={(v: string) => { S().updateCore(cur.id, (c) => ({ ...c, kUnit: (v || null) as PermUnit | null })); S().log(`Core k unit set to ${v || 'unconfirmed'}`); }} options={[{ v: '', l: '— unconfirmed —' }, ...(['mD', 'D', 'um2', 'm2'] as PermUnit[]).map((u) => ({ v: u, l: PERM_LABEL[u] }))]} /></Field>
          {kG && <div className="hint">Detected: {kG.unit ?? '?'} — {kG.reason}</div>}
          {(!cur.phiUnit || !cur.kUnit) && <Msgs items={[{ level: 'WARNING', text: 'RQI/FZI are blocked until both units are confirmed.' }]} />}
          <div className="row" style={{ marginTop: 6 }}>
            {phi && <button className="btn sm" onClick={() => convertCol(cur.map.phi!, 0.01, `${cur.map.phi}_FRAC`, 'v/v')}>φ % → fraction</button>}
            {phi && <button className="btn sm" onClick={() => convertCol(cur.map.phi!, 100, `${cur.map.phi}_PCT`, '%')}>φ fraction → %</button>}
            {k && cur.kUnit && cur.kUnit !== 'mD' && <button className="btn sm" onClick={() => convertCol(cur.map.k!, PERM_TO_MD[cur.kUnit!], `${cur.map.k}_MD`, 'mD')}>k → mD</button>}
          </div>
        </Box>
        <Box title="Core QC">
          <div className="row"><button className="btn sm" onClick={dedupe}>Remove duplicates</button><button className="btn sm" onClick={nullFilter}>Filter nulls</button><button className="btn sm" onClick={restore}>Restore all</button></div>
          <div className="row" style={{ marginTop: 5 }}><Sel value={outMode} onChange={setOutMode} options={[{ v: 'iqr', l: 'Tukey IQR' }, { v: 'mad', l: 'Median ± MAD' }]} /><span className="hint">×</span><Num value={outK} onChange={setOutK} style={{ width: 44 }} /><button className="btn sm" onClick={detect}>Detect outliers</button></div>
          {flags && <button className="btn sm warn" style={{ marginTop: 4 }} onClick={excludeFlagged}>Exclude {flags.reduce((s, x) => s + x, 0)} flagged</button>}
          <div className="hint" style={{ marginTop: 4 }}>Nothing is removed silently: every filter is logged with Before/After/Removed and can be restored.</div>
        </Box>
        <Box title="Filter log">
          {cur.filterLog.length ? cur.filterLog.map((f, i) => <div key={i} className="mono" style={{ fontSize: 10.5, borderBottom: '1px solid var(--bd)', padding: '2px 0' }}><b>{f.op}</b><br />Before: N={f.before} · After: N={f.after} · Removed: N={f.removed}<br /><span className="dim">Reason: {f.reason}</span></div>) : <span className="hint">No filters applied.</span>}
        </Box>
      </RightPanel>
    </>
  );
}

const coreRange = (D: number[]): [number, number] | undefined => { const v = D.filter((x) => x === x); if (!v.length) return undefined; const a = Math.min(...v), b = Math.max(...v); const pad = Math.max(5, (b - a) * 0.08); return [a - pad, b + pad]; };
function CorePlots({ meta }: { meta: CoreMeta }) {
  const arr = registry.core(meta.id)!; useStore((s) => s.dataVersion);
  const well = useStore((s) => s.wells.find((w) => w.id === meta.wellId));
  const { shifted } = coreDepths(meta, arr);
  const cp = corePhiFraction(meta, arr); const k = coreKmD(meta, arr) ?? coreCol(meta, arr, 'K'); const phi = cp.v ?? coreCol(meta, arr, 'PHI'); const rqi = arr.num.get('RQI'), fzi = arr.num.get('FZI');
  const act = (a?: Float64Array | null) => (a ? Array.from(a, (v, i) => (arr.excluded[i] ? NaN : v)) : []);
  const unitsNote = arr.num.has('RQI') ? 'standardised (φ fraction, k mD)' : cp.note;
  const d = well ? registry.depth(well.id) : undefined; const names = well?.curves.map((c) => c.mnemonic) ?? [];
  const lg = (fam: string) => { const m = well ? (names.includes(fam) ? fam : findByFamily(names, fam, S().aliases)) : undefined; const v = m && well ? registry.curve(well.id, m) : undefined; return m && v && d ? { m, v } : null; };
  const gr = lg('GR'), phit = lg('PHIT_ND') ?? lg('PHIT'), kl = lg('KSDR') ?? lg('K');
  const D = Array.from(shifted);
  const tracks: DepthTrack[] = [
    ...(gr ? [{ width: 130, series: [{ depth: d!, values: gr.v, label: gr.m, unit: 'gAPI', color: '#000000', min: 0, max: 150 }] }] : []),
    { width: 160, series: [...(phit ? [{ depth: d!, values: phit.v, label: phit.m, unit: 'v/v', color: '#1c3ef0', min: 0.45, max: 0 }] : []), { depth: D, values: act(phi), label: 'Core φ', unit: 'v/v', color: '#e00000', kind: 'dots' as const, min: 0.45, max: 0, size: 3.2 }] },
    { width: 160, series: [...(kl ? [{ depth: d!, values: kl.v, label: kl.m, unit: 'mD', color: '#e8590c', min: 0.01, max: 10000, log: true }] : []), { depth: D, values: act(k), label: 'Core K', unit: 'mD', color: '#e00000', kind: 'dots' as const, min: 0.01, max: 10000, log: true, size: 3.2 }] },
    ...(rqi ? [{ width: 150, series: [{ depth: D, values: act(rqi), label: 'RQI', unit: 'µm', color: '#7048e8', kind: 'dots' as const, log: true, min: 0.001, max: 10 }, { depth: D, values: act(fzi), label: 'FZI', unit: 'µm', color: '#f76707', kind: 'dots' as const, log: true, min: 0.01, max: 100, hollow: true }] }] : []),
  ];
  const xp: { t: string; x: number[]; y: number[]; lx?: boolean; ly?: boolean; xl: string; yl: string }[] = [
    { t: 'Core K vs φ', x: act(phi), y: act(k), ly: true, xl: 'φ (v/v)', yl: 'K (mD)' },
    ...(rqi ? [{ t: 'Core K vs RQI', x: act(rqi), y: act(k), lx: true, ly: true, xl: 'RQI (µm)', yl: 'K (mD)' }, { t: 'Core K vs FZI', x: act(fzi), y: act(k), lx: true, ly: true, xl: 'FZI (µm)', yl: 'K (mD)' }] : []),
  ];
  return <div className="col">
    <span className="hint">Depth plots are drawn as conventional log tracks at the shifted (log) core depth; excluded samples hidden. Units: {unitsNote}. {rqi ? '' : 'Run RQI/FZI (RQI/FZI module) to add RQI / FZI tracks and K vs RQI / FZI plots.'}</span>
    <div className="split" style={{ gridTemplateColumns: 'minmax(420px, 640px) 1fr' }}>
      <div style={{ height: 680 }}><DepthPlot title={`${meta.name} — core vs depth${well ? ' (with ' + well.name + ' logs)' : ''}`} wellId={well?.id} tracks={tracks} range={coreRange(D)} /></div>
      <div className="col">{xp.map((p) => <div key={p.t} className="box" style={{ height: 330 }}><XYPlot light title={p.t} series={[{ kind: 'scatter', x: p.x, y: p.y, color: '#e8590c', size: 3 }]} logX={p.lx} logY={p.ly} xLabel={p.xl} yLabel={p.yl} /></div>)}</div>
    </div>
  </div>;
}

function ManualCore() {
  const wells = useStore((s) => s.wells);
  const [wid, setWid] = useState(wells[0]?.id ?? '');
  const [txt, setTxt] = useState('DEPTH\tPHI\tK\n');
  const [phiU, setPhiU] = useState<PhiUnit>('fraction'); const [kU, setKU] = useState<PermUnit>('mD');
  const rows = useMemo(() => txt.trim().split(/\r?\n/).slice(1).map((l) => l.trim().split(/[\t,;\s]+/).map(Number)).filter((r) => r.length >= 3 && r.every(isNum)), [txt]);
  if (!wells.length) return <Empty>Load a well first.</Empty>;
  return <Box title="Manual core table" style={{ maxWidth: 560 }}>
    <div className="row"><span className="hint">Well</span><select value={wid} onChange={(e) => setWid(e.target.value)}>{wells.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
      <Sel value={phiU} onChange={setPhiU} options={[{ v: 'fraction', l: 'φ fraction' }, { v: 'percent', l: 'φ %' }]} /><Sel value={kU} onChange={setKU} options={['mD', 'D']} /></div>
    <textarea rows={10} style={{ width: '100%', marginTop: 5 }} value={txt} onChange={(e) => setTxt(e.target.value)} />
    <div className="row"><span className="hint">{rows.length} valid rows (DEPTH, PHI, K — paste from a spreadsheet)</span>
      <button className="btn pri" disabled={!rows.length} onClick={() => { createCore({ wellId: wid, name: 'Manual core table', source: 'manual entry', depthUnit: 'm', depth: Float64Array.from(rows.map((r) => r[0])), num: { PHI_IN: { data: Float64Array.from(rows.map((r) => r[1])), unit: phiU === 'percent' ? '%' : 'v/v' }, K_IN: { data: Float64Array.from(rows.map((r) => r[2])), unit: kU } }, text: {}, map: { phi: 'PHI_IN', k: 'K_IN' }, phiUnit: phiU, kUnit: kU }); S().bump(); S().notify('OK', `Manual core table created (${rows.length} rows).`); }}>Create</button></div>
  </Box>;
}
