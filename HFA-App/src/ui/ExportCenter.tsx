import { useState } from 'react';
import { S, useStore } from '../store/store';
import { registry } from '../data-engine/registry';
import { coreDepths } from '../data-engine/core';
import { RESERVOIR_KEY, scopeLabel, zoneMask } from '../data-engine/zones';
import { Box, Empty, Field, ModHead, Msgs, Sel, Tabs, useActiveWell, download } from './common';
import { toCSV, toLAS, toXLSX, colsToRows, safeName, exportFigure, type Col } from '../export/io';
import { buildReport, reportHTML, reportPDF } from '../export/report';
import { ensureAllCurves } from './QCDashboard';
import { projectFlags } from '../qc/qc';
import { PRED_LAYOUT } from './Prediction';
import { ALGO_LABEL, modelStatsRow } from './Regression';
import { exportProject } from '../project/project';
import { hfuColor } from '../util/num';

type Fmt = 'csv' | 'xlsx' | 'las' | 'json';
const SECTIONS: [string, string][] = [['project', 'Project information'], ['wells', 'Well information'], ['qc', 'Data QC'], ['reservoir', 'Reservoir intervals & petrophysical evaluation'], ['depth', 'Depth matching'], ['petro', 'Petrophysical methodology'], ['rqi', 'RQI/FZI methodology'], ['hfu', 'HFU identification'], ['crossplots', 'Crossplots'], ['clustering', 'Clustering'], ['regression', 'Regression models'], ['validation', 'Validation'], ['depthint', 'HFU depth interpretation'], ['stats', 'Key statistics'], ['limits', 'Limitations'], ['notes', 'Analyst notes']];

export function ExportCenter() {
  const [tab, setTab] = useState<'curves' | 'hfu' | 'models' | 'figures' | 'report'>('curves');
  return <>
    <ModHead title="Export & Report" sub="All exports are generated locally in the browser">
      <button className="btn" onClick={exportProject}>Export project (.hfaproj)</button>
    </ModHead>
    <Tabs value={tab} onChange={setTab} tabs={[{ v: 'curves', l: 'Curves' }, { v: 'hfu', l: 'HFU results' }, { v: 'models', l: 'Regression results' }, { v: 'figures', l: 'Figures' }, { v: 'report', l: 'Interpretation report' }]} />
    <div className="mod-b">{tab === 'curves' ? <CurvesExport /> : tab === 'hfu' ? <HfuExport /> : tab === 'models' ? <ModelsExport /> : tab === 'figures' ? <Figures /> : <ReportGen />}</div>
  </>;
}

function CurvesExport() {
  const well = useActiveWell(); const zone = useStore((s) => s.zone); useStore((s) => s.dataVersion);
  const [sel, setSel] = useState<string[]>([]); const [fmt, setFmt] = useState<Fmt>('las'); const [msgs, setMsgs] = useState<{ level: any; text: string }[]>([]);
  if (!well) return <Empty>No well.</Empty>;
  const cur = sel.length ? sel : well.curves.map((c) => c.mnemonic);
  const go = async () => {
    try {
      await registry.ensureCurves(well.id, cur);
      const d = registry.depth(well.id)!; const zm = zoneMask(well.id, zone); const idx: number[] = []; for (let i = 0; i < d.length; i++) if (!zm || zm[i]) idx.push(i);
      const cols: Col[] = [{ name: 'DEPTH', unit: well.depthUnit, data: idx.map((i) => d[i]) }, ...cur.map((m) => { const a = registry.curve(well.id, m)!; return { name: m, unit: well.curves.find((c) => c.mnemonic === m)?.unit, data: idx.map((i) => a[i]) }; })];
      const zl = zone === RESERVOIR_KEY ? 'reservoir' : zone.startsWith('RES:') ? 'res_' + (S().reservoirs.find((r) => 'RES:' + r.id === zone)?.name ?? '') : zone;
      const base = `${safeName(well.name)}${zone ? '_' + safeName(zl) : ''}`;
      if (fmt === 'csv') download(toCSV(cols), `${base}.csv`, 'text/csv');
      else if (fmt === 'xlsx') download(await toXLSX([{ name: 'curves', rows: colsToRows(cols) }, { name: 'provenance', rows: [['Curve', 'Unit', 'Source', 'Formula / origin', 'Version', 'Missing data'], ...cur.map((m) => { const c = well.curves.find((x) => x.mnemonic === m)!; return [m, c.unit, c.source, c.calc?.formula ?? 'measured', c.calc ? `v${c.calc.version}` : '', c.calc?.missing ?? '']; })] }]), `${base}.xlsx`);
      else if (fmt === 'las') { if (zone) setMsgs([{ level: 'INFO', text: 'LAS export always writes the full well grid (scope ignored); curves computed on the reservoir are NULL outside it.' }]); download(toLAS(well, cur), `${base}.las`, 'text/plain'); }
      else download(JSON.stringify({ well: { name: well.name, uwi: well.uwi, depthUnit: well.depthUnit }, curves: well.curves.filter((c) => cur.includes(c.mnemonic)).map((c) => ({ ...c, stats: undefined })), data: Object.fromEntries(cols.map((c) => [c.name, Array.from(c.data as ArrayLike<number>, (v) => (v === v ? v : null))])) }), `${base}.json`, 'application/json');
      S().log(`Exported ${cur.length} curves of ${well.name} as ${fmt.toUpperCase()}${zone ? ` (${scopeLabel(zone, well.id)})` : ''}`);
    } catch (e: any) { setMsgs([{ level: 'CRITICAL', text: e.message }]); }
  };
  return <div className="split">
    <Box title="Options">
      <Field label="Format"><Sel value={fmt} onChange={setFmt} options={[{ v: 'las', l: 'LAS 2.0' }, { v: 'csv', l: 'CSV' }, { v: 'xlsx', l: 'XLSX (with provenance sheet)' }, { v: 'json', l: 'JSON' }]} /></Field>
      <div className="row"><button className="btn sm" onClick={() => setSel(well.curves.map((c) => c.mnemonic))}>all</button><button className="btn sm" onClick={() => setSel(well.curves.filter((c) => c.calc).map((c) => c.mnemonic))}>calculated only</button><button className="btn sm" onClick={() => setSel([])}>clear</button></div>
      <div className="hint">{sel.length ? `${sel.length} selected` : 'Nothing selected → all curves'} · the global analysis scope (reservoir / zone) applies to CSV/XLSX/JSON.</div>
      <button className="btn pri" style={{ marginTop: 6 }} onClick={go}>Export {well.name}</button>
      <Msgs items={msgs} />
    </Box>
    <div className="tbl-wrap" style={{ maxHeight: 560 }}><table className="t"><thead><tr><th /><th>Curve</th><th>Unit</th><th>Type</th><th>Origin</th></tr></thead><tbody>
      {well.curves.map((c) => <tr key={c.mnemonic}><td><input type="checkbox" checked={sel.includes(c.mnemonic)} onChange={(e) => setSel(e.target.checked ? [...sel, c.mnemonic] : sel.filter((x) => x !== c.mnemonic))} /></td><td>{c.mnemonic}</td><td className="dim">{c.unit}</td><td className="dim">{c.category}</td><td className="dim">{c.calc ? `${c.calc.kind} v${c.calc.version}` : c.source}</td></tr>)}
    </tbody></table></div>
  </div>;
}

function HfuExport() {
  const sets = useStore((s) => s.hfuSets);
  if (!sets.length) return <Empty>No HFU / cluster sets.</Empty>;
  const exp = async (id: string, kind: 'csv' | 'xlsx' | 'json') => {
    const h = sets.find((x) => x.id === id)!; const st = S();
    const unitRows = [['Unit', 'Label', 'Status', 'FZI min', 'FZI max', 'N', 'Mean FZI', 'Mean PHI', 'Median K'], ...h.units.map((u) => [u.id, u.label, u.status, u.fziMin ?? '', u.fziMax === Infinity ? 'inf' : u.fziMax ?? '', u.stats?.n ?? '', u.stats?.mean_FZI ?? '', u.stats?.mean_PHI ?? '', u.stats?.median_K ?? ''])];
    let sample: Col[] = [];
    if (h.domain === 'core' && h.coreId && h.labels) { const c = st.cores.find((x) => x.id === h.coreId)!; const a = registry.core(c.id)!; const { original, shifted } = coreDepths(c, a); const g = (n: string) => a.num.get(n) ?? new Float64Array(c.n).fill(NaN);
      sample = [{ name: 'DEPTH_ORIGINAL', unit: c.depthUnit, data: original }, { name: 'DEPTH_SHIFTED', unit: c.depthUnit, data: shifted }, { name: 'PHI', unit: 'v/v', data: g('PHI') }, { name: 'K', unit: 'mD', data: g('K') }, { name: 'RQI', unit: 'um', data: g('RQI') }, { name: 'FZI', unit: 'um', data: g('FZI') }, { name: 'UNIT', data: h.labels }, { name: 'LABEL', data: h.labels.map((l) => h.units.find((u) => u.id === l)?.label ?? '') }, { name: 'STATUS', data: h.labels.map((l) => h.units.find((u) => u.id === l)?.status ?? '') }, { name: 'EXCLUDED', data: Array.from(a.excluded) }]; }
    else if (h.curve) { await registry.ensureCurves(h.wellId, [h.curve]); const d = registry.depth(h.wellId)!; sample = [{ name: 'DEPTH', data: d }, { name: h.curve, data: registry.curve(h.wellId, h.curve)! }]; }
    const base = safeName(h.name);
    if (kind === 'csv') download(toCSV(sample), `${base}_samples.csv`, 'text/csv');
    else if (kind === 'xlsx') download(await toXLSX([{ name: 'units', rows: unitRows }, { name: 'samples', rows: colsToRows(sample) }, { name: 'method', rows: [['Name', h.name], ['Method', h.method], ['Algorithm', h.algorithm ?? ''], ['Features', h.features.join(', ')], ['Scaling', h.scaling ?? ''], ['Boundaries (um)', (h.boundaries ?? []).join(', ')], ['Created', h.createdAt]] }]), `${base}.xlsx`);
    else download(JSON.stringify({ ...h, labels: h.labels }, null, 1), `${base}.json`, 'application/json');
    S().log(`Exported HFU set "${h.name}" (${kind.toUpperCase()})`);
  };
  return <Box title="HFU / cluster sets"><table className="t"><thead><tr><th>Set</th><th>Method</th><th>Units</th><th>Export</th></tr></thead><tbody>
    {sets.map((h) => <tr key={h.id}><td>{h.name}</td><td className="dim">{h.method}</td><td>{h.units.map((u) => <span key={u.id} className="pill" style={{ background: hfuColor(u.id) }} title={u.label} />)}</td><td><button className="btn sm" onClick={() => exp(h.id, 'csv')}>CSV</button> <button className="btn sm" onClick={() => exp(h.id, 'xlsx')}>XLSX</button> <button className="btn sm" onClick={() => exp(h.id, 'json')}>JSON</button></td></tr>)}
  </tbody></table></Box>;
}

function ModelsExport() {
  const models = useStore((s) => s.models); const vals = useStore((s) => s.validations);
  if (!models.length) return <Empty>No regression models.</Empty>;
  const xlsx = async () => {
    const summary = [['Model', 'Target', 'Algorithm', 'Features', 'Groups', 'N', 'R2', 'AdjR2', 'RMSE', 'MAE', 'AIC', 'BIC', 'Validation', 'Val R2', 'Val RMSE', 'Created'], ...models.map((m) => { const s = modelStatsRow(m); const v = [...vals].reverse().find((x) => x.modelId === m.id); return [m.name, m.targetTransform === 'log10' ? `log10(${m.target})` : m.target, ALGO_LABEL[m.algorithm], m.features.join(', '), m.groupBy === 'hfu' ? m.subModels.length : 'global', s.n, s.r2, s.adjR2, s.rmse, s.mae, s.aic, s.bic, v?.method ?? '', v?.metrics.r2 ?? '', v?.metrics.rmse ?? '', m.createdAt]; })];
    const sheets = [{ name: 'summary', rows: summary }, ...models.map((m) => ({ name: m.name.slice(0, 28), rows: m.subModels.flatMap((q) => [[`Group: ${q.group}`, `N=${q.n}`, `R2=${q.metrics.r2}`, `RMSE=${q.metrics.rmse}`], [q.equation], ['Term', 'Coefficient / importance', 'Std. error', 't', 'p', 'VIF'], ...(q.table ?? []).map((r) => [r.name, r.coef, r.se ?? '', r.t ?? '', r.p ?? '', r.vif ?? '']), ['Warnings', q.warnings.join(' | ')], []]) }))];
    download(await toXLSX(sheets), 'regression_results.xlsx'); S().log('Exported regression results (XLSX)');
  };
  return <Box title={`${models.length} models`}><div className="row"><button className="btn pri" onClick={xlsx}>Export XLSX (summary + per-model coefficients)</button><button className="btn" onClick={() => { download(JSON.stringify(models, null, 1), 'regression_models.json', 'application/json'); S().log('Exported regression models (JSON)'); }}>Export JSON (full, re-usable models)</button><button className="btn" onClick={() => download(JSON.stringify(vals, null, 1), 'validation_runs.json', 'application/json')}>Export validation runs (JSON)</button></div>
    <div className="hint" style={{ marginTop: 6 }}>JSON contains complete model definitions (coefficients, scaling, trees, training ranges) for audit or re-use.</div></Box>;
}

function Figures() {
  const wells = useStore((s) => s.wells); const layout = useStore((s) => s.layout); const cores = useStore((s) => s.cores); const tops = useStore((s) => s.tops); const annotations = useStore((s) => s.annotations);
  const [wid, setWid] = useState(wells[0]?.id ?? ''); const [lay, setLay] = useState<'current' | 'hfu'>('hfu'); const [h, setH] = useState(1400);
  const w = wells.find((x) => x.id === wid);
  const panel = async (k: 'png' | 'svg' | 'pdf') => {
    if (!w) return; await ensureAllCurves([w.id]);
    const tracks = lay === 'current' ? layout : PRED_LAYOUT; const widths = tracks.map((t) => t.width); const xs = widths.map((_, i) => widths.slice(0, i).reduce((s, x) => s + x, 0));
    exportFigure(k, `${w.name}_log_panel`, undefined, { o: { well: w, tracks, widths, xs, range: { top: w.start, base: w.stop }, cores: cores.filter((c) => c.wellId === w.id), tops: tops.filter((t) => t.wellId === w.id), annotations }, h });
  };
  return <div className="grid2">
    <Box title="Log panel (full well)">
      <Field label="Well"><select value={wid} onChange={(e) => setWid(e.target.value)}>{wells.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
      <Field label="Layout"><Sel value={lay} onChange={setLay} options={[{ v: 'hfu', l: 'HFU interpretation (GR · FZI · HFU · K · φ)' }, { v: 'current', l: 'Current log-viewer layout' }]} /></Field>
      <Field label="Height (px)"><input type="number" value={h} onChange={(e) => setH(+e.target.value)} /></Field>
      <div className="row"><button className="btn" onClick={() => panel('png')}>PNG</button><button className="btn" onClick={() => panel('svg')}>SVG (vector)</button><button className="btn" onClick={() => panel('pdf')}>PDF</button></div>
      <div className="hint">Visible-window exports are also available from the log viewer header (“Export view”).</div>
    </Box>
    <Box title="Crossplots, core-log match and QC">
      <div className="hint">Every plot in the application has PNG / SVG / PDF buttons that appear when you hover over it (crossplot studio, validation, clustering, depth-match before/after, reservoir quality, transitions…).</div>
      <div className="row" style={{ marginTop: 6 }}><button className="btn" onClick={async () => { await ensureAllCurves(); const f = projectFlags(S().zone); download(toCSV([{ name: 'Level', data: f.map((x) => x.level) }, { name: 'Well', data: f.map((x) => x.well) }, { name: 'Item', data: f.map((x) => x.item) }, { name: 'Message', data: f.map((x) => x.text) }], false), 'QC_report.csv', 'text/csv'); }}>QC report (CSV)</button>
        <button className="btn" onClick={() => S().go('depth')}>Open core-log match →</button><button className="btn" onClick={() => S().go('crossplot')}>Open crossplots →</button></div>
    </Box>
  </div>;
}

function ReportGen() {
  const proj = useStore((s) => s.project);
  const [notes, setNotes] = useState(proj.notes ?? ''); const [inc, setInc] = useState<Record<string, boolean>>({}); const [busy, setBusy] = useState(''); const [msgs, setMsgs] = useState<{ level: any; text: string }[]>([]);
  const gen = async (kind: 'html' | 'pdf') => {
    setBusy(`Building ${kind.toUpperCase()}…`); setMsgs([]);
    try {
      const r = await buildReport({ notes, include: inc });
      if (kind === 'html') download(reportHTML(r), `${safeName(proj.name)}_interpretation_report.html`, 'text/html');
      else download(await reportPDF(r), `${safeName(proj.name)}_interpretation_report.pdf`, 'application/pdf');
      S().log(`Generated interpretation report (${kind.toUpperCase()}, ${r.sections.length} sections)`); setMsgs([{ level: 'OK', text: `Report generated with ${r.sections.length} sections.` }]);
    } catch (e: any) { setMsgs([{ level: 'CRITICAL', text: `Report failed: ${e.message}` }]); } finally { setBusy(''); }
  };
  return <div className="split">
    <Box title="Sections">{SECTIONS.map(([k, l]) => <label key={k} className="cb" style={{ display: 'flex' }}><input type="checkbox" checked={inc[k] !== false} onChange={(e) => setInc({ ...inc, [k]: e.target.checked })} />{l}</label>)}</Box>
    <div className="col">
      <Box title="Generate Interpretation Report">
        <Field label="Analyst notes"><textarea rows={8} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Interpretation notes, caveats, recommendations…" /></Field>
        <div className="row"><button className="btn" onClick={() => { S().set({ project: { ...proj, notes }, dirty: true }); S().log('Updated analyst notes'); }}>Save notes to project</button>
          <button className="btn pri" disabled={!!busy} onClick={() => gen('pdf')}>Generate PDF</button><button className="btn pri" disabled={!!busy} onClick={() => gen('html')}>Generate HTML</button>{busy && <span className="tag warn">{busy}</span>}</div>
        <div className="hint" style={{ marginTop: 6 }}>Contents: project & well information, data QC, depth matching, petrophysical & RQI/FZI methodology, HFU identification, crossplots, clustering, regression, validation, HFU depth interpretation with log panels, key statistics, automatically compiled limitations and analyst notes.</div>
      </Box>
      <Msgs items={msgs} />
    </div>
  </div>;
}
