import { useEffect, useState } from 'react';
import { S, useStore } from '../store/store';
import { registry } from '../data-engine/registry';
import { projectFlags, wellQC, type Flag, type WellQC } from '../qc/qc';
import { Box, Empty, ModHead, Sel, ZoneSelect, download } from './common';
import { toCSV } from '../export/io';
import { fmt } from '../util/num';

export async function ensureAllCurves(ids?: string[]) {
  for (const w of S().wells) if (!ids || ids.includes(w.id)) { try { await registry.ensureCurves(w.id, w.curves.map((c) => c.mnemonic)); } catch { /* reported by QC */ } }
}

const LV: Record<string, string> = { CRITICAL: 'crit', WARNING: 'warn', INFO: '' };

export function QCDashboard() {
  const wells = useStore((s) => s.wells); const zone = useStore((s) => s.zone); useStore((s) => s.dataVersion); const activeWellId = useStore((s) => s.activeWellId);
  const [wid, setWid] = useState(activeWellId ?? wells[0]?.id ?? '');
  const [q, setQ] = useState<WellQC | null>(null); const [flags, setFlags] = useState<Flag[]>([]); const [lvl, setLvl] = useState<'all' | 'CRITICAL' | 'WARNING' | 'INFO'>('all'); const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await ensureAllCurves(); const w = S().wells.find((x) => x.id === wid); setQ(w ? wellQC(w, zone) : null); setFlags(projectFlags(zone)); S().log(`Ran statistical QC${zone ? ` (zone ${zone})` : ''}: ${projectFlags(zone).length} flags`); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (wells.length) run(); }, [wid, zone]);
  if (!wells.length) return <><ModHead title="Statistical QC" /><Empty>Load data first.</Empty></>;
  const cnt = (l: string) => flags.filter((f) => f.level === l).length;
  const shown = flags.filter((f) => lvl === 'all' || f.level === lvl);
  const exportQC = () => download(toCSV([{ name: 'Level', data: flags.map((f) => f.level) }, { name: 'Well', data: flags.map((f) => f.well) }, { name: 'Item', data: flags.map((f) => f.item) }, { name: 'Message', data: flags.map((f) => f.text) }], false), 'QC_report.csv', 'text/csv');
  return <>
    <ModHead title="Statistical QC Dashboard" sub="Flags are informative — nothing is removed automatically">
      <select value={wid} onChange={(e) => setWid(e.target.value)}>{wells.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
      <ZoneSelect /><button className="btn" onClick={run} disabled={busy}>{busy ? 'Running…' : 'Re-run QC'}</button><button className="btn" onClick={exportQC}>Export QC CSV</button>
    </ModHead>
    <div className="mod-b">
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
        {[['CRITICAL', cnt('CRITICAL'), 'var(--crit)'], ['WARNING', cnt('WARNING'), 'var(--warn)'], ['INFO', cnt('INFO'), 'var(--info)'], ['Curves checked', q?.curves.length ?? 0, ''], ['Depth gaps', q?.gaps.length ?? 0, ''], ['Duplicate depth samples', q?.duplicates ?? 0, '']].map(([l, v, c]) =>
          <div key={String(l)} className="kpi" style={{ cursor: typeof l === 'string' && ['CRITICAL', 'WARNING', 'INFO'].includes(l) ? 'pointer' : undefined }} onClick={() => ['CRITICAL', 'WARNING', 'INFO'].includes(String(l)) && setLvl(l as any)}><div className="l">{l}</div><div className="v" style={{ color: String(c) || undefined }}>{v}</div></div>)}
      </div>
      <div className="grid2" style={{ gridTemplateColumns: '1.1fr 1fr', marginTop: 8 }}>
        <Box title="Flags (all wells)" right={<Sel value={lvl} onChange={setLvl} options={[{ v: 'all', l: 'All levels' }, 'CRITICAL', 'WARNING', 'INFO']} />}>
          <div className="tbl-wrap" style={{ maxHeight: 520 }}><table className="t"><thead><tr><th>Level</th><th>Well</th><th>Item</th><th>Message</th></tr></thead><tbody>
            {shown.map((f, i) => <tr key={i}><td><span className={'tag ' + LV[f.level]}>{f.level}</span></td><td>{f.well}</td><td>{f.item}</td><td style={{ whiteSpace: 'normal', fontFamily: 'var(--sans)' }}>{f.text}</td></tr>)}
            {!shown.length && <tr><td colSpan={4} className="dim">No flags.</td></tr>}
          </tbody></table></div>
        </Box>
        <div className="col">
          {q && <Box title={`Curves — ${q.well.name}${zone ? ` · ${zone}` : ''}`}>
            <div className="tbl-wrap" style={{ maxHeight: 330 }}><table className="t"><thead><tr><th>Curve</th><th>Unit</th><th>Type</th><th title="NaN over the whole (zone) grid">Null %</th><th title="NaN inside the curve's own logged interval">Missing %</th><th title="beyond median ± 5·MAD">Outlier %</th><th>Coverage %</th><th>Top</th><th>Base</th></tr></thead><tbody>
              {q.curves.map((c) => <tr key={c.mnemonic}><td>{c.mnemonic}</td><td className="dim">{c.unit}</td><td className="dim">{c.category}</td>
                <td className="num">{c.nullPct.toFixed(1)}</td><td className="num" style={{ color: c.missingPct > 20 ? 'var(--warn)' : undefined }}>{c.missingPct.toFixed(1)}</td><td className="num" style={{ color: c.outlierPct > 2 ? 'var(--warn)' : undefined }}>{c.outlierPct.toFixed(2)}</td><td className="num">{c.coveragePct.toFixed(0)}</td><td className="num">{fmt(c.top, 6)}</td><td className="num">{fmt(c.base, 6)}</td></tr>)}
            </tbody></table></div>
          </Box>}
          {q && <Box title="Depth sampling">
            <table className="t"><thead><tr><th>Sampling interval</th><th>Occurrences</th></tr></thead><tbody>{q.steps.slice(0, 6).map((s) => <tr key={s.step}><td className="num">{s.step} {q.well.depthUnit}</td><td className="num">{s.n}</td></tr>)}</tbody></table>
            {q.gaps.length > 0 && <div className="hint" style={{ marginTop: 4 }}>Gaps: {q.gaps.slice(0, 12).map((g) => `${g.top.toFixed(2)}–${g.base.toFixed(2)}`).join(', ')}{q.gaps.length > 12 ? ' …' : ''}</div>}
            <div className="hint">Unit consistency, core coverage and duplicate-measurement checks are included in the flag list.</div>
          </Box>}
        </div>
      </div>
    </div>
  </>;
}
