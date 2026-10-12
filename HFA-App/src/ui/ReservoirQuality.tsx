import { FLAG_RE } from '../curves/catalog';
import { useMemo, useState } from 'react';
import { useStore } from '../store/store';
import { registry } from '../data-engine/registry';
import { coreCol, coreDepths, sampleLogAt } from '../data-engine/core';
import { inZone, zoneMask } from '../data-engine/zones';
import { findByFamily } from '../curves/catalog';
import { Box, Empty, ModHead, Sel, ZoneSelect, download } from './common';
import { XYPlot } from '../visualization/XYPlot';
import { toCSV } from '../export/io';
import { fmt, hfuColor, isNum, pctSorted } from '../util/num';

type Stat = 'mean' | 'median' | 'geomean' | 'p10' | 'p50' | 'p90' | 'min' | 'max' | 'n';
const STATS: Stat[] = ['n', 'mean', 'median', 'geomean', 'p10', 'p50', 'p90', 'min', 'max'];
const LOGPROP = new Set(['K', 'RQI', 'FZI']);

export function summarize(v: number[]): Record<Stat, number> {
  const s = v.filter(isNum).sort((a, b) => a - b); const n = s.length;
  const pos = s.filter((x) => x > 0);
  return { n, mean: n ? s.reduce((a, b) => a + b, 0) / n : NaN, median: pctSorted(s, 50), geomean: pos.length ? Math.pow(10, pos.reduce((a, b) => a + Math.log10(b), 0) / pos.length) : NaN, p10: pctSorted(s, 10), p50: pctSorted(s, 50), p90: pctSorted(s, 90), min: s[0] ?? NaN, max: s[n - 1] ?? NaN };
}

export interface RQTable { props: string[]; units: { id: number; label: string; status: string; stats: Record<string, Record<Stat, number>> }[]; source: string }

export function buildRQ(setId: string, wellCurve: { wellIds: string[]; curve: string } | null, zone: string): RQTable | null {
  const st = useStore.getState(); const hs = st.hfuSets.find((h) => h.id === setId);
  const buckets = new Map<number, Record<string, number[]>>(); const props = new Set<string>();
  const push = (u: number, p: string, v: number) => { if (!u || !isNum(v)) return; props.add(p); const b = buckets.get(u) ?? {}; (b[p] ??= []).push(v); buckets.set(u, b); };
  let source = '';
  if (hs && hs.domain === 'core' && hs.coreId && hs.labels) {
    const cm = st.cores.find((c) => c.id === hs.coreId); const a = cm && registry.core(cm.id); const w = st.wells.find((x) => x.id === cm?.wellId);
    if (!cm || !a || !w) return null;
    const { shifted } = coreDepths(cm, a); const names = w.curves.map((c) => c.mnemonic);
    const logs: [string, string | undefined][] = [['VSH', findByFamily(names, 'VSH')], ['NMR T2LM', findByFamily(names, 'T2LM')], ['NMR FFI', findByFamily(names, 'CMFF')], ['NMR BVI', findByFamily(names, 'BFV')], ['NMR φ', findByFamily(names, 'CMRP') ?? findByFamily(names, 'TCMR')]];
    const sampled = logs.filter(([, m]) => m).map(([p, m]) => [p, sampleLogAt(w, m!, shifted)] as const);
    for (let i = 0; i < cm.n; i++) {
      if (a.excluded[i] || !inZone(w.id, zone, shifted[i])) continue; const u = hs.labels[i];
      push(u, 'PHI', coreCol(cm, a, 'PHI')![i]); push(u, 'K', coreCol(cm, a, 'K')![i]); push(u, 'RQI', a.num.get('RQI')?.[i] ?? NaN); push(u, 'FZI', a.num.get('FZI')?.[i] ?? NaN);
      for (const [p, arr] of sampled) push(u, p, arr[i]);
    }
    source = `core samples of "${cm.name}" labelled by "${hs.name}"`;
  } else if (wellCurve) {
    for (const wid of wellCurve.wellIds) {
      const w = st.wells.find((x) => x.id === wid); if (!w) continue; const h = registry.curve(wid, wellCurve.curve); if (!h) continue;
      const names = w.curves.map((c) => c.mnemonic); const mask = zoneMask(wid, zone); if (!mask) continue;
      const pick = (...c: (string | undefined)[]) => c.find((m) => m && names.includes(m));
      const map: [string, string | undefined][] = [['PHI', pick(findByFamily(names, 'PHIE'), findByFamily(names, 'PHIT'), findByFamily(names, 'CMRP'))], ['K', pick('K_PRED', findByFamily(names, 'K'))], ['RQI', pick('RQI_PRED', 'RQI_LOG')], ['FZI', pick('FZI_PRED', 'FZI_LOG')], ['VSH', findByFamily(names, 'VSH')], ['NMR T2LM', findByFamily(names, 'T2LM')], ['NMR FFI', findByFamily(names, 'CMFF')], ['NMR BVI', findByFamily(names, 'BFV')]];
      const arrs = map.filter(([, m]) => m).map(([p, m]) => [p, registry.curve(wid, m!)] as const).filter(([, a]) => a);
      for (let i = 0; i < h.length; i++) { if (!mask[i]) continue; const u = isNum(h[i]) ? Math.round(h[i]) : 0; for (const [p, a] of arrs) push(u, p, a![i]); }
    }
    source = `log samples of ${wellCurve.curve} in ${wellCurve.wellIds.length} well(s)`;
  } else return null;
  const units = [...buckets.keys()].sort((a, b) => a - b).map((id) => { const u = hs?.units.find((q) => q.id === id); const b = buckets.get(id)!; return { id, label: u?.label ?? `Unit ${id}`, status: u?.status ?? 'unvalidated', stats: Object.fromEntries(Object.entries(b).map(([p, v]) => [p, summarize(v)])) }; });
  return { props: ['PHI', 'K', 'RQI', 'FZI', 'VSH', 'NMR φ', 'NMR T2LM', 'NMR FFI', 'NMR BVI'].filter((p) => props.has(p)), units, source };
}

export function ReservoirQuality() {
  const sets = useStore((s) => s.hfuSets); const wells = useStore((s) => s.wells); const zone = useStore((s) => s.zone); useStore((s) => s.dataVersion);
  const [src, setSrc] = useState<string>(() => sets.find((h) => h.domain === 'core')?.id ?? '__log');
  const [curve, setCurve] = useState('HFU_PRED'); const [wids, setWids] = useState<string[]>(wells.map((w) => w.id));
  const [prop, setProp] = useState('K'); const [stat, setStat] = useState<Stat>('median'); const [dir, setDir] = useState<'desc' | 'asc'>('desc');
  const disc = [...new Set(wells.flatMap((w) => w.curves.filter((c) => c.discrete && !FLAG_RE.test(c.mnemonic)).map((c) => c.mnemonic)))];
  const t = useMemo(() => buildRQ(src, src === '__log' ? { wellIds: wids, curve } : null, zone), [src, curve, wids, zone, sets, useStore.getState().dataVersion]);
  if (!t) return <><ModHead title="Reservoir Quality" /><Empty>Create an HFU set (core) or an HFU curve on the well grid first.</Empty></>;
  const ordered = [...t.units].sort((a, b) => { const va = a.stats[prop]?.[stat] ?? NaN, vb = b.stats[prop]?.[stat] ?? NaN; return (dir === 'desc' ? vb - va : va - vb) || 0; });
  const exportCsv = () => { const rows = t.units.flatMap((u) => t.props.map((p) => [u.label, p, ...STATS.map((s) => u.stats[p]?.[s])])); download(toCSV(['Unit', 'Property', ...STATS].map((h, j) => ({ name: h, data: rows.map((r) => r[j] as any) })), false), 'reservoir_quality.csv', 'text/csv'); };
  return <>
    <ModHead title="Reservoir Quality" sub={`Per-HFU statistics · ${t.source}${zone ? ` · zone ${zone}` : ''}`}>
      <select value={src} onChange={(e) => setSrc(e.target.value)}>{sets.filter((h) => h.domain === 'core').map((h) => <option key={h.id} value={h.id}>Core set: {h.name}</option>)}<option value="__log">Log HFU curve…</option></select>
      {src === '__log' && <><select value={curve} onChange={(e) => setCurve(e.target.value)}>{disc.map((m) => <option key={m}>{m}</option>)}</select>
        <select multiple value={wids} onChange={(e) => setWids([...e.target.selectedOptions].map((o) => o.value))} style={{ height: 40 }}>{wells.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></>}
      <ZoneSelect /><button className="btn" onClick={exportCsv}>Export CSV</button>
    </ModHead>
    <div className="mod-b">
      <Box title="Factual ordering by one property" right={<><Sel value={prop} onChange={setProp} options={t.props} /><Sel value={stat} onChange={setStat} options={STATS.filter((s) => s !== 'n')} /><Sel value={dir} onChange={setDir} options={[{ v: 'desc', l: 'high → low' }, { v: 'asc', l: 'low → high' }]} /></>}>
        <div className="msg INFO" style={{ marginBottom: 6 }}><b>METRIC</b>Units ordered by <b>{stat} {prop}</b> ({dir === 'desc' ? 'highest first' : 'lowest first'}). This is an ordering by one measured property, not an overall reservoir-quality score.</div>
        <div className="grid2" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <table className="t"><thead><tr><th>#</th><th>Unit</th><th>Status</th><th>{stat} {prop}</th><th>N</th></tr></thead><tbody>
            {ordered.map((u, i) => <tr key={u.id}><td>{i + 1}</td><td><span className="pill" style={{ background: hfuColor(u.id) }} />{u.label}</td><td className="dim">{u.status}</td><td className="num">{fmt(u.stats[prop]?.[stat], 4)}</td><td className="num">{u.stats[prop]?.n ?? 0}</td></tr>)}
          </tbody></table>
          <div className="box" style={{ height: 220 }}><XYPlot title={`${stat} ${prop} by unit`} logY={LOGPROP.has(prop) && stat !== 'n'} xLabel="unit" series={[{ kind: 'bars', x: t.units.map((u) => u.id), y: t.units.map((u) => u.stats[prop]?.[stat] ?? NaN), colors: t.units.map((u) => hfuColor(u.id)), barWidth: 0.7 }]} /></div>
        </div>
      </Box>
      {t.props.map((p) => <Box key={p} title={`${p} statistics per HFU`} style={{ marginTop: 8 }}>
        <table className="t"><thead><tr><th>Unit</th>{STATS.map((s) => <th key={s}>{s === 'geomean' ? 'geo. mean' : s.toUpperCase().length <= 3 ? s.toUpperCase() : s}</th>)}</tr></thead><tbody>
          {t.units.map((u) => <tr key={u.id}><td><span className="pill" style={{ background: hfuColor(u.id) }} />{u.label}</td>{STATS.map((s) => <td key={s} className="num">{s === 'n' ? u.stats[p]?.n ?? 0 : fmt(u.stats[p]?.[s], 4)}</td>)}</tr>)}
        </tbody></table>
      </Box>)}
      <div className="hint" style={{ marginTop: 6 }}>P10/P50/P90 = 10th/50th/90th percentiles (low → high). Geometric mean is the appropriate average for K, RQI and FZI.</div>
    </div>
  </>;
}
