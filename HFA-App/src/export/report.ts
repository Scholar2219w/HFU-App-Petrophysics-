// "Generate Interpretation Report" (spec §30) → self-contained HTML and PDF.
import { FLAG_RE } from '../curves/catalog';
import { S } from '../store/store';
import { registry } from '../data-engine/registry';
import { coreDepths } from '../data-engine/core';
import { describeOp } from '../depth/transforms';
import { hfuEquations } from '../hfu/engine';
import { projectFlags } from '../qc/qc';
import { transitionStats } from '../hfu/transitions';
import { buildRQ } from '../ui/ReservoirQuality';
import { modelStatsRow, ALGO_LABEL } from '../ui/Regression';
import { ensureAllCurves } from '../ui/QCDashboard';
import { xyToCanvas, logToCanvas, customToCanvas } from './io';
import { scopeLabel } from '../data-engine/zones';
import { inputsFor, paramsFor, petroZones, summation } from '../petrophysics/quanti';
import { depthLayout, renderDepthPlot, type DepthTrack } from '../visualization/DepthPlot';
import type { PetroZoneParams } from '../types';
import { PRED_LAYOUT } from '../ui/Prediction';
import { DEMO_BANNER } from '../demo/demo';
import type { TrackDef } from '../store/store';
import { fmt, hfuColor, nowIso } from '../util/num';

type Block = { p: string } | { table: { head: string[]; rows: string[][] } } | { img: { url: string; jpg: string; w: number; h: number; caption: string } } | { eq: string };
export interface Section { h: string; blocks: Block[] }
export interface Report { title: string; subtitle: string; created: string; sections: Section[]; demo: boolean }

const img = (c: HTMLCanvasElement, caption: string): Block => ({ img: { url: c.toDataURL('image/png'), jpg: c.toDataURL('image/jpeg', 0.82), w: c.width / 2, h: c.height / 2, caption } });

export async function buildReport(opts: { notes: string; include: Record<string, boolean> }): Promise<Report> {
  await ensureAllCurves();
  const st = S(); const P = st.project; const secs: Section[] = []; const inc = (k: string) => opts.include[k] !== false;
  const demo = st.wells.some((w) => w.demo);
  if (inc('project')) secs.push({ h: 'Project information', blocks: [{ table: { head: ['Field', 'Value'], rows: [['Project', P.name], ['Field', P.field], ['Basin', P.basin], ['Formation', P.formation], ['Operator', P.operator], ['Region', P.region], ['Analyst', P.analyst], ['Date', P.date], ['Report generated', nowIso().slice(0, 16).replace('T', ' ')]].map((r) => r.map((x) => x || '—')) } }, ...(demo ? [{ p: `⚠ ${DEMO_BANNER}` } as Block] : [])] });
  if (inc('wells')) secs.push({ h: 'Well information', blocks: [{ table: { head: ['Well', 'UWI', 'Depth range', 'Step', 'Samples', 'Curves', 'Sources'], rows: st.wells.map((w) => [w.name, w.uwi || '—', `${fmt(w.start, 6)}–${fmt(w.stop, 6)} ${w.depthUnit}`, fmt(w.step, 4), String(w.nSamples), String(w.curves.length), w.sources.map((s) => `${s.name} (${s.format})`).join('; ')]) } }] });
  if (inc('qc')) { const f = projectFlags(); const c = (l: string) => f.filter((x) => x.level === l).length; secs.push({ h: 'Data QC', blocks: [{ p: `${c('CRITICAL')} critical, ${c('WARNING')} warning and ${c('INFO')} informational flags. Flags are informative; no data were removed automatically.` }, { table: { head: ['Level', 'Well', 'Item', 'Message'], rows: f.slice(0, 80).map((x) => [x.level, x.well, x.item, x.text]) } }] }); }
  if (inc('reservoir')) {
    const blocks: Block[] = [];
    const R = st.reservoirs.filter((r) => r.active);
    blocks.push(R.length ? { table: { head: ['Well', 'Reservoir interval', 'Top (m MD)', 'Base (m MD)', 'Gross (m)', 'Source'], rows: R.map((r) => [st.wells.find((w) => w.id === r.wellId)?.name ?? '', r.name, fmt(r.top, 6), fmt(r.base, 6), (r.base - r.top).toFixed(2), r.source]) } } : { p: 'No reservoir interval defined — analyses were run on the whole well.' });
    if (st.zone) blocks.push({ p: `Analysis scope at report time: ${scopeLabel(st.zone)}.` });
    for (const w of st.wells) {
      if (!w.curves.some((c) => c.mnemonic === 'PHIT_ND' || c.mnemonic === 'SW_AR' || c.mnemonic === 'VSH_GR')) continue;
      const zones = petroZones(w.id, st.petro.zonation); if (!zones.length) continue;
      const keys: [keyof PetroZoneParams, string][] = [['vshMethod', 'Vsh method'], ['grClean', 'GR clean'], ['grShale', 'GR shale'], ['rhoMa', 'ρma'], ['rhoFl', 'ρfl'], ['nphiShift', 'ΔN'], ['rhoSh', 'ρsh'], ['nphiSh', 'Nsh'], ['hcCorr', 'HC corr.'], ['a', 'a'], ['m', 'm'], ['n', 'n'], ['rw', 'Rw'], ['rwTemp', 'Rw T'], ['temperature', 'T'], ['vshCut', 'Vsh cut'], ['phiCut', 'φ cut'], ['swCut', 'Sw cut']];
      blocks.push({ p: `${w.name} — parameters per zone (${st.petro.zonation} zonation):` });
      blocks.push({ table: { head: ['Parameter', ...zones.map((z) => z.name)], rows: keys.map(([k, l]) => [l, ...zones.map((z) => { const v = paramsFor(w.id, z.key)[k] as any; return typeof v === 'number' ? fmt(v, 4) : String(v); })]) } });
      const g = (m: string) => registry.curve(w.id, m);
      if (g('NET_RES')) { const rows = summation(w.id, zones, { phi: g('PHIE_ND') ?? g('PHIT_ND'), sw: g('SW_AR'), vsh: g('VSH_GR'), netRes: g('NET_RES'), netPay: g('NET_PAY') });
        blocks.push({ table: { head: ['Zone', 'Top', 'Base', 'Gross', 'Net res.', 'N/G', 'Net pay', 'Avg φ', 'Avg Sw', 'Avg Vsh', 'HCPV'], rows: rows.map((r) => [r.name, fmt(r.top, 6), fmt(r.base, 6), r.gross.toFixed(2), r.netRes.toFixed(2), fmt(r.ntg, 3), r.netPay.toFixed(2), fmt(r.phiAvg, 3), fmt(r.swAvg, 3), fmt(r.vshAvg, 3), r.hcpv.toFixed(3)]) } }); }
      const d = registry.depth(w.id); if (d) {
        const S_ = (m: string, color: string, extra: any = {}) => (g(m) ? [{ depth: d, values: g(m)!, label: m, unit: w.curves.find((c) => c.mnemonic === m)?.unit ?? '', color, ...extra }] : []);
        const inp = inputsFor(w);
        const tracks: DepthTrack[] = [{ width: 130, series: [...S_(inp.gr, '#000000', { min: 0, max: 150 }), ...S_('VSH_GR', '#2b8a3e', { min: 0, max: 1, fill: 'left', fillColor: 'rgba(43,138,62,0.3)' })] }, { width: 130, series: S_(inp.rt, '#1c3ef0', { min: 0.2, max: 2000, log: true }) }, { width: 140, series: [...S_(inp.rhob, '#e00000', { min: 1.95, max: 2.95 }), ...S_(inp.nphi, '#1c3ef0', { min: 0.45, max: -0.15, dash: true })] }, { width: 140, series: [...S_('PHIT_ND', '#1c3ef0', { min: 0.45, max: 0 }), ...S_('PHIE_ND', '#0ca678', { min: 0.45, max: 0, fill: 'right', fillColor: 'rgba(12,166,120,0.2)' })] }, { width: 120, series: S_('SW_AR', '#000000', { min: 1, max: 0, fill: 'right', fillColor: 'rgba(80,200,230,0.45)' }) }].filter((t) => t.series.length) as DepthTrack[];
        const top = Math.min(...zones.map((z) => z.top)) - 5, base = Math.max(...zones.map((z) => z.base)) + 5;
        const p = { tracks, wellId: w.id, title: '' }; const L = depthLayout(p, 0); const H = 900;
        blocks.push(img(customToCanvas({ w: L.W, h: H, render: (ctx) => renderDepthPlot(ctx, L.W, H, p, L, { top, base }, null, 'light') }), `${w.name}: petrophysical evaluation on the reservoir (GR/VSH · Rt · RHOB/NPHI · PHIT/PHIE · SW_AR)`));
      }
    }
    secs.push({ h: 'Reservoir intervals & petrophysical evaluation', blocks });
  }
  if (inc('depth')) secs.push({ h: 'Depth matching', blocks: st.cores.length ? st.cores.flatMap((c) => [{ p: `${c.name} (${st.wells.find((w) => w.id === c.wellId)?.name}): ${c.depthOps.filter((o) => o.active).length} active reversible depth operation(s). Original core depths are preserved.` } as Block, ...(c.depthOps.length ? [{ table: { head: ['#', 'Operation', 'Method', 'Confidence', 'Marker', 'Active'], rows: c.depthOps.map((o, i) => [String(i + 1), describeOp(o), o.method ?? '', o.confidence ?? '', o.marker ?? '', o.active ? 'yes' : 'no']) } } as Block] : [])]) : [{ p: 'No core data loaded.' }] });
  if (inc('petro')) { const rows = st.wells.flatMap((w) => w.curves.filter((c) => c.calc && c.calc.kind === 'formula').map((c) => [w.name, c.mnemonic, c.calc!.formula, c.calc!.inputs.join(', '), c.calc!.units, `v${c.calc!.version}`, c.calc!.missing])); secs.push({ h: 'Petrophysical methodology', blocks: rows.length ? [{ p: 'All calculated curves with their exact formulas, inputs, units, version and missing-data handling:' }, { table: { head: ['Well', 'Curve', 'Formula', 'Inputs', 'Units', 'Ver.', 'Missing data'], rows } }] : [{ p: 'No formula-based curves were calculated.' }] }); }
  if (inc('rqi')) secs.push({ h: 'RQI / FZI methodology', blocks: [{ eq: hfuEquations(st.hfuConfig.rqiConst).join('\n') }, { table: { head: ['Core dataset', 'φ column / unit', 'k column / unit', 'Valid FZI samples', 'Excluded (QC)'], rows: st.cores.map((c) => { const a = registry.core(c.id); const f = a?.num.get('FZI'); return [c.name, `${c.map.phi ?? '—'} / ${c.phiUnit ?? 'UNCONFIRMED'}`, `${c.map.k ?? '—'} / ${c.kUnit ?? 'UNCONFIRMED'}`, String(f ? Array.from(f).filter((v, i) => v === v && !a!.excluded[i]).length : 0), String(a ? a.excluded.reduce((s, v) => s + (v ? 1 : 0), 0) : 0)]; }) } }, { p: 'Units are converted to φ (fraction) and k (mD) before calculation; calculation is blocked when either unit is not confirmed.' }] });
  if (inc('hfu')) secs.push({ h: 'HFU identification', blocks: st.hfuSets.length ? st.hfuSets.flatMap((h) => [{ p: `${h.name} — ${h.method}${h.algorithm ? ` (${h.algorithm})` : ''}; domain: ${h.domain}; features: ${h.features.join(', ')}${h.scaling ? `; scaling: ${h.scaling}` : ''}${h.boundaries?.length ? `; FZI thresholds: ${h.boundaries.map((b) => b.toPrecision(3)).join(' / ')} µm` : ''}.` } as Block, { table: { head: ['Unit', 'Label', 'Status', 'N', 'FZI range (µm)', 'Mean FZI', 'Mean φ', 'Median K (mD)'], rows: h.units.map((u) => [String(u.id), u.label, u.status, String(u.stats?.n ?? '—'), u.fziMin !== undefined ? `${fmt(u.fziMin, 3)}–${u.fziMax === Infinity ? '∞' : fmt(u.fziMax, 3)}` : '—', fmt(u.stats?.mean_FZI, 3), fmt(u.stats?.mean_PHI, 3), fmt(u.stats?.median_K, 3)]) } } as Block]) : [{ p: 'No HFU / cluster sets were created.' }] });
  if (inc('crossplots')) {
    const blocks: Block[] = [];
    for (const c of st.cores) {
      const a = registry.core(c.id); if (!a?.num.has('FZI')) continue;
      const set = st.hfuSets.find((h) => h.domain === 'core' && h.coreId === c.id);
      const act = (n: string) => Array.from(a.num.get(n)!, (v, i) => (a.excluded[i] ? NaN : v)); const col = act('FZI').map((_, i) => hfuColor(set?.labels?.[i] ?? 0) === '#333a44' ? '#9aa4b2' : hfuColor(set?.labels?.[i] ?? 0));
      const C = st.hfuConfig.rqiConst;
      blocks.push(img(xyToCanvas({ light: true, title: `${c.name}: RQI vs Φz${set ? ` (coloured by ${set.name})` : ''}`, logX: true, logY: true, xLabel: 'Φz (v/v)', yLabel: 'RQI (µm)', series: [{ kind: 'scatter', x: act('PHIZ'), y: act('RQI'), colors: col, size: 3 }], refLines: (set?.units ?? []).map((u) => ({ x1: 0.01, y1: (u.stats?.mean_FZI ?? 1) * 0.01, x2: 1, y2: u.stats?.mean_FZI ?? 1, color: u.color, dash: true })), xRange: [0.01, 1] }, 760, 470), 'Unit-slope lines represent constant FZI (mean FZI of each unit).'));
      blocks.push(img(xyToCanvas({ light: true, title: `${c.name}: core K vs φ`, logY: true, xLabel: 'φ (v/v)', yLabel: 'K (mD)', series: [{ kind: 'scatter', x: act('PHI'), y: act('K'), colors: col, size: 3 }, ...(set?.boundaries ?? []).map((f) => { const x = Array.from({ length: 60 }, (_, i) => 0.01 + i * 0.006); return { kind: 'line' as const, x, y: x.map((p) => p * Math.pow((f * p) / (1 - p) / C, 2)), color: '#8a95a5', dash: true, width: 1 }; })] }, 760, 470), 'Dashed curves: iso-FZI unit boundaries.'));
      void coreDepths;
    }
    secs.push({ h: 'Crossplots', blocks: blocks.length ? blocks : [{ p: 'No core RQI/FZI results available.' }] });
  }
  if (inc('clustering')) { const f = st.hfuSets.filter((h) => h.method.startsWith('F')); secs.push({ h: 'Clustering', blocks: f.length ? [{ table: { head: ['Set', 'Algorithm', 'Features', 'Scaling', 'K', 'Validated as HFU'], rows: f.map((h) => [h.name, h.algorithm ?? '', h.features.join(', '), h.scaling ?? '', String(h.units.length), `${h.units.filter((u) => u.status === 'Hydraulic Flow Unit').length}/${h.units.length}`]) } }, { p: 'Statistical clusters are not geological HFUs until validated by the analyst.' }] : [{ p: 'No multi-feature clustering was performed.' }] }); }
  if (inc('regression')) secs.push({ h: 'Regression models', blocks: st.models.length ? [{ table: { head: ['Model', 'Target', 'Algorithm', 'Features', 'Groups', 'N', 'R²', 'Adj R²', 'RMSE', 'AIC'], rows: st.models.map((m) => { const s = modelStatsRow(m); return [m.name, m.targetTransform === 'log10' ? `log10(${m.target})` : m.target, ALGO_LABEL[m.algorithm], m.features.join(', '), m.groupBy === 'hfu' ? String(m.subModels.length) : 'global', String(s.n), fmt(s.r2, 3), fmt(s.adjR2, 3), fmt(s.rmse, 3), fmt(s.aic, 4)]; }) } }, ...st.models.flatMap((m) => m.subModels.map((q) => ({ eq: `${m.name} [${q.group}]  N=${q.n}\n${q.equation}` } as Block)))] : [{ p: 'No regression models.' }] });
  if (inc('validation')) {
    const blocks: Block[] = st.validations.length ? [{ table: { head: ['Model', 'Method', 'N', 'R²', 'RMSE', 'MAE', 'Median AE'], rows: st.validations.map((v) => [st.models.find((m) => m.id === v.modelId)?.name ?? '(deleted)', v.method, String(v.metrics.n), fmt(v.metrics.r2, 3), fmt(v.metrics.rmse, 3), fmt(v.metrics.mae, 3), fmt(v.metrics.medae, 3)]) } }] : [{ p: 'No validation runs.' }];
    for (const v of st.validations.slice(-3)) { const lo = Math.min(...v.actual, ...v.predicted), hi = Math.max(...v.actual, ...v.predicted); blocks.push(img(xyToCanvas({ light: true, title: `Out-of-sample predicted vs actual — ${st.models.find((m) => m.id === v.modelId)?.name ?? ''} (${v.method})`, xLabel: 'actual', yLabel: 'predicted', series: [{ kind: 'scatter', x: v.actual, y: v.predicted, color: '#4ea1ff', size: 3 }], refLines: [{ x1: lo, y1: lo, x2: hi, y2: hi, color: '#aaa', dash: true, label: '1:1' }] }, 700, 430), `Validation R² ${fmt(v.metrics.r2, 3)}, RMSE ${fmt(v.metrics.rmse, 3)}`)); }
    secs.push({ h: 'Validation', blocks });
  }
  if (inc('depthint')) {
    const blocks: Block[] = [];
    for (const w of st.wells) {
      const hc = w.curves.find((c) => c.mnemonic === 'HFU_PRED') ? 'HFU_PRED' : w.curves.find((c) => c.discrete && !FLAG_RE.test(c.mnemonic) && !['EXTRAP', 'HFU_CORE'].includes(c.mnemonic))?.mnemonic; if (!hc) continue;
      const tracks: TrackDef[] = PRED_LAYOUT.map((t) => (t.kind === 'hfu' ? { ...t, hfu: { source: 'curve', curve: hc } } : t));
      const widths = tracks.map((t) => t.width); const xs = widths.map((_, i) => widths.slice(0, i).reduce((s, x) => s + x, 0));
      blocks.push(img(logToCanvas({ well: w, tracks, widths, xs, range: { top: w.start, base: w.stop }, cores: st.cores.filter((c) => c.wellId === w.id), tops: st.tops.filter((t) => t.wellId === w.id), annotations: st.annotations }, 900, 1.5), `${w.name}: HFU depth interpretation (${hc}), full well.`));
      const ts = transitionStats(w.id, hc); if (ts) blocks.push({ table: { head: ['Unit', 'Intervals', 'Mean thickness', 'Total thickness', 'Persistence'], rows: ts.units.map((u) => [String(u), String(ts.thickByUnit[u].n), fmt(ts.thickByUnit[u].mean, 3), fmt(ts.thickByUnit[u].total, 4), fmt(ts.persistence[u], 3)]) } }, { p: `${w.name}: ${ts.intervals.length} intervals, ${ts.nTransitions} transitions (${fmt(ts.perHundred, 3)} per 100 ${w.depthUnit}), vertical continuity ${(100 * ts.continuity).toFixed(1)} %.` });
    }
    secs.push({ h: 'HFU depth interpretation', blocks: blocks.length ? blocks : [{ p: 'No continuous HFU curve (e.g. HFU_PRED) has been generated.' }] });
  }
  if (inc('stats')) { const set = st.hfuSets.find((h) => h.domain === 'core'); const t = set ? buildRQ(set.id, null, '') : null; secs.push({ h: 'Key statistics (reservoir quality per HFU)', blocks: t ? [{ p: `Source: ${t.source}. Units listed in numerical order; no subjective quality score is implied.` }, { table: { head: ['Unit', 'Status', 'N', 'Mean φ', 'Geo-mean K (mD)', 'Median K (mD)', 'Geo-mean RQI', 'Geo-mean FZI'], rows: t.units.map((u) => [u.label, u.status, String(u.stats.PHI?.n ?? 0), fmt(u.stats.PHI?.mean, 3), fmt(u.stats.K?.geomean, 3), fmt(u.stats.K?.median, 3), fmt(u.stats.RQI?.geomean, 3), fmt(u.stats.FZI?.geomean, 3)]) } }] : [{ p: 'No core HFU set available.' }] }); }
  if (inc('limits')) {
    const L: string[] = [];
    if (demo) L.push(`${DEMO_BANNER}: results are for software testing only.`);
    st.cores.forEach((c) => { if (!c.phiUnit || !c.kUnit) L.push(`Core "${c.name}": porosity/permeability units are not confirmed.`); if (!c.depthOps.some((o) => o.active)) L.push(`Core "${c.name}": no core-to-log depth shift applied.`); });
    st.hfuSets.forEach((h) => { const n = h.units.filter((u) => u.status !== 'Hydraulic Flow Unit').length; if (n) L.push(`"${h.name}": ${n} of ${h.units.length} units are statistical clusters not yet validated as HFUs.`); });
    st.models.forEach((m) => { if (!st.validations.some((v) => v.modelId === m.id)) L.push(`${m.name} has not been validated out-of-sample.`); m.subModels.forEach((q) => { if (q.n < 30) L.push(`${m.name} [${q.group}] was fitted on only ${q.n} samples.`); }); });
    st.validations.forEach((v) => { if (/random/i.test(v.method)) L.push(`A random split was used for validation (${v.method}); metrics for depth-correlated data are optimistic.`); });
    st.wells.forEach((w) => { const e = registry.curve(w.id, 'EXTRAP'); if (e) { let n = 0, x = 0; for (const v of e) if (v === v) { n++; if (v > 0) x++; } if (n && x / n > 0.05) L.push(`${w.name}: ${((100 * x) / n).toFixed(1)}% of predicted samples are extrapolated beyond the training range.`); } });
    L.push('Regression relationships are correlational; they do not establish causation.', 'Predicted FZI/HFU away from cored intervals inherit the uncertainty of the regression model and of the log inputs.');
    secs.push({ h: 'Limitations', blocks: L.map((p) => ({ p: `• ${p}` })) });
  }
  if (inc('notes')) secs.push({ h: 'Analyst notes', blocks: [{ p: opts.notes || P.notes || '—' }] });
  return { title: `Interpretation Report — ${P.name}`, subtitle: 'HFA — Hydraulic Flow Analysis Suite · Integrated Hydraulic Flow Unit, Petrophysics & Reservoir Quality Analysis', created: nowIso(), sections: secs, demo };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function reportHTML(r: Report): string {
  const body = r.sections.map((s, i) => `<h2>${i + 1}. ${esc(s.h)}</h2>` + s.blocks.map((b) => ('p' in b ? `<p>${esc(b.p)}</p>` : 'eq' in b ? `<pre>${esc(b.eq)}</pre>` : 'table' in b ? `<table><thead><tr>${b.table.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${b.table.rows.map((row) => `<tr>${row.map((c) => `<td>${esc(String(c))}</td>`).join('')}</tr>`).join('')}</tbody></table>` : `<figure><img src="${b.img.url}" style="max-width:100%"/><figcaption>${esc(b.img.caption)}</figcaption></figure>`)).join('')).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.title)}</title><style>body{font:13px/1.45 'Segoe UI',system-ui,sans-serif;max-width:1000px;margin:24px auto;color:#1a1f26;padding:0 16px}h1{font-size:22px;margin:0}h2{font-size:16px;border-bottom:1px solid #ccd;padding-bottom:3px;margin-top:26px}table{border-collapse:collapse;width:100%;font-size:11.5px;margin:6px 0}th,td{border:1px solid #d5dae1;padding:3px 6px;text-align:left;vertical-align:top}th{background:#eef1f5}pre{background:#f4f6f8;padding:8px;border:1px solid #dde;font-size:12px;white-space:pre-wrap}figure{margin:10px 0}figcaption{font-size:11px;color:#556}.demo{background:#fff1e0;border:1px solid #f0a050;padding:6px 10px;font-weight:600}</style></head><body><h1>${esc(r.title)}</h1><div style="color:#667">${esc(r.subtitle)}<br>Generated ${esc(r.created.slice(0, 16).replace('T', ' '))} — computed locally in the browser.</div>${r.demo ? `<p class="demo">${DEMO_BANNER}</p>` : ''}${body}</body></html>`;
}

const PDF_MAP: Record<string, string> = { 'φ': 'phi', 'Φ': 'Phi', 'ϕ': 'phi', 'μ': 'u', '√': 'sqrt', '·': '*', '–': '-', '—': '-', '−': '-', '→': '->', '←': '<-', '↔': '<->', '≤': '<=', '≥': '>=', '≠': '!=', '∞': 'inf', '≈': '~', '⚠': '!', '•': '-', '…': '...', '‘': "'", '’': "'", '“': '"', '”': '"', 'Σ': 'Sum', 'σ': 'sigma', 'ρ': 'rho', 'α': 'alpha', 'β': 'beta', 'Δ': 'd', 'δ': 'd', 'λ': 'lambda', 'τ': 'tau', 'θ': 'theta', 'χ': 'chi', 'ε': 'e', '✓': 'yes', '✗': 'no', '▲': '^', '▼': 'v', '●': '*', '⁻': '-' };
/** jsPDF's standard fonts only cover WinAnsi — transliterate everything else so nothing prints as '?'. */
export const pdfSafe = (t: string) => t.replace(/[^\x20-\x7E\xA0-\xFF\n]/g, (c) => PDF_MAP[c] ?? (c.normalize('NFKD').replace(/[^\x20-\x7E]/g, '') || '?'));

export async function reportPDF(r: Report): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  const W = 595, H = 842, M = 40, CW = W - 2 * M;
  let y = M;
  const need = (h: number) => { if (y + h > H - M) { pdf.addPage(); y = M; } };
  const text = (t: string, size = 9.5, bold = false, color = 20) => { pdf.setFont('helvetica', bold ? 'bold' : 'normal'); pdf.setFontSize(size); pdf.setTextColor(color); for (const line of pdf.splitTextToSize(pdfSafe(t), CW) as string[]) { need(size * 1.3); pdf.text(line, M, y + size); y += size * 1.3; } };
  text(r.title, 17, true); text(r.subtitle, 9, false, 90); text(`Generated ${r.created.slice(0, 16).replace('T', ' ')} - computed locally in the browser.`, 8.5, false, 110); y += 6;
  if (r.demo) text(DEMO_BANNER, 11, true, 160);
  r.sections.forEach((s, i) => {
    need(40); y += 8; text(`${i + 1}. ${s.h}`, 13, true); pdf.setDrawColor(190); pdf.line(M, y, W - M, y); y += 5;
    for (const b of s.blocks) {
      if ('p' in b) { text(b.p); y += 3; }
      else if ('eq' in b) { pdf.setFont('courier', 'normal'); text(b.eq, 8.5); y += 3; }
      else if ('img' in b) { const sc = Math.min(1, CW / b.img.w); const hh = b.img.h * sc; if (hh > H - 2 * M - 20) { const s2 = (H - 2 * M - 30) / b.img.h; need(b.img.h * s2 + 16); pdf.addImage(b.img.jpg, 'JPEG', M, y, b.img.w * s2, b.img.h * s2); y += b.img.h * s2 + 4; } else { need(hh + 16); pdf.addImage(b.img.jpg, 'JPEG', M, y, b.img.w * sc, hh); y += hh + 4; } text(b.img.caption, 8, false, 90); y += 4; }
      else {
        const n = b.table.head.length; const lens = b.table.head.map((h, j) => Math.max(h.length, ...b.table.rows.slice(0, 40).map((row) => Math.min(60, String(row[j] ?? '').length)))); const tot = lens.reduce((a, c) => a + c, 0) || 1; const cw = lens.map((l) => (CW * l) / tot);
        const fs = n > 7 ? 6.5 : 7.5; pdf.setFontSize(fs);
        const drawRow = (cells: string[], head: boolean) => {
          pdf.setFont('helvetica', head ? 'bold' : 'normal'); const wrapped = cells.map((c, j) => pdf.splitTextToSize(pdfSafe(String(c ?? '')), cw[j] - 4) as string[]); const rh = Math.max(...wrapped.map((w) => w.length)) * fs * 1.2 + 4;
          need(rh); if (head) { pdf.setFillColor(235, 238, 243); pdf.rect(M, y, CW, rh, 'F'); } let x = M; pdf.setTextColor(25);
          wrapped.forEach((w, j) => { w.forEach((line, k) => pdf.text(line, x + 2, y + fs + 1 + k * fs * 1.2)); pdf.setDrawColor(210); pdf.rect(x, y, cw[j], rh); x += cw[j]; }); y += rh;
        };
        drawRow(b.table.head, true); b.table.rows.forEach((row) => drawRow(row, false)); y += 6;
      }
    }
  });
  const pages = pdf.getNumberOfPages(); for (let p = 1; p <= pages; p++) { pdf.setPage(p); pdf.setFontSize(7.5); pdf.setTextColor(130); pdf.text(`${pdfSafe(r.title)} - page ${p}/${pages}`, M, H - 20); }
  return pdf.output('blob');
}
