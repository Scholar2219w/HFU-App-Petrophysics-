import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { registry } from '../data-engine/registry';
import { zoneMask } from '../data-engine/zones';
import { resolveMnem } from '../visualization/LogViewer';
import { evaluate, parse, variables } from '../petrophysics/formula';
import { Empty, ModHead, Msgs, Num, ZoneSelect, useActiveWell, download } from './common';
import { toCSV, toXLSX, colsToRows, safeName } from '../export/io';
import { fmt } from '../util/num';

const DEFAULT = ['GR', 'VSH', 'RHOB', 'NPHI', 'PHIE', 'K', 'RQI_LOG', 'FZI_PRED', 'HFU_PRED'];
const ROW_H = 20;

export function DataTable() {
  const well = useActiveWell(); const zone = useStore((s) => s.zone); useStore((s) => s.dataVersion);
  const [cols, setCols] = useState<string[]>([]);
  useEffect(() => { if (well) setCols([...new Set(DEFAULT.map((f) => resolveMnem(well, f)).filter(Boolean) as string[])]); }, [well?.id]);
  const [sort, setSort] = useState<{ c: string; d: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState(''); const [search, setSearch] = useState(''); const [freeze, setFreeze] = useState(1);
  const [showChooser, setShowChooser] = useState(false); const [scroll, setScroll] = useState(0); const [h, setH] = useState(600);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setH(el.clientHeight)); ro.observe(el); return () => ro.disconnect(); }, [well?.id]);
  const view = useMemo(() => {
    if (!well) return null; const d = registry.depth(well.id); if (!d) return null;
    const arrs = cols.map((c) => registry.curve(well.id, c) ?? new Float32Array(d.length).fill(NaN));
    let idx: number[] = []; const zm = zoneMask(well.id, zone); let err = '';
    let fm: Float32Array | null = null;
    if (filter.trim()) { try { const vars = [...variables(parse(filter))]; const a: Record<string, Float32Array> = {}; for (const v of vars) { const c = registry.curve(well.id, v); if (!c) throw new Error(`Unknown or unloaded curve ${v}`); a[v] = c; } fm = evaluate(filter, a, d.length).out; } catch (e: any) { err = e.message; } }
    const q = search.trim().toLowerCase();
    for (let i = 0; i < d.length; i++) {
      if (zm && !zm[i]) continue; if (fm && fm[i] !== 1) continue;
      if (q && !(d[i].toFixed(3).includes(q) || arrs.some((a) => fmt(a[i], 5).toLowerCase().includes(q)))) continue;
      idx.push(i);
    }
    if (sort) { const a = sort.c === 'DEPTH' ? d : arrs[cols.indexOf(sort.c)]; if (a) idx.sort((x, y) => { const u = a[x], v = a[y]; if (u !== u) return 1; if (v !== v) return -1; return (u - v) * sort.d; }); }
    return { d, arrs, idx, err };
  }, [well?.id, cols.join(), zone, filter, search, sort?.c, sort?.d, useStore.getState().dataVersion]);
  if (!well || !view) return <><ModHead title="Data Table" /><Empty>No well loaded.</Empty></>;
  const all = ['DEPTH', ...cols]; const widths = all.map((c) => (c === 'DEPTH' ? 90 : 96));
  const lefts = widths.map((_, i) => widths.slice(0, i).reduce((s, x) => s + x, 0));
  const first = Math.max(0, Math.floor(scroll / ROW_H) - 5), last = Math.min(view.idx.length, first + Math.ceil(h / ROW_H) + 12);
  const cell = (c: string, ci: number, i: number) => { const v = ci === 0 ? view.d[i] : view.arrs[ci - 1][i]; return ci === 0 ? v.toFixed(3) : fmt(v, 5); };
  const exportView = async (kind: 'csv' | 'xlsx') => {
    const out = all.map((c, ci) => ({ name: c, unit: ci === 0 ? well.depthUnit : well.curves.find((x) => x.mnemonic === c)?.unit, data: view.idx.map((i) => (ci === 0 ? view.d[i] : view.arrs[ci - 1][i])) }));
    if (kind === 'csv') download(toCSV(out), `${safeName(well.name)}_table.csv`, 'text/csv'); else download(await toXLSX([{ name: well.name, rows: colsToRows(out) }]), `${safeName(well.name)}_table.xlsx`);
  };
  return <>
    <ModHead title="Data Table" sub={`${well.name} · ${view.idx.length.toLocaleString()} of ${view.d.length.toLocaleString()} rows (virtualised — only visible rows are rendered)`}>
      <input placeholder="Search values…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 130 }} />
      <input placeholder="Filter e.g. GR < 50 AND PHIE > 0.1" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 240 }} />
      <ZoneSelect /><span className="hint">Freeze</span><Num value={freeze} onChange={(v) => setFreeze(Math.max(0, Math.min(all.length, Math.round(v))))} style={{ width: 44 }} />
      <button className={'btn' + (showChooser ? ' on' : '')} onClick={() => setShowChooser(!showChooser)}>Columns…</button>
      <button className="btn" onClick={() => exportView('csv')}>Export CSV</button><button className="btn" onClick={() => exportView('xlsx')}>Export XLSX</button>
    </ModHead>
    {view.err && <Msgs items={[{ level: 'CRITICAL', text: `Filter: ${view.err}` }]} />}
    {showChooser && <div className="row" style={{ padding: '4px 10px', background: 'var(--bg1)', borderBottom: '1px solid var(--bd)', maxHeight: 90, overflow: 'auto', gap: 6 }}>
      {well.curves.map((c) => <label key={c.mnemonic} className="cb"><input type="checkbox" checked={cols.includes(c.mnemonic)} onChange={(e) => setCols(e.target.checked ? [...cols, c.mnemonic] : cols.filter((x) => x !== c.mnemonic))} />{c.mnemonic}</label>)}
    </div>}
    <div className="mod-b nopad"><div ref={box} style={{ flex: 1, overflow: 'auto', position: 'relative' }} onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)}>
      <div className="vt-head" style={{ width: lefts[lefts.length - 1] + widths[widths.length - 1] }}>{all.map((c, ci) => <div key={c} className={ci < freeze ? 'frozen' : ''} style={{ width: widths[ci], left: ci < freeze ? lefts[ci] : undefined, background: ci < freeze ? 'var(--bg2)' : undefined }} onClick={() => setSort(sort?.c === c ? { c, d: (-sort.d) as 1 | -1 } : { c, d: 1 })} title="Click to sort">
        {c}{sort?.c === c ? (sort.d > 0 ? ' ▲' : ' ▼') : ''} {ci > 0 && <span style={{ float: 'right', cursor: 'pointer' }} title="Hide column" onClick={(e) => { e.stopPropagation(); setCols(cols.filter((x) => x !== c)); }}>×</span>}</div>)}</div>
      <div style={{ height: view.idx.length * ROW_H, position: 'relative', width: lefts[lefts.length - 1] + widths[widths.length - 1] }}>
        {view.idx.slice(first, last).map((i, k) => <div key={i} className="vt-row" style={{ top: (first + k) * ROW_H }}>{all.map((c, ci) => <div key={c} className={ci < freeze ? 'frozen' : ''} style={{ width: widths[ci], left: ci < freeze ? lefts[ci] : undefined, textAlign: 'right' }}>{cell(c, ci, i)}</div>)}</div>)}
      </div>
    </div></div>
  </>;
}
