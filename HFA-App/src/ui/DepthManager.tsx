import { useMemo, useState } from 'react';
import { S, useStore, activeCore } from '../store/store';
import { registry } from '../data-engine/registry';
import { coreDepths, sampleLogAt } from '../data-engine/core';
import { applyOps, autoCorrelate, describeOp, fitLinear, fitPoly, invertOps, type CorrelationResult } from '../depth/transforms';
import { putCalculatedCurve } from '../data-engine/ingest';
import type { DepthOp } from '../types';
import { Box, CurvePicker, Empty, Field, ModHead, Msgs, Num, Sel, Tabs } from './common';
import { CoreSelector } from './CoreManager';
import { RightPanel } from './RightPanel';
import { XYPlot } from '../visualization/XYPlot';
import { DepthPlot, type DepthTrack } from '../visualization/DepthPlot';
import { fmt, isNum, nowIso, pearson, uid } from '../util/num';
import { findByFamily } from '../curves/catalog';

export function DepthManager() {
  const [tab, setTab] = useState<'match' | 'ref'>('match');
  return <>
    <ModHead title="Depth Manager" sub="Core-log depth matching · reversible depth transformations · depth references" />
    <Tabs value={tab} onChange={setTab} tabs={[{ v: 'match', l: 'Core–Log Depth Matching' }, { v: 'ref', l: 'Depth References (MD / TVD / TVDSS)' }]} />
    <div className="mod-b">{tab === 'match' ? <CoreLogMatch /> : <DepthRefs />}</div>
  </>;
}

function CoreLogMatch() {
  const core = useStore((s) => activeCore(s)); useStore((s) => s.dataVersion);
  const well = useStore((s) => s.wells.find((w) => w.id === core?.wellId));
  const arr = core ? registry.core(core.id) : undefined;
  const numCols = arr ? [...arr.num.keys()] : [];
  const [logCurve, setLogCurve] = useState<string>(() => (well ? (['PHIT', 'PHIE', 'CMRP', 'TCMR', 'NPHI', 'RHOB'].map((f) => findByFamily(well.curves.map((c) => c.mnemonic), f)).find(Boolean)) ?? well.curves[0]?.mnemonic : '') ?? '');
  const [coreColName, setCoreColName] = useState<string>(() => (arr?.num.has('PHI') ? 'PHI' : core?.map.phi) ?? numCols[0] ?? '');
  const [type, setType] = useState<'shift' | 'linear' | 'poly' | 'tie'>('shift');
  const [amount, setAmount] = useState(0); const [la, setLa] = useState(1); const [lb, setLb] = useState(0); const [deg, setDeg] = useState(2);
  const [pairs, setPairs] = useState<[number, number][]>([]);
  const [useIv, setUseIv] = useState(false); const [ivTop, setIvTop] = useState(0); const [ivBase, setIvBase] = useState(0);
  const [conf, setConf] = useState<'High' | 'Medium' | 'Low'>('Medium'); const [marker, setMarker] = useState('');
  const [win, setWin] = useState(5); const [stepS, setStepS] = useState(0.05);
  const [corr, setCorr] = useState<CorrelationResult | null>(null);
  const [pick, setPick] = useState<number | null>(null); // pending core depth for tie point
  const [msgs, setMsgs] = useState<{ level: any; text: string }[]>([]);
  const [invert, setInvert] = useState(false);

  const data = useMemo(() => {
    if (!core || !arr || !well) return null;
    const { original, shifted } = coreDepths(core, arr);
    const vals = arr.num.get(coreColName); const d = registry.depth(well.id); const lc = registry.curve(well.id, logCurve);
    return { original, shifted, vals, d, lc };
  }, [core, arr, well, coreColName, logCurve, S().dataVersion]);
  if (!core || !arr || !well) return <Empty>Load a well and a core dataset (Import Manager → Add Core Data) to match depths.</Empty>;
  if (!data?.vals || !data.lc || !data.d) return <><div className="row"><CoreSelector /><CurvePicker wellId={well.id} value={logCurve} onChange={setLogCurve} /><select value={coreColName} onChange={(e) => setCoreColName(e.target.value)}>{numCols.map((c) => <option key={c}>{c}</option>)}</select></div><Empty>Select a log curve and a core column (loading…)</Empty></>;
  const { original, shifted, vals, d, lc } = data;
  const ivOk = (o: number) => !useIv || (o >= ivTop && o <= ivBase);

  const pendingOp = (): DepthOp | null => {
    const base = { id: uid('d_'), active: true, interval: useIv ? ([ivTop, ivBase] as [number, number]) : undefined, confidence: conf, marker: marker || undefined, createdAt: nowIso() };
    if (type === 'shift') return { ...base, type, amount, method: corr && Math.abs(corr.bestShift - amount) < 1e-9 ? 'auto-correlation' : 'manual' };
    if (type === 'linear') return { ...base, type, a: la, b: lb, method: 'manual/tie-point fit' };
    if (type === 'poly') { const c = fitPoly(pairs.map(([o, t]) => [applyOps(core.depthOps, o), t]), deg); return c ? { ...base, type, coeffs: c, method: `poly deg ${deg} fit to ${pairs.length} tie points` } : null; }
    return pairs.length ? { ...base, type: 'tie', pairs: pairs.map(([o, t]) => [applyOps(core.depthOps, o), t]), method: 'tie points' } : null;
  };
  const op = pendingOp();
  const preview = Float64Array.from(original, (o, i) => (op && ivOk(o) ? applyOps([{ ...op, interval: undefined }], shifted[i]) : shifted[i]));
  const sg = invert ? -1 : 1;
  const r = (depths: Float64Array) => { const lv = sampleLogAt(well, logCurve, depths); const mask = Array.from(vals, (v, i) => (arr.excluded[i] ? NaN : sg * v)); return { r: pearson(mask, lv), n: lv.filter((v, i) => isNum(v) && isNum(mask[i])).length }; };
  const rBefore = r(shifted), rAfter = r(preview);

  const runAuto = () => {
    try {
      const sel = Array.from(original.keys()).filter((i) => ivOk(original[i]) && !arr.excluded[i]);
      const cd = Float64Array.from(sel, (i) => shifted[i]);
      const pos = autoCorrelate(d, lc, cd, Float64Array.from(sel, (i) => vals[i]), win, stepS);
      const neg = autoCorrelate(d, lc, cd, Float64Array.from(sel, (i) => -vals[i]), win, stepS);
      const useNeg = neg.r > pos.r; const res = useNeg ? neg : pos;
      if (useNeg !== invert) setInvert(useNeg);
      setCorr(res); setType('shift'); setAmount(res.bestShift); setConf(res.confidence);
      setMsgs([...(useNeg ? [{ level: 'INFO', text: `Inverse relationship detected (e.g. density ↔ porosity): correlation maximised on −${coreColName}.` }] : []), { level: 'INFO', text: `Best bulk shift ${res.bestShift >= 0 ? '+' : ''}${res.bestShift.toFixed(3)} m (r = ${res.r.toFixed(3)}, N = ${res.n}, confidence ${res.confidence}). Preview below — Accept to store the operation.` }, ...res.warnings.map((t) => ({ level: 'WARNING', text: t }))]);
    } catch (e: any) { setCorr(null); setMsgs([{ level: 'CRITICAL', text: e.message }]); }
  };
  const accept = () => {
    if (!op) { setMsgs([{ level: 'WARNING', text: 'Define the transformation first (tie points required for poly / tie methods).' }]); return; }
    S().updateCore(core.id, (c) => ({ ...c, depthOps: [...c.depthOps, op] }));
    registry.touchCore(core.id); S().bump();
    S().log(`Applied core-log depth op to "${core.name}": ${describeOp(op)} (confidence ${op.confidence}${op.marker ? `, marker ${op.marker}` : ''})`);
    setMsgs([{ level: 'OK', text: `Accepted: ${describeOp(op)}. Stored as reversible operation #${core.depthOps.length + 1}.` }]); setPairs([]); setCorr(null); setAmount(0);
  };
  const reject = () => { setPairs([]); setCorr(null); setAmount(0); setLa(1); setLb(0); setMsgs([{ level: 'INFO', text: 'Preview discarded.' }]); };
  const toggleOp = (id: string) => { S().updateCore(core.id, (c) => ({ ...c, depthOps: c.depthOps.map((o) => (o.id === id ? { ...o, active: !o.active } : o)) })); S().log(`Depth op ${id} toggled`); S().bump(); };
  const delOp = (id: string) => { S().updateCore(core.id, (c) => ({ ...c, depthOps: c.depthOps.filter((o) => o.id !== id) })); S().log(`Depth op ${id} removed (reverted)`); S().bump(); };

  // plot ranges
  const lo = Math.min(...Array.from(original)) - win - 3, hi = Math.max(...Array.from(original)) + win + 3;
  const i0 = d.findIndex((x) => x >= lo), i1 = d.findIndex((x) => x > hi);
  const ld = Array.from(d.subarray(Math.max(0, i0), i1 < 0 ? d.length : i1)); const lv = Array.from(lc.subarray(Math.max(0, i0), i1 < 0 ? d.length : i1));
  // conventional log-track display in real units: each curve on its own scale; core shares the log scale when units are comparable
  const coreAct = Array.from(vals, (v, i) => (arr.excluded[i] ? NaN : v));
  const rng = (a: number[]) => { const v = a.filter(isNum).sort((x, y) => x - y); return v.length ? [v[Math.floor(v.length * 0.02)], v[Math.max(0, Math.ceil(v.length * 0.98) - 1)]] : [0, 1]; };
  const [l0, l1] = rng(lv), [c0, c1] = rng(coreAct);
  const lcMeta = well.curves.find((c) => c.mnemonic === logCurve); const famPor = /Porosity|Neutron|NMR/.test(lcMeta?.category ?? '');
  const shared = !invert && Math.max(l1, c1) - Math.min(l0, c0) < 3 * Math.max(l1 - l0, c1 - c0, 1e-9);
  const padR = (a: number, b: number) => { const p0 = (b - a) * 0.1 || 0.05; return [a - p0, b + p0] as [number, number]; };
  const [sl0, sl1] = shared ? padR(Math.min(l0, c0), Math.max(l1, c1)) : padR(l0, l1); const [sc0, sc1] = shared ? [sl0, sl1] : padR(c0, c1);
  const rev = famPor; // porosity-type logs are conventionally drawn increasing to the left
  const logS = { depth: ld, values: lv, label: logCurve, unit: lcMeta?.unit ?? '', color: '#1c3ef0', min: sl0, max: sl1, reverse: rev };
  const coreS = (depths: ArrayLike<number>, label: string, color: string, extra: any = {}) => ({ depth: depths, values: coreAct, label, unit: shared ? '' : 'own scale', color, kind: 'dots' as const, min: sc0, max: sc1, reverse: invert ? !rev : rev, size: 3.2, ...extra });
  const grM = findByFamily(well.curves.map((c) => c.mnemonic), 'GR', S().aliases); const grV = grM ? registry.curve(well.id, grM) : undefined;
  const dTracks: DepthTrack[] = [
    ...(grV && grM !== logCurve ? [{ width: 110, series: [{ depth: d, values: grV, label: grM!, unit: 'gAPI', color: '#000000', min: 0, max: 150 }] }] : []),
    { title: 'Before', width: 200, series: [logS, coreS(shifted, `core ${invert ? '−' : ''}${coreColName} (current)`, '#e8590c')] },
    { title: 'After', width: 200, series: [logS, coreS(shifted, 'before', '#adb5bd', { size: 2.4 }), coreS(preview, `core ${coreColName} (preview)`, '#2b8a3e')] },
  ];
  const onDepthPick = (depth: number, ti: number) => {
    const t = dTracks[ti]; if (!t || !t.title) return;
    if (pick === null) { let bi = -1, bd = Infinity; shifted.forEach((x, i) => { if (arr.excluded[i]) return; const e = Math.abs(x - depth); if (e < bd) { bd = e; bi = i; } }); if (bi < 0 || bd > (hi - lo) / 40) return; setPick(original[bi]); setMsgs([{ level: 'INFO', text: `Tie point: core sample at original ${original[bi].toFixed(2)} m (current ${shifted[bi].toFixed(2)}) selected — now click the matching feature depth on the log curve.` }]); }
    else { setPairs([...pairs, [pick, +depth.toFixed(3)]]); setPick(null); if (type === 'shift') setType('tie'); setMsgs([{ level: 'OK', text: `Tie point added: ${pick.toFixed(2)} → ${depth.toFixed(2)} m` }]); }
  };
  const noOverlap = rBefore.n === 0;
  const fitFromPairs = () => {
    if (!pairs.length) return;
    const cur = pairs.map(([o, t]) => [applyOps(core.depthOps, o), t] as [number, number]);
    if (type === 'shift') setAmount(cur.reduce((s, [a, b]) => s + (b - a), 0) / cur.length);
    if (type === 'linear') { const f = fitLinear(cur); if (f) { setLa(f.a); setLb(f.b); } else setMsgs([{ level: 'WARNING', text: 'Linear stretch/squeeze needs ≥ 2 tie points.' }]); }
  };

  return (
    <div className="split w380" style={{ height: '100%' }}>
      <div className="col" style={{ overflow: 'auto' }}>
        <Box title="1–2 · Select curves">
          <Field label="Core dataset"><CoreSelector /></Field>
          <Field label="Log curve"><CurvePicker wellId={well.id} value={logCurve} onChange={setLogCurve} /></Field>
          <Field label="Core column"><select value={coreColName} onChange={(e) => setCoreColName(e.target.value)}>{numCols.map((c) => <option key={c}>{c}</option>)}</select></Field>
          <div className="hint">Typical pairs: core φ ↔ PHIT/NPHI, grain density ↔ RHOB, core GR ↔ GR. Units must be comparable (use derived PHI fraction after RQI/FZI).</div>
        </Box>
        <Box title="4–5 · Pick features / calculate shift">
          <div className="row"><span className="hint">Search ±</span><Num value={win} onChange={setWin} style={{ width: 50 }} /><span className="hint">m step</span><Num value={stepS} onChange={setStepS} style={{ width: 50 }} /><button className="btn pri" onClick={runAuto}>Auto-correlate</button></div>
          <label className="cb" style={{ marginTop: 3 }}><input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />inverse relationship (correlate −core; auto-detected)</label>
          <Field label="Transformation"><Sel value={type} onChange={setType} options={[{ v: 'shift', l: 'Bulk shift' }, { v: 'linear', l: 'Stretch / squeeze (linear)' }, { v: 'poly', l: 'Polynomial (from tie points)' }, { v: 'tie', l: 'Manual tie points (piecewise)' }]} /></Field>
          {type === 'shift' && <Field label="Shift (m, +down)"><Num value={amount} onChange={setAmount} /></Field>}
          {type === 'linear' && <><Field label="a (scale)"><Num value={la} onChange={setLa} /></Field><Field label="b (offset m)"><Num value={lb} onChange={setLb} /></Field></>}
          {type === 'poly' && <Field label="Degree"><Sel value={String(deg) as any} onChange={(v: string) => setDeg(+v)} options={['1', '2', '3']} /></Field>}
          <div className="hint">Tie points: click a <b>core point</b> in the Before track, then the matching <b>log feature</b>. {pick !== null && <b style={{ color: '#f5a623' }}>Waiting for log pick…</b>}</div>
          {pairs.length > 0 && <div className="tbl-wrap" style={{ maxHeight: 110 }}><table className="t"><thead><tr><th>Core (orig)</th><th>Log</th><th>Δ</th><th /></tr></thead><tbody>{pairs.map(([a, b], i) => <tr key={i}><td className="num">{a.toFixed(2)}</td><td className="num">{b.toFixed(2)}</td><td className="num">{(b - applyOps(core.depthOps, a)).toFixed(2)}</td><td><button className="btn sm" onClick={() => setPairs(pairs.filter((_, k) => k !== i))}>✕</button></td></tr>)}</tbody></table></div>}
          {pairs.length > 0 && (type === 'shift' || type === 'linear') && <button className="btn sm" onClick={fitFromPairs}>Fit {type} from tie points</button>}
          <label className="cb" style={{ marginTop: 4 }}><input type="checkbox" checked={useIv} onChange={(e) => { setUseIv(e.target.checked); if (!ivTop && !ivBase) { setIvTop(Math.floor(original[0])); setIvBase(Math.ceil(original[original.length - 1])); } }} />Interval-specific (original core depth)</label>
          {useIv && <div className="row"><Num value={ivTop} onChange={setIvTop} /><span>–</span><Num value={ivBase} onChange={setIvBase} /><span className="hint">m</span></div>}
          <Field label="Confidence"><Sel value={conf} onChange={setConf} options={['High', 'Medium', 'Low']} /></Field>
          <Field label="Reference marker"><input value={marker} onChange={(e) => setMarker(e.target.value)} placeholder="e.g. top Vulcan / GR spike" /></Field>
        </Box>
        <Box title="6–8 · Preview & accept">
          <div className="kv"><span>Before match</span><span>r = {fmt(rBefore.r, 3)} (N={rBefore.n})</span><span>After (preview)</span><span style={{ color: rAfter.r > rBefore.r ? 'var(--ok)' : 'var(--warn)' }}>r = {fmt(rAfter.r, 3)} (N={rAfter.n})</span><span>Operation</span><span>{op ? describeOp(op) : '—'}</span></div>
          <div className="row" style={{ marginTop: 6 }}><button className="btn pri" disabled={!op} onClick={accept}>Accept</button><button className="btn" onClick={reject}>Reject</button></div>
        </Box>
        <Msgs items={msgs} />
      </div>
      <div className="col" style={{ minHeight: 0 }}>
        {noOverlap && <Msgs items={[{ level: 'WARNING', text: `${logCurve} has no valid samples at the core depths (${lv.filter(isNum).length} valid samples in the cored window ${lo.toFixed(1)}–${hi.toFixed(1)} m). Choose another curve (e.g. TNPH instead of NPHI) — correlation r cannot be computed.` }]} />}
        <div style={{ height: 620 }}><DepthPlot title={`Core–log match — ${logCurve} vs core ${invert ? '−' : ''}${coreColName}${shared ? ' (common scale)' : ' (separate scales)'} · click a core point, then the log feature, to add a tie point`} wellId={well.id} tracks={dTracks} range={[lo, hi]} onPick={onDepthPick} /></div>
        {corr && <div className="box" style={{ height: 170, marginTop: 8 }}><XYPlot title="Correlation profile r(shift)" xLabel="shift (m)" yLabel="Pearson r" series={[{ kind: 'line', x: corr.profile.map((p) => p.shift), y: corr.profile.map((p) => p.r), color: '#e8c547' }]} refLines={[{ x1: corr.bestShift, y1: -1, x2: corr.bestShift, y2: 1, color: '#3ecf8e', dash: true, label: `best ${corr.bestShift.toFixed(2)}` }]} yRange={[Math.min(...corr.profile.map((p) => p.r).filter(isNum)) - 0.05, 1]} /></div>}
        <Box title="Core depth table" style={{ marginTop: 8 }}>
          <div className="tbl-wrap" style={{ maxHeight: 220 }}><table className="t"><thead><tr><th>#</th><th>Original Core Depth</th><th>Shifted Core Depth</th><th>Shift Amount</th><th>Confidence</th><th>Reference Marker</th></tr></thead>
            <tbody>{Array.from(original, (o, i) => { const lastOp = [...core.depthOps].reverse().find((x) => x.active && (!x.interval || (o >= x.interval[0] && o <= x.interval[1]))); return <tr key={i} style={{ opacity: arr.excluded[i] ? 0.4 : 1 }}><td className="dim">{i + 1}</td><td className="num">{o.toFixed(3)}</td><td className="num">{shifted[i].toFixed(3)}</td><td className="num">{(shifted[i] - o >= 0 ? '+' : '') + (shifted[i] - o).toFixed(3)}</td><td>{lastOp?.confidence ?? '—'}</td><td>{lastOp?.marker ?? '—'}</td></tr>; })}</tbody></table></div>
        </Box>
      </div>
      <RightPanel>
        <Box title={`Depth operations — ${core.name}`}>
          {core.depthOps.length ? core.depthOps.map((o, i) => <div key={o.id} style={{ borderBottom: '1px solid var(--bd)', padding: '3px 0', opacity: o.active ? 1 : 0.5 }}>
            <div className="row"><b>#{i + 1}</b><span className="mono" style={{ fontSize: 10.5 }}>{describeOp(o)}</span></div>
            <div className="hint">{o.method} · confidence {o.confidence ?? '—'}{o.marker ? ` · ${o.marker}` : ''} · {o.createdAt.slice(0, 16).replace('T', ' ')}</div>
            <div className="row"><button className="btn sm" onClick={() => toggleOp(o.id)}>{o.active ? 'Disable' : 'Enable'}</button><button className="btn sm danger" onClick={() => delOp(o.id)}>Revert</button>
              <span className="hint">inverse check: {fmt(invertOps([o], applyOps([o], original[0] ?? 0)), 6)} ≈ {fmt(original[0], 6)}</span></div>
          </div>) : <span className="hint">No operations. Original depths are always preserved; shifted depth = original + ops.</span>}
        </Box>
      </RightPanel>
    </div>
  );
}

function DepthRefs() {
  const well = useStore((s) => s.wells.find((w) => w.id === (s.activeWellId ?? s.wells[0]?.id)));
  const [kb, setKb] = useState(0); const [txt, setTxt] = useState('MD\tINC\tAZI\n'); const [msgs, setMsgs] = useState<{ level: any; text: string }[]>([]);
  if (!well) return <Empty>No well.</Empty>;
  const survey = txt.trim().split(/\r?\n/).slice(1).map((l) => l.trim().split(/[\t,;\s]+/).map(Number)).filter((r) => r.length >= 3 && r.every(isNum)).sort((a, b) => a[0] - b[0]);
  const compute = () => {
    const d = registry.depth(well.id)!; const tvd = new Float32Array(d.length);
    let method = 'vertical well assumption (TVD = MD)';
    if (survey.length >= 2) {
      method = `minimum curvature from ${survey.length} survey stations`;
      const st = [{ md: survey[0][0], tvd: survey[0][0] }]; // assume vertical above first station
      for (let i = 1; i < survey.length; i++) {
        const [m1, i1, a1] = survey[i - 1], [m2, i2, a2] = survey[i]; const r = Math.PI / 180;
        const dl = Math.acos(Math.min(1, Math.cos((i2 - i1) * r) - Math.sin(i1 * r) * Math.sin(i2 * r) * (1 - Math.cos((a2 - a1) * r))));
        const rf = dl > 1e-9 ? (2 / dl) * Math.tan(dl / 2) : 1;
        st.push({ md: m2, tvd: st[i - 1].tvd + ((m2 - m1) / 2) * (Math.cos(i1 * r) + Math.cos(i2 * r)) * rf });
      }
      for (let i = 0; i < d.length; i++) { const m = d[i]; if (m <= st[0].md) tvd[i] = m - st[0].md + st[0].tvd; else if (m >= st[st.length - 1].md) { const L = st[st.length - 1], P = st[st.length - 2]; tvd[i] = L.tvd + ((m - L.md) * (L.tvd - P.tvd)) / (L.md - P.md); } else { let k = 1; while (st[k].md < m) k++; const A = st[k - 1], B = st[k]; tvd[i] = A.tvd + ((m - A.md) * (B.tvd - A.tvd)) / (B.md - A.md); } }
    } else for (let i = 0; i < d.length; i++) tvd[i] = d[i];
    const tvdss = Float32Array.from(tvd, (v) => v - kb);
    const calc = (f: string) => ({ kind: 'formula' as const, formula: f, inputs: ['MD'], units: well.depthUnit, version: 1, missing: 'n/a', createdAt: nowIso(), notes: method });
    putCalculatedCurve(well.id, 'TVD', tvd, well.depthUnit, 'True vertical depth', calc(`TVD(MD) by ${method}`));
    putCalculatedCurve(well.id, 'TVDSS', tvdss, well.depthUnit, 'TVD sub-sea', calc(`TVD − ${kb} (reference elevation)`));
    S().log(`Computed TVD/TVDSS for ${well.name} (${method}; elevation ${kb} ${well.depthUnit})`);
    setMsgs([{ level: 'OK', text: `TVD and TVDSS curves created (${method}).` }, ...(survey.length < 2 ? [{ level: 'WARNING', text: 'No deviation survey supplied — TVD assumes a vertical well.' }] : [])]);
  };
  return <div className="grid2" style={{ maxWidth: 1100 }}>
    <Box title="Depth references">
      <table className="t"><tbody>
        <tr><td>Measured Depth (MD)</td><td>Well reference index ({well.depthUnit}), {fmt(well.start, 6)}–{fmt(well.stop, 6)}</td></tr>
        <tr><td>Log Depth</td><td>= MD of the wireline index (logs are the depth reference)</td></tr>
        <tr><td>Core Depth</td><td>Driller's/core depth as recorded; matched to log depth via reversible ops</td></tr>
        <tr><td>Reference Depth</td><td>Log depth after core-log matching (core "shifted" depth)</td></tr>
        <tr><td>TVD / TVDSS</td><td>{well.curves.some((c) => c.mnemonic === 'TVD') ? 'available as curves' : 'compute below'}</td></tr>
      </tbody></table>
    </Box>
    <Box title="Compute TVD / TVDSS">
      <Field label={`Reference elevation (${well.depthUnit})`}><Num value={kb} onChange={setKb} /></Field>
      <div className="hint">Deviation survey (paste MD, INC°, AZI° — e.g. from Gorgonichthys_1_Surveys). Leave empty for a vertical well.</div>
      <textarea rows={8} style={{ width: '100%' }} value={txt} onChange={(e) => setTxt(e.target.value)} />
      <div className="row"><span className="hint">{survey.length} stations</span><button className="btn pri" onClick={compute}>Compute</button></div>
      <Msgs items={msgs} />
    </Box>
  </div>;
}
