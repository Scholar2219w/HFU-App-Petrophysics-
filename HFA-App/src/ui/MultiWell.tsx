import { FLAG_RE } from '../curves/catalog';
import { useMemo, useState } from 'react';
import { useStore } from '../store/store';
import { registry } from '../data-engine/registry';
import { allZoneNames, zoneMask, zonesForWell } from '../data-engine/zones';
import { resolveMnem } from '../visualization/LogViewer';
import { FAMILIES } from '../curves/catalog';
import { Box, Empty, ModHead, ZoneSelect } from './common';
import { XYPlot } from '../visualization/XYPlot';
import { summarize } from './ReservoirQuality';
import { fmt, hfuColor, isNum } from '../util/num';
import type { WellMeta } from '../types';

const LOGGY = /^(K|RQI|FZI|RT|RXO|RM|RS|KTIM|KSDR|T2LM|K_PRED|FZI_.*|RQI_.*)$/i;
function values(w: WellMeta, prop: string, zone: string): number[] {
  const m = resolveMnem(w, prop); if (!m) return []; const a = registry.curve(w.id, m); const mask = zoneMask(w.id, zone); if (!a || !mask) return [];
  const out: number[] = []; for (let i = 0; i < a.length; i++) if (mask[i] && isNum(a[i])) out.push(a[i]); return out;
}
const first = (w: WellMeta, ...c: string[]) => c.find((m) => resolveMnem(w, m));

export function MultiWell() {
  const wells = useStore((s) => s.wells); const zone = useStore((s) => s.zone); useStore((s) => s.dataVersion);
  const [sel, setSel] = useState<string[]>(wells.map((w) => w.id));
  const props = useMemo(() => [...new Set([...['FZI_PRED', 'FZI_LOG', 'K_PRED', 'RQI_LOG'], ...Object.keys(FAMILIES).filter((f) => wells.some((w) => resolveMnem(w, f))), ...wells.flatMap((w) => w.curves.map((c) => c.mnemonic))])].filter((p) => wells.some((w) => resolveMnem(w, p))), [wells]);
  const [prop, setProp] = useState(props.includes('GR') ? 'GR' : props[0] ?? ''); const [logx, setLogx] = useState(false); const [cdf, setCdf] = useState(false);
  const [hfuCurve, setHfuCurve] = useState('HFU_PRED');
  const ws = wells.filter((w) => sel.includes(w.id));
  const dist = useMemo(() => ws.map((w) => ({ w, v: values(w, prop, zone) })), [ws.map((w) => w.id).join(), prop, zone, useStore.getState().dataVersion]);
  if (wells.length < 1) return <><ModHead title="Multi-Well Analysis" /><Empty>Load wells first.</Empty></>;
  const all = dist.flatMap((d) => d.v).filter((x) => !logx || x > 0); const lo = Math.min(...all), hi = Math.max(...all);
  const tf = (x: number) => (logx ? Math.log10(x) : x); const itf = (x: number) => (logx ? Math.pow(10, x) : x);
  const nb = 40; const a = tf(lo), b = tf(hi); const bw = (b - a) / nb || 1;
  const series = dist.map(({ w, v }) => {
    const y = new Array(nb).fill(0); let n = 0; for (const x of v) { if (logx && x <= 0) continue; y[Math.min(nb - 1, Math.max(0, Math.floor((tf(x) - a) / bw)))]++; n++; }
    const f = y.map((c) => c / (n || 1)); let acc = 0; const cy = f.map((c) => (acc += c));
    return { kind: 'step' as const, x: [itf(a), ...Array.from({ length: nb }, (_, i) => itf(a + (i + 1) * bw))], y: cdf ? [0, ...cy] : [f[0], ...f], color: w.color, width: 1.6 };
  });
  const discAll = [...new Set(wells.flatMap((w) => w.curves.filter((c) => c.discrete && !FLAG_RE.test(c.mnemonic)).map((c) => c.mnemonic)))];
  const hfuDist = ws.map((w) => { const h = registry.curve(w.id, hfuCurve); const mask = zoneMask(w.id, zone); const cnt = new Map<number, number>(); let n = 0; if (h && mask) for (let i = 0; i < h.length; i++) if (mask[i] && isNum(h[i]) && h[i] > 0) { cnt.set(Math.round(h[i]), (cnt.get(Math.round(h[i])) ?? 0) + 1); n++; } return { w, cnt, n }; });
  const units = [...new Set(hfuDist.flatMap((d) => [...d.cnt.keys()]))].sort((x, y) => x - y);
  const zones = allZoneNames();
  return <>
    <ModHead title="Multi-Well Analysis" sub="Well-to-well comparison · HFU distribution · cross-well & formation-specific statistics">
      <span className="row" style={{ gap: 4 }}>{wells.map((w) => <label key={w.id} className="cb"><input type="checkbox" checked={sel.includes(w.id)} onChange={(e) => setSel(e.target.checked ? [...sel, w.id] : sel.filter((x) => x !== w.id))} /><span className="pill" style={{ background: w.color }} />{w.name}</label>)}</span>
      <ZoneSelect />
    </ModHead>
    <div className="mod-b">
      <Box title="Well summary">
        <table className="t"><thead><tr><th>Well</th><th>Depth range</th><th>Formations</th><th>HFU curve</th><th>FZI (geo. mean)</th><th>RQI (geo. mean)</th><th>K (geo. mean)</th><th>φ (mean)</th><th>Core samples</th></tr></thead><tbody>
          {ws.map((w) => { const g = (p?: string) => (p ? summarize(values(w, p, zone)) : null); const fz = g(first(w, 'FZI_PRED', 'FZI_LOG')), rq = g(first(w, 'RQI_PRED', 'RQI_LOG')), k = g(first(w, 'K_PRED', 'K')), ph = g(first(w, 'PHIE', 'PHIT', 'CMRP'));
            return <tr key={w.id}><td><span className="pill" style={{ background: w.color }} />{w.name}</td><td>{fmt(w.start, 6)}–{fmt(w.stop, 6)} {w.depthUnit}</td><td className="dim" style={{ whiteSpace: 'normal' }}>{zonesForWell(w.id).map((z) => z.name).join(', ') || '—'}</td><td>{w.curves.some((c) => c.mnemonic === hfuCurve) ? hfuCurve : '—'}</td><td className="num">{fmt(fz?.geomean, 3)}</td><td className="num">{fmt(rq?.geomean, 3)}</td><td className="num">{fmt(k?.geomean, 3)}</td><td className="num">{fmt(ph?.mean, 3)}</td><td className="num">{useStore.getState().cores.filter((c) => c.wellId === w.id).reduce((s, c) => s + c.n, 0)}</td></tr>; })}
        </tbody></table>
      </Box>
      <div className="grid2" style={{ marginTop: 8 }}>
        <Box title="Overlay of distributions" right={<><select value={prop} onChange={(e) => { setProp(e.target.value); setLogx(LOGGY.test(e.target.value)); }}>{props.map((p) => <option key={p}>{p}</option>)}</select><label className="cb"><input type="checkbox" checked={logx} onChange={(e) => setLogx(e.target.checked)} />log</label><label className="cb"><input type="checkbox" checked={cdf} onChange={(e) => setCdf(e.target.checked)} />cumulative</label></>}>
          <div style={{ height: 280 }}>{all.length ? <XYPlot series={series} logX={logx} xLabel={prop} yLabel={cdf ? 'cumulative fraction' : 'fraction of samples'} legend={ws.map((w) => ({ label: w.name, color: w.color }))} /> : <Empty>No {prop} data in the selected wells{zone ? ` / zone ${zone}` : ''}.</Empty>}</div>
          <table className="t" style={{ marginTop: 6 }}><thead><tr><th>Well</th><th>N</th><th>Mean</th><th>Median</th><th>P10</th><th>P90</th><th>Min</th><th>Max</th></tr></thead><tbody>
            {dist.map(({ w, v }) => { const s = summarize(v); return <tr key={w.id}><td><span className="pill" style={{ background: w.color }} />{w.name}</td><td className="num">{s.n}</td><td className="num">{fmt(s.mean, 4)}</td><td className="num">{fmt(s.median, 4)}</td><td className="num">{fmt(s.p10, 4)}</td><td className="num">{fmt(s.p90, 4)}</td><td className="num">{fmt(s.min, 4)}</td><td className="num">{fmt(s.max, 4)}</td></tr>; })}
          </tbody></table>
        </Box>
        <Box title="HFU distribution (share of samples)" right={<select value={hfuCurve} onChange={(e) => setHfuCurve(e.target.value)}>{discAll.map((m) => <option key={m}>{m}</option>)}</select>}>
          {hfuDist.map(({ w, cnt, n }) => <div key={w.id} style={{ margin: '4px 0' }}>
            <div className="hint">{w.name} — {n ? `${n} samples` : 'no HFU curve'}</div>
            <div style={{ display: 'flex', height: 18, border: '1px solid var(--bd)' }}>{units.map((u) => { const f = n ? (cnt.get(u) ?? 0) / n : 0; return f ? <div key={u} title={`unit ${u}: ${(100 * f).toFixed(1)}%`} style={{ width: `${100 * f}%`, background: hfuColor(u), fontSize: 10, color: '#0c0f13', textAlign: 'center', overflow: 'hidden' }}>{f > 0.06 ? `${u}·${(100 * f).toFixed(0)}%` : ''}</div> : null; })}</div>
          </div>)}
          <div className="hint">Unit numbers are comparable between wells only if the same HFU set / FZI thresholds were used for all wells.</div>
        </Box>
      </div>
      {zones.length > 0 && <Box title={`Formation-specific: median ${prop}`} style={{ marginTop: 8 }}>
        <table className="t"><thead><tr><th>Formation / zone</th>{ws.map((w) => <th key={w.id}>{w.name}</th>)}</tr></thead><tbody>
          {zones.map((z) => <tr key={z}><td>{z}</td>{ws.map((w) => { const s = summarize(values(w, prop, z)); return <td key={w.id} className="num">{s.n ? `${fmt(s.median, 4)} (n=${s.n})` : '—'}</td>; })}</tr>)}
        </tbody></table>
      </Box>}
    </div>
  </>;
}
