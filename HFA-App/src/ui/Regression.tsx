import { DepthPlot } from '../visualization/DepthPlot';
import { RESERVOIR_KEY } from '../data-engine/zones';
import { useMemo, useState } from 'react';
import { S, useStore } from '../store/store';
import { call } from '../workers/rpc';
import { buildDataset, cloneDs, dsTransfer, featBase, featIsLog, leakageWarnings, targetLabel, type DatasetSpec } from '../regression/prepare';
import type { SelectionResult } from '../regression/engine';
import type { Algo, RegressionModel, SubModel } from '../types';
import { Box, Empty, Field, ModHead, Msgs, Num, Sel, Tabs } from './common';
import { RightPanel } from './RightPanel';
import { XYPlot } from '../visualization/XYPlot';
import { fmt, hfuColor, isNum, nowIso, pearson, uid } from '../util/num';
import { predictLocal } from './predictLocal';

export const ALGO_LABEL: Record<Algo, string> = { MLR: 'Multiple Linear Regression', LogLinear: 'Log-Linear Regression', Poly2: 'Polynomial Regression (2nd order)', Ridge: 'Ridge', Lasso: 'Lasso', ElasticNet: 'Elastic Net', RandomForest: 'Random Forest', GBT: 'Gradient-Boosted Trees (XGBoost-style, built-in)', RFClassifier: 'Random-Forest classifier (HFU class)' };
const SEL_METHODS = [{ v: 'manual', l: 'Manual / all features' }, { v: 'correlation', l: 'Correlation filtering' }, { v: 'vif', l: 'VIF' }, { v: 'forward', l: 'Forward selection (AIC)' }, { v: 'backward', l: 'Backward elimination (p)' }, { v: 'rfe', l: 'Recursive Feature Elimination' }, { v: 'lasso', l: 'LASSO' }, { v: 'mi', l: 'Mutual information' }, { v: 'rf', l: 'Random-forest importance' }, { v: 'permutation', l: 'Permutation importance' }];
const LOGGY = /^(AT\d0|RT|RXO.*|ILD|LLD|RD|RS|RM|KTIM|KSDR|T2LM|K|PERM.*)$/i;
export const TARGETS = [{ v: 'FZI|log', l: 'log(FZI)' }, { v: 'FZI|', l: 'FZI' }, { v: 'RQI|', l: 'RQI' }, { v: 'K|log', l: 'log(K)' }, { v: 'K|', l: 'Permeability K' }, { v: 'HFU|', l: 'HFU class' }];

export function useDatasetSpec() {
  const cores = useStore((s) => s.cores); const wells = useStore((s) => s.wells);
  const [spec, setSpec] = useState<DatasetSpec>(() => ({ domain: cores.length ? 'core' : 'log', coreIds: cores.slice(0, 1).map((c) => c.id), wellIds: wells.slice(0, 1).map((w) => w.id), target: 'FZI', targetLog: true, features: [], interval: null, hfuSetId: undefined, groups: [], zone: useStore.getState().zone || undefined }));
  return [spec, setSpec] as const;
}

export function DatasetEditor({ spec, setSpec, hideTarget }: { spec: DatasetSpec; setSpec: (s: DatasetSpec) => void; hideTarget?: boolean }) {
  const cores = useStore((s) => s.cores); const wells = useStore((s) => s.wells); const sets = useStore((s) => s.hfuSets);
  const up = (p: Partial<DatasetSpec>) => setSpec({ ...spec, ...p });
  const logNames = useMemo(() => [...new Set(wells.filter((w) => spec.domain === 'log' ? spec.wellIds.includes(w.id) : cores.some((c) => spec.coreIds.includes(c.id) && c.wellId === w.id)).flatMap((w) => w.curves.map((c) => c.mnemonic)))].sort(), [wells, spec.domain, spec.wellIds, spec.coreIds, cores]);
  const setsFor = sets.filter((h) => (spec.domain === 'core' ? h.domain === 'core' && spec.coreIds.includes(h.coreId!) : h.domain === 'log' || true));
  return <>
    <Field label="Sample domain"><Sel value={spec.domain} onChange={(v) => up({ domain: v, target: v === 'core' ? 'FZI' : 'FZI_LOG' })} options={[{ v: 'core', l: 'Core samples (logs at shifted core depth)' }, { v: 'log', l: 'Log samples (well grid)' }]} /></Field>
    {spec.domain === 'core' ? <Field label="Core datasets (wells)"><select multiple style={{ height: 46 }} value={spec.coreIds} onChange={(e) => up({ coreIds: [...e.target.selectedOptions].map((o) => o.value) })}>{cores.map((c) => <option key={c.id} value={c.id}>{c.name} ({wells.find((w) => w.id === c.wellId)?.name})</option>)}</select></Field>
      : <Field label="Wells"><select multiple style={{ height: 46 }} value={spec.wellIds} onChange={(e) => up({ wellIds: [...e.target.selectedOptions].map((o) => o.value) })}>{wells.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>}
    {!hideTarget && (spec.domain === 'core'
      ? <Field label="Target"><Sel value={`${spec.target}|${spec.targetLog ? 'log' : ''}` as any} onChange={(v: string) => { const [t, l] = v.split('|'); up({ target: t, targetLog: l === 'log' }); }} options={TARGETS} /></Field>
      : <Field label="Target curve"><div className="row"><select value={spec.target} onChange={(e) => up({ target: e.target.value })}><option value="HFU">HFU class</option>{logNames.map((m) => <option key={m}>{m}</option>)}</select><label className="cb"><input type="checkbox" checked={spec.targetLog} onChange={(e) => up({ targetLog: e.target.checked })} />log10</label></div></Field>)}
    <Field label="Training interval"><div className="row"><input type="checkbox" checked={!!spec.interval} onChange={(e) => { const iv = S().interval; up({ interval: e.target.checked ? (iv ? [iv.top, iv.base] : [0, 10000]) : null }); }} />{spec.interval && <><Num value={spec.interval[0]} onChange={(v) => up({ interval: [v, spec.interval![1]] })} style={{ width: 66 }} /><Num value={spec.interval[1]} onChange={(v) => up({ interval: [spec.interval![0], v] })} style={{ width: 66 }} /></>}</div></Field>
    <Field label="Scope"><select value={spec.zone ?? ''} onChange={(e) => up({ zone: e.target.value || undefined })}><option value="">Whole well</option>{useStore.getState().reservoirs.length > 0 && <><option value={RESERVOIR_KEY}>★ Reservoir intervals</option>{useStore.getState().reservoirs.map((r) => <option key={r.id} value={'RES:' + r.id}>{r.name} ({r.top}–{r.base})</option>)}</>}{[...new Set(useStore.getState().tops.map((t) => t.name))].map((z) => <option key={z}>{z}</option>)}</select></Field>
    <Field label="HFU / cluster set"><select value={spec.hfuSetId ?? ''} onChange={(e) => up({ hfuSetId: e.target.value || undefined, groups: [] })}><option value="">— none —</option>{setsFor.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></Field>
    {spec.hfuSetId && <Field label="Restrict to units"><div className="row" style={{ gap: 3 }}>{sets.find((h) => h.id === spec.hfuSetId)?.units.map((u) => <label key={u.id} className="cb"><input type="checkbox" checked={!spec.groups?.length || spec.groups.includes(u.id)} onChange={(e) => { const all = sets.find((h) => h.id === spec.hfuSetId)!.units.map((q) => q.id); const cur = spec.groups?.length ? spec.groups : all; up({ groups: e.target.checked ? [...cur, u.id] : cur.filter((x) => x !== u.id) }); }} /><span className="pill" style={{ background: u.color }} />{u.id}</label>)}</div></Field>}
  </>;
}

export function FeatureTable({ spec, setSpec, corr }: { spec: DatasetSpec; setSpec: (s: DatasetSpec) => void; corr?: Record<string, number> }) {
  const cores = useStore((s) => s.cores); const wells = useStore((s) => s.wells);
  const names = useMemo(() => [...new Set(wells.filter((w) => spec.domain === 'log' ? spec.wellIds.includes(w.id) : cores.some((c) => spec.coreIds.includes(c.id) && c.wellId === w.id)).flatMap((w) => w.curves.filter((c) => !c.discrete && !['Depth', 'Flag'].includes(c.category)).map((c) => c.mnemonic)))].sort(), [wells, spec, cores]);
  const has = (m: string) => spec.features.find((f) => featBase(f) === m);
  const toggle = (m: string, on: boolean) => setSpec({ ...spec, features: on ? [...spec.features, LOGGY.test(m) ? `LOG10(${m})` : m] : spec.features.filter((f) => featBase(f) !== m) });
  const setLog = (m: string, on: boolean) => setSpec({ ...spec, features: spec.features.map((f) => (featBase(f) === m ? (on ? `LOG10(${m})` : m) : f)) });
  return <div className="tbl-wrap" style={{ maxHeight: 240 }}><table className="t"><thead><tr><th /><th>Predictor</th><th>log10</th><th>r with target</th></tr></thead><tbody>
    {names.map((m) => { const f = has(m); return <tr key={m} style={{ color: /_CORE$|_PRED$|^FZI|^RQI|^HFU|^CLUSTER/i.test(m) ? 'var(--warn)' : undefined }}><td><input type="checkbox" checked={!!f} onChange={(e) => toggle(m, e.target.checked)} /></td><td>{m}</td><td>{f && <input type="checkbox" checked={featIsLog(f)} onChange={(e) => setLog(m, e.target.checked)} />}</td><td className="num">{f && corr ? fmt(corr[f], 3) : ''}</td></tr>; })}
  </tbody></table></div>;
}

export function modelStatsRow(m: RegressionModel) {
  const s = m.subModels; const n = s.reduce((a, b) => a + b.n, 0);
  const w = (k: keyof SubModel['metrics']) => s.reduce((a, b) => a + ((b.metrics[k] as number) ?? NaN) * b.n, 0) / n;
  return { n, r2: w('r2'), adjR2: w('adjR2'), rmse: Math.sqrt(s.reduce((a, b) => a + b.metrics.rmse ** 2 * b.n, 0) / n), mae: w('mae'), aic: s.reduce((a, b) => a + (b.metrics.aic ?? NaN), 0), bic: s.reduce((a, b) => a + (b.metrics.bic ?? NaN), 0) };
}

export function Regression() {
  const models = useStore((s) => s.models); const vals = useStore((s) => s.validations);
  const [spec, setSpec] = useDatasetSpec();
  const [tab, setTab] = useState<'build' | 'compare'>('build');
  const [algo, setAlgo] = useState<Algo>('MLR'); const [groupBy, setGroupBy] = useState<'global' | 'hfu'>('global');
  const [minN, setMinN] = useState(30); const [lambda, setLambda] = useState<string>('cv'); const [alpha, setAlpha] = useState(0.5); const [nTrees, setNTrees] = useState(150);
  const [selMethod, setSelMethod] = useState('forward'); const [selThr, setSelThr] = useState(0.85); const [selN, setSelN] = useState(3);
  const [selRes, setSelRes] = useState<SelectionResult | null>(null);
  const [busy, setBusy] = useState(''); const [msgs, setMsgs] = useState<{ level: any; text: string }[]>([]);
  const [cur, setCur] = useState<string | null>(null);
  const built = useMemo(() => { if (!spec.features.length) return null; try { return buildDataset(spec); } catch (e: any) { return e.message as string; } }, [spec, useStore((s) => s.dataVersion)]);
  const corr = useMemo(() => { if (!built || typeof built === 'string') return undefined; const o: Record<string, number> = {}; spec.features.forEach((f, j) => (o[f] = pearson(Array.from({ length: built.ds.n }, (_, i) => built.ds.X[i * built.ds.p + j]), built.ds.y))); return o; }, [built]);
  const effAlgo: Algo = spec.target === 'HFU' ? 'RFClassifier' : algo;

  const runSel = async () => {
    if (!built || typeof built === 'string') return; setBusy('Feature selection…');
    try { const d = cloneDs(built.ds); const r = await call<SelectionResult>('analysis', 'selectFeatures', [d, selMethod, { threshold: selMethod === 'vif' ? selThr : selMethod === 'backward' ? 0.05 : selThr, nFeatures: selN, algorithm: effAlgo }], { transfer: dsTransfer(d) }); setSelRes(r); S().log(`Feature selection (${r.method}) on ${spec.features.length} candidates → ${r.selected.join(', ')}`); }
    catch (e: any) { setMsgs([{ level: 'CRITICAL', text: e.message }]); } finally { setBusy(''); }
  };
  const fit = async () => {
    if (!built || typeof built === 'string') return;
    const warn: { level: any; text: string }[] = [];
    if (groupBy === 'hfu' && !spec.hfuSetId) { setMsgs([{ level: 'CRITICAL', text: 'Regression by HFU/cluster requires an HFU or cluster set.' }]); return; }
    if (built.ds.n < minN && groupBy === 'global') { setMsgs([{ level: 'CRITICAL', text: `Regression requires at least ${minN} valid samples (have ${built.ds.n}). Lower the minimum only if you accept the uncertainty.` }]); return; }
    leakageWarnings(spec).forEach((t) => warn.push({ level: 'WARNING', text: t }));
    if (built.missingPct > 30) warn.push({ level: 'WARNING', text: `High missing data: ${built.missingPct.toFixed(0)}% of candidate samples dropped (missing target or predictor).` });
    setBusy('Fitting…');
    try {
      const d = cloneDs(built.ds);
      const r = await call<{ subs: SubModel[]; errors: string[] }>('analysis', 'fitModel', [d, { algorithm: effAlgo, params: { lambda: lambda === 'cv' ? 'cv' : +lambda, alpha, nTrees }, minN, targetLabel: targetLabel(spec) }, groupBy, built.groupLabels], { transfer: dsTransfer(d) });
      if (!r.subs.length) throw new Error(`No model could be fitted. ${r.errors.join(' ')}`);
      r.errors.forEach((t) => warn.push({ level: 'WARNING', text: t }));
      const nm = `${spec.target === 'HFU' ? 'HFU' : spec.target} Regression Model ${String(models.length + 1).padStart(2, '0')}`;
      const m: RegressionModel = { id: uid('m_'), name: nm, target: spec.target, targetTransform: spec.targetLog ? 'log10' : 'none', algorithm: effAlgo, params: { lambda, alpha, nTrees, minN, ds: spec, dropped: built.dropped, before: built.before }, domain: spec.domain, wellIds: [...new Set(built.ds.wellNames)], coreId: spec.coreIds[0], hfuSetId: spec.hfuSetId, groupBy, interval: spec.interval ?? undefined, features: spec.features, selectionMethod: selRes ? selRes.method : 'Manual', subModels: r.subs, createdAt: nowIso() };
      S().upsertModel(m); setCur(m.id);
      S().log(`Created ${nm}: ${targetLabel(spec)} = f(${spec.features.join(', ')}) — ${ALGO_LABEL[effAlgo]}, ${groupBy === 'hfu' ? `${r.subs.length} group models` : 'global'}, N=${built.ds.n}`);
      setMsgs([{ level: 'OK', text: `${nm} fitted (${r.subs.length} sub-model${r.subs.length > 1 ? 's' : ''}).` }, ...warn]);
    } catch (e: any) { setMsgs([{ level: 'CRITICAL', text: e.message }, ...warn]); } finally { setBusy(''); }
  };
  const model = models.find((m) => m.id === cur) ?? models[models.length - 1];
  return (
    <>
      <ModHead title="FZI Regression Studio" sub="Global or per-HFU/cluster models · feature selection · objective statistics (no opaque 'best model')">{busy && <span className="tag warn">{busy}</span>}</ModHead>
      <Tabs value={tab} onChange={setTab} tabs={[{ v: 'build', l: 'Build model' }, { v: 'compare', l: `Compare models (${models.length})` }]} />
      <div className="mod-b">
        {tab === 'build' ? <div className="split w380">
          <div className="col">
            <Box title="Dataset"><DatasetEditor spec={spec} setSpec={setSpec} />
              {typeof built === 'string' && <Msgs items={[{ level: 'CRITICAL', text: built }]} />}
              {built && typeof built !== 'string' && <div className="hint">Samples: Before N={built.before} → After N={built.ds.n}. Removed: {Object.entries(built.dropped).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}</div>}
            </Box>
            <Box title="Candidate predictors"><FeatureTable spec={spec} setSpec={setSpec} corr={corr} /><div className="hint">Orange = derived from target/labels (leakage risk). log10 applied to resistivity/permeability-type inputs by default.</div></Box>
            <Box title="Feature selection">
              <Field label="Method"><Sel value={selMethod} onChange={setSelMethod} options={SEL_METHODS} /></Field>
              {['correlation', 'vif'].includes(selMethod) && <Field label={selMethod === 'vif' ? 'Max VIF' : 'Max |r| between'}><Num value={selThr} onChange={setSelThr} /></Field>}
              {['rfe', 'mi', 'rf', 'permutation', 'forward'].includes(selMethod) && <Field label="# features"><Num value={selN} onChange={setSelN} /></Field>}
              <button className="btn" disabled={!built || typeof built === 'string' || !!busy} onClick={runSel}>Run selection</button>
              {selRes && <div style={{ marginTop: 6 }}>
                <table className="t"><thead><tr><th>Feature</th><th>Score</th><th>Note</th></tr></thead><tbody>{selRes.ranking.map((r) => <tr key={r.name} style={{ color: selRes.selected.includes(r.name) ? undefined : 'var(--tx3)' }}><td>{r.name}</td><td className="num">{fmt(r.score, 4)}</td><td className="dim">{r.note ?? (selRes.selected.includes(r.name) ? 'selected' : '')}</td></tr>)}</tbody></table>
                {selRes.log.map((l, i) => <div key={i} className="hint mono">{l}</div>)}
                <button className="btn sm pri" style={{ marginTop: 4 }} onClick={() => setSpec({ ...spec, features: selRes.selected })}>Use selected ({selRes.selected.length})</button>
              </div>}
            </Box>
            <Box title="Model">
              <Field label="Algorithm"><Sel value={effAlgo} onChange={setAlgo} options={(Object.keys(ALGO_LABEL) as Algo[]).filter((a) => (spec.target === 'HFU' ? a === 'RFClassifier' : a !== 'RFClassifier')).map((a) => ({ v: a, l: ALGO_LABEL[a] }))} /></Field>
              {['Ridge', 'Lasso', 'ElasticNet'].includes(effAlgo) && <Field label="λ"><input value={lambda} onChange={(e) => setLambda(e.target.value)} placeholder="cv" /></Field>}
              {effAlgo === 'ElasticNet' && <Field label="α (L1 ratio)"><Num value={alpha} onChange={setAlpha} /></Field>}
              {['RandomForest', 'RFClassifier'].includes(effAlgo) && <Field label="Trees"><Num value={nTrees} onChange={setNTrees} /></Field>}
              {effAlgo === 'LogLinear' && !spec.targetLog && <div className="hint" style={{ color: 'var(--warn)' }}>Log-linear = linear model of log10(target): enable a log target (e.g. log(FZI)).</div>}
              <Field label="Regression by"><Sel value={groupBy} onChange={setGroupBy} options={[{ v: 'global', l: 'Global regression' }, { v: 'hfu', l: 'By HFU / cluster (selected set)' }]} /></Field>
              <Field label="Minimum N per model"><Num value={minN} onChange={(v) => setMinN(Math.max(3, Math.round(v)))} /></Field>
              <button className="btn pri" disabled={!built || typeof built === 'string' || !!busy || (effAlgo === 'LogLinear' && !spec.targetLog)} onClick={fit}>Fit model</button>
            </Box>
            <Msgs items={msgs} />
          </div>
          <div className="col">{model ? <ModelView m={model} /> : <Empty>Select a target and predictors, then fit a model. Example: log(FZI) = f(GR, RHOB, NPHI).</Empty>}</div>
        </div> : <CompareModels models={models} vals={vals} onOpen={(id) => { setCur(id); setTab('build'); }} />}
      </div>
      <RightPanel><ModelList cur={model?.id} setCur={setCur} /></RightPanel>
    </>
  );
}

function ModelList({ cur, setCur }: { cur?: string; setCur: (id: string) => void }) {
  const models = useStore((s) => s.models);
  return <Box title="Models">{models.length ? models.map((m) => { const s = modelStatsRow(m); return <div key={m.id} onClick={() => setCur(m.id)} style={{ padding: '3px 4px', cursor: 'pointer', background: cur === m.id ? '#1c3350' : undefined, borderBottom: '1px solid var(--bd)' }}>
    <b>{m.name}</b><div className="hint mono">{m.targetTransform === 'log10' ? `log10(${m.target})` : m.target} = f({m.features.join(', ')})</div><div className="hint">{ALGO_LABEL[m.algorithm]} · {m.groupBy === 'hfu' ? `${m.subModels.length} groups` : 'global'} · N={s.n} · R²={fmt(s.r2, 3)}</div>
    <button className="btn sm danger" onClick={(e) => { e.stopPropagation(); S().removeModel(m.id); S().log(`Deleted model ${m.name}`, 'warn'); }}>Delete</button></div>; }) : <span className="hint">No models.</span>}</Box>;
}

export function ModelView({ m }: { m: RegressionModel }) {
  const [gi, setGi] = useState(0); const s = m.subModels[Math.min(gi, m.subModels.length - 1)];
  const pa = useMemo(() => predictLocal(m, s), [m.id, s.group]);
  const cls = s.kind === 'classifier';
  return <div className="col">
    <Box title={<>{m.name} <span className="dim">· {ALGO_LABEL[m.algorithm]} · target {m.targetTransform === 'log10' ? `log10(${m.target})` : m.target} · selection: {m.selectionMethod}</span></>}>
      <div className="tbl-wrap"><table className="t"><thead><tr><th>Group</th><th>N</th><th>Features</th><th>R²</th><th>Adj R²</th><th>RMSE</th><th>MAE</th><th>AIC</th><th>BIC</th><th>Residual mean ± sd</th><th>Residual P05…P95</th><th>Warnings</th></tr></thead>
        <tbody>{m.subModels.map((q, i) => <tr key={q.group} className={i === gi ? 'sel' : ''} onClick={() => setGi(i)} style={{ cursor: 'pointer' }}>
          <td>{q.groupId > 0 && <span className="pill" style={{ background: hfuColor(q.groupId) }} />}{q.group}</td><td className="num" style={{ color: q.n < (m.params.minN ?? 30) ? 'var(--crit)' : undefined }}>{q.n}</td><td>{q.features.length}</td>
          {cls ? <td colSpan={6} className="num">accuracy {(100 * (q.metrics as any).accuracy).toFixed(1)}% · OOB {(100 * ((q.metrics as any).oobAccuracy ?? NaN)).toFixed(1)}%</td> : <><td className="num">{fmt(q.metrics.r2, 3)}{(q.metrics as any).oobR2 !== undefined && <span className="dim"> (OOB {fmt((q.metrics as any).oobR2, 3)})</span>}</td><td className="num">{fmt(q.metrics.adjR2, 3)}</td><td className="num">{fmt(q.metrics.rmse, 3)}</td><td className="num">{fmt(q.metrics.mae, 3)}</td><td className="num">{fmt(q.metrics.aic, 4)}</td><td className="num">{fmt(q.metrics.bic, 4)}</td></>}
          <td className="num">{fmt(q.residual.mean, 3)} ± {fmt(q.residual.sd, 3)}</td><td className="num">{fmt(q.residual.p05, 3)} … {fmt(q.residual.p95, 3)}</td><td>{q.warnings.length ? <span className="tag warn" title={q.warnings.join('\n')}>{q.warnings.length}</span> : ''}</td></tr>)}</tbody></table></div>
    </Box>
    <div className="grid2" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <Box title={`${s.group} — equation & coefficients`}>
        <div className="formula">{s.equation}</div>
        {s.table && <table className="t" style={{ marginTop: 6 }}><thead><tr><th>Term</th><th>{s.kind === 'linear' ? 'Coefficient' : 'Importance'}</th>{s.kind === 'linear' && <><th>Std. error</th><th>t</th><th>p-value</th><th>VIF</th></>}</tr></thead>
          <tbody>{s.table.map((r) => <tr key={r.name}><td>{r.name}</td><td className="num">{fmt(r.coef, 4)}</td>{s.kind === 'linear' && <><td className="num">{fmt(r.se, 3)}</td><td className="num">{fmt(r.t, 3)}</td><td className="num" style={{ color: (r.p ?? 0) > 0.05 ? 'var(--warn)' : undefined }}>{r.p === undefined ? '—' : r.p < 1e-4 ? '<1e-4' : r.p.toFixed(4)}</td><td className="num" style={{ color: (r.vif ?? 0) > 10 ? 'var(--crit)' : (r.vif ?? 0) > 5 ? 'var(--warn)' : undefined }}>{fmt(r.vif, 3)}</td></>}</tr>)}</tbody></table>}
        {(s as any).conditionNumber !== undefined && <div className="hint">Multicollinearity: condition number {fmt((s as any).conditionNumber, 3)} (&gt;30 = collinear); VIF &gt; 5 moderate, &gt; 10 severe.</div>}
        <Msgs items={s.warnings.map((t) => ({ level: 'WARNING', text: t }))} />
        <div className="hint">Training range: {s.features.map((f, j) => `${f} [${fmt(s.featureRanges[j][0], 3)}, ${fmt(s.featureRanges[j][1], 3)}]`).join(' · ')}</div>
      </Box>
      <div className="col">
        {pa && <div className="box" style={{ height: 280 }}><XYPlot title="Training fit: predicted vs actual (in-sample — see Validation for out-of-sample)" xLabel={`actual ${m.targetTransform === 'log10' ? 'log10 ' : ''}${m.target}`} yLabel="predicted" series={[{ kind: 'scatter', x: pa.actual, y: pa.pred, colors: pa.group.map((g) => hfuColor(g || 1)), size: 2.8 }]} refLines={[{ x1: Math.min(...pa.actual), y1: Math.min(...pa.actual), x2: Math.max(...pa.actual), y2: Math.max(...pa.actual), color: '#aaa', dash: true, label: '1:1' }]} /></div>}
        {pa && <div style={{ height: 460 }}><DepthPlot title="Residual vs depth (training) — actual − predicted" tracks={[{ width: 220, series: [{ depth: pa.depth, values: pa.actual.map((a, i) => a - pa.pred[i]), label: 'residual', color: '#d6336c', kind: 'dots', size: 2.6, min: -Math.max(...pa.actual.map((a, i) => Math.abs(a - pa.pred[i]))), max: Math.max(...pa.actual.map((a, i) => Math.abs(a - pa.pred[i]))) }] }]} /></div>}
      </div>
    </div>
  </div>;
}

function CompareModels({ models, vals, onOpen }: { models: RegressionModel[]; vals: any[]; onOpen: (id: string) => void }) {
  const [sort, setSort] = useState<string>('');
  const rows = models.map((m) => { const s = modelStatsRow(m); const v = [...vals].reverse().find((x) => x.modelId === m.id); return { m, s, v }; });
  const key = (r: typeof rows[number]): number => (sort === 'cv' ? r.v?.metrics.rmse ?? Infinity : sort ? (r.s as any)[sort] : 0);
  const sorted = sort ? [...rows].sort((a, b) => (['r2', 'adjR2'].includes(sort) ? key(b) - key(a) : key(a) - key(b))) : rows;
  const th = (k: string, l: string) => <th style={{ cursor: 'pointer', color: sort === k ? '#4ea1ff' : undefined }} onClick={() => setSort(k)}>{l}</th>;
  if (!models.length) return <Empty>No models yet.</Empty>;
  return <Box title="Side-by-side model comparison" right={<span className="hint">{sort ? `Ordered by ${sort} (factual ordering, not a recommendation)` : 'click a metric to order'}</span>}>
    <div className="tbl-wrap"><table className="t"><thead><tr><th>Model</th><th>Target</th><th>Algorithm</th><th>Features</th><th>Groups</th>{th('n', 'N')}{th('r2', 'R²')}{th('adjR2', 'Adj R²')}{th('rmse', 'RMSE')}{th('mae', 'MAE')}{th('aic', 'AIC')}{th('bic', 'BIC')}{th('cv', 'Validation RMSE')}<th>Validation method</th><th>Warnings</th></tr></thead>
      <tbody>{sorted.map(({ m, s, v }) => <tr key={m.id} onClick={() => onOpen(m.id)} style={{ cursor: 'pointer' }}><td><b>{m.name}</b></td><td>{m.targetTransform === 'log10' ? `log10(${m.target})` : m.target}</td><td>{ALGO_LABEL[m.algorithm]}</td><td className="mono">{m.features.join(', ')}</td><td>{m.groupBy === 'hfu' ? m.subModels.length : 'global'}</td>
        <td className="num">{s.n}</td><td className="num">{fmt(s.r2, 3)}</td><td className="num">{fmt(s.adjR2, 3)}</td><td className="num">{fmt(s.rmse, 3)}</td><td className="num">{fmt(s.mae, 3)}</td><td className="num">{fmt(s.aic, 4)}</td><td className="num">{fmt(s.bic, 4)}</td><td className="num">{v ? fmt(v.metrics.rmse, 3) : '—'}</td><td className="dim">{v?.method ?? 'not validated'}</td><td>{m.subModels.reduce((a, q) => a + q.warnings.length, 0) || ''}</td></tr>)}</tbody></table></div>
    <div className="hint">AIC/BIC are comparable only between models fitted on the same samples and target transform. In-sample metrics are optimistic — validate before choosing.</div>
  </Box>;
}
void isNum;
