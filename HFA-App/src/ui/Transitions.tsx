import { FLAG_RE } from '../curves/catalog';
import { useMemo, useState } from 'react';
import { useStore } from '../store/store';
import { transitionStats } from '../hfu/transitions';
import { LogViewer } from '../visualization/LogViewer';
import { XYPlot } from '../visualization/XYPlot';
import { Box, Empty, ModHead, Num, ZoneSelect, useActiveWell, download } from './common';
import { toCSV } from '../export/io';
import { fmt, hfuColor } from '../util/num';

const discreteOf = (w: any) => w.curves.filter((c: any) => c.discrete && !FLAG_RE.test(c.mnemonic) && !['EXTRAP', 'HFU_CORE'].includes(c.mnemonic)).map((c: any) => c.mnemonic) as string[];

export function Transitions() {
  const well = useActiveWell(); const wells = useStore((s) => s.wells); const zone = useStore((s) => s.zone); useStore((s) => s.dataVersion);
  const [curve, setCurve] = useState(''); const [minT, setMinT] = useState(0);
  const disc = well ? discreteOf(well) : [];
  const c = curve && disc.includes(curve) ? curve : disc.includes('HFU_PRED') ? 'HFU_PRED' : disc[0] ?? '';
  const st = useMemo(() => (well && c ? transitionStats(well.id, c, zone, minT) : null), [well?.id, c, zone, minT, useStore.getState().dataVersion]);
  const cmp = useMemo(() => wells.map((w) => { const cc = discreteOf(w); const k = cc.includes(c) ? c : cc.includes('HFU_PRED') ? 'HFU_PRED' : cc[0]; return { w, k, s: k ? transitionStats(w.id, k, zone, minT) : null }; }), [wells, c, zone, minT, useStore.getState().dataVersion]);
  if (!well) return <><ModHead title="HFU Transition Analysis" /><Empty>No well.</Empty></>;
  if (!c) return <><ModHead title="HFU Transition Analysis" /><Empty>No continuous HFU / cluster curve on {well.name}. Generate HFU_PRED (Predicted FZI / HFU) or a log-domain HFU/cluster set first.</Empty></>;
  const K = st?.units.length ? Math.max(...st.units) : 0;
  const bins = (() => { if (!st?.intervals.length) return null; const mx = Math.max(...st.intervals.map((q) => q.thick)); const nb = 20; const w = mx / nb || 1; const series = st.units.map((u) => { const y = new Array(nb).fill(0); st.intervals.filter((q) => q.unit === u).forEach((q) => y[Math.min(nb - 1, Math.floor(q.thick / w))]++); return { u, y }; }); return { x: Array.from({ length: nb }, (_, i) => (i + 0.5) * w), series, w }; })();
  const exportCsv = () => st && download(toCSV([{ name: 'Top', unit: well.depthUnit, data: st.intervals.map((q) => q.top) }, { name: 'Base', unit: well.depthUnit, data: st.intervals.map((q) => q.base) }, { name: 'Thickness', unit: well.depthUnit, data: st.intervals.map((q) => q.thick) }, { name: 'Unit', data: st.intervals.map((q) => q.unit) }]), `${well.name}_${c}_intervals.csv`, 'text/csv');
  return <>
    <ModHead title="HFU Transition Analysis" sub={`${well.name} · vertical HFU behaviour`}>
      <span className="hint">Curve</span><select value={c} onChange={(e) => setCurve(e.target.value)}>{disc.map((m) => <option key={m}>{m}</option>)}</select>
      <ZoneSelect /><span className="hint" title="Intervals thinner than this are merged into the preceding interval (statistics only)">Min. bed</span><Num value={minT} onChange={setMinT} style={{ width: 56 }} /><span className="hint">{well.depthUnit}</span>
      <button className="btn" onClick={exportCsv}>Export intervals CSV</button>
    </ModHead>
    <div className="mod-b nopad" style={{ flexDirection: 'row' }}>
      <div style={{ width: 150, borderRight: '1px solid var(--bd)' }}><LogViewer wellId={well.id} tracks={[{ id: 'tr_d', kind: 'depth', width: 52, curves: [] }, { id: 'tr_h', kind: 'hfu', width: 70, curves: [], hfu: { source: 'curve', curve: c } }]} cursorFields={[c]} /></div>
      <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        {st && <>
          <div className="kpis" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
            {[['Intervals', st.intervals.length], ['HFU transitions', st.nTransitions], ['Transitions / 100 ' + well.depthUnit, fmt(st.perHundred, 3)], ['Mean interval thickness', `${fmt(st.meanThick, 3)} ${well.depthUnit}`], ['Median thickness', `${fmt(st.medianThick, 3)} ${well.depthUnit}`], ['Vertical continuity', `${(100 * st.continuity).toFixed(1)} %`]].map(([l, v]) => <div key={String(l)} className="kpi"><div className="l">{l}</div><div className="v">{v}</div></div>)}
          </div>
          <div className="hint" style={{ margin: '4px 0' }}>Vertical continuity = share of adjacent sample pairs that stay in the same unit. Persistence = probability that the next sample (downwards) stays in the unit (sample-level Markov chain).</div>
          <div className="grid2">
            <Box title="Per-unit thickness & persistence">
              <table className="t"><thead><tr><th>Unit</th><th>Intervals</th><th>Mean thick.</th><th>Max thick.</th><th>Total</th><th>Share</th><th>Persistence</th></tr></thead><tbody>
                {st.units.map((u) => { const t = st.thickByUnit[u]; const tot = Object.values(st.thickByUnit).reduce((s, x) => s + x.total, 0); return <tr key={u}><td><span className="pill" style={{ background: hfuColor(u) }} />{u}</td><td className="num">{t.n}</td><td className="num">{fmt(t.mean, 3)}</td><td className="num">{fmt(t.max, 3)}</td><td className="num">{fmt(t.total, 4)}</td><td className="num">{((100 * t.total) / (tot || 1)).toFixed(1)}%</td><td className="num">{fmt(st.persistence[u], 3)}</td></tr>; })}
              </tbody></table>
            </Box>
            <Box title="Transition matrix (interval → next deeper interval)">
              <table className="t heat"><thead><tr><th>from \ to</th>{Array.from({ length: K }, (_, j) => <th key={j} style={{ textAlign: 'center' }}>{j + 1}</th>)}</tr></thead><tbody>
                {st.matrix.map((row, i) => <tr key={i}><td><span className="pill" style={{ background: hfuColor(i + 1) }} />{i + 1}</td>{row.map((v, j) => <td key={j} style={{ background: v ? `rgba(78,161,255,${0.15 + 0.75 * (st.matrixProb[i][j] || 0)})` : undefined }} title={`P = ${fmt(st.matrixProb[i][j], 3)}`}>{v || ''}{v ? <span className="dim"> ({(100 * st.matrixProb[i][j]).toFixed(0)}%)</span> : ''}</td>)}</tr>)}
              </tbody></table>
              <div className="hint">Counts of observed changes; percentages are row-normalised transition probabilities. Transition depths: {st.transitionDepths.slice(0, 20).map((z) => z.toFixed(1)).join(', ')}{st.transitionDepths.length > 20 ? ' …' : ''}</div>
            </Box>
          </div>
          {bins && <div className="box" style={{ height: 260, marginTop: 8 }}><XYPlot title="HFU interval thickness histogram" xLabel={`thickness (${well.depthUnit})`} yLabel="intervals" series={bins.series.map((s) => ({ kind: 'step' as const, x: [0, ...bins.x.map((x) => x + bins.w / 2)], y: [s.y[0], ...s.y], color: hfuColor(s.u), width: 1.6 }))} legend={bins.series.map((s) => ({ label: `unit ${s.u}`, color: hfuColor(s.u) }))} /></div>}
        </>}
        <Box title="Well comparison" style={{ marginTop: 8 }}>
          <table className="t"><thead><tr><th>Well</th><th>Curve</th><th>Intervals</th><th>Transitions</th><th>per 100 {well.depthUnit}</th><th>Mean thick.</th><th>Continuity</th><th>Dominant unit (by thickness)</th></tr></thead><tbody>
            {cmp.map(({ w, k, s }) => { const dom = s ? Object.entries(s.thickByUnit).sort((a, b) => b[1].total - a[1].total)[0] : null; return <tr key={w.id}><td>{w.name}</td><td>{k ?? '—'}</td><td className="num">{s?.intervals.length ?? '—'}</td><td className="num">{s?.nTransitions ?? '—'}</td><td className="num">{fmt(s?.perHundred, 3)}</td><td className="num">{fmt(s?.meanThick, 3)}</td><td className="num">{s ? (100 * s.continuity).toFixed(1) + '%' : '—'}</td><td>{dom ? <><span className="pill" style={{ background: hfuColor(+dom[0]) }} />{dom[0]}</> : '—'}</td></tr>; })}
          </tbody></table>
          <div className="hint">Wells are compared with their own HFU curve of the same name when present. Unit numbering is only comparable between wells when the same HFU set / thresholds were applied.</div>
        </Box>
      </div>
    </div>
  </>;
}
