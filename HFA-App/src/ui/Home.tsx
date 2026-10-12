import { useStore, S, type ModuleId } from '../store/store';
import { registry } from '../data-engine/registry';
import { Box, ModHead } from './common';
import { loadDemo, DEMO_BANNER } from '../demo/demo';
import { fmt } from '../util/num';
import { WorkflowGuide } from './WorkflowGuide';
import { scopeLabel } from '../data-engine/zones';

export function Home() {
  const s = useStore(); useStore((x) => x.dataVersion);
  const depthAnalyzed = s.wells.reduce((a, w) => a + (w.stop - w.start), 0);
  const coreN = s.cores.reduce((a, c) => a + c.n, 0);
  const fziN = s.cores.reduce((a, c) => { const r = registry.core(c.id); const f = r?.num.get('FZI'); return a + (f ? f.filter((v, i) => v === v && !r!.excluded[i]).length : 0); }, 0);
  const hfuN = s.hfuSets.length ? Math.max(...s.hfuSets.map((h) => h.units.length)) : 0;
  const hasPred = s.wells.some((w) => w.curves.some((c) => c.mnemonic === 'FZI_PRED'));
  const steps: [string, boolean, ModuleId][] = [
    ['Import', s.wells.length > 0, 'import'], ['Curve Mapping', Object.keys(s.aliases).length > 0 || s.wells.length > 0, 'curves'], ['QC', s.cores.some((c) => c.filterLog.length > 0), 'core'],
    ['Depth Matching', s.cores.some((c) => c.depthOps.length > 0), 'depth'], ['PHI · K · RQI · FZI', fziN > 0, 'hfu'], ['RQI vs PHI plot', fziN > 0, 'hfu'], ['Identify HFUs', s.hfuSets.length > 0, 'hfu'],
    ['Clustering', s.hfuSets.some((h) => h.method.startsWith('F')), 'cluster'], ['Select predictors', s.models.length > 0, 'regression'], ['Regression', s.models.length > 0, 'regression'], ['Validate', s.validations.length > 0, 'validation'],
    ['FZI_PRED', hasPred, 'prediction'], ['HFU_PRED', s.wells.some((w) => w.curves.some((c) => c.mnemonic === 'HFU_PRED')), 'prediction'], ['HFU track', hasPred, 'hfutrack'],
  ];
  const kpis: [string, string][] = [['Wells', String(s.wells.length)], ['Depth analyzed', `${fmt(depthAnalyzed, 5)} m`], ['Core samples', String(coreN)], ['Valid FZI samples', String(fziN)], ['HFUs (max units)', String(hfuN)], ['Regression models', String(s.models.length)], ['Analysis scope', scopeLabel(s.zone, s.activeWellId ?? s.wells[0]?.id)]];
  const cards: [string, string, ModuleId][] = [
    ['Data QC', `${s.wells.reduce((a, w) => a + w.curves.length, 0)} curves · ${s.cores.reduce((a, c) => a + c.filterLog.length, 0)} core QC operations`, 'qc'],
    ['Reservoir & Petrophysics', `${s.reservoirs.filter((r) => r.active).length} reservoir interval(s) · ${s.wells.some((w) => w.curves.some((c) => c.mnemonic === 'SW_AR')) ? 'evaluation run' : 'evaluation not run'}`, 'petro'],
    ['Core-Log Match', `${s.cores.reduce((a, c) => a + c.depthOps.filter((o) => o.active).length, 0)} active depth operations`, 'depth'],
    ['HFU Analysis', `${s.hfuSets.length} sets · ${s.hfuSets.reduce((a, h) => a + h.units.filter((u) => u.status === 'Hydraulic Flow Unit').length, 0)} validated HFUs`, 'hfu'],
    ['Regression', `${s.models.length} models`, 'regression'],
    ['Validation', `${s.validations.length} runs`, 'validation'],
  ];
  return <>
    <ModHead title="Overview" sub={`${s.project.name}${s.project.field ? ' · ' + s.project.field : ''}${s.project.formation ? ' · ' + s.project.formation : ''}`}>
      {!s.wells.length && <button className="btn warn" onClick={() => { loadDemo(); S().notify('WARNING', `${DEMO_BANNER} loaded.`); }}>Load Demo Data</button>}
      <button className="btn pri" onClick={() => S().go('import')}>Import data</button>
    </ModHead>
    <div className="mod-b">
      <div className="kpis">{kpis.map(([l, v]) => <div key={l} className="kpi"><div className="l">{l}</div><div className="v">{v}</div></div>)}</div>
      <div style={{ marginTop: 8 }}><WorkflowGuide /></div>
      <div className="cards" style={{ marginTop: 8 }}>{cards.map(([t, d, m]) => <div key={t} className="card" onClick={() => S().go(m)}><h4>{t}</h4><div className="hint">{d}</div></div>)}</div>
      <Box title="Wells" style={{ marginTop: 8 }}>
        <table className="t"><thead><tr><th>Well</th><th>UWI</th><th>Top</th><th>Base</th><th>Step</th><th>Curves</th><th>Core datasets</th><th>Tops</th><th>Sources</th></tr></thead>
          <tbody>{s.wells.map((w) => <tr key={w.id} onClick={() => { S().set({ activeWellId: w.id }); S().go('logview'); }} style={{ cursor: 'pointer' }}><td><span className="pill" style={{ background: w.color }} />{w.name}{w.demo && <span className="tag warn" style={{ marginLeft: 6 }}>DEMO</span>}</td><td>{w.uwi || '—'}</td><td className="num">{fmt(w.start, 6)}</td><td className="num">{fmt(w.stop, 6)}</td><td className="num">{fmt(w.step, 4)}</td><td className="num">{w.curves.length}</td><td className="num">{s.cores.filter((c) => c.wellId === w.id).length}</td><td className="num">{s.tops.filter((t) => t.wellId === w.id).length}</td><td className="dim">{w.sources.map((x) => x.name).join(', ')}</td></tr>)}</tbody></table>
        {!s.wells.length && <div className="hint">No wells yet. Drag LAS / DLIS / CSV / XLSX files into the Import Manager, or load the demo dataset.</div>}
      </Box>
    </div>
  </>;
}
