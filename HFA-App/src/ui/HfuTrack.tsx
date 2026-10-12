import { FLAG_RE } from '../curves/catalog';
import { useState } from 'react';
import { S, useStore, type TrackDef } from '../store/store';
import { registry } from '../data-engine/registry';
import { coreCol, coreDepths, mode } from '../data-engine/core';
import { LogViewer, type BandInterval } from '../visualization/LogViewer';
import { Box, Empty, Kv, ModHead, useActiveWell } from './common';
import { RightPanel } from './RightPanel';
import { findByFamily } from '../curves/catalog';
import { fmt, hfuColor, isNum, lowerBound, mean } from '../util/num';

function layout(hfuCurve: string, phi: string, k: string): TrackDef[] {
  return [
    { id: 'h_d', kind: 'depth', width: 52, curves: [] },
    { id: 'h_band', title: 'HFU', kind: 'hfu', width: 70, curves: [], hfu: { source: 'curve', curve: hfuCurve } },
    { id: 'h_fzi', title: 'FZI', kind: 'curve', width: 160, grid: true, curves: [{ mnem: 'FZI_PRED', color: '#e8c547', width: 1.3, scale: 'log', min: 0.01, max: 100 }, { mnem: 'FZI_LOG', color: '#f07db5', width: 1, scale: 'log', min: 0.01, max: 100, dash: true }, { mnem: 'FZI', color: '#fff', width: 1, scale: 'log', min: 0.01, max: 100, core: { column: 'FZI' } }] },
    { id: 'h_rqi', title: 'RQI', kind: 'curve', width: 140, grid: true, curves: [{ mnem: 'RQI_LOG', color: '#b083f0', width: 1.2, scale: 'log', min: 0.001, max: 10 }, { mnem: 'RQI_PRED', color: '#b083f0', width: 1, scale: 'log', min: 0.001, max: 10, dash: true }, { mnem: 'RQI', color: '#fff', width: 1, scale: 'log', min: 0.001, max: 10, core: { column: 'RQI' } }] },
    { id: 'h_k', title: 'K', kind: 'curve', width: 160, grid: true, curves: [{ mnem: k, color: '#ff8c42', width: 1.3, scale: 'log', min: 0.001, max: 10000 }, { mnem: 'K', color: '#fff', width: 1, scale: 'log', min: 0.001, max: 10000, core: { column: 'K' } }] },
    { id: 'h_phi', title: 'PHI', kind: 'curve', width: 130, grid: true, curves: [{ mnem: phi, color: '#39c5cf', width: 1.2, scale: 'lin', min: 0.3, max: 0, fill: 'right', fillColor: 'rgba(57,197,207,0.15)' }, { mnem: 'PHI', color: '#fff', width: 1, scale: 'lin', min: 0.3, max: 0, core: { column: 'PHI' } }] },
  ];
}

interface Info { b: BandInterval; curve: string; rows: [string, React.ReactNode][]; warnings: string[] }

export function HfuTrack() {
  const well = useActiveWell(); const sets = useStore((s) => s.hfuSets); const cores = useStore((s) => s.cores); const models = useStore((s) => s.models); useStore((s) => s.dataVersion);
  const discrete = well?.curves.filter((c) => c.discrete && !FLAG_RE.test(c.mnemonic) && c.mnemonic !== 'HFU_CORE').map((c) => c.mnemonic) ?? [];
  const [hc, setHc] = useState(''); const curve = hc || (discrete.includes('HFU_PRED') ? 'HFU_PRED' : discrete[0] ?? '');
  const names = well?.curves.map((c) => c.mnemonic) ?? [];
  const phi = ['PHIE', 'PHIT', 'CMRP', 'TCMR'].map((f) => findByFamily(names, f)).find(Boolean) ?? 'PHIE';
  const kC = names.includes('K_PRED') ? 'K_PRED' : findByFamily(names, 'K') ?? 'K_PRED';
  const [info, setInfo] = useState<Info | null>(null);
  if (!well) return <><ModHead title="HFU Depth Track" /><Empty>No well.</Empty></>;
  const meta = well.curves.find((c) => c.mnemonic === curve);
  const hs = sets.find((h) => h.curve === curve && h.wellId === well.id) ?? sets.find((h) => meta?.calc?.formula.includes(`"${h.name}"`)) ?? sets.find((h) => h.wellId === well.id);
  const onBand = (b: BandInterval, cn: string) => {
    const d = registry.depth(well.id)!; const i0 = lowerBound(d, b.top), i1 = lowerBound(d, b.base);
    const seg = (m: string) => { const c = registry.curve(well.id, m); if (!c) return [] as number[]; const out: number[] = []; for (let i = i0; i < i1; i++) if (isNum(c[i])) out.push(c[i]); return out; };
    const logMean = (m: string) => { const v = seg(m).filter((x) => x > 0); return v.length ? Math.pow(10, mean(v.map(Math.log10))) : NaN; };
    const fzi = names.includes('FZI_PRED') ? 'FZI_PRED' : 'FZI_LOG'; const rqi = names.includes('RQI_LOG') ? 'RQI_LOG' : 'RQI_PRED';
    const ex = seg('EXTRAP'); const exPct = ex.length ? (100 * ex.filter((x) => x > 0).length) / ex.length : NaN;
    // boundary margin (log units) of FZI_PRED
    const bnd = hs?.boundaries ?? []; const f = seg(fzi).filter((x) => x > 0);
    const margin = bnd.length && f.length ? mean(f.map((v) => Math.min(...bnd.map((bb) => Math.abs(Math.log10(v) - Math.log10(bb)))))) : NaN;
    // core samples in the interval
    const cs: { phi: number[]; k: number[]; fzi: number[]; rqi: number[]; fac: string[]; hfu: number[] } = { phi: [], k: [], fzi: [], rqi: [], fac: [], hfu: [] };
    for (const cm of cores.filter((c) => c.wellId === well.id)) {
      const a = registry.core(cm.id); if (!a) continue; const { shifted } = coreDepths(cm, a);
      const lab = sets.find((h) => h.domain === 'core' && h.coreId === cm.id)?.labels;
      for (let i = 0; i < cm.n; i++) { if (a.excluded[i] || shifted[i] < b.top || shifted[i] > b.base) continue;
        const g = (n: string) => coreCol(cm, a, n)?.[i]; const p = g('PHI'), kk = g('K'), fz = a.num.get('FZI')?.[i], rq = a.num.get('RQI')?.[i];
        if (isNum(p!)) cs.phi.push(p!); if (isNum(kk!)) cs.k.push(kk!); if (isNum(fz!)) cs.fzi.push(fz!); if (isNum(rq!)) cs.rqi.push(rq!);
        const fac = cm.map.facies ? a.text.get(cm.map.facies)?.[i] : undefined; if (fac) cs.fac.push(fac); if (lab?.[i]) cs.hfu.push(lab[i]); }
    }
    const agree = cs.hfu.length ? (100 * cs.hfu.filter((x) => x === b.value).length) / cs.hfu.length : NaN;
    const modelId = meta?.calc?.model ?? well.curves.find((c) => c.mnemonic === fzi)?.calc?.model; const model = models.find((m2) => m2.id === modelId);
    const sub = model?.groupBy === 'hfu' ? model.subModels.find((s) => s.groupId === b.value) : model?.subModels[0];
    let conf = 'n/a'; const warnings: string[] = [];
    if (isNum(exPct) || isNum(margin)) { const score = (isNum(exPct) ? (exPct < 5 ? 2 : exPct < 25 ? 1 : 0) : 1) + (isNum(margin) ? (margin > 0.2 ? 2 : margin > 0.08 ? 1 : 0) : 1) + (isNum(agree) ? (agree >= 70 ? 1 : agree < 40 ? -1 : 0) : 0); conf = score >= 4 ? 'High' : score >= 2 ? 'Medium' : 'Low'; }
    if (exPct > 20) warnings.push(`${exPct.toFixed(0)}% of samples in this interval are extrapolated.`);
    if (isNum(margin) && margin < 0.08) warnings.push('Predicted FZI lies close to a unit boundary (mean margin < 0.08 log units) — classification is sensitive.');
    const unit = hs?.units.find((u) => u.id === b.value);
    setInfo({ b, curve: cn, warnings, rows: [
      ['Depth', `${b.top.toFixed(2)} – ${b.base.toFixed(2)} ${well.depthUnit} (${(b.base - b.top).toFixed(2)} ${well.depthUnit})`],
      ['HFU', <><span className="pill" style={{ background: hfuColor(b.value) }} />{unit?.label ?? `Unit ${b.value}`} <span className={'tag ' + (unit?.status === 'Hydraulic Flow Unit' ? 'ok' : 'warn')}>{unit?.status ?? 'unvalidated'}</span></>],
      [`Mean φ (${phi})`, fmt(mean(seg(phi)), 3)], [`Mean K (${kC}, geometric)`, `${fmt(logMean(kC), 3)} mD`], [`Mean RQI (${rqi}, geo.)`, `${fmt(logMean(rqi), 3)} µm`], [`Mean FZI (${fzi}, geo.)`, `${fmt(logMean(fzi), 3)} µm`],
      ['Core samples', cs.fzi.length || cs.phi.length ? `${Math.max(cs.phi.length, cs.fzi.length)} · φ ${fmt(mean(cs.phi), 3)} · K ${fmt(cs.k.length ? Math.pow(10, mean(cs.k.filter((x) => x > 0).map(Math.log10))) : NaN, 3)} mD · FZI ${fmt(cs.fzi.length ? Math.pow(10, mean(cs.fzi.map(Math.log10))) : NaN, 3)}` : 'none'],
      ['Dominant facies', cs.fac.length ? `${mode(cs.fac)} (${cs.fac.filter((x) => x === mode(cs.fac)).length}/${cs.fac.length})` : '— (no core facies)'],
      ['Regression model', model ? <>{model.name}{sub ? <div className="mono dim" style={{ fontSize: 10 }}>{sub.equation}</div> : null}</> : '— (curve not produced by a model)'],
      ['Confidence', <><b>{conf}</b> <span className="dim">extrap {fmt(exPct, 3)}% · boundary margin {fmt(margin, 3)} log · core agreement {isNum(agree) ? agree.toFixed(0) + '%' : 'n/a'}</span></>],
    ] });
    S().set({ interval: { wellId: well.id, top: +b.top.toFixed(3), base: +b.base.toFixed(3) } });
  };
  return (
    <>
      <ModHead title="HFU Depth Track" sub={`${well.name} · click an HFU band for interval statistics`}>
        <span className="hint">HFU curve</span><select value={curve} onChange={(e) => setHc(e.target.value)}>{discrete.length ? discrete.map((c) => <option key={c}>{c}</option>) : <option value="">— none —</option>}</select>
      </ModHead>
      <div className="mod-b nopad">{curve ? <LogViewer wellId={well.id} tracks={layout(curve, phi, kC)} onBandClick={onBand} cursorFields={[curve, 'FZI_PRED', 'FZI_LOG', 'FZI_CORE', 'RQI_LOG', kC, phi, 'EXTRAP']} /> : <Empty>No continuous HFU curve yet. Generate HFU_PRED (Prediction) or a log-domain HFU/cluster set.</Empty>}</div>
      <RightPanel>
        <Box title="Units">{hs ? hs.units.map((u) => <div key={u.id} className="row" style={{ gap: 4 }}><span className="pill" style={{ background: u.color }} />{u.label}<span className="dim">{u.fziMin !== undefined ? `FZI ${fmt(u.fziMin, 3)}–${u.fziMax === Infinity ? '∞' : fmt(u.fziMax, 3)}` : ''}</span><span className={'tag ' + (u.status === 'Hydraulic Flow Unit' ? 'ok' : 'warn')}>{u.status === 'Hydraulic Flow Unit' ? 'HFU' : 'cluster'}</span></div>) : <span className="hint">No HFU set linked.</span>}</Box>
        <Box title="Selected interval">{info ? <><Kv rows={info.rows} />{info.warnings.map((w, i) => <div key={i} className="msg WARNING" style={{ marginTop: 4 }}>{w}</div>)}</> : <span className="hint">Click an HFU band.</span>}</Box>
      </RightPanel>
    </>
  );
}
