import { useMemo, useState } from 'react';
import { S, useStore } from '../store/store';
import { registry } from '../data-engine/registry';
import { zonesForWell } from '../data-engine/zones';
import { evaluate, parse, variables } from '../petrophysics/formula';
import { putCalculatedCurve } from '../data-engine/ingest';
import { Box, Empty, Field, ModHead, Msgs, Num, Sel, useActiveWell } from './common';
import { fmt, isNum, nowIso } from '../util/num';

type Op = '>' | '<' | '>=' | '<=' | '==' | '!=' | 'BETWEEN';
interface Cond { join: 'AND' | 'OR'; not: boolean; curve: string; op: Op; a: number; b: number }
const ident = (m: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(m) ? m : `[${m}]`);
export const condToExpr = (cs: Cond[]) => cs.map((c, i) => `${i ? ` ${c.join} ` : ''}${c.not ? 'NOT ' : ''}${c.op === 'BETWEEN' ? `${ident(c.curve)} BETWEEN ${c.a} AND ${c.b}` : `${ident(c.curve)} ${c.op} ${c.a}`}`).join('');

export function FilterBuilder() {
  const well = useActiveWell(); const saved = useStore((s) => s.savedFilters); useStore((s) => s.dataVersion);
  const names = well?.curves.map((c) => c.mnemonic) ?? [];
  const pick = (...c: string[]) => c.find((m) => names.includes(m)) ?? names[0] ?? '';
  const [conds, setConds] = useState<Cond[]>(() => [{ join: 'AND', not: false, curve: pick('GR'), op: '<', a: 50, b: 0 }, { join: 'AND', not: false, curve: pick('PHIE', 'PHIT', 'CMRP'), op: '>', a: 0.1, b: 0 }, { join: 'AND', not: false, curve: pick('FZI_PRED', 'FZI_LOG'), op: '>', a: 1, b: 0 }]);
  const [text, setText] = useState<string | null>(null);
  const [useDepth, setUseDepth] = useState(false); const [top, setTop] = useState(0); const [base, setBase] = useState(0);
  const [fm, setFm] = useState(''); const [hfuC, setHfuC] = useState(''); const [hfuV, setHfuV] = useState<number[]>([]);
  const [fname, setFname] = useState(''); const [msgs, setMsgs] = useState<{ level: any; text: string }[]>([]);
  const expr = text ?? condToExpr(conds);
  const res = useMemo(() => {
    if (!well) return null; const d = registry.depth(well.id); if (!d) return null;
    try {
      const n = d.length; let mask = new Uint8Array(n).fill(1); const steps: string[] = [];
      if (expr.trim()) {
        const vars = [...variables(parse(expr))]; const miss = vars.filter((v) => !names.includes(v)); if (miss.length) return { error: `Unknown curve(s): ${miss.join(', ')}` };
        const arrs: Record<string, Float32Array> = {}; for (const v of vars) { const c = registry.curve(well.id, v); if (!c) return { error: `Curve ${v} is loading…` }; arrs[v] = c; }
        const { out } = evaluate(expr, arrs, n); for (let i = 0; i < n; i++) mask[i] = out[i] === 1 ? 1 : 0; steps.push(`condition: ${expr}`);
      }
      if (useDepth) { for (let i = 0; i < n; i++) if (d[i] < top || d[i] > base) mask[i] = 0; steps.push(`depth ${top}–${base}`); }
      if (fm) { const z = zonesForWell(well.id).find((q) => q.name === fm); if (z) { for (let i = 0; i < n; i++) if (d[i] < z.top || d[i] >= z.base) mask[i] = 0; steps.push(`formation ${fm}`); } }
      if (hfuC && hfuV.length) { const h = registry.curve(well.id, hfuC); if (h) { for (let i = 0; i < n; i++) if (!hfuV.includes(Math.round(h[i]))) mask[i] = 0; steps.push(`${hfuC} ∈ {${hfuV.join(', ')}}`); } }
      let after = 0; for (const m of mask) after += m;
      const ivs: { top: number; base: number }[] = []; let s0 = -1;
      for (let i = 0; i <= n; i++) { const on = i < n && mask[i]; if (on && s0 < 0) s0 = i; if (!on && s0 >= 0) { ivs.push({ top: d[s0], base: d[i - 1] }); s0 = -1; } }
      const step = well.step || 0;
      return { mask, before: n, after, removed: n - after, ivs, net: after * step, steps };
    } catch (e: any) { return { error: e.message }; }
  }, [well?.id, expr, useDepth, top, base, fm, hfuC, hfuV.join(), useStore.getState().dataVersion]);
  if (!well) return <><ModHead title="Interval Selection & Formula Builder" /><Empty>No well.</Empty></>;
  const upd = (i: number, p: Partial<Cond>) => { setText(null); setConds(conds.map((c, k) => (k === i ? { ...c, ...p } : c))); };
  const disc = well.curves.filter((c) => c.discrete).map((c) => c.mnemonic);
  const ok = res && !('error' in res);
  const r = ok ? (res as Exclude<typeof res, { error: string } | null>) : null;
  const toSelection = () => { if (!r) return; const d = registry.depth(well.id)!; const depths: number[] = []; for (let i = 0; i < d.length; i++) if (r.mask[i]) depths.push(d[i]); S().set({ selection: { wellId: well.id, source: 'log', depths, label: `filter: ${r.after} samples` } }); S().log(`Selection from filter (${r.steps.join(' AND ')}): ${r.after} samples`); };
  const toInterval = () => { if (!r?.ivs.length) return; const t = r.ivs[0].top, b = r.ivs[r.ivs.length - 1].base; S().set({ interval: { wellId: well.id, top: t, base: b } }); };
  const toCurve = () => { if (!r) return; const nm = `SEL_${(fname || 'FILTER').toUpperCase().replace(/\W+/g, '_')}`; putCalculatedCurve(well.id, nm, Float32Array.from(r.mask, (m) => (m ? 1 : NaN)), 'flag', `Interval selection flag`, { kind: 'formula', formula: r.steps.join(' AND ') || 'all samples', inputs: [...new Set([...(expr.trim() ? [...variables(parse(expr))] : []), ...(hfuC ? [hfuC] : [])])], units: 'flag', version: 1, missing: 'NaN input → not selected', createdAt: nowIso() }, true); S().log(`Saved selection flag curve ${nm}: Before N=${r.before}, After N=${r.after}, Removed N=${r.removed}`); setMsgs([{ level: 'OK', text: `Created ${nm} (discrete flag; view it as an HFU-style band in the log viewer).` }]); };
  const save = () => { if (!fname) { setMsgs([{ level: 'WARNING', text: 'Enter a filter name.' }]); return; } S().set({ savedFilters: [...saved.filter((f) => f.name !== fname), { name: fname, expr }] }); S().log(`Saved filter "${fname}": ${expr}`); };
  return <>
    <ModHead title="Interval Selection & Formula Builder" sub={`${well.name} · build conditions visually or type an expression (AND · OR · NOT · > < >= <= == != BETWEEN)`} />
    <div className="mod-b">
      <div className="split w380" style={{ gridTemplateColumns: '560px 1fr' }}>
        <div className="col">
          <Box title="Boolean condition (visual builder)" right={<button className="btn sm" onClick={() => { setText(null); setConds([...conds, { join: 'AND', not: false, curve: names[0], op: '>', a: 0, b: 0 }]); }}>+ condition</button>}>
            {conds.map((c, i) => <div key={i} className="fb-row">
              {i ? <Sel value={c.join} onChange={(v) => upd(i, { join: v })} options={['AND', 'OR']} style={{ width: 58 }} /> : <span style={{ width: 58 }} className="hint">WHERE</span>}
              <label className="cb"><input type="checkbox" checked={c.not} onChange={(e) => upd(i, { not: e.target.checked })} />NOT</label>
              <select value={c.curve} onChange={(e) => upd(i, { curve: e.target.value })} style={{ width: 120 }}>{names.map((m) => <option key={m}>{m}</option>)}</select>
              <Sel value={c.op} onChange={(v) => upd(i, { op: v })} options={['>', '<', '>=', '<=', '==', '!=', 'BETWEEN']} style={{ width: 84 }} />
              <Num value={c.a} onChange={(v) => upd(i, { a: v })} style={{ width: 70 }} />{c.op === 'BETWEEN' && <><span className="hint">and</span><Num value={c.b} onChange={(v) => upd(i, { b: v })} style={{ width: 70 }} /></>}
              <button className="btn sm" onClick={() => { setText(null); setConds(conds.filter((_, k) => k !== i)); }}>✕</button>
            </div>)}
            <Field label="Expression (editable)"><textarea rows={2} value={expr} onChange={(e) => setText(e.target.value)} /></Field>
            {text !== null && <div className="hint">Manual expression overrides the visual rows. <a href="#" onClick={(e) => { e.preventDefault(); setText(null); }}>Revert to builder</a></div>}
          </Box>
          <Box title="Additional selection methods (combined with AND)">
            <div className="row"><label className="cb"><input type="checkbox" checked={useDepth} onChange={(e) => { setUseDepth(e.target.checked); if (!top && !base) { const iv = S().interval; setTop(iv?.top ?? well.start); setBase(iv?.base ?? well.stop); } }} />Depth range</label>{useDepth && <><Num value={top} onChange={setTop} /><Num value={base} onChange={setBase} /><span className="hint">(or drag in the depth track)</span></>}</div>
            <Field label="Formation"><select value={fm} onChange={(e) => setFm(e.target.value)}><option value="">—</option>{zonesForWell(well.id).map((z) => <option key={z.name + z.top}>{z.name}</option>)}</select></Field>
            <Field label="HFU / cluster"><div className="row"><select value={hfuC} onChange={(e) => { setHfuC(e.target.value); setHfuV([]); }}><option value="">—</option>{disc.map((m) => <option key={m}>{m}</option>)}</select>
              {hfuC && [1, 2, 3, 4, 5, 6, 7, 8].map((u) => <label key={u} className="cb"><input type="checkbox" checked={hfuV.includes(u)} onChange={(e) => setHfuV(e.target.checked ? [...hfuV, u] : hfuV.filter((x) => x !== u))} />{u}</label>)}</div></Field>
          </Box>
          <Box title="Saved filters">
            <div className="row"><input value={fname} onChange={(e) => setFname(e.target.value)} placeholder="filter name" /><button className="btn sm" onClick={save}>Save filter</button></div>
            {saved.map((f) => <div key={f.name} className="row" style={{ marginTop: 3 }}><b style={{ minWidth: 90 }}>{f.name}</b><span className="mono dim" style={{ fontSize: 10.5, flex: 1 }}>{f.expr}</span><button className="btn sm" onClick={() => { setText(f.expr); setFname(f.name); }}>Load</button><button className="btn sm danger" onClick={() => S().set({ savedFilters: saved.filter((x) => x.name !== f.name) })}>✕</button></div>)}
            {!saved.length && <span className="hint">No saved filters.</span>}
          </Box>
          <Msgs items={msgs} />
        </div>
        <div className="col">
          {res && 'error' in res && <Msgs items={[{ level: 'CRITICAL', text: res.error! }]} />}
          {r && <Box title="Result">
            <div className="kpis" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>{[['Before', `N = ${r.before}`], ['After', `N = ${r.after}`], ['Removed', `N = ${r.removed}`], ['Net thickness', `${fmt(r.net, 4)} ${well.depthUnit}`], ['Intervals', r.ivs.length]].map(([l, v]) => <div key={String(l)} className="kpi"><div className="l">{l}</div><div className="v" style={{ fontSize: 14 }}>{v}</div></div>)}</div>
            <div className="hint" style={{ margin: '4px 0' }}>Reason: {r.steps.join(' AND ') || 'no condition (all samples)'} — samples with missing inputs are not selected.</div>
            <div className="row"><button className="btn pri" onClick={toSelection}>Show in log viewer (selection)</button><button className="btn" onClick={toInterval}>Set as active interval</button><button className="btn" onClick={toCurve}>Save as flag curve</button></div>
            <div className="tbl-wrap" style={{ maxHeight: 420, marginTop: 6 }}><table className="t"><thead><tr><th>#</th><th>Top</th><th>Base</th><th>Thickness</th></tr></thead><tbody>
              {r.ivs.slice(0, 500).map((q, i) => <tr key={i} onClick={() => S().set({ viewRange: { wellId: well.id, top: q.top - 5, base: q.base + 5 }, interval: { wellId: well.id, top: q.top, base: q.base } })} style={{ cursor: 'pointer' }}><td className="dim">{i + 1}</td><td className="num">{fmt(q.top, 6)}</td><td className="num">{fmt(q.base, 6)}</td><td className="num">{fmt(q.base - q.top + (well.step || 0), 4)}</td></tr>)}
            </tbody></table></div>
          </Box>}
        </div>
      </div>
    </div>
  </>;
}
void isNum;
