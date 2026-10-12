import { RESERVOIR_KEY, scopeIntervals } from '../data-engine/zones';
import { useState } from 'react';
import { S, useStore, type TrackDef } from '../store/store';
import { registry } from '../data-engine/registry';
import { putCalculatedCurve } from '../data-engine/ingest';
import { call } from '../workers/rpc';
import { featBase, featIsLog } from '../regression/prepare';
import { classifyFzi, kFromFzi } from '../hfu/engine';
import { resolveMnem, LogViewer } from '../visualization/LogViewer';
import { Box, CurvePicker, Empty, Field, ModHead, Msgs, Num, Sel } from './common';
import { RightPanel } from './RightPanel';
import { ALGO_LABEL, modelStatsRow } from './Regression';
import { findByFamily } from '../curves/catalog';
import { fmt, isNum, nowIso } from '../util/num';
import type { RegressionModel } from '../types';

export const PRED_LAYOUT: TrackDef[] = [
  { id: 'p_d', kind: 'depth', width: 52, curves: [] },
  { id: 'p_gr', title: 'GR', kind: 'curve', width: 110, grid: true, curves: [{ mnem: 'GR', color: '#3ecf8e', width: 1, scale: 'lin', min: 0, max: 150, fill: 'left', fillColor: 'rgba(62,207,142,0.15)' }] },
  { id: 'p_fzi', title: 'FZI', kind: 'curve', width: 170, grid: true, curves: [{ mnem: 'FZI_LOG', color: '#f07db5', width: 1, scale: 'log', min: 0.01, max: 100, dash: true }, { mnem: 'FZI_PRED', color: '#e8c547', width: 1.4, scale: 'log', min: 0.01, max: 100 }, { mnem: 'FZI', color: '#ffffff', width: 1, scale: 'log', min: 0.01, max: 100, core: { column: 'FZI' } }] },
  { id: 'p_hc', title: 'HFU', kind: 'hfu', width: 56, curves: [], hfu: { source: 'curve', curve: 'HFU_PRED' } },
  { id: 'p_k', title: 'K', kind: 'curve', width: 170, grid: true, curves: [{ mnem: 'K_PRED', color: '#ff8c42', width: 1.4, scale: 'log', min: 0.001, max: 10000 }, { mnem: 'K', color: '#ffffff', width: 1, scale: 'log', min: 0.001, max: 10000, core: { column: 'K' } }] },
  { id: 'p_phi', title: 'PHI', kind: 'curve', width: 130, grid: true, curves: [{ mnem: 'PHIE', color: '#39c5cf', width: 1.2, scale: 'lin', min: 0.3, max: 0 }, { mnem: 'PHI', color: '#ffffff', width: 1, scale: 'lin', min: 0.3, max: 0, core: { column: 'PHI' } }] },
];

export function auditText(m: RegressionModel) {
  const s = modelStatsRow(m); const v = [...S().validations].reverse().find((x) => x.modelId === m.id);
  return `Model: ${m.name} | Algorithm: ${ALGO_LABEL[m.algorithm]}${m.groupBy === 'hfu' ? ' (per HFU/cluster)' : ''} | Inputs: ${m.features.join(', ')} | Target: ${m.targetTransform === 'log10' ? `log10(${m.target})` : m.target} | Training: ${m.wellIds.join(', ')}${m.interval ? ` ${m.interval[0]}–${m.interval[1]} m` : ''} (${m.domain} samples, N=${s.n}) | R² ${fmt(s.r2, 3)} RMSE ${fmt(s.rmse, 3)}${v ? ` | Validation (${v.method}) R² ${fmt(v.metrics.r2, 3)} RMSE ${fmt(v.metrics.rmse, 3)}` : ' | not validated'} | Created ${m.createdAt.slice(0, 16).replace('T', ' ')}`;
}

export function Prediction() {
  const models = useStore((s) => s.models); const wells = useStore((s) => s.wells); const sets = useStore((s) => s.hfuSets); const tops = useStore((s) => s.tops); const C = useStore((s) => s.hfuConfig.rqiConst); const interval = useStore((s) => s.interval);
  const [mid, setMid] = useState(models[models.length - 1]?.id ?? ''); const m = models.find((x) => x.id === mid);
  const [wid, setWid] = useState(useStore.getState().activeWellId ?? wells[0]?.id ?? ''); const well = wells.find((w) => w.id === wid);
  const [scope, setScope] = useState<'reservoir' | 'well' | 'interval' | 'formation' | 'cluster'>(() => (S().reservoirs.some((r) => r.active) ? 'reservoir' : 'well'));
  const [top, setTop] = useState(0); const [base, setBase] = useState(0); const [fm, setFm] = useState(''); const [clCurve, setClCurve] = useState(''); const [clVal, setClVal] = useState(1);
  const [groupCurve, setGroupCurve] = useState('');
  const [phiC, setPhiC] = useState(() => (well ? ['PHIE', 'PHIT', 'CMRP', 'TCMR'].map((f) => findByFamily(well.curves.map((c) => c.mnemonic), f)).find(Boolean) ?? '' : ''));
  const [hsId, setHsId] = useState(sets.find((h) => h.boundaries?.length)?.id ?? ''); const [merge, setMerge] = useState(true);
  const [busy, setBusy] = useState(false); const [msgs, setMsgs] = useState<{ level: any; text: string }[]>([]);
  if (!models.length) return <><ModHead title="Predicted FZI / HFU" /><Empty>Fit (and ideally validate) a model first.</Empty></>;
  if (!well) return <><ModHead title="Predicted FZI / HFU" /><Empty>No well.</Empty></>;
  const wellTops = tops.filter((t) => t.wellId === well.id).sort((a, b) => a.md - b.md);
  const discrete = well.curves.filter((c) => c.discrete || c.category === 'HFU').map((c) => c.mnemonic);
  const hs = sets.find((h) => h.id === hsId);
  const run = async () => {
    if (!m) return; setBusy(true); const out: typeof msgs = [];
    try {
      const d = registry.depth(well.id)!; const n = d.length;
      const scopeMask = new Uint8Array(n);
      let scopeLabel = 'entire well';
      if (scope === 'reservoir') { const iv = scopeIntervals(well.id, RESERVOIR_KEY); if (!iv) throw new Error('No reservoir interval defined for this well (Data → Reservoir Intervals).'); for (let i = 0; i < n; i++) scopeMask[i] = iv.some(([t, b]) => d[i] >= t && d[i] < b) ? 1 : 0; scopeLabel = `reservoir intervals (${iv.map(([t, b]) => `${t}–${b}`).join(', ')})`; }
      else if (scope === 'well') scopeMask.fill(1);
      else if (scope === 'interval') { for (let i = 0; i < n; i++) scopeMask[i] = d[i] >= top && d[i] <= base ? 1 : 0; scopeLabel = `interval ${top}–${base}`; }
      else if (scope === 'formation') { const i0 = wellTops.findIndex((t) => t.id === fm); if (i0 < 0) throw new Error('Select a formation.'); const t0 = wellTops[i0].md, t1 = wellTops[i0 + 1]?.md ?? Infinity; for (let i = 0; i < n; i++) scopeMask[i] = d[i] >= t0 && d[i] < t1 ? 1 : 0; scopeLabel = `formation ${wellTops[i0].name}`; }
      else { const c = registry.curve(well.id, clCurve); if (!c) throw new Error('Select a cluster/HFU curve.'); for (let i = 0; i < n; i++) scopeMask[i] = c[i] === clVal ? 1 : 0; scopeLabel = `${clCurve} = ${clVal}`; }
      const p = m.features.length; const X = new Float64Array(n * p).fill(NaN);
      const cols = m.features.map((f) => { const mm = resolveMnem(well, featBase(f)); const c = mm ? registry.curve(well.id, mm) : undefined; if (!c) throw new Error(`Predictor ${featBase(f)} not available in ${well.name}.`); return c; });
      for (let i = 0; i < n; i++) if (scopeMask[i]) for (let j = 0; j < p; j++) { const v = cols[j][i]; X[i * p + j] = featIsLog(m.features[j]) ? (v > 0 ? Math.log10(v) : NaN) : v; }
      let group: Int32Array | null = null;
      if (m.groupBy === 'hfu') { const g = registry.curve(well.id, groupCurve); if (!g) throw new Error('Per-HFU model: select the discrete curve that assigns each depth to an HFU/cluster (e.g. HFU_PRED from a global model, or a classifier output).'); group = Int32Array.from(g, (v) => (isNum(v) ? v : 0)); }
      const r = await call<{ out: Float32Array; spread: Float32Array }>('analysis', 'predictGrid', [m.subModels, X, n, p, group], { transfer: [X.buffer] });
      // re-fill X for extrapolation test (X was transferred)
      const extrap = new Float32Array(n).fill(NaN); let nEx = 0, nPred = 0;
      const byG = new Map(m.subModels.map((s) => [s.groupId, s]));
      for (let i = 0; i < n; i++) {
        if (!isNum(r.out[i])) continue; nPred++;
        const s = group ? byG.get(group[i]) : m.subModels[0]; if (!s) continue;
        let ex = 0; for (let j = 0; j < p; j++) { const raw = cols[j][i]; const v = featIsLog(m.features[j]) ? Math.log10(raw) : raw; const [lo, hi] = s.featureRanges[j]; if (v < lo || v > hi) { ex = 1; break; } }
        extrap[i] = ex; nEx += ex;
      }
      const audit = auditText(m);
      const base0 = (name: string) => (merge ? registry.curve(well.id, name) : undefined);
      const mergeInto = (name: string, vals: Float32Array) => { const prev = base0(name); if (!prev) return vals; const o = Float32Array.from(prev); for (let i = 0; i < n; i++) if (scopeMask[i]) o[i] = vals[i]; return o; };
      const calc = (formula: string, units: string, inputs: string[]) => ({ kind: 'prediction' as const, formula, inputs, units, version: 1, missing: 'NaN where any predictor missing or outside scope', createdAt: nowIso(), model: m.id, notes: `${audit} | Applied to ${well.name}, ${scopeLabel}` });
      const phi = phiC ? registry.curve(well.id, phiC) : undefined;
      let fzi: Float32Array | null = null, k: Float32Array | null = null;
      const tv = Float32Array.from(r.out, (v) => (m.targetTransform === 'log10' ? Math.pow(10, v) : v));
      if (m.target === 'FZI') fzi = tv;
      else if (m.target === 'K') { k = tv; if (phi) fzi = Float32Array.from(k, (kk, i) => { const ph = phi[i]; if (!(kk > 0 && ph > 0 && ph < 1)) return NaN; return (C * Math.sqrt(kk / ph)) / (ph / (1 - ph)); }); }
      else if (m.target === 'RQI') { putCalculatedCurve(well.id, 'RQI_PRED', mergeInto('RQI_PRED', tv), 'µm', 'Predicted RQI', calc(`${m.name}(${m.features.join(', ')})`, 'µm', m.features)); if (phi) fzi = Float32Array.from(tv, (q, i) => { const ph = phi[i]; return ph > 0 && ph < 1 ? q / (ph / (1 - ph)) : NaN; }); }
      else if (m.target === 'HFU') { putCalculatedCurve(well.id, 'HFU_PRED', mergeInto('HFU_PRED', Float32Array.from(tv, (v) => (isNum(v) && v > 0 ? v : NaN))), '', 'Predicted HFU (classifier)', calc(`${m.name} classifier(${m.features.join(', ')})`, '', m.features), true); out.push({ level: 'OK', text: 'HFU_PRED written from classifier.' }); }
      else putCalculatedCurve(well.id, `${m.target}_PRED`, mergeInto(`${m.target}_PRED`, tv), '', `Predicted ${m.target}`, calc(`${m.name}(${m.features.join(', ')})`, '', m.features));
      if (fzi) {
        putCalculatedCurve(well.id, 'FZI_PRED', mergeInto('FZI_PRED', fzi), 'µm', 'Predicted FZI', calc(m.target === 'FZI' ? `${m.targetTransform === 'log10' ? '10^' : ''}${m.name}(${m.features.join(', ')})` : `FZI from predicted ${m.target} and ${phiC}`, 'µm', [...m.features, ...(m.target !== 'FZI' ? [phiC] : [])]));
        if (!k && phi) { k = Float32Array.from(fzi, (f, i) => kFromFzi(f, phi[i], C)); }
        else if (!phi) out.push({ level: 'WARNING', text: 'K_PRED not computed: select a porosity curve (K = φ·(FZI·Φz/C)²).' });
        if (hs?.boundaries?.length) {
          const cls = classifyFzi(fzi, hs.boundaries);
          putCalculatedCurve(well.id, 'HFU_PRED', mergeInto('HFU_PRED', Float32Array.from(cls, (c) => (c ? c : NaN))), '', `HFU from FZI_PRED (${hs.name})`, calc(`classify(FZI_PRED; thresholds ${hs.boundaries.map((b) => b.toPrecision(3)).join(', ')} µm from "${hs.name}")`, '', ['FZI_PRED']), true);
        } else out.push({ level: 'WARNING', text: 'HFU_PRED not generated: choose an HFU set that has FZI thresholds.' });
      }
      if (k) putCalculatedCurve(well.id, 'K_PRED', mergeInto('K_PRED', k), 'mD', 'Predicted permeability', calc(m.target === 'K' ? `${m.targetTransform === 'log10' ? '10^' : ''}${m.name}(${m.features.join(', ')})` : `${phiC}·(FZI_PRED·Φz/${C})²`, 'mD', m.target === 'K' ? m.features : ['FZI_PRED', phiC]));
      putCalculatedCurve(well.id, 'EXTRAP', mergeInto('EXTRAP', extrap), 'flag', 'Model extrapolation flag (1 = predictor outside training range)', calc(`any predictor outside the training [min, max] of ${m.name}`, 'flag', m.features), true);
      if (m.subModels[0].kind === 'forest') putCalculatedCurve(well.id, `${m.target}_PRED_SD`, mergeInto(`${m.target}_PRED_SD`, r.spread), '', 'Spread of tree predictions (model-space)', calc('std. dev. of random-forest tree predictions', '', m.features));
      S().log(`Applied ${m.name} to ${well.name} (${scopeLabel}): ${nPred} predicted samples, ${nEx} extrapolated (${nPred ? ((100 * nEx) / nPred).toFixed(1) : 0}%)`);
      out.unshift({ level: 'OK', text: `Predicted ${nPred.toLocaleString()} samples in ${scopeLabel}. Extrapolated: ${nEx.toLocaleString()} (${nPred ? ((100 * nEx) / nPred).toFixed(1) : 0}%) — shown as a red strip on predicted-curve tracks.` });
      if (nPred && nEx / nPred > 0.2) out.push({ level: 'WARNING', text: 'More than 20% of predictions extrapolate beyond the training range of at least one predictor.' });
      setMsgs(out);
    } catch (e: any) { setMsgs([{ level: 'CRITICAL', text: e.message }]); } finally { setBusy(false); }
  };
  return (
    <>
      <ModHead title="Predicted FZI / HFU Curves" sub="FZI_PRED · HFU_PRED · K_PRED alongside FZI_CORE / FZI_LOG / HFU_CORE — extrapolated depths flagged">{busy && <span className="tag warn">predicting…</span>}</ModHead>
      <div className="mod-b nopad" style={{ flexDirection: 'row' }}>
        <div style={{ width: 340, padding: 8, overflow: 'auto', borderRight: '1px solid var(--bd)' }}>
          <Box title="Model & target well">
            <Field label="Model"><select value={mid} onChange={(e) => setMid(e.target.value)}>{models.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            {m && <div className="hint mono" style={{ fontSize: 10 }}>{auditText(m)}</div>}
            <Field label="Apply to well"><select value={wid} onChange={(e) => { setWid(e.target.value); S().set({ activeWellId: e.target.value }); }}>{wells.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
            <Field label="Scope"><Sel value={scope} onChange={setScope} options={[{ v: 'reservoir', l: 'Reservoir intervals' }, { v: 'well', l: 'Entire well' }, { v: 'interval', l: 'Selected interval' }, { v: 'formation', l: 'Selected formation' }, { v: 'cluster', l: 'Selected cluster / HFU' }]} /></Field>
            {scope === 'interval' && <div className="row"><Num value={top} onChange={setTop} style={{ width: 70 }} /><Num value={base} onChange={setBase} style={{ width: 70 }} />{interval?.wellId === well.id && <button className="btn sm" onClick={() => { setTop(interval.top); setBase(interval.base); }}>use selection</button>}</div>}
            {scope === 'formation' && <select value={fm} onChange={(e) => setFm(e.target.value)}><option value="">— formation —</option>{wellTops.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.md})</option>)}</select>}
            {scope === 'cluster' && <div className="row"><select value={clCurve} onChange={(e) => setClCurve(e.target.value)}><option value="">— curve —</option>{discrete.map((c) => <option key={c}>{c}</option>)}</select><Num value={clVal} onChange={setClVal} style={{ width: 44 }} /></div>}
            {m?.groupBy === 'hfu' && <Field label="HFU assignment curve"><select value={groupCurve} onChange={(e) => setGroupCurve(e.target.value)}><option value="">— required —</option>{discrete.map((c) => <option key={c}>{c}</option>)}</select></Field>}
            <Field label="Porosity (for K / FZI)"><CurvePicker wellId={well.id} value={phiC} onChange={setPhiC} allowNone="—" /></Field>
            <Field label="HFU thresholds from"><select value={hsId} onChange={(e) => setHsId(e.target.value)}><option value="">— none —</option>{sets.filter((h) => h.boundaries?.length).map((h) => <option key={h.id} value={h.id}>{h.name} ({h.boundaries!.map((b) => b.toPrecision(2)).join('/')})</option>)}</select></Field>
            <label className="cb"><input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} />keep existing values outside scope</label>
            <button className="btn pri" style={{ marginTop: 6 }} disabled={busy || !m} onClick={run}>Generate predicted curves</button>
          </Box>
          <Msgs items={msgs} />
          <CompareAtCore wellId={well.id} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}><LogViewer wellId={well.id} tracks={PRED_LAYOUT} cursorFields={['GR', 'FZI_CORE', 'FZI_LOG', 'FZI_PRED', 'HFU_CORE', 'HFU_PRED', 'K_CORE', 'K_PRED', 'EXTRAP']} /></div>
      </div>
      <RightPanel><Box title="Legend"><div className="hint">FZI track: white dots = core FZI (FZI_CORE, shifted depth); pink dashed = FZI_LOG; yellow = FZI_PRED. HFU band = HFU_PRED; ▶ markers = HFU_CORE. Red strip = extrapolation (EXTRAP = 1).</div></Box></RightPanel>
    </>
  );
}

function CompareAtCore({ wellId }: { wellId: string }) {
  useStore((s) => s.dataVersion);
  const fc = registry.curve(wellId, 'FZI_CORE'), fp = registry.curve(wellId, 'FZI_PRED'), hc = registry.curve(wellId, 'HFU_CORE'), hp = registry.curve(wellId, 'HFU_PRED');
  if (!fc || !fp) return null;
  let n = 0, se = 0, agree = 0, nh = 0; for (let i = 0; i < fc.length; i++) { if (isNum(fc[i]) && isNum(fp[i]) && fc[i] > 0 && fp[i] > 0) { n++; se += (Math.log10(fc[i]) - Math.log10(fp[i])) ** 2; } if (hc && hp && isNum(hc[i]) && isNum(hp[i])) { nh++; if (hc[i] === hp[i]) agree++; } }
  return <Box title="Predicted vs core (at core depths)"><div className="kv"><span>N (FZI)</span><span>{n}</span><span>RMSE log10 FZI</span><span>{fmt(Math.sqrt(se / (n || 1)), 3)}</span>{nh > 0 && <><span>HFU agreement</span><span>{((100 * agree) / nh).toFixed(1)}% of {nh}</span></>}</div><div className="hint">Includes training samples — use Validation for unbiased error.</div></Box>;
}
