import { DepthPlot } from '../visualization/DepthPlot';
import { useState } from 'react';
import { S, useStore } from '../store/store';
import { call } from '../workers/rpc';
import { buildDataset, dsTransfer, leakageWarnings } from '../regression/prepare';
import type { ValidationSpec } from '../regression/engine';
import type { ValidationRun } from '../types';
import { Box, Empty, Field, ModHead, Msgs, Num, Sel } from './common';
import { RightPanel } from './RightPanel';
import { XYPlot } from '../visualization/XYPlot';
import { histogram } from './Calculator';
import { ALGO_LABEL } from './Regression';
import { metricsFrom } from '../regression/linear';
import { probit } from '../clustering/core';
import { fmt, isNum, nowIso, PALETTE, uid } from '../util/num';

const METHODS: { v: ValidationSpec['method']; l: string }[] = [
  { v: 'kfold-block', l: 'Depth-blocked K-fold (default)' }, { v: 'split-block', l: 'Train/Test split — depth block' }, { v: 'split-random', l: 'Train/Test split — random' },
  { v: 'kfold-random', l: 'K-fold — random' }, { v: 'lowo', l: 'Leave-One-Well-Out' }, { v: 'stratified', l: 'Cluster-stratified K-fold' }, { v: 'interval', l: 'Independent validation interval' },
];

export function Validation() {
  const models = useStore((s) => s.models); const runs = useStore((s) => s.validations);
  const [mid, setMid] = useState(models[models.length - 1]?.id ?? '');
  const [method, setMethod] = useState<ValidationSpec['method']>('kfold-block'); const [k, setK] = useState(5); const [frac, setFrac] = useState(0.25);
  const [iv, setIv] = useState<[number, number]>([0, 0]);
  const [busy, setBusy] = useState(false); const [msgs, setMsgs] = useState<{ level: any; text: string }[]>([]);
  const [rid, setRid] = useState<string | null>(null);
  const m = models.find((x) => x.id === mid);
  if (!models.length) return <><ModHead title="Model Validation" /><Empty>Fit a regression model first (FZI Regression Studio).</Empty></>;
  const run = async () => {
    if (!m) return; setBusy(true); setMsgs([]);
    try {
      const spec = { ...m.params.ds, interval: method === 'interval' ? null : m.params.ds.interval };
      const b = buildDataset(spec); const warn: string[] = [...leakageWarnings(spec)];
      if (method === 'interval' && m.interval && !(iv[1] < m.interval[0] || iv[0] > m.interval[1])) warn.push(`Train/test leakage: validation interval ${iv[0]}–${iv[1]} overlaps the model's training interval ${m.interval[0]}–${m.interval[1]}.`);
      if (method === 'stratified' && !m.hfuSetId) warn.push('Cluster-stratified folds need an HFU/cluster set on the model; all samples are in one stratum.');
      const d = b.ds;
      const r = await call<any>('analysis', 'validate', [d, { algorithm: m.algorithm, params: { lambda: m.params.lambda === 'cv' ? 'cv' : +m.params.lambda, alpha: m.params.alpha, nTrees: m.params.nTrees }, minN: Math.min(m.params.minN ?? 30, 10), targetLabel: m.target }, { method, k, testFrac: frac, groupBy: m.groupBy, testInterval: iv }], { transfer: dsTransfer(d) });
      const vr: ValidationRun = { id: uid('v_'), modelId: m.id, method: METHODS.find((x) => x.v === method)!.l, params: { k, frac, iv }, metrics: r.metrics, folds: r.folds, createdAt: nowIso(), actual: r.actual, predicted: r.predicted, depth: r.depth, fold: r.fold, warnings: [...warn, ...r.warnings] };
      S().set({ validations: [...S().validations, vr] }); setRid(vr.id);
      S().log(`Validated ${m.name} — ${vr.method}: R² ${fmt(r.metrics.r2, 3)}, RMSE ${fmt(r.metrics.rmse, 3)} (N=${r.metrics.n})`);
      if (m.params.minN > 10) setMsgs([{ level: 'INFO', text: 'Within folds the minimum-N threshold is relaxed to 10 so that small training folds can still be evaluated.' }]);
    } catch (e: any) { setMsgs([{ level: 'CRITICAL', text: e.message }]); } finally { setBusy(false); }
  };
  const vr = runs.find((r) => r.id === rid) ?? [...runs].reverse().find((r) => r.modelId === mid);
  const log = m?.targetTransform === 'log10';
  const res = vr ? vr.actual.map((a, i) => a - vr.predicted[i]) : [];
  const qq = (() => { if (!vr) return null; const s = [...res].sort((a, b) => a - b); const n = s.length; const mu = s.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(s.reduce((a, b) => a + (b - mu) ** 2, 0) / (n - 1)); return { x: s.map((_, i) => probit((i + 0.5) / n)), y: s.map((v) => (v - mu) / sd) }; })();
  const back = vr && log && m?.target !== 'HFU' ? metricsFrom(vr.actual.map((v) => 10 ** v), vr.predicted.map((v) => 10 ** v), vr.metrics.p) : null;
  const cls = m?.algorithm === 'RFClassifier';
  const lim = vr ? [Math.min(...vr.actual, ...vr.predicted), Math.max(...vr.actual, ...vr.predicted)] : [0, 1];
  const fc = vr ? vr.fold.map((f) => PALETTE[f % PALETTE.length]) : [];
  return (
    <>
      <ModHead title="Model Validation" sub="Depth-correlated samples are NOT split randomly by default">{busy && <span className="tag warn">validating…</span>}</ModHead>
      <div className="mod-b">
        <div className="split">
          <div className="col">
            <Box title="Setup">
              <Field label="Model"><select value={mid} onChange={(e) => setMid(e.target.value)}>{models.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
              {m && <div className="hint mono">{ALGO_LABEL[m.algorithm]} · {m.groupBy === 'hfu' ? 'by HFU' : 'global'} · {m.features.join(', ')}</div>}
              <Field label="Method"><Sel value={method} onChange={setMethod} options={METHODS} /></Field>
              {['kfold-block', 'kfold-random', 'stratified'].includes(method) && <Field label="K folds"><Num value={k} onChange={(v) => setK(Math.max(2, Math.round(v)))} /></Field>}
              {method.startsWith('split') && <Field label="Test fraction"><Num value={frac} onChange={setFrac} /></Field>}
              {method === 'interval' && <Field label="Validation interval"><div className="row"><Num value={iv[0]} onChange={(v) => setIv([v, iv[1]])} style={{ width: 66 }} /><Num value={iv[1]} onChange={(v) => setIv([iv[0], v])} style={{ width: 66 }} /></div></Field>}
              {method.includes('random') && <Msgs items={[{ level: 'WARNING', text: 'Random splits of depth-correlated log samples give optimistic metrics (neighbouring samples leak into training).' }]} />}
              <button className="btn pri" disabled={busy || !m} onClick={run}>Run validation</button>
            </Box>
            <Msgs items={msgs} />
            {vr && <Box title="Out-of-sample metrics">
              {cls ? <div className="kv"><span>Accuracy</span><span>{(100 * (vr.metrics as any).accuracy).toFixed(1)}%</span><span>N</span><span>{vr.metrics.n}</span></div> :
                <table className="t"><thead><tr><th>Metric</th><th>{log ? `log10(${m?.target})` : m?.target}</th>{back && <th>{m?.target} (back-transformed)</th>}</tr></thead><tbody>
                  {([['R²', 'r2'], ['Adjusted R²', 'adjR2'], ['RMSE', 'rmse'], ['MAE', 'mae'], ['Median abs. error', 'medae'], ['MAPE %', 'mape']] as const).map(([l, k2]) => <tr key={k2}><td>{l}</td><td className="num">{k2 === 'mape' && log ? 'n/a (log target)' : fmt(vr.metrics[k2] as number, 4)}</td>{back && <td className="num">{fmt(back[k2] as number, 4)}</td>}</tr>)}
                  <tr><td>N</td><td className="num">{vr.metrics.n}</td>{back && <td />}</tr></tbody></table>}
              <Msgs items={vr.warnings.map((t) => ({ level: 'WARNING', text: t }))} />
              {vr.folds.length > 0 && <table className="t" style={{ marginTop: 6 }}><thead><tr><th>Fold</th><th>R²</th><th>RMSE</th><th>MAE</th><th>N</th></tr></thead><tbody>{vr.folds.map((f, i) => <tr key={i}><td><span className="pill" style={{ background: PALETTE[i % PALETTE.length] }} />{f.name}</td><td className="num">{fmt(f.metrics.r2, 3)}</td><td className="num">{fmt(f.metrics.rmse, 3)}</td><td className="num">{fmt(f.metrics.mae, 3)}</td><td className="num">{f.metrics.n}</td></tr>)}</tbody></table>}
            </Box>}
          </div>
          {vr ? <div className="gridD" style={{ height: 640 }}>
            <div className="box"><XYPlot title="Predicted vs Actual (out-of-fold)" xLabel="actual" yLabel="predicted" series={[{ kind: 'scatter', x: vr.actual, y: vr.predicted, colors: fc, size: 2.8 }]} refLines={[{ x1: lim[0], y1: lim[0], x2: lim[1], y2: lim[1], color: '#aaa', dash: true, label: '1:1' }]} /></div>
            <div className="dcol" style={{ minHeight: 0 }}><DepthPlot title="Residual vs depth (actual − predicted)" tracks={[{ width: 220, series: [{ depth: vr.depth, values: res, label: 'residual', color: '#333333', kind: 'dots', size: 2.6, colors: fc, min: -Math.max(...res.filter(isNum).map(Math.abs)), max: Math.max(...res.filter(isNum).map(Math.abs)) }] }]} /></div>
            <div className="box"><XYPlot title="Residual histogram" xLabel="residual" yLabel="count" series={[{ kind: 'bars', ...(histogram(res, 25) ?? { x: [], y: [] }), color: '#b083f0' }]} /></div>
            <div className="box"><XYPlot title="Residual vs Predicted" xLabel="predicted" yLabel="residual" series={[{ kind: 'scatter', x: vr.predicted, y: res, colors: fc, size: 2.6 }]} refLines={[{ x1: Math.min(...vr.predicted), y1: 0, x2: Math.max(...vr.predicted), y2: 0, color: '#aaa', dash: true }]} /></div>
            {qq && <div className="box"><XYPlot title="Normal Q-Q plot of residuals" xLabel="theoretical quantile" yLabel="standardised residual" series={[{ kind: 'scatter', x: qq.x, y: qq.y, color: '#39c5cf', size: 2.6 }]} refLines={[{ x1: -3, y1: -3, x2: 3, y2: 3, color: '#aaa', dash: true }]} /></div>}
          </div> : <Empty>Run a validation to see diagnostics.</Empty>}
        </div>
      </div>
      <RightPanel><Box title="Validation runs">{runs.length ? [...runs].reverse().map((r) => <div key={r.id} onClick={() => { setRid(r.id); setMid(r.modelId); }} style={{ cursor: 'pointer', padding: '3px 4px', borderBottom: '1px solid var(--bd)', background: vr?.id === r.id ? '#1c3350' : undefined }}>
        <b>{models.find((x) => x.id === r.modelId)?.name ?? '(deleted model)'}</b><div className="hint">{r.method} · R² {fmt(r.metrics.r2, 3)} · RMSE {fmt(r.metrics.rmse, 3)} · N {r.metrics.n}</div></div>) : <span className="hint">None.</span>}</Box></RightPanel>
    </>
  );
}
