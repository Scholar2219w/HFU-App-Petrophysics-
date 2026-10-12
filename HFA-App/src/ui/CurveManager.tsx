import { useEffect, useMemo, useRef, useState } from 'react';
import { S, useStore } from '../store/store';
import { BUILTIN_ALIASES, FAMILIES, categorize, familyOf } from '../curves/catalog';
import { registry } from '../data-engine/registry';
import type { CurveCategory, CurveMeta } from '../types';
import { Box, Empty, Kv, ModHead, useActiveWell } from './common';
import { fmt } from '../util/num';

const CATS: CurveCategory[] = ['Depth', 'Gamma Ray', 'Resistivity', 'Density', 'Neutron', 'Sonic', 'Porosity', 'Permeability', 'NMR', 'Image', 'Caliper', 'Pressure', 'Core', 'Calculated', 'Photoelectric', 'SP', 'Saturation', 'Shale', 'HFU', 'Flag', 'Other'];
export const curveSearchBus = { focus: () => {} };

export function CalcInfoView({ c }: { c: CurveMeta }) {
  if (!c.calc) return <span className="hint">Measured curve from {c.source}.</span>;
  return <div className="col">
    <div className="formula">{c.mnemonic} = {c.calc.formula}</div>
    <Kv rows={[['Kind', c.calc.kind], ['Inputs', c.calc.inputs.join(', ') || '—'], ['Units', c.calc.units || '—'], ['Version', `v${c.calc.version}`], ['Missing data', c.calc.missing], ['Created', c.calc.createdAt.replace('T', ' ').slice(0, 19)], ...(c.calc.model ? [['Model', c.calc.model] as [string, string]] : []), ...(c.calc.notes ? [['Notes', c.calc.notes] as [string, string]] : [])]} />
  </div>;
}

export function CurveManager() {
  const well = useActiveWell();
  const aliases = useStore((s) => s.aliases);
  const [q, setQ] = useState(''); const [cat, setCat] = useState(''); const [sel, setSel] = useState<string | null>(null);
  const [sort, setSort] = useState<{ k: string; d: 1 | -1 }>({ k: 'category', d: 1 });
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => { curveSearchBus.focus = () => search.current?.focus(); }, []);
  const rows = useMemo(() => {
    let r = (well?.curves ?? []).filter((c) => (!q || (c.mnemonic + c.description + c.family).toLowerCase().includes(q.toLowerCase())) && (!cat || c.category === cat));
    const key = (c: CurveMeta): any => (sort.k === 'min' ? c.stats.min : sort.k === 'max' ? c.stats.max : sort.k === 'null' ? c.stats.nullPct : (c as any)[sort.k] ?? '');
    return [...r].sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * sort.d);
  }, [well, q, cat, sort]);
  if (!well) return <><ModHead title="Curve Manager" /><Empty>No well loaded.</Empty></>;
  const cur = well.curves.find((c) => c.mnemonic === sel);
  const edit = (m: string, p: Partial<CurveMeta>) => { S().upsertCurveMeta(well.id, { ...well.curves.find((c) => c.mnemonic === m)!, ...p }); };
  const th = (k: string, l: string) => <th onClick={() => setSort({ k, d: sort.k === k ? (-sort.d as 1 | -1) : 1 })} style={{ cursor: 'pointer' }}>{l}{sort.k === k ? (sort.d > 0 ? ' ▲' : ' ▼') : ''}</th>;
  return (
    <>
      <ModHead title="Curve Manager" sub={`${well.name} · ${well.curves.length} curves · ${well.nSamples.toLocaleString()} samples · step ${fmt(well.step, 4)} ${well.depthUnit}${well.regular ? '' : ' (irregular)'}`}>
        <input ref={search} placeholder="Find curve (Ctrl+F)" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 180 }} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All types</option>{CATS.map((c) => <option key={c}>{c}</option>)}</select>
      </ModHead>
      <div className="mod-b">
        <div className="split w380" style={{ gridTemplateColumns: '1fr 360px', height: '100%' }}>
          <div className="tbl-wrap">
            <table className="t"><thead><tr>{th('mnemonic', 'Mnemonic')}{th('family', 'Alias')}{th('description', 'Description')}{th('unit', 'Unit')}{th('category', 'Type')}<th>Data Type</th>{th('min', 'Min')}{th('max', 'Max')}{th('null', 'Null %')}<th>Sampling</th>{th('source', 'Source')}</tr></thead>
              <tbody>{rows.map((c) => (
                <tr key={c.mnemonic} className={sel === c.mnemonic ? 'sel' : ''} onClick={() => setSel(c.mnemonic)} draggable onDragStart={(e) => e.dataTransfer.setData('text/curve', c.mnemonic)} title="Drag onto a log-viewer track">
                  <td><b>{c.mnemonic}</b></td><td>{c.family ?? <span className="dim">—</span>}</td><td className="dim" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.description}</td><td>{c.unit}</td><td>{c.category}</td><td className="dim">Float32</td>
                  <td className="num">{fmt(c.stats.min, 4)}</td><td className="num">{fmt(c.stats.max, 4)}</td><td className="num" style={{ color: c.stats.nullPct > 50 ? 'var(--warn)' : undefined }}>{c.stats.nullPct.toFixed(1)}</td><td className="num">{fmt(well.step, 4)}</td><td className="dim">{c.calc ? `${c.calc.kind} v${c.calc.version}` : c.source}</td>
                </tr>))}</tbody></table>
          </div>
          <div className="col" style={{ overflow: 'auto' }}>
            {cur ? <Box title={`Curve ${cur.mnemonic}`} right={<button className="btn sm danger" onClick={() => { if (confirm(`Delete curve ${cur.mnemonic} from ${well.name}? (Undo not available for deletions.)`)) { registry.deleteCurve(well.id, cur.mnemonic); S().removeCurveMeta(well.id, cur.mnemonic); S().log(`Deleted curve ${cur.mnemonic}`, 'warn'); setSel(null); S().bump(); } }}>Delete</button>}>
              <label className="f"><span>Description</span><input value={cur.description} onChange={(e) => edit(cur.mnemonic, { description: e.target.value })} /></label>
              <label className="f"><span>Unit</span><input value={cur.unit} onChange={(e) => edit(cur.mnemonic, { unit: e.target.value })} /></label>
              <label className="f"><span>Type</span><select value={cur.category} onChange={(e) => edit(cur.mnemonic, { category: e.target.value as CurveCategory })}>{CATS.map((c) => <option key={c}>{c}</option>)}</select></label>
              <label className="f"><span>Alias (family)</span><select value={cur.family ?? ''} onChange={(e) => { const fam = e.target.value; S().set({ aliases: { ...aliases, [cur.mnemonic.toUpperCase()]: fam } }); edit(cur.mnemonic, { family: fam || undefined, category: fam ? FAMILIES[fam].category : categorize(cur.mnemonic, cur.unit) }); S().log(`Alias mapping ${cur.mnemonic} → ${fam || '(none)'}`); }}>
                <option value="">— none —</option>{Object.entries(FAMILIES).map(([k, v]) => <option key={k} value={k}>{k} — {v.label}</option>)}</select></label>
              <div style={{ marginTop: 6 }}><CalcInfoView c={cur} /></div>
              <Kv rows={[['P05 / P95', `${fmt(cur.stats.p05, 4)} / ${fmt(cur.stats.p95, 4)}`], ['Mean', fmt(cur.stats.mean, 4)], ['Valid samples', cur.stats.nValid.toLocaleString()]]} />
            </Box> : <Box title="Curve"><span className="hint">Select a curve. Drag rows onto log-viewer tracks.</span></Box>}
            <Box title="Alias mapping" right={<span className="hint">user-defined overrides built-in</span>}>
              <AliasEditor />
            </Box>
          </div>
        </div>
      </div>
    </>
  );
}

function AliasEditor() {
  const aliases = useStore((s) => s.aliases); const wells = useStore((s) => s.wells);
  const [m, setM] = useState(''); const [f, setF] = useState('GR');
  const apply = (next: Record<string, string>) => {
    S().set({ aliases: next });
    for (const w of wells) S().updateWell(w.id, (x) => ({ ...x, curves: x.curves.map((c) => { const fam = familyOf(c.mnemonic, next); return { ...c, family: fam, category: c.calc ? c.category : categorize(c.mnemonic, c.unit, next) }; }) }));
  };
  const builtIns = Object.entries(BUILTIN_ALIASES).filter(([k, v]) => k !== v).slice(0, 400);
  return <div className="col">
    <div className="row"><input placeholder="mnemonic e.g. HSGR" value={m} onChange={(e) => setM(e.target.value.toUpperCase())} style={{ width: 120 }} />→<select value={f} onChange={(e) => setF(e.target.value)}>{Object.keys(FAMILIES).map((k) => <option key={k}>{k}</option>)}</select><button className="btn sm" disabled={!m} onClick={() => { apply({ ...aliases, [m]: f }); S().log(`Alias mapping ${m} → ${f}`); setM(''); }}>Add</button></div>
    <div className="tbl-wrap" style={{ maxHeight: 220 }}><table className="t"><thead><tr><th>Mnemonic</th><th>→ Family</th><th>Origin</th><th /></tr></thead><tbody>
      {Object.entries(aliases).map(([k, v]) => <tr key={'u' + k}><td>{k}</td><td>{v || '(none)'}</td><td>user</td><td><button className="btn sm" onClick={() => { const n = { ...aliases }; delete n[k]; apply(n); }}>✕</button></td></tr>)}
      {builtIns.map(([k, v]) => <tr key={k} className="dim"><td>{k}</td><td>{v}</td><td className="dim">built-in</td><td /></tr>)}
    </tbody></table></div>
  </div>;
}
