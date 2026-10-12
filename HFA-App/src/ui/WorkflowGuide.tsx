import { S, useStore, type ModuleId, type State } from '../store/store';
import { registry } from '../data-engine/registry';
import { Box } from './common';

export function workflowSteps(s: State): { n: number; label: string; done: boolean; go: ModuleId; hint: string }[] {
  const fzi = s.cores.some((c) => registry.core(c.id)?.num.has('FZI'));
  const has = (m: string) => s.wells.some((w) => w.curves.some((c) => c.mnemonic === m));
  const logged = (re: RegExp) => s.history.some((h) => re.test(h.msg));
  const list: { n: number; label: string; done: boolean; go: ModuleId; hint: string }[] = [
    { n: 1, label: 'Import', done: s.wells.length > 0 && s.cores.length > 0, go: 'import', hint: 'Load LAS/DLIS/LIS logs and core (CSV/XLSX).' },
    { n: 2, label: 'Curve Mapping', done: s.wells.some((w) => w.curves.filter((c) => c.family).length >= 3), go: 'curves', hint: 'Check aliases (e.g. AT90 → RT, TNPH → NPHI).' },
    { n: 2.5, label: 'Define reservoir interval(s)', done: s.reservoirs.some((r) => r.active), go: 'reservoir', hint: 'Analysis runs on the reservoir, not on the whole well (flag file, tops, or manual).' },
    { n: 2.7, label: 'Petrophysics: VSH · PHIT_ND · Archie Sw', done: has('PHIT_ND') && has('SW_AR'), go: 'petro', hint: 'GR P5/P95 per zone, ND crossplot, Pickett plot, cut-offs & summation.' },
    { n: 3, label: 'QC', done: s.cores.some((c) => c.filterLog.length > 0) || logged(/statistical QC/), go: 'qc', hint: 'Review QC flags; clean core duplicates / nulls.' },
    { n: 4, label: 'Depth Matching', done: s.cores.some((c) => c.depthOps.some((o) => o.active)), go: 'depth', hint: 'Shift core to log depth; accept the operation.' },
    { n: 5, label: 'Calculate PHI · K · RQI · FZI', done: fzi, go: 'hfu', hint: 'Confirm φ and k units, then calculate.' },
    { n: 6, label: 'RQI vs PHI plot', done: fzi, go: 'hfu', hint: 'Inspect log RQI vs log Φz (unit-slope lines).' },
    { n: 7, label: 'Identify HFUs', done: s.hfuSets.some((h) => !h.method.startsWith('F')), go: 'hfu', hint: 'Methods A–E (FZI-based).' },
    { n: 8, label: 'Run clustering', done: s.hfuSets.some((h) => h.method.startsWith('F')), go: 'cluster', hint: 'Method F — multi-feature clustering.' },
    { n: 9, label: 'Review cluster statistics', done: s.hfuSets.some((h) => h.units.some((u) => u.status === 'Hydraulic Flow Unit')), go: 'cluster', hint: 'Validate / rename statistical clusters as HFUs.' },
    { n: 10, label: 'Select log predictors', done: s.models.length > 0 || logged(/Feature selection/), go: 'regression', hint: 'Candidate logs + feature-selection method.' },
    { n: 11, label: 'Run regression', done: s.models.length > 0, go: 'regression', hint: 'Global or per-HFU models.' },
    { n: 12, label: 'Validate', done: s.validations.length > 0, go: 'validation', hint: 'Depth-blocked or well-based validation.' },
    { n: 13, label: 'Generate FZI_PRED', done: has('FZI_PRED'), go: 'prediction', hint: 'Apply the chosen model to the well.' },
    { n: 14, label: 'Generate HFU_PRED', done: has('HFU_PRED'), go: 'prediction', hint: 'Classify FZI_PRED with HFU thresholds.' },
    { n: 15, label: 'Display HFU track', done: has('HFU_PRED') && logged(/HFU Depth Track|Applied .* to/), go: 'hfutrack', hint: 'Click bands for interval statistics.' },
    { n: 16, label: 'Export interpretation', done: logged(/interpretation report|Exported/), go: 'export', hint: 'Generate the interpretation report (PDF/HTML).' },
  ];
  return list.map((x, i) => ({ ...x, n: i + 1 }));
}

export function WorkflowGuide({ compact }: { compact?: boolean }) {
  const s = useStore(); const steps = workflowSteps(s); const next = steps.find((x) => !x.done);
  return <Box title="Default HFU workflow" right={<span className="hint">{steps.filter((x) => x.done).length}/{steps.length}</span>}>
    <ul className="guide tree">{steps.map((st) => <li key={st.n} className={(st.done ? 'done ' : '') + (next?.n === st.n ? 'cur' : '')} onClick={() => S().go(st.go)} title={st.hint}>
      <span style={{ width: 18 }}>{st.done ? '✓' : st.n}</span><span>{st.label}</span>{!compact && next?.n === st.n && <span className="hint" style={{ marginLeft: 'auto' }}>{st.hint}</span>}</li>)}</ul>
    {next && <button className="btn pri sm" style={{ marginTop: 6 }} onClick={() => S().go(next.go)}>Continue: step {next.n} — {next.label} →</button>}
  </Box>;
}
