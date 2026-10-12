import { useState } from 'react';
import { S, useStore, DEFAULT_LAYOUT, PETRO_LAYOUT, type CurveDisplay, type TrackDef } from '../store/store';
import { reservoirsForWell } from '../data-engine/zones';
import { setReservoirs } from '../data-engine/reservoir';
import { LogViewer, defaultDisplayFor, resolveMnem } from '../visualization/LogViewer';
import { Box, Empty, ModHead, Num, Sel, useActiveWell } from './common';
import { RightPanel } from './RightPanel';
import { CATEGORY_COLORS, FAMILIES } from '../curves/catalog';
import { registry } from '../data-engine/registry';
import { fullStats, uid } from '../util/num';
import type { WellMeta } from '../types';

export function CurvePalette({ well }: { well: WellMeta }) {
  const [q, setQ] = useState('');
  return <div className="row" style={{ gap: 3, padding: '4px 8px', borderBottom: '1px solid var(--bd)', background: 'var(--bg1)', maxHeight: 58, overflow: 'auto' }}>
    <input placeholder="filter" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 70, height: 18 }} />
    {well.curves.filter((c) => !q || c.mnemonic.toLowerCase().includes(q.toLowerCase())).map((c) => (
      <span key={c.mnemonic} className="chip" draggable onDragStart={(e) => e.dataTransfer.setData('text/curve', c.mnemonic)} title={`${c.description} [${c.unit}] — drag onto a track header`}>
        <span className="pill" style={{ background: CATEGORY_COLORS[c.category] ?? '#999', width: 6, height: 6 }} />{c.mnemonic}
      </span>))}
  </div>;
}

export function TrackEditor({ well, tracks, setTracks, selected, setSelected }: { well: WellMeta; tracks: TrackDef[]; setTracks: (t: TrackDef[]) => void; selected: string | null; setSelected: (s: string | null) => void }) {
  const t = tracks.find((x) => x.id === selected);
  const cores = useStore((s) => s.cores.filter((c) => c.wellId === well.id));
  const updT = (p: Partial<TrackDef>) => setTracks(tracks.map((x) => (x.id === selected ? { ...x, ...p } : x)));
  const updC = (i: number, p: Partial<CurveDisplay>) => updT({ curves: t!.curves.map((c, k) => (k === i ? { ...c, ...p } : c)) });
  const move = (d: number) => { const i = tracks.findIndex((x) => x.id === selected); const j = i + d; if (j < 0 || j >= tracks.length) return; const a = [...tracks]; [a[i], a[j]] = [a[j], a[i]]; setTracks(a); };
  const names = [...new Set([...well.curves.map((c) => c.mnemonic), ...Object.keys(FAMILIES)])];
  const coreCols = [...new Set(cores.flatMap((c) => [...(registry.core(c.id)?.num.keys() ?? [])]))];
  return <>
    <Box title="Tracks" right={<><button className="btn sm" onClick={() => { const id = uid('t_'); setTracks([...tracks, { id, kind: 'curve', width: 140, grid: true, curves: [] }]); setSelected(id); }}>+ Track</button><button className="btn sm" onClick={() => setTracks([...tracks, { id: uid('t_'), kind: 'hfu', width: 60, curves: [], hfu: null }])}>+ HFU</button><button className="btn sm" title="Formation zones track" onClick={() => setTracks([...tracks.slice(0, 1), { id: uid('t_'), kind: 'zone', width: 26, curves: [] }, ...tracks.slice(1)])}>+ Zones</button><button className="btn sm" title="Flag track (bars where the curve > 0)" onClick={() => { const id = uid('t_'); setTracks([...tracks, { id, kind: 'flag', width: 20, curves: [], flag: { curve: 'RES_FLAG', color: '#ffe600' } }]); setSelected(id); }}>+ Flag</button><button className="btn sm" onClick={() => setTracks(DEFAULT_LAYOUT)}>Reset</button></>}>
      <div className="tbl-wrap" style={{ maxHeight: 150 }}><table className="t"><tbody>{tracks.map((x, i) => (
        <tr key={x.id} className={x.id === selected ? 'sel' : ''} onClick={() => setSelected(x.id)} style={{ cursor: 'pointer' }}><td className="dim">{i + 1}</td><td>{x.kind === 'depth' ? 'Depth' : x.kind === 'zone' ? 'Zones (tops)' : x.kind === 'flag' ? `Flag ${x.flag?.curve ?? 'RES_FLAG'}` : x.kind === 'hfu' ? `HFU band (${x.hfu?.curve ?? 'auto'})` : x.curves.map((c) => (c.core ? '●' : '') + c.mnem).join(', ') || '(empty)'}</td></tr>))}</tbody></table></div>
    </Box>
    {t && <Box title={`Track ${tracks.indexOf(t) + 1}`} right={<><button className="btn sm" onClick={() => move(-1)}>◀</button><button className="btn sm" onClick={() => move(1)}>▶</button><button className="btn sm danger" onClick={() => { setTracks(tracks.filter((x) => x.id !== t.id)); setSelected(null); }}>Remove</button></>}>
      <label className="f w90"><span>Width px</span><Num value={t.width} onChange={(v) => updT({ width: Math.max(30, v) })} /></label>
      {t.kind === 'curve' && <div className="row"><label className="cb"><input type="checkbox" checked={t.grid !== false} onChange={(e) => updT({ grid: e.target.checked })} />grid</label><label className="cb"><input type="checkbox" checked={t.minorGrid !== false} onChange={(e) => updT({ minorGrid: e.target.checked })} />minor grid</label></div>}
      {t.kind === 'hfu' && <label className="f w90"><span>HFU curve</span><select value={t.hfu?.curve ?? ''} onChange={(e) => updT({ hfu: e.target.value ? { source: 'curve', curve: e.target.value } : null })}><option value="">auto (HFU_PRED / first discrete)</option>{well.curves.filter((c) => c.discrete || c.category === 'HFU').map((c) => <option key={c.mnemonic}>{c.mnemonic}</option>)}</select></label>}
      {t.kind === 'flag' && <div className="row"><select value={t.flag?.curve ?? 'RES_FLAG'} onChange={(e) => updT({ flag: { curve: e.target.value, color: t.flag?.color ?? '#ffe600' } })}>{[...new Set(['RES_FLAG', 'BH_FL_BS', 'BH_FL_DRHO', 'NET_RES', 'NET_PAY', ...well.curves.filter((c) => c.discrete || /FLAG|NET|PAY|SEL_/i.test(c.mnemonic)).map((c) => c.mnemonic)])].map((m) => <option key={m}>{m}</option>)}</select><input type="color" value={(t.flag?.color ?? '#ffe600').slice(0, 7)} onChange={(e) => updT({ flag: { curve: t.flag?.curve ?? 'RES_FLAG', color: e.target.value } })} style={{ width: 22, height: 20, padding: 0, border: 0 }} /></div>}
      {t.kind === 'curve' && t.curves.map((c, i) => {
        const m = c.core ? null : resolveMnem(well, c.mnem);
        return <div key={i} style={{ borderTop: '1px solid var(--bd)', marginTop: 5, paddingTop: 4 }}>
          <div className="row" style={{ gap: 4 }}>
            <input type="color" value={c.color.slice(0, 7)} onChange={(e) => updC(i, { color: e.target.value })} style={{ width: 22, height: 20, padding: 0, border: 0 }} />
            {c.core ? <select value={c.core.column} onChange={(e) => updC(i, { core: { ...c.core!, column: e.target.value }, mnem: e.target.value })}>{[...new Set(['K', 'PHI', 'FZI', 'RQI', ...coreCols])].map((n) => <option key={n}>{n}</option>)}</select>
              : <select value={c.mnem} onChange={(e) => updC(i, { mnem: e.target.value })} style={{ width: 110 }}>{names.map((n) => <option key={n}>{n}</option>)}</select>}
            <span className="dim mono" style={{ fontSize: 10 }}>{c.core ? 'core' : m ? (m !== c.mnem ? `→${m}` : '') : 'n/a'}</span>
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => updT({ curves: t.curves.filter((_, k) => k !== i) })}>✕</button>
          </div>
          <div className="row" style={{ gap: 4, marginTop: 3 }}>
            <Sel value={c.scale} onChange={(v) => updC(i, { scale: v })} options={['lin', 'log']} />
            <Num value={c.min} onChange={(v) => updC(i, { min: v })} style={{ width: 62 }} /><Num value={c.max} onChange={(v) => updC(i, { max: v })} style={{ width: 62 }} />
            <button className="btn sm" title="Auto-scale to P01–P99 of this well" onClick={() => { const mm = resolveMnem(well, c.mnem); const d = mm && registry.curve(well.id, mm); if (!d) return; const s = fullStats(d); if (c.scale === 'log') updC(i, { min: Math.pow(10, Math.floor(Math.log10(Math.max(1e-4, s.min)))), max: Math.pow(10, Math.ceil(Math.log10(Math.max(1e-3, s.max)))) }); else updC(i, { min: s.p05, max: s.p95 }); }}>auto</button>
            <label className="cb"><input type="checkbox" checked={!!c.reverse} onChange={(e) => updC(i, { reverse: e.target.checked })} />rev</label>
          </div>
          <div className="row" style={{ gap: 4, marginTop: 3 }}>
            <span className="hint">w</span><Num value={c.width} onChange={(v) => updC(i, { width: v })} style={{ width: 44 }} />
            <label className="cb"><input type="checkbox" checked={!!c.dash} onChange={(e) => updC(i, { dash: e.target.checked })} />dash</label>
            {!c.core && <Sel value={c.fill ?? 'none'} onChange={(v) => updC(i, { fill: v })} options={[{ v: 'none', l: 'no fill' }, { v: 'left', l: 'fill left' }, { v: 'right', l: 'fill right' }, { v: 'crossover', l: 'crossover' }, { v: 'baseline', l: 'baseline (sand/shale)' }]} />}
            {c.fill === 'baseline' && <><span className="hint">at</span><Num value={c.baseline} onChange={(v) => updC(i, { baseline: v })} style={{ width: 50 }} /></>}
            {c.fill === 'crossover' && <select value={c.crossWith ?? ''} onChange={(e) => updC(i, { crossWith: e.target.value })}><option value="">with…</option>{t.curves.filter((_, k) => k !== i).map((o) => <option key={o.mnem}>{o.mnem}</option>)}</select>}
            {c.fill && c.fill !== 'none' && <input type="color" value={(c.fillColor ?? '#f5a623').slice(0, 7)} onChange={(e) => updC(i, { fillColor: e.target.value + '55' })} style={{ width: 22, height: 20, padding: 0, border: 0 }} />}
          </div>
        </div>;
      })}
      {t.kind === 'curve' && <div className="row" style={{ marginTop: 6 }}>
        <select value="" onChange={(e) => e.target.value && updT({ curves: [...t.curves, defaultDisplayFor(well, e.target.value, t.curves.length)] })}><option value="">+ add curve…</option>{well.curves.map((c) => <option key={c.mnemonic}>{c.mnemonic}</option>)}</select>
        {cores.length > 0 && <button className="btn sm" onClick={() => updT({ curves: [...t.curves, { mnem: 'K', color: '#ffffff', width: 1, scale: 'log', min: 0.01, max: 10000, core: { column: 'K' } }] })}>+ core points</button>}
      </div>}
    </Box>}
  </>;
}

export function LogView() {
  const well = useActiveWell();
  const layout = useStore((s) => s.layout);
  const [sel, setSel] = useState<string | null>(null);
  const vr = useStore((s) => s.viewRange); const theme = useStore((s) => s.logTheme); const iv = useStore((s) => s.interval); useStore((s) => s.reservoirs);
  if (!well) return <><ModHead title="Log Visualization" /><Empty>No well loaded — use Import Manager or Project → Load Demo Data.</Empty></>;
  const setTracks = (t: TrackDef[]) => S().set({ layout: t, dirty: true });
  const res = reservoirsForWell(well.id);
  const r = vr?.wellId === well.id ? vr : null;
  return (
    <>
      <ModHead title="Log Visualization" sub={`${well.name} · wheel = zoom depth · Shift+wheel = track width · drag = pan · drag in depth track = select interval · dbl-click = full well · Space = cursor`}>
        <span className="hint">Top</span><Num value={r ? +r.top.toFixed(2) : undefined} onChange={(v) => S().set({ viewRange: { wellId: well.id, top: v, base: r?.base ?? v + 100 } })} />
        <span className="hint">Base</span><Num value={r ? +r.base.toFixed(2) : undefined} onChange={(v) => S().set({ viewRange: { wellId: well.id, top: r?.top ?? v - 100, base: v } })} />
        <button className="btn" onClick={() => S().set({ viewRange: { wellId: well.id, top: well.start, base: well.stop } })}>Full</button>
        {res.length > 0 && <button className="btn warn" title="Zoom to the reservoir interval(s) ± 10 m" onClick={() => { const t = Math.min(...res.map((x) => x.top)) - 10, b = Math.max(...res.map((x) => x.base)) + 10; S().set({ viewRange: { wellId: well.id, top: t, base: b } }); }}>Reservoir</button>}
        {iv?.wellId === well.id && <button className="btn" title="Store the dragged depth interval as a reservoir interval" onClick={() => setReservoirs(well.id, [{ name: `Res ${iv.top.toFixed(1)}`, top: iv.top, base: iv.base, source: 'log-viewer selection' }], 'append', 'log-viewer interval')}>Set interval as reservoir</button>}
        <select value="" onChange={(e) => { const v = e.target.value; if (!v) return; S().set({ layout: v === 'petro' ? PETRO_LAYOUT : DEFAULT_LAYOUT, dirty: true }); S().log(`Log layout template: ${v === 'petro' ? 'Petrophysical interpretation (conventional)' : 'HFU default'}`); }} title="Track templates"><option value="">Template…</option><option value="petro">Petrophysical interpretation (Techlog-style)</option><option value="hfu">HFU analysis (default)</option></select>
        <button className="btn" title="Conventional white tracks / dark tracks" onClick={() => S().set({ logTheme: theme === 'light' ? 'dark' : 'light' })}>{theme === 'light' ? '◐ Dark tracks' : '◑ White tracks'}</button>
      </ModHead>
      <CurvePalette well={well} />
      <div className="mod-b nopad"><LogViewer wellId={well.id} tracks={layout} onTracksChange={setTracks} selectedTrack={sel} onSelectTrack={setSel} /></div>
      <RightPanel><TrackEditor well={well} tracks={layout} setTracks={setTracks} selected={sel} setSelected={setSel} /></RightPanel>
    </>
  );
}
