import { useMemo, useState } from 'react';
import { S, useStore } from '../store/store';
import { PRESETS, evaluate, parse, variables, FUNCTION_NAMES, type Preset } from '../petrophysics/formula';
import { registry } from '../data-engine/registry';
import { putCalculatedCurve } from '../data-engine/ingest';
import { findByFamily } from '../curves/catalog';
import { Box, Empty, Field, ModHead, Msgs, useActiveWell } from './common';
import { RightPanel } from './RightPanel';
import { CalcInfoView } from './CurveManager';
import { XYPlot } from '../visualization/XYPlot';
import { fmt, fullStats, isNum, nowIso, percentiles } from '../util/num';
import type { WellMeta } from '../types';

const ident = (m: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(m) ? m : `[${m}]`);

function resolveDefault(well: WellMeta, def: string) {
  const names = well.curves.map((c) => c.mnemonic);
  if (names.includes(def)) return def;
  return findByFamily(names, def) ?? (def === 'PHI' ? findByFamily(names, 'PHIE') ?? findByFamily(names, 'PHIT') : undefined) ?? '';
}

export function Calculator() {
  const well = useActiveWell(); const wells = useStore((s) => s.wells); useStore((s) => s.dataVersion);
  const [pid, setPid] = useState('vsh_lin');
  const preset = PRESETS.find((p) => p.id === pid)!;
  const [vals, setVals] = useState<Record<string, string>>({});
  const [out, setOut] = useState(''); const [unit, setUnit] = useState(''); const [custom, setCustom] = useState('');
  const [clip, setClip] = useState(true); const [allWells, setAllWells] = useState(false);
  const [msgs, setMsgs] = useState<{ level: any; text: string }[]>([]);

  const paramFor = (w: WellMeta, p: Preset['params'][number], curveCtx: Record<string, string>) => {
    const v = vals[p.key];
    if (typeof p.def === 'string' && !/^P\d\d$/.test(p.def)) return w.id === well?.id && v ? v : resolveDefault(w, v && w.id !== well?.id ? v : String(p.def));
    if (v !== undefined && v !== '' && !/^P\d\d$/.test(v)) return v;
    if (typeof p.def === 'string' && /^P\d\d$/.test(p.def)) { // percentile of the curve param (first curve param)
      const src = curveCtx[preset.params.find((q) => typeof q.def === 'string' && !/^P\d\d$/.test(q.def as string))!.key]; const c = src && registry.curve(w.id, src);
      return c ? percentiles(c, [+p.def.slice(1)])[0].toPrecision(5) : 'NaN';
    }
    return String(p.def);
  };
  const build = (w: WellMeta) => {
    if (preset.id === 'custom') return { expr: custom, ctx: {} as Record<string, string> };
    const ctx: Record<string, string> = {};
    for (const p of preset.params) if (typeof p.def === 'string' && !/^P\d\d$/.test(p.def)) ctx[p.key] = paramFor(w, p, ctx);
    for (const p of preset.params) if (!(p.key in ctx)) ctx[p.key] = paramFor(w, p, ctx);
    let e = preset.expr; for (const [k, v] of Object.entries(ctx)) e = e.split(`{${k}}`).join(preset.params.find((q) => q.key === k && typeof q.def === 'string' && !/^P\d\d$/.test(q.def as string)) ? ident(v) : v);
    return { expr: e, ctx };
  };
  const outName = out || preset.output; const outUnit = unit || preset.unit;
  const res = useMemo(() => {
    if (!well) return null;
    try {
      const { expr } = build(well); if (!expr.trim()) return null;
      const vars = [...variables(parse(expr))]; const missing = vars.filter((v) => !well.curves.some((c) => c.mnemonic === v));
      if (missing.length) return { error: `Unknown curve(s) in this well: ${missing.join(', ')}`, expr, vars };
      const arrs: Record<string, Float32Array> = {}; for (const v of vars) { const c = registry.curve(well.id, v); if (!c) return { error: `Curve ${v} is loading…`, expr, vars }; arrs[v] = c; }
      const r = evaluate(expr, arrs, well.nSamples, { clip: clip ? preset.clip ?? null : null });
      return { expr, vars, out: r.out, nInvalid: r.nInvalid, stats: fullStats(r.out) };
    } catch (e: any) { return { error: e.message, expr: '', vars: [] as string[] }; }
  }, [well, pid, vals, custom, clip, S().dataVersion]);

  if (!well) return <><ModHead title="Petrophysical Calculator" /><Empty>No well loaded.</Empty></>;
  const create = () => {
    const targets = allWells ? wells : [well]; const m: typeof msgs = [];
    for (const w of targets) {
      try {
        const { expr } = build(w); const vars = [...variables(parse(expr))];
        const miss = vars.filter((v) => !w.curves.some((c) => c.mnemonic === v)); if (miss.length) { m.push({ level: 'WARNING', text: `${w.name}: skipped — missing ${miss.join(', ')}` }); continue; }
        const arrs: Record<string, Float32Array> = {}; for (const v of vars) arrs[v] = registry.curve(w.id, v)!;
        if (Object.values(arrs).some((a) => !a)) { m.push({ level: 'WARNING', text: `${w.name}: inputs still loading, try again.` }); continue; }
        const r = evaluate(expr, arrs, w.nSamples, { clip: clip ? preset.clip ?? null : null });
        putCalculatedCurve(w.id, outName, r.out, outUnit, preset.id === 'custom' ? 'Custom expression' : preset.name, {
          kind: 'formula', formula: expr, inputs: vars, units: outUnit, version: 1, createdAt: nowIso(),
          missing: `Any missing input → missing output; invalid results (÷0, log ≤ 0, √<0) → missing (${r.nInvalid.toLocaleString()} samples).${clip && preset.clip ? ` Output clipped to [${preset.clip[0]}, ${preset.clip[1]}].` : ''}`,
          notes: preset.description,
        });
        S().log(`Calculated ${outName} on ${w.name}: ${outName} = ${expr}`);
        m.push({ level: 'OK', text: `${w.name}: ${outName} created (${(100 - fullStats(r.out).nullPct).toFixed(1)}% valid).` });
      } catch (e: any) { m.push({ level: 'CRITICAL', text: `${w.name}: ${e.message}` }); }
    }
    setMsgs(m);
  };
  const hist = res && 'out' in res && res.out ? histogram(res.out, 40) : null;
  return (
    <>
      <ModHead title="Petrophysical Calculation Engine" sub="Transparent formulas · every calculated curve records formula, inputs, units, version and missing-data handling" />
      <div className="mod-b">
        <div className="split w380">
          <div className="col">
            <Box title="Calculation">
              <Field label="Template"><select value={pid} onChange={(e) => { setPid(e.target.value); setVals({}); setOut(''); setUnit(''); }}>{PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
              <div className="hint" style={{ margin: '2px 0 6px' }}>{preset.description}</div>
              {preset.params.map((p) => {
                const isCurve = typeof p.def === 'string' && !/^P\d\d$/.test(p.def as string);
                const cur = isCurve ? vals[p.key] ?? resolveDefault(well, String(p.def)) : vals[p.key] ?? (typeof p.def === 'string' ? '' : String(p.def));
                return <Field key={p.key} label={p.label}>{isCurve
                  ? <select value={cur} onChange={(e) => setVals({ ...vals, [p.key]: e.target.value })}><option value="">— select —</option>{well.curves.map((c) => <option key={c.mnemonic}>{c.mnemonic}</option>)}</select>
                  : <input value={cur} placeholder={typeof p.def === 'string' ? `${p.def} of curve (auto)` : ''} onChange={(e) => setVals({ ...vals, [p.key]: e.target.value })} />}</Field>;
              })}
              {preset.id === 'custom' && <><textarea rows={3} style={{ width: '100%' }} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. 0.0314 * sqrt(KTIM / CMRP_3MS)" />
                <div className="hint">Operators + − × / ^ &lt; &gt; &lt;= &gt;= == AND OR NOT BETWEEN · functions: {FUNCTION_NAMES.join(', ')} · names with symbols: [NAME-1]</div></>}
              <Field label="Output curve"><input value={out} placeholder={preset.output} onChange={(e) => setOut(e.target.value.toUpperCase().replace(/\s+/g, '_'))} /></Field>
              <Field label="Output unit"><input value={unit} placeholder={preset.unit} onChange={(e) => setUnit(e.target.value)} /></Field>
              {preset.clip && <label className="cb"><input type="checkbox" checked={clip} onChange={(e) => setClip(e.target.checked)} />clip to [{preset.clip[0]}, {preset.clip[1]}]</label>}
              <label className="cb" style={{ marginLeft: 10 }}><input type="checkbox" checked={allWells} onChange={(e) => setAllWells(e.target.checked)} />apply to all wells (curves resolved by alias)</label>
              <div className="row" style={{ marginTop: 6 }}><button className="btn pri" disabled={!res || 'error' in res} onClick={create}>Create {outName}</button>{well.curves.some((c) => c.mnemonic === outName) && <span className="tag warn">overwrites → new version</span>}</div>
            </Box>
            <Msgs items={msgs} />
          </div>
          <div className="col">
            <Box title="Formula (as evaluated)">
              {res && <div className="formula">{outName} = {res.expr || '…'}</div>}
              {res && 'error' in res && <Msgs items={[{ level: 'CRITICAL', text: res.error! }]} />}
              {res && 'stats' in res && res.stats && <div className="kv" style={{ marginTop: 6, gridTemplateColumns: 'repeat(6, auto 1fr)' }}>
                <span>Inputs</span><span>{res.vars.join(', ')}</span><span>Units</span><span>{outUnit || '—'}</span><span>Valid</span><span>{res.stats.nValid.toLocaleString()} / {well.nSamples.toLocaleString()}</span>
                <span>Min</span><span>{fmt(res.stats.min, 4)}</span><span>Mean</span><span>{fmt(res.stats.mean, 4)}</span><span>Max</span><span>{fmt(res.stats.max, 4)}</span>
                <span>Missing</span><span>any NaN input → NaN</span><span>Invalid</span><span>{res.nInvalid?.toLocaleString()}</span><span>Well</span><span>{well.name}</span>
              </div>}
            </Box>
            {hist && <div className="box" style={{ height: 240, marginTop: 8 }}><XYPlot title={`Distribution of ${outName} (preview)`} series={[{ kind: 'bars', x: hist.x, y: hist.y, color: '#39c5cf' }]} xLabel={outName} yLabel="count" /></div>}
          </div>
        </div>
      </div>
      <RightPanel>
        <Box title={`Calculated curves — ${well.name}`}>
          {well.curves.filter((c) => c.calc).length ? well.curves.filter((c) => c.calc).map((c) => <div key={c.mnemonic} style={{ borderBottom: '1px solid var(--bd)', padding: '4px 0' }}><b>{c.mnemonic}</b> <span className="dim">[{c.unit}] v{c.calc!.version}</span><CalcInfoView c={c} /></div>) : <span className="hint">None yet.</span>}
        </Box>
      </RightPanel>
    </>
  );
}

export function histogram(a: ArrayLike<number>, nb: number, log = false) {
  let mn = Infinity, mx = -Infinity; const t = (v: number) => (log ? Math.log10(v) : v);
  for (let i = 0; i < a.length; i++) { const v = a[i]; if (!isNum(v) || (log && v <= 0)) continue; const x = t(v); if (x < mn) mn = x; if (x > mx) mx = x; }
  if (mn === Infinity) return null; if (mn === mx) { mx = mn + 1; }
  const w = (mx - mn) / nb; const y = new Array(nb).fill(0);
  for (let i = 0; i < a.length; i++) { const v = a[i]; if (!isNum(v) || (log && v <= 0)) continue; y[Math.min(nb - 1, Math.floor((t(v) - mn) / w))]++; }
  return { x: y.map((_, i) => mn + (i + 0.5) * w), y, w };
}
