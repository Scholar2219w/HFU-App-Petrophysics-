import { useEffect, useRef, useState } from 'react';
import { S, useStore, activeWell, type ModuleId } from './store/store';
import { registry } from './data-engine/registry';
import { exportProject, importProject, saveProject } from './project/project';
import { loadDemo, DEMO_BANNER } from './demo/demo';
import { fmt, fmtBytes } from './util/num';
import { Box, Kv } from './ui/common';
import { Home } from './ui/Home';
import { ImportManager, importBus } from './ui/ImportManager';
import { CurveManager, curveSearchBus } from './ui/CurveManager';
import { LogView } from './ui/LogView';
import { DepthManager } from './ui/DepthManager';
import { CoreManager } from './ui/CoreManager';
import { Calculator } from './ui/Calculator';
import { HfuAnalyzer } from './ui/HfuAnalyzer';
import { Clustering } from './ui/Clustering';
import { Crossplots } from './ui/Crossplots';
import { Regression } from './ui/Regression';
import { Validation } from './ui/Validation';
import { Prediction } from './ui/Prediction';
import { HfuTrack } from './ui/HfuTrack';
import { OpenProject, ProjectProps } from './ui/ProjectDialog';
import { QCDashboard } from './ui/QCDashboard';
import { ExportCenter } from './ui/ExportCenter';
import { Transitions } from './ui/Transitions';
import { ReservoirQuality } from './ui/ReservoirQuality';
import { MultiWell } from './ui/MultiWell';
import { Zones } from './ui/Zones';
import { FilterBuilder } from './ui/FilterBuilder';
import { DataTable } from './ui/DataTable';
import { Audit } from './ui/Audit';
import { Advanced } from './ui/Advanced';
import { Reservoir } from './ui/Reservoir';
import { Petrophysics } from './ui/Petrophysics';
import { scopeLabel } from './data-engine/zones';
import { WorkflowGuide } from './ui/WorkflowGuide';
import { undo, redo, historyEntries } from './store/history';
import { Modal } from './ui/common';

const MODULES: Record<ModuleId, { label: string; C: () => JSX.Element }> = {
  home: { label: 'Overview', C: Home }, import: { label: 'Import Manager', C: ImportManager }, curves: { label: 'Curve Manager', C: CurveManager },
  logview: { label: 'Log Visualization', C: LogView }, depth: { label: 'Core-Log Match', C: DepthManager }, core: { label: 'Core Data', C: CoreManager },
  calc: { label: 'Formula Calculator', C: Calculator }, reservoir: { label: 'Reservoir Intervals', C: Reservoir }, petro: { label: 'Petrophysical Evaluation', C: Petrophysics }, hfu: { label: 'RQI/FZI', C: HfuAnalyzer }, cluster: { label: 'HFU Clustering', C: Clustering },
  crossplot: { label: 'Crossplots', C: Crossplots }, regression: { label: 'Regression', C: Regression }, validation: { label: 'Validation', C: Validation },
  prediction: { label: 'Predicted FZI / HFU', C: Prediction }, hfutrack: { label: 'HFU Depth Track', C: HfuTrack }, project: { label: 'Project', C: Home },
  qc: { label: 'QC Dashboard', C: QCDashboard }, export: { label: 'Export & Report', C: ExportCenter }, transitions: { label: 'HFU Transitions', C: Transitions },
  rq: { label: 'Reservoir Summary', C: ReservoirQuality }, multiwell: { label: 'Multi-Well Analysis', C: MultiWell }, zones: { label: 'Formations & Zones', C: Zones },
  filters: { label: 'Interval & Formula Builder', C: FilterBuilder }, table: { label: 'Data Table', C: DataTable }, audit: { label: 'Audit Trail', C: Audit }, advanced: { label: 'Advanced Modules', C: Advanced },
};

type MenuItem = { l: string; k?: string; on?: () => void; dis?: boolean } | 'sep';
function Menu({ label, items, open, setOpen }: { label: string; items: MenuItem[]; open: string | null; setOpen: (s: string | null) => void }) {
  return <div className={'menu' + (open === label ? ' open' : '')} onMouseEnter={() => open && setOpen(label)}>
    <button onClick={() => setOpen(open === label ? null : label)}>{label}</button>
    {open === label && <div className="dd">{items.map((it, i) => it === 'sep' ? <div key={i} className="sep" /> : <button key={i} disabled={it.dis} onClick={() => { setOpen(null); it.on?.(); }}><span>{it.l}</span>{it.k && <kbd>{it.k}</kbd>}</button>)}</div>}
  </div>;
}

function HistoryList() {
  useStore((s) => s.history); useStore((s) => s.canUndo); useStore((s) => s.canRedo);
  const h = historyEntries();
  return <div style={{ maxHeight: 280, overflow: 'auto' }}>
    {h.undone.map((e, i) => <div key={'u' + i} className="hist-row undone" title="undone — Ctrl+Y to redo"><span className="dim">{e.t.slice(11, 16)}</span><span>{e.label}</span></div>)}
    {[...h.done].reverse().map((e, i) => <div key={'d' + i} className="hist-row" style={{ color: i === 0 ? '#fff' : undefined }}><span className="dim">{e.t.slice(11, 16)}</span><span>{e.label}</span></div>)}
  </div>;
}

export function App() {
  const st = useStore();
  const well = activeWell(st);
  const [menu, setMenu] = useState<string | null>(null);
  const [dlg, setDlg] = useState<'new' | 'props' | 'open' | 'privacy' | 'keys' | null>(null);
  const [guide, setGuide] = useState(false);
  const [mem, setMem] = useState('');
  const projIn = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => { registry.setProject(st.project.id); }, []);
  useEffect(() => {
    const t = setInterval(() => { const pm = (performance as any).memory; setMem(`${fmtBytes(registry.memoryBytes())} arrays${pm ? ` · JS heap ${fmtBytes(pm.usedJSHeapSize)}` : ''}`); }, 1500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 's') { e.preventDefault(); saveProject(); }
      else if (key === 'o') { e.preventDefault(); S().go('import'); setTimeout(() => importBus.open('well'), 60); }
      else if (key === 'f') { e.preventDefault(); S().go('curves'); setTimeout(() => curveSearchBus.focus(), 60); }
      else if (key === 'z' || key === 'y') { const t = (e.target as HTMLElement)?.tagName; if (t === 'INPUT' || t === 'TEXTAREA') return; e.preventDefault(); if (key === 'y' || e.shiftKey) redo(); else undo(); }
    };
    window.addEventListener('keydown', k); const c = () => setMenu(null); window.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('.menu')) c(); });
    return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => { const b = (e: BeforeUnloadEvent) => { if (S().dirty && S().wells.length) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', b); return () => window.removeEventListener('beforeunload', b); }, []);

  const M = MODULES[st.module] ?? MODULES.home;
  const demo = st.wells.some((w) => w.demo);
  const go = (m: ModuleId) => () => S().go(m);
  const cursor = st.cursor && st.cursor.wellId === well?.id ? st.cursor.depth : undefined;
  const lastLog = st.history[st.history.length - 1];
  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">HFA — Hydraulic Flow Analysis Suite<small>Integrated HFU, Petrophysics &amp; Reservoir Quality Analysis</small></div>
        <Menu label="Project" open={menu} setOpen={setMenu} items={[{ l: 'New Project…', on: () => setDlg('new') }, { l: 'Open Project…', on: () => setDlg('open') }, { l: 'Save Project', k: 'Ctrl+S', on: saveProject }, 'sep', { l: `Undo${st.canUndo ? '' : ' (nothing)'}`, k: 'Ctrl+Z', on: undo, dis: !st.canUndo }, { l: 'Redo', k: 'Ctrl+Y', on: redo, dis: !st.canRedo }, 'sep', { l: 'Project Properties…', on: () => setDlg('props') }, { l: 'Export Project (.hfaproj)…', on: exportProject }, { l: 'Import Project…', on: () => projIn.current?.click() }, 'sep', { l: `Load Demo Data (${DEMO_BANNER})`, on: () => { loadDemo(); S().notify('WARNING', `${DEMO_BANNER} loaded.`); } }]} />
        <Menu label="Well" open={menu} setOpen={setMenu} items={[{ l: 'Import well data…', k: 'Ctrl+O', on: () => { S().go('import'); setTimeout(() => importBus.open('well'), 60); } }, 'sep', ...st.wells.map((w) => ({ l: `${w.id === well?.id ? '● ' : ''}${w.name}`, on: () => S().set({ activeWellId: w.id }) })), 'sep', { l: 'Rename active well…', dis: !well, on: () => { const n = prompt('Well name', well!.name); if (n) { S().updateWell(well!.id, (w) => ({ ...w, name: n })); S().log(`Renamed well → ${n}`); } } }, { l: 'Remove active well', dis: !well, on: () => { if (confirm(`Remove ${well!.name} and its core datasets from the project?`)) { registry.deleteWell(well!.id); S().set({ wells: S().wells.filter((w) => w.id !== well!.id), cores: S().cores.filter((c) => c.wellId !== well!.id), activeWellId: undefined }); S().log(`Removed well ${well!.name}`, 'warn'); } } }]} />
        <Menu label="Data" open={menu} setOpen={setMenu} items={[{ l: 'Import Manager', on: go('import') }, { l: 'Curve Manager', k: 'Ctrl+F', on: go('curves') }, { l: 'Core Data', on: go('core') }, { l: 'Depth Manager / Core-Log Match', on: go('depth') }, { l: 'Add Tops…', on: () => { S().go('import'); setTimeout(() => importBus.open('tops'), 60); } }, { l: 'Formations & Zones', on: go('zones') }, { l: 'Reservoir Intervals (analysis scope)', on: go('reservoir') }, 'sep', { l: 'Data Table', on: go('table') }, { l: 'Interval & Formula Builder', on: go('filters') }]} />
        <Menu label="Analysis" open={menu} setOpen={setMenu} items={[{ l: 'Log Visualization', on: go('logview') }, { l: 'Petrophysical Evaluation (Vsh · PHIT_ND · Archie Sw)', on: go('petro') }, { l: 'Formula Calculator', on: go('calc') }, { l: 'RQI / FZI · HFU Analyzer', on: go('hfu') }, { l: 'HFU Clustering', on: go('cluster') }, { l: 'Crossplot Studio', on: go('crossplot') }, { l: 'FZI Regression Studio', on: go('regression') }, { l: 'Validation', on: go('validation') }, { l: 'Predicted FZI / HFU', on: go('prediction') }, { l: 'HFU Depth Track', on: go('hfutrack') }, 'sep', { l: 'HFU Transition Analysis', on: go('transitions') }, { l: 'Reservoir Quality Summary', on: go('rq') }, { l: 'Multi-Well Analysis', on: go('multiwell') }, { l: 'Advanced Modules (NMR, MICP, SCAL…)', on: go('advanced') }, { l: 'Audit Trail', on: go('audit') }]} />
        <Menu label="QC" open={menu} setOpen={setMenu} items={[{ l: 'Core QC (duplicates, nulls, outliers)', on: go('core') }, { l: 'Curve statistics (null %, ranges)', on: go('curves') }, { l: 'Statistical QC Dashboard', on: go('qc') }]} />
        <Menu label="Export" open={menu} setOpen={setMenu} items={[{ l: 'Export & Report centre', on: go('export') }, { l: 'Generate Interpretation Report…', on: go('export') }, { l: 'Export Project (.hfaproj)', on: exportProject }]} />
        <Menu label="Settings" open={menu} setOpen={setMenu} items={[{ l: 'Curve alias mapping', on: go('curves') }, { l: `RQI constant C = ${st.hfuConfig.rqiConst}`, on: go('hfu') }, { l: `Log & depth plots: ${st.logTheme === 'light' ? 'conventional (white) ✓' : 'dark'} — switch`, on: () => { S().set({ logTheme: st.logTheme === 'light' ? 'dark' : 'light' }); } }, { l: 'Keyboard shortcuts', on: () => setDlg('keys') }, { l: 'Privacy & data security', on: () => setDlg('privacy') }, 'sep', { l: 'Clear ALL local HFA data (IndexedDB)…', on: () => { if (confirm('Delete every locally stored HFA project and array in this browser?')) { indexedDB.deleteDatabase('hfa-suite'); location.reload(); } } }]} />
        <div className="spacer" />
        {st.wells.length > 0 && <span className={'scope-chip' + (st.zone ? '' : ' off')} style={{ marginRight: 8 }} title="Analysis scope — click to manage reservoir intervals" onClick={go('reservoir')}>Scope: {scopeLabel(st.zone, st.activeWellId ?? st.wells[0]?.id, true)}</span>}
        <button className={'btn sm' + (guide ? ' on' : '')} style={{ marginRight: 8 }} onClick={() => setGuide(!guide)}>Workflow guide</button>
        {demo && <span className="demo-flag">{DEMO_BANNER}</span>}
        <span className="hint" title="All parsing and computation run in this browser. No well data is uploaded.">● local-only · offline-capable</span>
      </div>
      <div className="sidebar">
        <div className="sec-h">Project Explorer <span className="dim">{st.project.name}</span></div>
        <ul className="tree">
          <li style={{ ['--ind' as any]: 0 }} onClick={go('home')} className={st.module === 'home' ? 'act' : ''}><span className="tw">▪</span>Overview</li>
          <li style={{ ['--ind' as any]: 0 }} className="dis"><span className="tw">▾</span>Wells<span className="ct">{st.wells.length}</span></li>
          {st.wells.map((w) => {
            const ex = expanded[w.id] ?? w.id === well?.id; const nc = st.cores.filter((c) => c.wellId === w.id); const nt = st.tops.filter((t) => t.wellId === w.id).length; const nh = w.curves.filter((c) => c.discrete).length;
            return [
              <li key={w.id} style={{ ['--ind' as any]: 1 }} className={w.id === well?.id ? 'act' : ''} onClick={() => { S().set({ activeWellId: w.id }); setExpanded({ ...expanded, [w.id]: !ex }); }}><span className="tw">{ex ? '▾' : '▸'}</span><span className="sw" style={{ background: w.color }} />{w.name}</li>,
              ...(ex ? [
                <li key={w.id + 'l'} style={{ ['--ind' as any]: 2 }} onClick={() => { S().set({ activeWellId: w.id }); S().go('curves'); }}>Logs<span className="ct">{w.curves.length}</span></li>,
                <li key={w.id + 'c'} style={{ ['--ind' as any]: 2 }} onClick={() => { S().set({ activeWellId: w.id, activeCoreId: nc[0]?.id }); S().go('core'); }}>Core<span className="ct">{nc.reduce((a, c) => a + c.n, 0)}</span></li>,
                <li key={w.id + 't'} style={{ ['--ind' as any]: 2 }} onClick={() => { S().set({ activeWellId: w.id }); S().go('logview'); }}>Tops<span className="ct">{nt}</span></li>,
                <li key={w.id + 'h'} style={{ ['--ind' as any]: 2 }} onClick={() => { S().set({ activeWellId: w.id }); S().go('hfutrack'); }}>HFU<span className="ct">{nh}</span></li>,
              ] : []),
            ];
          })}
        </ul>
        <div className="sec-h">Data</div>
        <ul className="tree">{(['import', 'curves', 'core', 'depth', 'zones', 'reservoir', 'calc', 'table', 'filters', 'qc'] as ModuleId[]).map((m) => <li key={m} style={{ ['--ind' as any]: 1 }} className={st.module === m ? 'act' : ''} onClick={go(m)}>{m === 'depth' ? 'Depth Manager' : MODULES[m].label}</li>)}</ul>
        <div className="sec-h">Analysis</div>
        <ul className="tree">
          {(['logview', 'petro', 'crossplot', 'depth', 'hfu', 'cluster', 'regression', 'validation', 'prediction', 'hfutrack', 'transitions', 'rq', 'multiwell', 'advanced', 'audit', 'export'] as ModuleId[]).map((m) => <li key={'a' + m} style={{ ['--ind' as any]: 1 }} className={st.module === m ? 'act' : ''} onClick={go(m)}>{MODULES[m].label}</li>)}
        </ul>
      </div>
      <div className="main"><M.C key={st.module} /></div>
      <div className="right">
        <div id="right-slot" />
        {well && <Box title="Well properties">
          <Kv rows={[['Well', well.name], ['UWI/API', well.uwi || '—'], ['Field', well.field || '—'], ['Depth', `${fmt(well.start, 6)} – ${fmt(well.stop, 6)} ${well.depthUnit}`], ['Sampling', `${fmt(well.step, 4)} ${well.depthUnit}${well.regular ? '' : ' (irregular)'}`], ['Samples', well.nSamples.toLocaleString()], ['Curves', String(well.curves.length)], ['Sources', well.sources.map((s) => s.name).join(', ')]]} />
        </Box>}
        {guide && <WorkflowGuide compact />}
        <Box title="Analysis history" right={<><button className="btn sm" disabled={!st.canUndo} onClick={undo} title="Undo (Ctrl+Z)">↶ Undo</button><button className="btn sm" disabled={!st.canRedo} onClick={redo} title="Redo (Ctrl+Y)">↷ Redo</button></>}>
          <HistoryList />
        </Box>
      </div>
      <div className="status">
        <span>Well: <b>{well?.name ?? '—'}</b></span>
        <span>Depth: <b>{well ? `${fmt(well.start, 5)}–${fmt(well.stop, 5)} ${well.depthUnit}` : '—'}</b></span>
        <span>Cursor: <b>{cursor !== undefined ? cursor.toFixed(2) : '—'}</b></span>
        <span>Interval: <b>{st.interval ? `${st.interval.top}–${st.interval.base}` : '—'}</b></span>
        <span>Selection: <b>{st.selection ? st.selection.label : '—'}</b></span>
        <span className="grow">Operation: <b>{M.label}</b>{lastLog ? <span className="dim"> · last: {lastLog.msg.slice(0, 80)}</span> : null}</span>
        <span className={st.busy ? 'busy' : ''}>{st.busy ? `⧗ ${st.busy.label}` : 'Ready'}{st.dirty ? ' · unsaved' : ''}</span>
        <span>Memory: <b>{mem}</b></span>
      </div>
      <div className="toasts">{st.toasts.map((t) => <div key={t.id} className={'toast ' + t.level} onClick={() => S().dismiss(t.id)}><b style={{ marginRight: 6 }}>{t.level}</b>{t.text}</div>)}</div>
      <input ref={projIn} type="file" hidden accept=".hfaproj" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { try { await importProject(f); S().notify('OK', `Imported project ${f.name}`); } catch (err: any) { S().notify('CRITICAL', err.message); } } e.target.value = ''; }} />
      {dlg === 'new' && <ProjectProps mode="new" onClose={() => setDlg(null)} />}
      {dlg === 'props' && <ProjectProps mode="edit" onClose={() => setDlg(null)} />}
      {dlg === 'open' && <OpenProject onClose={() => setDlg(null)} />}
      {dlg === 'keys' && <Modal title="Keyboard shortcuts" onClose={() => setDlg(null)}><table className="t"><tbody>{[['Ctrl + O', 'Open data (Import Manager)'], ['Ctrl + S', 'Save project'], ['Ctrl + Z', 'Undo last analysis step'], ['Ctrl + Y / Ctrl + Shift + Z', 'Redo'], ['Ctrl + F', 'Find curve'], ['Mouse wheel', 'Zoom depth (log viewer)'], ['Shift + mouse wheel', 'Horizontal zoom (track width)'], ['Drag', 'Pan depth'], ['Drag in depth track', 'Select interval'], ['Alt + click', 'Add annotation (prefix "!" for a marker)'], ['Double-click', 'Full well'], ['Space', 'Toggle cursor read-out'], ['Esc', 'Cancel selection / interval']].map(([k, v]) => <tr key={k}><td><b className="mono">{k}</b></td><td>{v}</td></tr>)}</tbody></table></Modal>}
      {dlg === 'privacy' && <Modal title="Privacy & data security" onClose={() => setDlg(null)} width={620}><div className="col">
        <div className="msg OK"><b>LOCAL-FIRST</b>All parsing (LAS, DLIS, LIS, CSV, XLSX, JSON, Parquet), calculations, clustering, regression, validation and exports run inside this browser (Web Workers). No server is contacted.</div>
        <div>• Raw well data stay on this machine. Projects are stored in this browser's IndexedDB; raw LAS/DLIS files are not copied into the project.</div>
        <div>• No analytics or telemetry of any kind is sent. No automatic cloud upload.</div>
        <div>• The application works offline once opened (single self-contained HTML file).</div>
        <div>• Nothing in this build requires a server-side operation. If an optional compute service is ever added, the app will state exactly what leaves the browser before sending anything.</div>
        <div>• Use Settings → “Clear ALL local HFA data” to remove everything stored by the app in this browser.</div>
      </div></Modal>}
    </div>
  );
}
