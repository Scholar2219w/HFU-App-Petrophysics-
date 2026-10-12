import { useEffect, useMemo, useState } from 'react';
import { S, useStore, activeCore } from '../store/store';
import { registry } from '../data-engine/registry';
import { coreDepths, sampleLogAt } from '../data-engine/core';
import { Box, Empty, Field, ModHead, Num, Sel } from './common';
import { RightPanel } from './RightPanel';
import { XYPlot, type Series, type Symbol } from '../visualization/XYPlot';
import { fit1d, movingAverage, FIT_LABEL, type Fit1D, type Fit1DResult } from '../regression/fit1d';
import { fmt, hfuColor, isNum, PALETTE } from '../util/num';
import { CoreSelector } from './CoreManager';
import { ZoneSelect } from './common';
import { inZone, zoneMask } from '../data-engine/zones';

const CORE_COLS = ['PHI', 'K', 'RQI', 'FZI', 'PHIZ', 'LOG_FZI'];
const LOGGY = /^(K|RQI|FZI|PHIZ|K_.*|KTIM|KSDR|RQI_.*|FZI_.*|AT\d0|RT|RXO.*|ILD|LLD|T2LM|PERM.*)$/i;
const ramp = (t: number) => { const c = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]]; const x = Math.max(0, Math.min(0.9999, t)) * 4; const i = Math.floor(x), f = x - i; const m = c[i].map((v, k) => Math.round(v + (c[i + 1][k] - v) * f)); return `rgb(${m[0]},${m[1]},${m[2]})`; };

export function Crossplots() {
  const wells = useStore((s) => s.wells); const core = useStore((s) => activeCore(s)); const hfuSets = useStore((s) => s.hfuSets); useStore((s) => s.dataVersion);
  const preset = useStore((s) => s.crossplotPreset); const zone = useStore((s) => s.zone); const activeWellId = useStore((s) => s.activeWellId);
  const [src, setSrc] = useState<'log' | 'core' | 'both'>(core ? 'core' : 'log');
  const [wellIds, setWellIds] = useState<string[]>(() => (activeWellId ? [activeWellId] : wells.slice(0, 1).map((w) => w.id)));
  const [x, setX] = useState('PHI'); const [y, setY] = useState('K');
  const [lx, setLx] = useState(false); const [ly, setLy] = useState(true);
  const [colorBy, setColorBy] = useState<string>('hfu'); const [colorCurve, setColorCurve] = useState('');
  const [hfuSetId, setHfuSetId] = useState<string>('');
  const [fits, setFits] = useState<Fit1D[]>(['power']); const [perGroup, setPerGroup] = useState(false);
  const [oneOne, setOneOne] = useState(false); const [ma, setMa] = useState(false); const [maWin, setMaWin] = useState(15);
  const [density, setDensity] = useState<'none' | 'hexbin' | 'contours'>('none');
  const [valIv, setValIv] = useState<[number, number] | null>(null);
  const [sel, setSel] = useState<number[]>([]);
  useEffect(() => { if (preset) { setX(preset.x); setY(preset.y); if (preset.logx !== undefined) setLx(preset.logx); if (preset.logy !== undefined) setLy(preset.logy); if (preset.source) setSrc(preset.source); S().set({ crossplotPreset: undefined }); } }, [preset]);

  const coreWell = wells.find((w) => w.id === core?.wellId);
  const curveNames = useMemo(() => [...new Set(wells.filter((w) => wellIds.includes(w.id) || w.id === coreWell?.id).flatMap((w) => w.curves.map((c) => c.mnemonic)))].sort(), [wells, wellIds, coreWell]);
  const axisOpts = src === 'log' ? curveNames : [...CORE_COLS.map((c) => c), ...(core ? [...(registry.core(core.id)?.num.keys() ?? [])].filter((c) => !CORE_COLS.includes(c)) : []), ...curveNames];

  const data = useMemo(() => {
    const X: number[] = [], Y: number[] = [], D: number[] = [], sym: Symbol[] = [], srcTag: ('core' | 'log')[] = [], wIdx: number[] = [], rowIdx: number[] = [], grp: number[] = [], cval: number[] = [], facies: string[] = [];
    const hs = hfuSets.find((h) => h.id === hfuSetId);
    const addLog = (w: typeof wells[number], wi: number) => {
      const d = registry.depth(w.id); const xa = registry.curve(w.id, x); const ya = registry.curve(w.id, y); if (!d || !xa || !ya) return;
      const g = colorBy === 'hfu' || colorBy === 'cluster' ? registry.curve(w.id, hs?.curve ?? (w.curves.some((c) => c.mnemonic === 'HFU_PRED') ? 'HFU_PRED' : 'HFU_CORE')) : undefined;
      const cc = colorBy === 'vsh' ? registry.curve(w.id, w.curves.find((c) => c.family === 'VSH')?.mnemonic ?? 'VSH') : colorBy === 'curve' ? registry.curve(w.id, colorCurve) : undefined;
      const zm = zoneMask(w.id, zone); if (!zm) return;
      for (let i = 0; i < d.length; i++) { if (!zm[i] || !isNum(xa[i]) || !isNum(ya[i])) continue; X.push(xa[i]); Y.push(ya[i]); D.push(d[i]); sym.push(valIv && d[i] >= valIv[0] && d[i] <= valIv[1] ? 'triangle' : 'square'); srcTag.push('log'); wIdx.push(wi); rowIdx.push(i); grp.push(g ? (isNum(g[i]) ? g[i] : 0) : 0); cval.push(cc ? cc[i] : NaN); facies.push(''); }
    };
    if (src !== 'core') wells.forEach((w, wi) => { if (wellIds.includes(w.id)) addLog(w, wi); });
    if (src !== 'log' && core && coreWell) {
      const a = registry.core(core.id); if (a) {
        const { shifted } = coreDepths(core, a);
        const col = (n: string) => a.num.get(n) ?? (coreWell.curves.some((c) => c.mnemonic === n) ? sampleLogAt(coreWell, n, shifted) : undefined);
        const xa = col(x), ya = col(y);
        const cc = colorBy === 'vsh' ? col(coreWell.curves.find((c) => c.family === 'VSH')?.mnemonic ?? 'VSH') : colorBy === 'curve' ? col(colorCurve) : undefined;
        const labels = hs && hs.domain === 'core' && hs.coreId === core.id ? hs.labels : hfuSets.find((h) => h.domain === 'core' && h.coreId === core.id)?.labels;
        const fac = core.map.facies ? a.text.get(core.map.facies) : undefined;
        if (xa && ya) for (let i = 0; i < core.n; i++) { if (a.excluded[i] || !inZone(coreWell.id, zone, shifted[i]) || !isNum(xa[i]) || !isNum(ya[i])) continue; X.push(xa[i]); Y.push(ya[i]); D.push(shifted[i]); sym.push(valIv && shifted[i] >= valIv[0] && shifted[i] <= valIv[1] ? 'triangle' : 'circle'); srcTag.push('core'); wIdx.push(wells.indexOf(coreWell)); rowIdx.push(i); grp.push(labels?.[i] ?? 0); cval.push(cc ? cc[i] : NaN); facies.push(fac?.[i] ?? ''); }
      }
    }
    return { X, Y, D, sym, srcTag, wIdx, rowIdx, grp, cval, facies };
  }, [src, wellIds, x, y, colorBy, colorCurve, hfuSetId, core?.id, valIv, S().dataVersion, hfuSets, zone]);

  const facList = [...new Set(data.facies.filter(Boolean))];
  const colors = data.X.map((_, i) => {
    switch (colorBy) {
      case 'hfu': case 'cluster': return data.grp[i] > 0 ? hfuColor(data.grp[i]) : '#56606e';
      case 'facies': return data.facies[i] ? PALETTE[facList.indexOf(data.facies[i]) % PALETTE.length] : '#56606e';
      case 'well': return wells[data.wIdx[i]]?.color ?? '#999';
      case 'source': return data.srcTag[i] === 'core' ? '#ffffff' : '#4ea1ff';
      default: return '#4ea1ff';
    }
  });
  let cMin = Infinity, cMax = -Infinity;
  if (['depth', 'vsh', 'curve'].includes(colorBy)) {
    const v = colorBy === 'depth' ? data.D : data.cval; for (const q of v) if (isNum(q)) { cMin = Math.min(cMin, q); cMax = Math.max(cMax, q); }
    v.forEach((q, i) => (colors[i] = isNum(q) ? ramp((q - cMin) / (cMax - cMin || 1)) : '#333'));
  }
  const selSet = new Set(sel);
  const series: Series[] = [{ kind: 'scatter', x: data.X, y: data.Y, colors, symbols: data.sym, size: src === 'log' ? 2 : 2.8, selectable: true, highlight: selSet, alpha: density === 'contours' ? 0.5 : 1, tip: (i) => `${data.srcTag[i]} · ${wells[data.wIdx[i]]?.name}\nDepth ${data.D[i].toFixed(2)}\n${x} ${fmt(data.X[i], 4)}\n${y} ${fmt(data.Y[i], 4)}${data.grp[i] ? `\nunit ${data.grp[i]}` : ''}${data.facies[i] ? `\n${data.facies[i]}` : ''}` }];
  const results: (Fit1DResult & { group: string; color: string })[] = [];
  const groups = perGroup ? [...new Set(data.grp.filter((g) => g > 0))].sort((a, b) => a - b) : [0];
  for (const g of groups) for (const f of fits) {
    const xs = data.X.filter((_, i) => !perGroup || data.grp[i] === g), ys = data.Y.filter((_, i) => !perGroup || data.grp[i] === g);
    const r = fit1d(xs, ys, f); if (!r) continue; const color = perGroup ? hfuColor(g) : ['#ffffff', '#e8c547', '#f07db5', '#3ecf8e', '#b083f0', '#ff8c42'][fits.indexOf(f)];
    results.push({ ...r, group: perGroup ? `unit ${g}` : 'all', color });
    series.push({ kind: 'line', x: r.curve.x, y: r.curve.y, color, width: 1.8 }, { kind: 'line', x: r.curve.x, y: r.curve.lo, color, width: 0.8, dash: true, alpha: 0.6 }, { kind: 'line', x: r.curve.x, y: r.curve.hi, color, width: 0.8, dash: true, alpha: 0.6 });
  }
  if (ma) { const m = movingAverage(data.X, data.Y, maWin, lx); series.push({ kind: 'line', x: m.x, y: m.y, color: '#39c5cf', width: 2 }); }
  const refLines: { x1: number; y1: number; x2: number; y2: number; color?: string; dash?: boolean; label?: string }[] = [];
  if (oneOne) { const lo = Math.min(...data.X.filter(isNum), ...data.Y.filter(isNum)), hi = Math.max(...data.X.filter(isNum), ...data.Y.filter(isNum)); refLines.push({ x1: lo > 0 || !lx ? lo : 1e-3, y1: lo > 0 || !ly ? lo : 1e-3, x2: hi, y2: hi, color: '#aaa', dash: true, label: '1:1' }); }
  const legend = colorBy === 'hfu' || colorBy === 'cluster' ? [...new Set(data.grp)].filter((g) => g > 0).sort().map((g) => ({ label: `unit ${g}`, color: hfuColor(g) })) : colorBy === 'facies' ? facList.map((f, i) => ({ label: f, color: PALETTE[i % PALETTE.length] })) : colorBy === 'well' ? wells.filter((w) => wellIds.includes(w.id)).map((w) => ({ label: w.name, color: w.color })) : colorBy === 'source' ? [{ label: 'core', color: '#fff' }, { label: 'log', color: '#4ea1ff' }] : undefined;
  const onLasso = (idx: number[]) => {
    setSel(idx); if (!idx.length) { S().set({ selection: undefined }); return; }
    const byWell = new Map<number, number[]>(); idx.forEach((i) => { const w = data.wIdx[i]; if (!byWell.has(w)) byWell.set(w, []); byWell.get(w)!.push(data.D[i]); });
    const [wi, depths] = [...byWell.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    S().set({ selection: { wellId: wells[wi].id, source: src === 'core' ? 'core' : 'log', depths, label: `${idx.length} pts lasso ${x}/${y}` } });
    S().log(`Crossplot lasso: ${idx.length} points selected (${x} vs ${y}) — synchronised to log viewer`);
  };
  if (!wells.length) return <><ModHead title="Crossplot Studio" /><Empty>Load data first.</Empty></>;
  return (
    <>
      <ModHead title="Crossplot Studio" sub={`${data.X.length.toLocaleString()} points · lasso selection synchronises with the log viewer`}>
        <Sel value={src} onChange={setSrc} options={[{ v: 'core', l: 'Core samples' }, { v: 'log', l: 'Log samples' }, { v: 'both', l: 'Core + log' }]} />
        {src !== 'log' && <CoreSelector />}<ZoneSelect />
        {sel.length > 0 && <button className="btn" onClick={() => S().go('logview')}>Show {sel.length} selected in log viewer →</button>}
      </ModHead>
      <div className="mod-b nopad" style={{ flexDirection: 'row' }}>
        <div style={{ flex: 1, minWidth: 0, padding: 6 }}>
          <XYPlot series={series} logX={lx} logY={ly} xLabel={x} yLabel={y} density={density} onLasso={onLasso} refLines={refLines} legend={legend}
            notes={results.map((r) => `${results.length > 1 || perGroup ? `[${r.group}] ` : ''}${r.eq}   R²=${r.r2.toFixed(3)} RMSE=${fmt(r.rmse, 3)} MAE=${fmt(r.mae, 3)} N=${r.n}`)} />
        </div>
      </div>
      <RightPanel>
        <Box title="Axes">
          {src !== 'core' && <Field label="Wells"><select multiple value={wellIds} onChange={(e) => setWellIds([...e.target.selectedOptions].map((o) => o.value))} style={{ height: 50 }}>{wells.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>}
          <Field label="X"><select value={x} onChange={(e) => { setX(e.target.value); setLx(LOGGY.test(e.target.value)); }}>{[...new Set(axisOpts)].map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Y"><select value={y} onChange={(e) => { setY(e.target.value); setLy(LOGGY.test(e.target.value)); }}>{[...new Set(axisOpts)].map((c) => <option key={c}>{c}</option>)}</select></Field>
          <div className="row"><label className="cb"><input type="checkbox" checked={lx} onChange={(e) => setLx(e.target.checked)} />log X</label><label className="cb"><input type="checkbox" checked={ly} onChange={(e) => setLy(e.target.checked)} />log Y</label><button className="btn sm" onClick={() => { setX(y); setY(x); setLx(ly); setLy(lx); }}>swap</button></div>
        </Box>
        <Box title="Colour / symbol">
          <Field label="Color by"><Sel value={colorBy} onChange={setColorBy} options={[{ v: 'hfu', l: 'HFU' }, { v: 'cluster', l: 'Cluster' }, { v: 'facies', l: 'Facies (core)' }, { v: 'depth', l: 'Depth' }, { v: 'vsh', l: 'Vsh' }, { v: 'curve', l: 'User-selected curve' }, { v: 'well', l: 'Well' }, { v: 'source', l: 'Core / Log' }, { v: 'none', l: 'Single colour' }]} /></Field>
          {(colorBy === 'hfu' || colorBy === 'cluster') && <Field label="HFU/cluster set"><select value={hfuSetId} onChange={(e) => setHfuSetId(e.target.value)}><option value="">auto (HFU_PRED / HFU_CORE)</option>{hfuSets.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></Field>}
          {colorBy === 'curve' && <Field label="Curve"><select value={colorCurve} onChange={(e) => setColorCurve(e.target.value)}><option value="" />{axisOpts.map((c) => <option key={c}>{c}</option>)}</select></Field>}
          {isFinite(cMin) && <div className="hint">Colour scale {fmt(cMin, 4)} → {fmt(cMax, 4)} (viridis)</div>}
          <div className="hint">Symbols: ● Core · ■ Log · ▲ Validation interval</div>
          <label className="cb"><input type="checkbox" checked={!!valIv} onChange={(e) => setValIv(e.target.checked ? [data.D.length ? Math.min(...data.D) : 0, data.D.length ? Math.max(...data.D) : 1] : null)} />mark validation interval</label>
          {valIv && <div className="row"><Num value={valIv[0]} onChange={(v) => setValIv([v, valIv[1]])} /><Num value={valIv[1]} onChange={(v) => setValIv([valIv[0], v])} /></div>}
        </Box>
        <Box title="Regression / overlays">
          {(Object.keys(FIT_LABEL) as Fit1D[]).map((f) => <label key={f} className="cb" style={{ display: 'flex' }}><input type="checkbox" checked={fits.includes(f)} onChange={(e) => setFits(e.target.checked ? [...fits, f] : fits.filter((q) => q !== f))} />{FIT_LABEL[f]}</label>)}
          <label className="cb"><input type="checkbox" checked={perGroup} onChange={(e) => setPerGroup(e.target.checked)} />fit per HFU / cluster</label>
          <div className="row" style={{ marginTop: 4 }}><label className="cb"><input type="checkbox" checked={oneOne} onChange={(e) => setOneOne(e.target.checked)} />1:1 line</label><label className="cb"><input type="checkbox" checked={ma} onChange={(e) => setMa(e.target.checked)} />moving avg</label>{ma && <Num value={maWin} onChange={setMaWin} style={{ width: 44 }} />}</div>
          <Field label="Density"><Sel value={density} onChange={setDensity} options={[{ v: 'none', l: 'points' }, { v: 'hexbin', l: 'hexbin' }, { v: 'contours', l: 'density contours' }]} /></Field>
        </Box>
        <Box title="Fit statistics">
          {results.length ? <table className="t"><thead><tr><th>Fit</th><th>R²</th><th>RMSE</th><th>MAE</th><th>N</th></tr></thead><tbody>{results.map((r, i) => <tr key={i} title={`${r.eq}\n${r.ci}\n${r.space}`}><td><span className="pill" style={{ background: r.color }} />{r.group !== 'all' ? r.group + ' ' : ''}{r.kind}</td><td className="num">{r.r2.toFixed(3)}</td><td className="num">{fmt(r.rmse, 3)}</td><td className="num">{fmt(r.mae, 3)}</td><td className="num">{r.n}</td></tr>)}</tbody></table> : <span className="hint">No fit.</span>}
          {results.map((r, i) => <div key={i} className="mono" style={{ fontSize: 10.5, marginTop: 3 }}><span style={{ color: r.color }}>■</span> {r.eq}<br /><span className="dim">{r.ci} · {r.space}</span></div>)}
          <div className="hint" style={{ marginTop: 4 }}>Dashed lines: 95% confidence band of the mean response. A fitted relationship is correlational, not causal.</div>
        </Box>
      </RightPanel>
    </>
  );
}
