import { DepthPlot } from '../visualization/DepthPlot';
import { scopeIntervals, scopeLabel } from '../data-engine/zones';
import { useMemo, useState } from 'react';
import { S, useStore, activeCore } from '../store/store';
import { registry } from '../data-engine/registry';
import { coreDepths, sampleLogAt } from '../data-engine/core';
import { putCalculatedCurve } from '../data-engine/ingest';
import { call } from '../workers/rpc';
import type { HfuSet, WellMeta } from '../types';
import { Box, Empty, Field, ModHead, Msgs, Num, Sel, useActiveWell, ZoneSelect } from './common';
import { CoreSelector } from './CoreManager';
import { RightPanel } from './RightPanel';
import { HfuSetsPanel, projectCoreResults } from './HfuAnalyzer';
import { XYPlot } from '../visualization/XYPlot';
import { histogram } from './Calculator';
import { makeUnits, unitStats } from '../hfu/identify';
import { fmt, hfuColor, isNum, median, nowIso, pearson, percentiles, uid } from '../util/num';

type Algo = 'kmeans' | 'gmm' | 'ward' | 'agglomerative' | 'dbscan';
const ALGOS: { v: Algo; l: string }[] = [{ v: 'kmeans', l: 'K-Means' }, { v: 'gmm', l: 'Gaussian Mixture Model' }, { v: 'ward', l: 'Hierarchical (Ward)' }, { v: 'agglomerative', l: 'Agglomerative (linkage)' }, { v: 'dbscan', l: 'DBSCAN' }];
const CORE_FEATS = ['PHI', 'K', 'RQI', 'FZI', 'PHIZ'];
const LOGDEF = /^(K|RQI|FZI|RQI_LOG|FZI_LOG|KTIM|KSDR|AT90|RT|RXO|RXOZ|AT\d0|ILD|LLD|T2LM|K_.*)$/i;

export interface FeatureMatrix { X: Float64Array; n: number; d: number; names: string[]; rows: number[]; depth: Float64Array; before: number; missing: Record<string, number>; cols: Record<string, Float64Array> }

/** Build complete-case feature matrix. Core domain: core columns + logs sampled at shifted core depths. */
export function buildMatrix(domain: 'core' | 'log', well: WellMeta, coreId: string | undefined, feats: string[], interval?: [number, number], maxRows = Infinity): FeatureMatrix | string {
  const cols: Record<string, Float64Array> = {}; let depth: Float64Array; let excl: Uint8Array | undefined;
  if (domain === 'core') {
    const meta = S().cores.find((c) => c.id === coreId); const a = coreId ? registry.core(coreId) : undefined; if (!meta || !a) return 'Select a core dataset.';
    depth = coreDepths(meta, a).shifted; excl = a.excluded;
    for (const f of feats) { const c = a.num.get(f); cols[f] = c ? Float64Array.from(c) : sampleLogAt(well, f, depth); }
  } else {
    depth = registry.depth(well.id)!;
    for (const f of feats) { const c = registry.curve(well.id, f); if (!c) return `Curve ${f} not loaded yet — retry.`; cols[f] = Float64Array.from(c); }
  }
  const n0 = depth.length; const missing: Record<string, number> = {};
  const sc = scopeIntervals(well.id, S().zone); // global analysis scope (reservoir / zone)
  const inIv = (i: number) => (!interval || (depth[i] >= interval[0] && depth[i] <= interval[1])) && (!sc || sc.some(([t, bb]) => depth[i] >= t && depth[i] < bb));
  let before = 0; for (let i = 0; i < n0; i++) if (inIv(i) && !excl?.[i]) before++;
  for (const f of feats) { let m = 0; for (let i = 0; i < n0; i++) if (inIv(i) && !excl?.[i] && !isNum(cols[f][i])) m++; missing[f] = before ? (100 * m) / before : 0; }
  let rows: number[] = [];
  for (let i = 0; i < n0; i++) if (inIv(i) && !excl?.[i] && feats.every((f) => isNum(cols[f][i]))) rows.push(i);
  if (rows.length > maxRows) { const s = rows.length / maxRows; rows = Array.from({ length: maxRows }, (_, k) => rows[Math.floor(k * s)]); }
  const d = feats.length; const X = new Float64Array(rows.length * d);
  rows.forEach((r, i) => feats.forEach((f, j) => (X[i * d + j] = cols[f][r])));
  return { X, n: rows.length, d, names: feats, rows, depth, before, missing, cols };
}

export function Clustering() {
  const core = useStore((s) => activeCore(s)); const well0 = useActiveWell(); useStore((s) => s.dataVersion);
  const interval = useStore((s) => s.interval);
  const [domain, setDomain] = useState<'core' | 'log'>(core ? 'core' : 'log');
  const well = domain === 'core' ? useStore.getState().wells.find((w) => w.id === core?.wellId) : well0;
  const coreArr = core ? registry.core(core.id) : undefined;
  const avail = useMemo(() => {
    if (!well) return [];
    const logs = well.curves.filter((c) => !c.discrete && !['Depth', 'Flag', 'HFU'].includes(c.category) && !/_CORE$/.test(c.mnemonic)).map((c) => c.mnemonic);
    return domain === 'core' ? [...CORE_FEATS.filter((f) => coreArr?.num.has(f)), ...logs] : logs;
  }, [well, domain, coreArr, S().dataVersion]);
  const [feats, setFeats] = useState<string[]>(['PHI', 'K', 'FZI']);
  const [logT, setLogT] = useState<Record<string, boolean>>({});
  const [scaling, setScaling] = useState<'none' | 'standard' | 'minmax' | 'robust' | 'log'>('standard');
  const [algo, setAlgo] = useState<Algo>('kmeans'); const [k, setK] = useState(4); const [linkage, setLinkage] = useState<'average' | 'complete' | 'single' | 'ward'>('average');
  const [eps, setEps] = useState(0.5); const [minPts, setMinPts] = useState(5); const [useIv, setUseIv] = useState(false);
  const [scan, setScan] = useState<any[] | null>(null); const [kd, setKd] = useState<number[] | null>(null);
  const [res, setRes] = useState<any>(null); const [busy, setBusy] = useState(''); const [msgs, setMsgs] = useState<{ level: any; text: string }[]>([]);
  const [px, setPx] = useState('PHI'); const [py, setPy] = useState('K');
  const [setName, setSetName] = useState('');
  const fs = feats.filter((f) => avail.includes(f));
  const pxE = fs.includes(px) ? px : fs[0] ?? px; const pyE = fs.includes(py) ? py : fs[1] ?? fs[0] ?? py;
  const isLogF = (f: string) => logT[f] ?? LOGDEF.test(f);
  const zone = useStore((st) => st.zone);
  const M = useMemo(() => (well && fs.length ? buildMatrix(domain, well, core?.id, fs, useIv && interval && interval.wellId === well.id ? [interval.top, interval.base] : undefined, domain === 'log' && ['ward', 'agglomerative'].includes(algo) ? 2500 : domain === 'log' ? 60000 : Infinity) : null), [well, domain, core?.id, fs.join(), useIv, interval, algo, S().dataVersion, zone, S().reservoirs]);

  if (!well) return <><ModHead title="HFU Clustering" /><Empty>Load data first.</Empty></>;
  const matrixErr = typeof M === 'string' ? M : null; const mat = typeof M === 'string' ? null : M;
  const job = () => {
    const Xl = new Float64Array(mat!.X); const d = mat!.d;
    // per-feature log transform (explicit, not hidden)
    fs.forEach((f, j) => { if (isLogF(f) || scaling === 'log') for (let i = 0; i < mat!.n; i++) Xl[i * d + j] = Xl[i * d + j] > 0 ? Math.log10(Xl[i * d + j]) : NaN; });
    const ok: number[] = []; for (let i = 0; i < mat!.n; i++) { let g = true; for (let j = 0; j < d; j++) if (!isNum(Xl[i * d + j])) g = false; if (g) ok.push(i); }
    const X = new Float64Array(ok.length * d); ok.forEach((r, i) => { for (let j = 0; j < d; j++) X[i * d + j] = Xl[r * d + j]; });
    return { X, n: ok.length, d, ok, dropped: mat!.n - ok.length };
  };
  const runScan = async () => {
    if (!mat) return; setBusy('Scanning K = 2…10'); setMsgs([]);
    try { const j = job(); const r = await call('analysis', 'scanK', [{ X: j.X, n: j.n, d: j.d, scaling: scaling === 'log' ? 'standard' : scaling, algo: algo === 'dbscan' ? 'kmeans' : algo, kMin: 2, kMax: 10, linkage }], { transfer: [j.X.buffer] }); setScan(r); S().log(`Cluster-number scan (${algo}, K=2–10) on ${j.n} samples`); }
    catch (e: any) { setMsgs([{ level: 'CRITICAL', text: e.message }]); } finally { setBusy(''); }
  };
  const runKd = async () => { if (!mat) return; const j = job(); setKd(await call('analysis', 'kDistance', [{ X: j.X, n: j.n, d: j.d, scaling: scaling === 'log' ? 'standard' : scaling, k: minPts }], { transfer: [j.X.buffer] })); };
  const run = async () => {
    if (!mat) return; setBusy('Clustering…'); setMsgs([]);
    try {
      const j = job();
      const r = await call('analysis', 'cluster', [{ X: j.X, n: j.n, d: j.d, scaling: scaling === 'log' ? 'standard' : scaling, algo, params: { k, linkage, eps, minPts } }], { transfer: [j.X.buffer] });
      // order clusters by median FZI (or first feature) so numbering is reproducible; DBSCAN noise → 0
      const ordKey = fs.includes('FZI') ? 'FZI' : fs.includes('FZI_LOG') ? 'FZI_LOG' : fs[0];
      const ids = [...new Set<number>(Array.from(r.labels as Int32Array).filter((l) => l >= 0))];
      const med = ids.map((c) => median(j.ok.filter((_, i) => r.labels[i] === c).map((ri) => mat.cols[ordKey][mat.rows[ri]])));
      const order = ids.map((c, i) => ({ c, m: med[i] })).sort((a, b) => a.m - b.m); const remap = new Map(order.map((o, i) => [o.c, i + 1]));
      const labelsFull = new Int16Array(mat.depth.length); // 0 = unassigned
      j.ok.forEach((ri, i) => { const l = r.labels[i]; labelsFull[mat.rows[ri]] = l >= 0 ? remap.get(l)! : 0; });
      setRes({ ...r, labelsFull, K: ids.length, ordKey, n: j.n, dropped: j.dropped });
      const m: typeof msgs = [{ level: 'INFO', text: `Complete cases: Before N=${mat.before}, After N=${j.n}, Removed N=${mat.before - j.n} (missing feature values${j.dropped ? ` or non-positive values under log transform (${j.dropped})` : ''}).` }, ...r.notes.map((t: string) => ({ level: 'INFO', text: t }))];
      if (r.metrics) m.push({ level: 'INFO', text: `Silhouette ${fmt(r.metrics.silhouette, 3)} · Calinski–Harabasz ${fmt(r.metrics.ch, 4)} · Davies–Bouldin ${fmt(r.metrics.db, 3)}` });
      m.push({ level: 'WARNING', text: 'These are STATISTICAL CLUSTERS. They become Hydraulic Flow Units only after analyst validation.' });
      setMsgs(m); S().log(`Ran ${algo} clustering (K=${ids.length}) on ${fs.join(', ')} [${scaling}] — ${j.n} samples`);
    } catch (e: any) { setMsgs([{ level: 'CRITICAL', text: e.message }]); } finally { setBusy(''); }
  };
  const save = () => {
    if (!res || !mat) return;
    const K = res.K; const id = uid('h_');
    const cols: Record<string, Float64Array> = {}; for (const f of ['PHI', 'K', 'RQI', 'FZI', 'FZI_LOG', 'PHIE', 'VSH', 'GR']) if (mat.cols[f]) cols[f] = mat.cols[f];
    if (domain === 'core' && coreArr) for (const f of ['PHI', 'K', 'RQI', 'FZI']) if (coreArr.num.has(f)) cols[f] = coreArr.num.get(f)!;
    const st = unitStats(res.labelsFull, cols, K);
    // FZI boundaries (for classifying predicted FZI) from medians of adjacent clusters
    const fk = cols.FZI ? 'FZI' : cols.FZI_LOG ? 'FZI_LOG' : null;
    const boundaries = fk && res.ordKey === fk ? st.slice(1).map((s, i) => Math.sqrt(st[i][`median_${fk}`] * s[`median_${fk}`])) : undefined;
    const units = makeUnits(K, boundaries, 'Cluster').map((u, i) => ({ ...u, stats: st[i] }));
    const set: HfuSet = { id, name: setName || `F-${ALGOS.find((a) => a.v === algo)!.l}-${K} ${domain}`, domain, wellId: well.id, coreId: domain === 'core' ? core?.id : undefined, method: 'F · Machine-learning clustering (multi-feature)', algorithm: ALGOS.find((a) => a.v === algo)!.l + (algo === 'agglomerative' ? ` (${linkage})` : algo === 'dbscan' ? ` eps=${eps} minPts=${minPts}` : ''), params: { k: K, scaling, logTransformed: fs.filter(isLogF) }, features: fs, scaling, units, boundaries, createdAt: nowIso() };
    if (domain === 'core') { set.labels = Array.from(res.labelsFull); projectCoreResults(core!, well, set.labels); }
    else { set.curve = `CLUSTER_${id.slice(2, 6).toUpperCase()}`; putCalculatedCurve(well.id, set.curve, Float32Array.from(res.labelsFull, (l: number) => (l ? l : NaN)), '', set.name, { kind: 'cluster', formula: `${set.algorithm} on [${fs.map((f) => (isLogF(f) ? `log10(${f})` : f)).join(', ')}], scaling ${scaling}`, inputs: fs, units: '', version: 1, missing: 'NaN where any feature missing (not clustered)', createdAt: nowIso() }, true); }
    S().upsertHfuSet(set); S().log(`Saved cluster set "${set.name}" (${K} statistical clusters)`);
    setMsgs([...msgs, { level: 'OK', text: `Saved "${set.name}". Validate/rename units in the right panel.${boundaries ? '' : ' (No FZI boundaries: FZI was not the ordering feature — HFU_PRED from FZI thresholds will not be available for this set.)'}` }]);
  };

  // diagnostics
  const corr = mat ? fs.map((a) => fs.map((b) => pearson(Array.from(mat.rows, (r) => mat.cols[a][r]), Array.from(mat.rows, (r) => mat.cols[b][r])))) : [];
  const outl = mat ? fs.map((f) => { const v = Array.from(mat.rows, (r) => (isLogF(f) && mat.cols[f][r] > 0 ? Math.log10(mat.cols[f][r]) : mat.cols[f][r])); const [q1, q3] = percentiles(v, [25, 75]); return v.filter((x) => x < q1 - 3 * (q3 - q1) || x > q3 + 3 * (q3 - q1)).length; }) : [];
  const lab = res && mat ? mat.rows.map((r) => res.labelsFull[r]) : null;
  const best = scan ? { sil: scan.reduce((b: any, r: any) => (r.silhouette > b.silhouette ? r : b)).k, ch: scan.reduce((b: any, r: any) => (r.ch > b.ch ? r : b)).k, db: scan.reduce((b: any, r: any) => (r.db < b.db ? r : b)).k } : null;
  return (
    <>
      <ModHead title="HFU Clustering" sub="Method F — multi-feature statistical clustering (runs in a Web Worker)">
        <Sel value={domain} onChange={(v) => { setDomain(v); setRes(null); setScan(null); setFeats(v === 'core' ? ['PHI', 'K', 'FZI'] : []); }} options={[{ v: 'core', l: 'Samples: core' }, { v: 'log', l: 'Samples: log (well grid)' }]} />
        {domain === 'core' ? <CoreSelector /> : <span className="hint">{well.name}</span>}
        {busy && <span className="tag warn">{busy}</span>}
      </ModHead>
      <div className="mod-b">
        <div className="split w380">
          <div className="col">
            <Box title="Features">
              <div className="tbl-wrap" style={{ maxHeight: 230 }}><table className="t"><thead><tr><th /><th>Feature</th><th>log10</th><th>Missing %</th></tr></thead><tbody>
                {avail.map((f) => <tr key={f}><td><input type="checkbox" checked={feats.includes(f)} onChange={(e) => setFeats(e.target.checked ? [...feats, f] : feats.filter((x) => x !== f))} /></td><td>{f}{CORE_FEATS.includes(f) && domain === 'core' ? <span className="dim"> (core)</span> : ''}</td>
                  <td><input type="checkbox" checked={isLogF(f)} onChange={(e) => setLogT({ ...logT, [f]: e.target.checked })} /></td><td className="num">{mat && feats.includes(f) ? fmt(mat.missing[f], 3) : ''}</td></tr>)}</tbody></table></div>
              <div className="row" style={{ marginTop: 4 }}><ZoneSelect /></div>
              <div className="hint">Only samples inside the scope are clustered{well ? ` (${scopeLabel(zone, well.id)})` : ''}; samples outside are excluded (not deleted).</div>
              {domain === 'core' && <div className="hint">Log features are sampled at shifted core depths (linear interpolation).</div>}
              {domain === 'log' && <label className="cb"><input type="checkbox" checked={useIv} onChange={(e) => setUseIv(e.target.checked)} />restrict to selected interval {interval?.wellId === well.id ? `(${interval.top}–${interval.base})` : '(drag in depth track)'}</label>}
              <Field label="Normalization"><Sel value={scaling} onChange={setScaling} options={[{ v: 'none', l: 'None' }, { v: 'standard', l: 'Standardization (z)' }, { v: 'minmax', l: 'Min-Max' }, { v: 'robust', l: 'Robust (median/IQR)' }, { v: 'log', l: 'Log transform + standardize' }]} /></Field>
              {matrixErr && <Msgs items={[{ level: 'WARNING', text: matrixErr }]} />}
              {mat && <div className="hint">Complete cases: {mat.n.toLocaleString()} of {mat.before.toLocaleString()}{domain === 'log' && mat.n >= 2500 && ['ward', 'agglomerative'].includes(algo) ? ' (evenly subsampled for O(n²) algorithm)' : ''}</div>}
            </Box>
            <Box title="Algorithm">
              <Field label="Algorithm"><Sel value={algo} onChange={setAlgo} options={ALGOS} /></Field>
              {algo !== 'dbscan' && <Field label="K (your choice)"><Num value={k} onChange={(v) => setK(Math.max(2, Math.min(10, Math.round(v))))} /></Field>}
              {algo === 'agglomerative' && <Field label="Linkage"><Sel value={linkage} onChange={setLinkage} options={['average', 'complete', 'single']} /></Field>}
              {algo === 'dbscan' && <><Field label="eps (scaled units)"><Num value={eps} onChange={setEps} /></Field><Field label="minPts"><Num value={minPts} onChange={setMinPts} /></Field><button className="btn sm" onClick={runKd}>k-distance plot</button></>}
              <div className="row" style={{ marginTop: 6 }}><button className="btn" disabled={!mat || !!busy || algo === 'dbscan'} onClick={runScan}>Scan K = 2…10</button><button className="btn pri" disabled={!mat || !!busy || mat.n < 10} onClick={run}>Run clustering</button></div>
              {best && <div className="hint" style={{ marginTop: 4 }}>Metric optima (information only — K is not changed automatically): silhouette → {best.sil}, Calinski–Harabasz → {best.ch}, Davies–Bouldin → {best.db}.</div>}
            </Box>
            {res && <Box title="Save"><Field label="Set name"><input value={setName} onChange={(e) => setSetName(e.target.value)} placeholder="auto" /></Field><button className="btn pri" onClick={save}>Save as cluster set</button></Box>}
            <Msgs items={msgs} />
          </div>
          <div className="col">
            {mat && !res && <Box title="Pre-clustering diagnostics">
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <table className="t" style={{ width: 'auto' }}><thead><tr><th>r</th>{fs.map((f) => <th key={f}>{f}</th>)}</tr></thead><tbody>{fs.map((a, i) => <tr key={a}><td><b>{a}</b></td>{fs.map((b, j) => { const v = corr[i][j]; return <td key={b} className="num" style={{ background: isNum(v) ? `rgba(${v > 0 ? '78,161,255' : '229,83,75'},${Math.abs(v) * 0.6})` : undefined }}>{fmt(v, 2)}</td>; })}</tr>)}</tbody></table>
                <table className="t" style={{ width: 'auto' }}><thead><tr><th>Feature</th><th>Missing %</th><th>Outliers (3×IQR)</th></tr></thead><tbody>{fs.map((f, i) => <tr key={f}><td>{f}</td><td className="num">{fmt(mat.missing[f], 3)}</td><td className="num">{outl[i]}</td></tr>)}</tbody></table>
              </div>
              <div className="hint">Outliers are flagged only, never removed silently. Correlation is shown to diagnose redundant features — correlation is not causation.</div>
              <div className="grid3" style={{ marginTop: 6 }}>{fs.map((f) => { const h = histogram(Array.from(mat.rows, (r) => mat.cols[f][r]), 30, isLogF(f)); return <div key={f} className="box" style={{ height: 150 }}><XYPlot title={`${isLogF(f) ? 'log10 ' : ''}${f}`} series={h ? [{ kind: 'bars', x: h.x, y: h.y, color: '#39c5cf' }] : []} /></div>; })}</div>
            </Box>}
            {scan && <div className="grid2" style={{ height: 330 }}>
              {[['inertia', 'Elbow — within-cluster SS'], ['silhouette', 'Silhouette (higher better)'], ['ch', 'Calinski–Harabasz (higher better)'], ['db', 'Davies–Bouldin (lower better)']].map(([key, t]) => <div key={key} className="box"><XYPlot title={t} xLabel="K" series={[{ kind: 'line', x: scan.map((r) => r.k), y: scan.map((r) => r[key]), color: '#e8c547' }, { kind: 'scatter', x: scan.map((r) => r.k), y: scan.map((r) => r[key]), color: '#e8c547', size: 3 }]} refLines={[{ x1: k, y1: Math.min(...scan.map((r) => r[key])), x2: k, y2: Math.max(...scan.map((r) => r[key])), color: '#4ea1ff', dash: true, label: `K=${k}` }]} /></div>)}
            </div>}
            {kd && <div className="box" style={{ height: 180, marginTop: 8 }}><XYPlot title={`k-distance (k=${minPts}) — choose eps near the knee`} xLabel="points (sorted)" yLabel="distance" series={[{ kind: 'line', x: kd.map((_, i) => i), y: kd, color: '#f07db5' }]} refLines={[{ x1: 0, y1: eps, x2: kd.length, y2: eps, color: '#4ea1ff', dash: true, label: 'eps' }]} /></div>}
            {res && mat && lab && <>
              <Box title={`Cluster statistics (${res.K} statistical clusters, ordered by median ${res.ordKey})`} style={{ marginTop: 8 }}>
                <ClusterStatsTable labels={res.labelsFull} K={res.K} well={well} domain={domain} coreId={core?.id} mat={mat} />
              </Box>
              <div className="row" style={{ marginTop: 6 }}><span className="hint">Crossplot</span><select value={pxE} onChange={(e) => setPx(e.target.value)}>{fs.map((f) => <option key={f}>{f}</option>)}</select><select value={pyE} onChange={(e) => setPy(e.target.value)}>{fs.map((f) => <option key={f}>{f}</option>)}</select></div>
              <div className="grid2" style={{ height: 520, marginTop: 4 }}>
                <div className="box"><XYPlot title={`${pyE} vs ${pxE}`} logX={isLogF(pxE)} logY={isLogF(pyE)} xLabel={pxE} yLabel={pyE} series={[{ kind: 'scatter', x: mat.rows.map((r) => mat.cols[pxE]?.[r]), y: mat.rows.map((r) => mat.cols[pyE]?.[r]), colors: lab.map((l: number) => hfuColor(l)), size: 2.6 }]} legend={Array.from({ length: res.K }, (_, i) => ({ label: `Cluster ${i + 1}`, color: hfuColor(i + 1) }))} /></div>
                <div className="dcol" style={{ minHeight: 0 }}><DepthPlot title="Clusters vs depth" wellId={well.id} tracks={[{ width: 200, series: [{ depth: mat.rows.map((r) => mat.depth[r]), values: mat.rows.map((r) => mat.cols[pxE]?.[r]), label: pxE, color: '#333333', kind: 'dots', size: 2.6, log: isLogF(pxE), colors: lab.map((l: number) => hfuColor(l)) }] }, { width: 60, series: [{ depth: mat.rows.map((r) => mat.depth[r]), values: lab.map((l: number) => l), label: 'cluster', color: '#333333', kind: 'dots', size: 2.6, min: 0, max: Math.max(1, ...lab) + 1, colors: lab.map((l: number) => hfuColor(l)) }] }]} /></div>
              </div>
            </>}
          </div>
        </div>
      </div>
      <RightPanel><HfuSetsPanel /></RightPanel>
    </>
  );
}

function ClusterStatsTable({ labels, K, well, domain, coreId, mat }: { labels: Int16Array; K: number; well: WellMeta; domain: 'core' | 'log'; coreId?: string; mat: FeatureMatrix }) {
  const a = domain === 'core' && coreId ? registry.core(coreId) : undefined;
  const get = (n: string, alts: string[]): Float64Array | undefined => {
    if (a?.num.has(n)) return a.num.get(n)!;
    if (mat.cols[n]) return mat.cols[n];
    for (const x of alts) { const c = registry.curve(well.id, x); if (c && domain === 'log') return Float64Array.from(c); }
    return undefined;
  };
  const cols: Record<string, Float64Array> = {};
  const phi = get('PHI', ['PHIE', 'PHIT', 'CMRP']); const k = get('K', ['K', 'KTIM', 'K_PRED']); const rqi = get('RQI', ['RQI_LOG']); const fzi = get('FZI', ['FZI_LOG', 'FZI_PRED']);
  if (phi) cols.PHI = phi; if (k) cols.K = k; if (rqi) cols.RQI = rqi; if (fzi) cols.FZI = fzi;
  const st = unitStats(labels, cols, K);
  return <div className="tbl-wrap"><table className="t"><thead><tr><th>Cluster</th><th>N</th><th>Mean φ</th><th>Median φ</th><th>Mean K</th><th>Median K</th><th>Mean RQI</th><th>Mean FZI</th><th>P10 K</th><th>P50 K</th><th>P90 K</th></tr></thead>
    <tbody>{st.map((s, i) => <tr key={i}><td><span className="pill" style={{ background: hfuColor(i + 1) }} />Cluster {i + 1}</td><td className="num">{s.n}</td><td className="num">{fmt(s.mean_PHI, 3)}</td><td className="num">{fmt(s.median_PHI, 3)}</td><td className="num">{fmt(s.mean_K, 3)}</td><td className="num">{fmt(s.median_K, 3)}</td><td className="num">{fmt(s.mean_RQI, 3)}</td><td className="num">{fmt(s.mean_FZI, 3)}</td><td className="num">{fmt(s.p10_K, 3)}</td><td className="num">{fmt(s.p50_K, 3)}</td><td className="num">{fmt(s.p90_K, 3)}</td></tr>)}</tbody></table>
    <div className="hint">P10/P50/P90 = 10th/50th/90th percentiles (statistical convention, low→high).{!cols.K ? ' K not available in this domain.' : ''}</div></div>;
}
