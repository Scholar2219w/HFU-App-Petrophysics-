import { useState } from 'react';
import { useStore } from '../store/store';
import { Box, Empty, Kv, ModHead, useActiveWell } from './common';
import { ALGO_LABEL, modelStatsRow } from './Regression';
import { describeOp } from '../depth/transforms';
import type { CurveMeta, RegressionModel, WellMeta } from '../types';
import { fmt } from '../util/num';

export function ModelAudit({ m }: { m: RegressionModel }) {
  const vals = useStore((s) => s.validations).filter((v) => v.modelId === m.id); const sets = useStore((s) => s.hfuSets); const s = modelStatsRow(m);
  const ds = m.params.ds ?? {};
  return <Kv rows={[
    ['Model', <b>{m.name}</b>], ['Algorithm', ALGO_LABEL[m.algorithm] + (m.groupBy === 'hfu' ? ` — one model per HFU/cluster (${m.subModels.length})` : '')],
    ['Inputs', m.features.join(', ')], ['Target', m.targetTransform === 'log10' ? `log10(${m.target})` : m.target],
    ['Training', `${m.wellIds.join(', ')} · ${m.domain} samples${m.interval ? ` · depth ${m.interval[0]}–${m.interval[1]}` : ''}${ds.zone ? ` · zone ${ds.zone}` : ''} · N = ${s.n}`],
    ['Samples removed', Object.entries(m.params.dropped ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'],
    ['HFU/cluster set', m.hfuSetId ? sets.find((h) => h.id === m.hfuSetId)?.name ?? '(deleted)' : '—'],
    ['Feature selection', m.selectionMethod], ['R² (training)', fmt(s.r2, 4)], ['RMSE (training)', fmt(s.rmse, 4)],
    ['Validation', vals.length ? vals.map((v) => `${v.method}: R² ${fmt(v.metrics.r2, 3)}, RMSE ${fmt(v.metrics.rmse, 3)}, N ${v.metrics.n} (${v.createdAt.slice(0, 16).replace('T', ' ')})`).join(' | ') : 'not validated'],
    ['Equations', <div>{m.subModels.map((q) => <div key={q.group} className="mono" style={{ fontSize: 10.5 }}>[{q.group}] {q.equation}</div>)}</div>],
    ['Date', m.createdAt.replace('T', ' ').slice(0, 19)],
  ]} />;
}

function Lineage({ well, c, depth = 0, seen }: { well: WellMeta; c: CurveMeta; depth?: number; seen: Set<string> }) {
  const models = useStore((s) => s.models); const cores = useStore((s) => s.cores);
  const m = c.calc?.model ? models.find((x) => x.id === c.calc!.model) : undefined;
  const core = c.calc?.kind === 'core-projection' || c.calc?.kind === 'hfu' ? cores.find((x) => x.wellId === well.id && c.calc!.formula.includes(x.name)) : undefined;
  const children = (c.calc?.inputs ?? []).map((i) => i.replace(/^LOG10\((.*)\)$/, '$1')).map((i) => well.curves.find((x) => x.mnemonic === i)).filter(Boolean) as CurveMeta[];
  return <div style={{ marginLeft: depth * 16, borderLeft: depth ? '1px solid var(--bd2)' : undefined, paddingLeft: depth ? 8 : 0, marginTop: 4 }}>
    <div><b>{c.mnemonic}</b> <span className="dim">[{c.unit || '—'}] · {c.calc ? `${c.calc.kind} v${c.calc.version} · ${c.calc.createdAt.slice(0, 16).replace('T', ' ')}` : `measured — ${c.source}`}</span></div>
    {c.calc && <div className="formula" style={{ margin: '2px 0' }}>{c.mnemonic} = {c.calc.formula}</div>}
    {c.calc && <div className="hint">Missing data: {c.calc.missing}{c.calc.notes && !m ? ` · ${c.calc.notes}` : ''}</div>}
    {m && <div className="box" style={{ margin: '4px 0' }}><div className="bb"><ModelAudit m={m} /></div></div>}
    {core && <div className="hint">Core dataset “{core.name}” · φ unit {core.phiUnit ?? 'UNCONFIRMED'} · k unit {core.kUnit ?? 'UNCONFIRMED'} · depth ops: {core.depthOps.filter((o) => o.active).map((o) => describeOp(o)).join('; ') || 'none'} · QC filters: {core.filterLog.map((f) => `${f.op} (−${f.removed})`).join('; ') || 'none'}</div>}
    {children.filter((ch) => !seen.has(ch.mnemonic)).map((ch) => { seen.add(ch.mnemonic); return <Lineage key={ch.mnemonic} well={well} c={ch} depth={depth + 1} seen={seen} />; })}
  </div>;
}

export function Audit() {
  const well = useActiveWell(); const models = useStore((s) => s.models); const sets = useStore((s) => s.hfuSets);
  const derived = well?.curves.filter((c) => c.calc) ?? [];
  const [cur, setCur] = useState<string>('');
  if (!well) return <><ModHead title="Audit Trail" /><Empty>No well.</Empty></>;
  const c = well.curves.find((x) => x.mnemonic === (cur || derived.find((d) => d.mnemonic === 'FZI_PRED')?.mnemonic || derived[0]?.mnemonic));
  return <>
    <ModHead title="Audit Trail" sub="Every calculated result is traceable to its formula, inputs, model, training data and date" />
    <div className="mod-b"><div className="split" style={{ gridTemplateColumns: '260px 1fr' }}>
      <Box title={`Derived curves — ${well.name}`}>{derived.length ? derived.map((d) => <div key={d.mnemonic} onClick={() => setCur(d.mnemonic)} style={{ padding: '2px 4px', cursor: 'pointer', background: c?.mnemonic === d.mnemonic ? '#1c3350' : undefined }}>{d.mnemonic} <span className="dim">{d.calc!.kind}</span></div>) : <span className="hint">No derived curves.</span>}</Box>
      <div className="col">
        {c && <Box title={`Provenance of ${c.mnemonic}`}><Lineage well={well} c={c} seen={new Set([c.mnemonic])} /></Box>}
        <Box title="Models">{models.length ? models.map((m) => <div key={m.id} style={{ borderBottom: '1px solid var(--bd)', padding: '4px 0' }}><ModelAudit m={m} /></div>) : <span className="hint">No models.</span>}</Box>
        <Box title="HFU / cluster sets">{sets.map((h) => <div key={h.id} className="hint" style={{ padding: '2px 0' }}><b style={{ color: 'var(--tx)' }}>{h.name}</b> — {h.method}{h.algorithm ? ` (${h.algorithm})` : ''} · features {h.features.join(', ')} · {h.units.filter((u) => u.status === 'Hydraulic Flow Unit').length}/{h.units.length} validated as HFU · {h.createdAt.slice(0, 16).replace('T', ' ')}</div>)}{!sets.length && <span className="hint">None.</span>}</Box>
      </div>
    </div></div>
  </>;
}
