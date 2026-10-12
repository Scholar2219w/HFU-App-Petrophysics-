// Reservoir interval manager — the analyst defines WHERE the reservoir is; every analysis
// (petrophysics, RQI/FZI, HFU identification, clustering, regression, prediction, statistics)
// then runs on the reservoir interval(s) by default instead of on the whole logged well.
import { useState } from 'react';
import { S, useStore } from '../store/store';
import { registry } from '../data-engine/registry';
import { coreDepths } from '../data-engine/core';
import { RESERVOIR_KEY, curveToIntervals, flagStepsToIntervals, reservoirsForWell, zonesForWell } from '../data-engine/zones';
import { removeReservoir, setReservoirs, updateReservoir } from '../data-engine/reservoir';
import { Box, Empty, Field, ModHead, Msgs, Num, ZoneSelect, useActiveWell } from './common';
import { DepthPlot, type DepthTrack } from '../visualization/DepthPlot';
import { findByFamily } from '../curves/catalog';
import { fmt } from '../util/num';

const FT = 0.3048;

export function Reservoir() {
  const well = useActiveWell(); const res = useStore((s) => s.reservoirs); const zone = useStore((s) => s.zone); const interval = useStore((s) => s.interval); useStore((s) => s.dataVersion);
  const cores = useStore((s) => s.cores);
  const [name, setName] = useState('Reservoir'); const [top, setTop] = useState<number>(NaN); const [base, setBase] = useState<number>(NaN);
  const [fm, setFm] = useState(''); const [flagCurve, setFlagCurve] = useState(''); const [inFeet, setInFeet] = useState<'auto' | 'm' | 'ft'>('auto');
  const [msgs, setMsgs] = useState<{ level: any; text: string }[]>([]);
  if (!well) return <><ModHead title="Reservoir Intervals" /><Empty>Load a well first.</Empty></>;
  const list = res.filter((r) => r.wellId === well.id).sort((a, b) => a.top - b.top);
  const act = reservoirsForWell(well.id);
  const zones = zonesForWell(well.id);
  const flagCands = well.curves.filter((c) => c.discrete || /FLAG|RES|NET|PAY/i.test(c.mnemonic)).map((c) => c.mnemonic).filter((m) => m !== 'RES_FLAG');
  const coreStats = cores.filter((c) => c.wellId === well.id).map((c) => { const a = registry.core(c.id); if (!a) return null; const sh = coreDepths(c, a).shifted; let n = 0, inside = 0; for (let i = 0; i < sh.length; i++) { if (a.excluded[i]) continue; n++; if (act.some((r) => sh[i] >= r.top && sh[i] < r.base)) inside++; } return { name: c.name, n, inside }; }).filter(Boolean) as { name: string; n: number; inside: number }[];

  const importFlagFile = async (f: File) => {
    const t = (await f.text()).replace(/^﻿/, ''); const lines = t.split(/\r?\n/).map((l) => l.split(/[,;\t]/).map((x) => x.trim())).filter((l) => l.length >= 2 && l.some(Boolean));
    const head = lines[0].map((h) => h.toUpperCase()); const di = head.findIndex((h) => /^(DEPT|DEPTH|MD|TDEP)/.test(h)); const fi = head.findIndex((h, i) => i !== di && h !== '');
    if (di < 0 || fi < 0) { setMsgs([{ level: 'CRITICAL', text: `${f.name}: need a depth column (DEPT/DEPTH/MD) and a flag column.` }]); return; }
    const rows = lines.slice(1).map((l) => ({ d: parseFloat(l[di]), f: parseFloat(l[fi]) })).filter((r) => isFinite(r.d) && isFinite(r.f));
    let iv = flagStepsToIntervals(rows);
    let unit = inFeet;
    if (unit === 'auto') { const inside = (a: [number, number][]) => a.filter(([x, y]) => x >= well.start - 1 && y <= well.stop + 1).length; unit = inside(iv) >= inside(iv.map(([a, b]) => [a * FT, b * FT])) ? 'm' : 'ft'; }
    if (unit === 'ft') iv = iv.map(([a, b]) => [+(a * FT).toFixed(3), +(b * FT).toFixed(3)]);
    if (!iv.length) { setMsgs([{ level: 'WARNING', text: `${f.name}: no interval with flag > 0 found.` }]); return; }
    setReservoirs(well.id, iv.map(([a, b], i) => ({ name: `${head[fi]}_${i + 1}`, top: a, base: b, source: `${f.name}${unit === 'ft' ? ' (ft → m)' : ''}` })), 'replace', `imported ${f.name}`);
    setMsgs([{ level: 'OK', text: `${iv.length} reservoir interval(s) from ${f.name} (${head[fi]} step flag, depths in ${unit === 'ft' ? 'feet → converted to m' : 'm'}): ${iv.map(([a, b]) => `${a}–${b}`).join(', ')}.` }]);
  };
  const d = registry.depth(well.id); const grM = findByFamily(well.curves.map((c) => c.mnemonic), 'GR', S().aliases);
  const lo = act.length ? Math.min(...act.map((r) => r.top)) : zones.length ? zones[Math.floor(zones.length / 2)].top : well.start;
  const hi = act.length ? Math.max(...act.map((r) => r.base)) : lo + 200;
  const tracks: DepthTrack[] = d ? [
    { width: 170, series: grM && registry.curve(well.id, grM) ? [{ depth: d, values: registry.curve(well.id, grM)!, label: grM, unit: 'gAPI', color: '#000000', min: 0, max: 150 }] : [] },
    { width: 50, series: registry.curve(well.id, 'RES_FLAG') ? [{ depth: d, values: registry.curve(well.id, 'RES_FLAG')!, label: 'RES_FLAG', color: '#c9a400', min: 0, max: 1, fill: 'left', fillColor: '#ffe600' }] : [] },
  ] : [];
  return <>
    <ModHead title="Reservoir Intervals" sub={`${well.name} · analysis scope — HFU & petrophysical analysis run on the reservoir, not on the whole logged well`}>
      <ZoneSelect />
      {act.length > 0 && zone !== RESERVOIR_KEY && <button className="btn warn" onClick={() => { S().set({ zone: RESERVOIR_KEY }); S().log('Analysis scope set to reservoir intervals'); }}>Use reservoir as analysis scope</button>}
    </ModHead>
    <div className="mod-b">
      <div className="split" style={{ gridTemplateColumns: 'minmax(420px, 1fr) 360px' }}>
        <div className="col">
          <Box title={`Reservoir intervals — ${well.name}`} right={<span className="hint">{act.length} active · gross {act.reduce((a, r) => a + r.base - r.top, 0).toFixed(2)} m</span>}>
            {list.length ? <table className="t"><thead><tr><th>Use</th><th>Name</th><th>Top (m MD)</th><th>Base (m MD)</th><th>Thickness</th><th>Source</th><th /></tr></thead><tbody>
              {list.map((r) => <tr key={r.id}><td><input type="checkbox" checked={r.active} onChange={(e) => updateReservoir(r.id, { active: e.target.checked }, `Reservoir "${r.name}" ${e.target.checked ? 'enabled' : 'disabled'}`)} /></td>
                <td><input value={r.name} onChange={(e) => S().set({ reservoirs: S().reservoirs.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)) })} onBlur={() => updateReservoir(r.id, {}, `Renamed reservoir interval to "${r.name}"`)} style={{ width: 120 }} /></td>
                <td><Num value={r.top} onChange={(v) => v < r.base && updateReservoir(r.id, { top: v }, `Reservoir "${r.name}" top → ${v}`)} style={{ width: 80 }} /></td>
                <td><Num value={r.base} onChange={(v) => v > r.top && updateReservoir(r.id, { base: v }, `Reservoir "${r.name}" base → ${v}`)} style={{ width: 80 }} /></td>
                <td className="num">{(r.base - r.top).toFixed(2)}</td><td className="dim">{r.source}</td><td><button className="btn sm danger" onClick={() => removeReservoir(r.id)}>✕</button></td></tr>)}
            </tbody></table> : <Empty>No reservoir interval yet. Add one below — by hand, from a formation, from an interval dragged in the log viewer, from a flag curve, or by importing a flag file (e.g. RES_FLAG.csv exported from Techlog).</Empty>}
          </Box>
          <Box title="Add reservoir interval">
            <div className="grid2">
              <div className="col">
                <b className="hint">Manual</b>
                <div className="row"><input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 110 }} /><Num value={top} onChange={setTop} placeholder="top" style={{ width: 80 }} /><Num value={base} onChange={setBase} placeholder="base" style={{ width: 80 }} />
                  <button className="btn pri sm" disabled={!(base > top)} onClick={() => setReservoirs(well.id, [{ name, top, base, source: 'manual' }], 'append', 'manual entry')}>Add</button></div>
                <b className="hint">From log-viewer interval</b>
                <div className="row">{interval?.wellId === well.id ? <><span className="mono">{interval.top} – {interval.base}</span><button className="btn sm" onClick={() => setReservoirs(well.id, [{ name: `Interval ${fmt(interval.top, 5)}`, top: interval.top, base: interval.base, source: 'log-viewer selection' }], 'append', 'log-viewer interval')}>Add</button></> : <span className="hint">drag in the depth track of Log Visualization to select one</span>}</div>
                <b className="hint">From formation (top → next top)</b>
                <div className="row"><select value={fm} onChange={(e) => setFm(e.target.value)}><option value="">— formation —</option>{zones.map((z) => <option key={z.name} value={z.name}>{z.name} ({z.top}–{z.base})</option>)}</select>
                  <button className="btn sm" disabled={!fm} onClick={() => { const z = zones.find((q) => q.name === fm)!; setReservoirs(well.id, [{ name: z.name, top: z.top, base: z.base, source: 'formation tops' }], 'append', `formation ${z.name}`); }}>Add</button></div>
              </div>
              <div className="col">
                <b className="hint">From a flag curve in the well (value &gt; 0)</b>
                <div className="row"><select value={flagCurve} onChange={(e) => setFlagCurve(e.target.value)}><option value="">— curve —</option>{flagCands.map((m) => <option key={m}>{m}</option>)}</select>
                  <button className="btn sm" disabled={!flagCurve || !d} onClick={() => { const v = registry.curve(well.id, flagCurve); if (!v || !d) return; const iv = curveToIntervals(d, v); setReservoirs(well.id, iv.map(([a, b], i) => ({ name: `${flagCurve}_${i + 1}`, top: +a.toFixed(3), base: +b.toFixed(3), source: `curve ${flagCurve}` })), 'replace', `flag curve ${flagCurve}`); }}>Replace with curve intervals</button></div>
                <b className="hint">Import step-flag file (DEPT, FLAG — flag switches at each depth)</b>
                <div className="row"><select value={inFeet} onChange={(e) => setInFeet(e.target.value as any)} title="Depth unit of the file"><option value="auto">depth unit: auto</option><option value="m">metres</option><option value="ft">feet → m</option></select>
                  <label className="btn sm">Choose CSV…<input type="file" accept=".csv,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importFlagFile(f); e.target.value = ''; }} /></label></div>
                <div className="hint">Example (RES_FLAG.csv): 3952 → 1, 3972 → 0, 4000 → 1, 4077 → 0 gives 3952–3972 and 4000–4077.</div>
              </div>
            </div>
            <Msgs items={msgs} />
          </Box>
          <Box title="What the reservoir scope changes">
            <div className="hint" style={{ lineHeight: 1.6 }}>
              • <b>Petrophysical Evaluation</b> (Vsh, PHIT_ND, Archie Sw, cut-offs) is computed only inside the reservoir intervals and its parameters (GR lines, matrix, Rw…) are picked per interval.<br />
              • <b>RQI/FZI, HFU identification and clustering</b> use only the core samples / log samples inside the reservoir; samples outside are excluded (counted and reported — not deleted).<br />
              • <b>Regression datasets, prediction, crossplots, QC, reservoir-quality, transitions, multi-well and data table</b> follow the global scope selector (top bar). Pick "Whole well" at any time to compare.
            </div>
          </Box>
          {coreStats.length > 0 && <Box title="Core coverage of the reservoir"><table className="t"><thead><tr><th>Core dataset</th><th>Valid samples</th><th>Inside reservoir</th><th>Outside (excluded from HFU)</th></tr></thead><tbody>{coreStats.map((c) => <tr key={c.name}><td>{c.name}</td><td className="num">{c.n}</td><td className="num">{c.inside}</td><td className="num">{c.n - c.inside}</td></tr>)}</tbody></table></Box>}
        </div>
        <div style={{ height: 760 }}>{d && tracks.length ? <DepthPlot title="Reservoir on GR (yellow = RES_FLAG)" wellId={well.id} tracks={tracks} range={[lo - 25, hi + 25]} /> : <Empty>Loading…</Empty>}</div>
      </div>
    </div>
  </>;
}
