import { useEffect, useRef, useState } from 'react';
import { S, useStore } from '../store/store';
import { call } from '../workers/rpc';
import { ingestLog } from '../data-engine/ingest';
import { createCore } from '../data-engine/core';
import type { ParsedLog, ParsedTable, TableOptions, TablePreview } from '../parsers/types';
import type { DlisScan } from '../parsers/dlis';
import { Box, Field, ModHead, Msgs, Sel } from './common';
import { fmt, fmtBytes, hfuColor, uid } from '../util/num';
import { loadDemo, DEMO_BANNER } from '../demo/demo';

type Kind = 'well' | 'core' | 'tops' | 'aux';
interface Job {
  id: string; file: File; kind: Kind; format: string;
  status: 'parsing' | 'ready' | 'done' | 'error';
  error?: string; progress?: number;
  parsed?: ParsedLog; dlis?: DlisScan; preview?: TablePreview;
  messages: { level: 'CRITICAL' | 'WARNING' | 'INFO' | 'OK'; text: string }[];
}

const fmtOf = (name: string) => {
  const e = name.split('.').pop()!.toLowerCase();
  if (e === 'las') return 'LAS'; if (e === 'dlis') return 'DLIS'; if (e === 'lis' || e === 'tif') return 'LIS';
  if (['csv', 'txt', 'asc', 'tsv', 'dat'].includes(e)) return 'CSV'; if (e === 'parquet') return 'PARQUET'; if (['xlsx', 'xls', 'xlsm', 'ods'].includes(e)) return 'XLSX';
  if (e === 'json') return 'JSON'; if (e === 'parquet') return 'PARQUET'; return e.toUpperCase();
};

// global hook so Ctrl+O / menu can open the file dialog
export const importBus = { open: (_k: Kind) => {} };

export function ImportManager() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const kindRef = useRef<Kind | undefined>(undefined);
  const wells = useStore((s) => s.wells);
  const upd = (id: string, p: Partial<Job>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...p } : j)));

  useEffect(() => { importBus.open = (k) => { kindRef.current = k; input.current?.click(); }; }, []);

  const addFiles = (files: FileList | File[], kind?: Kind) => {
    for (const file of Array.from(files)) {
      const format = fmtOf(file.name);
      const k: Kind = kind ?? (['LAS', 'DLIS', 'LIS'].includes(format) ? 'well' : /core|plug|rca|poro|perm/i.test(file.name) ? 'core' : /top|marker|pick|zone|formation|strat/i.test(file.name) ? 'tops' : /flag/i.test(file.name) ? 'aux' : 'well');
      const job: Job = { id: uid('j_'), file, kind: k, format, status: 'parsing', messages: [] };
      setJobs((js) => [job, ...js]);
      S().log(`Import: reading ${file.name} (${fmtBytes(file.size)})`);
      (async () => {
        try {
          if (format === 'LIS') {
            const parsed = await call<ParsedLog>('parse', 'parseLIS', [file]);
            upd(job.id, { status: 'ready', parsed, messages: parsed.warnings.map((t) => ({ level: 'WARNING' as const, text: t })) }); return;
          }
          if (format === 'LAS') {
            if (k === 'core') { upd(job.id, { status: 'error', error: 'Core data in LAS form: import the LAS as a well (Role: Well logs); core-like curves can then be used as log curves, or export them to CSV and import as core.' }); return; }
            if (k === 'tops') {
              const txt = await file.text(); const lines = txt.split(/\r?\n/); const out: { name: string; md: number }[] = []; let on = false; let wellName = '';
              for (const l of lines) {
                const t = l.trim(); if (!t || t.startsWith('#')) continue;
                if (t.startsWith('~')) { on = /^~(TOP|TOPS|FORMATION|MARKER)/i.test(t); continue; }
                const wm = /^WELL\s*\.\S*\s+(.*?)\s*:/i.exec(t); if (wm) wellName = wm[1];
                if (!on) continue;
                const hm = /^([^.]+)\.(\S*)\s+([-\d.eE+]+)\s*:\s*(.*)$/.exec(t);
                if (hm) { out.push({ name: (hm[4] || hm[1]).trim(), md: parseFloat(hm[3]) }); continue; }
                const wmm = /^(.*\S)\s+([-\d.eE+]+)\s*$/.exec(t); if (wmm) out.push({ name: wmm[1].replace(/^"|"$/g, ''), md: parseFloat(wmm[2]) });
              }
              if (!out.length) { upd(job.id, { status: 'error', error: 'No ~TOPS / ~FORMATION section with "name depth" entries found in this LAS file.' }); return; }
              const w = S().wells.find((x) => x.name.toUpperCase().replace(/[^A-Z0-9]/g, '') === wellName.toUpperCase().replace(/[^A-Z0-9]/g, '')) ?? S().wells.find((x) => x.id === S().activeWellId);
              if (!w) { upd(job.id, { status: 'error', error: 'Load the well first — tops must be attached to a well.' }); return; }
              S().set({ tops: [...S().tops, ...out.map((o, i) => ({ id: uid('t_'), wellId: w.id, name: o.name, md: o.md, color: hfuColor((i % 8) + 2) }))] }); S().log(`Loaded ${out.length} tops from ${file.name} → ${w.name}`); S().bump();
              upd(job.id, { status: 'done', messages: [{ level: 'OK', text: `${out.length} tops loaded into ${w.name}.` }] }); return;
            }
            const parsed = await call<ParsedLog>('parse', 'parseLAS', [file], { onProgress: (p) => upd(job.id, { progress: p }) });
            upd(job.id, { status: 'ready', parsed, messages: parsed.warnings.map((t) => ({ level: 'WARNING' as const, text: t })) });
          } else if (format === 'DLIS') {
            const dlis = await call<DlisScan>('parse', 'scanDLIS', [file]);
            const nf = dlis.logicalFiles.reduce((s, l) => s + l.frames.length, 0);
            upd(job.id, { status: 'ready', dlis, messages: [{ level: 'INFO', text: `DLIS contains ${dlis.logicalFiles.length} logical file(s) and ${nf} frame(s). Select a frame and channels before importing.` }, ...dlis.warnings.map((t) => ({ level: 'WARNING' as const, text: t }))] });
          } else {
            const preview = await call<TablePreview>('parse', 'previewTable', [file]);
            upd(job.id, { status: 'ready', preview });
          }
        } catch (e: any) { upd(job.id, { status: 'error', error: e.message }); S().log(`Import failed: ${file.name}: ${e.message}`, 'error'); }
      })();
    }
  };

  return (
    <>
      <ModHead title="Import Manager" sub="Browser-side parsing in a Web Worker — raw files never leave this computer">
        <button className="btn" onClick={() => { kindRef.current = 'well'; input.current?.click(); }}>+ Add Well</button>
        <button className="btn" onClick={() => { kindRef.current = 'core'; input.current?.click(); }}>+ Add Core Data</button>
        <button className="btn" onClick={() => { kindRef.current = 'tops'; input.current?.click(); }}>+ Add Tops</button>
        <button className="btn" onClick={() => { kindRef.current = 'aux'; input.current?.click(); }}>+ Add Auxiliary Data</button>
        <button className="btn warn" title={DEMO_BANNER} onClick={() => { loadDemo(); S().notify('WARNING', `${DEMO_BANNER} loaded (2 wells, core, tops).`); }}>Load Demo Data</button>
      </ModHead>
      <div className="mod-b">
        <input ref={input} type="file" multiple hidden accept=".las,.dlis,.lis,.csv,.txt,.tsv,.asc,.dat,.xlsx,.xls,.xlsm,.json,.parquet" onChange={(e) => { if (e.target.files) addFiles(e.target.files, kindRef.current); kindRef.current = undefined; e.target.value = ''; }} />
        <div className={'drop' + (over ? ' over' : '')} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}>
          <b>Drop files here</b> — LAS · DLIS · CSV · XLSX / XLS · JSON &nbsp;<span>· LIS (incl. TIF) · Parquet</span><br />
          <span className="hint">File type is inferred from extension/name; change the role per file below before loading.</span>
        </div>
        {jobs.map((j) => <JobView key={j.id} job={j} upd={(p) => upd(j.id, p)} wells={wells.map((w) => ({ id: w.id, name: w.name }))} remove={() => setJobs((js) => js.filter((x) => x.id !== j.id))} />)}
        <LoadedTable />
      </div>
    </>
  );
}

function LoadedTable() {
  const wells = useStore((s) => s.wells); const cores = useStore((s) => s.cores);
  const rows = wells.flatMap((w) => w.sources.map((s) => ({ w, s })));
  if (!rows.length && !cores.length) return null;
  return (
    <Box title="Loaded data" style={{ marginTop: 8 }}>
      <div className="tbl-wrap" style={{ maxHeight: 280 }}>
        <table className="t"><thead><tr><th>File Name</th><th>Well Name</th><th>UWI/API</th><th>Depth Start</th><th>Depth Stop</th><th>Sampling</th><th>Curves</th><th>Samples</th><th>Units</th><th>Null</th><th>LAS Ver.</th><th>Format</th><th>File Size</th><th>Note</th></tr></thead>
          <tbody>{rows.map(({ w, s }, i) => (
            <tr key={i}><td>{s.name}</td><td>{w.name}</td><td>{w.uwi || '—'}</td><td className="num">{fmt(s.depthStart, 6)}</td><td className="num">{fmt(s.depthStop, 6)}</td><td className="num">{fmt(s.step, 4)}</td><td className="num">{s.curves.length}</td><td className="num">{s.nSamples}</td><td>{w.depthUnit}</td><td className="num">{s.nullValue ?? '—'}</td><td>{s.lasVersion ?? '—'}</td><td>{s.format}</td><td className="num">{fmtBytes(s.size)}</td><td className="dim">{s.note ?? ''}</td></tr>
          ))}
            {cores.map((c) => <tr key={c.id}><td>{c.source}</td><td>{wells.find((w) => w.id === c.wellId)?.name}</td><td>—</td><td colSpan={3} className="dim">core dataset "{c.name}"</td><td className="num">{c.columns.length}</td><td className="num">{c.n}</td><td>{c.depthUnit}</td><td colSpan={5} className="dim">φ unit: {c.phiUnit ?? 'UNCONFIRMED'} · k unit: {c.kUnit ?? 'UNCONFIRMED'}</td></tr>)}
          </tbody></table>
      </div>
    </Box>
  );
}

function JobView({ job, upd, wells, remove }: { job: Job; upd: (p: Partial<Job>) => void; wells: { id: string; name: string }[]; remove: () => void }) {
  const title = <><span className="tag">{job.format}</span> {job.file.name} <span className="dim">({fmtBytes(job.file.size)})</span>
    <Sel value={job.kind} onChange={(k) => upd({ kind: k })} options={[{ v: 'well', l: 'Role: Well logs' }, { v: 'core', l: 'Role: Core data' }, { v: 'tops', l: 'Role: Tops' }, { v: 'aux', l: 'Role: Auxiliary (depth-indexed)' }]} />
  </>;
  return (
    <Box title={title} style={{ marginTop: 8 }} right={<><span className={'tag ' + (job.status === 'done' ? 'ok' : job.status === 'error' ? 'crit' : '')}>{job.status}</span><button className="btn sm" onClick={remove}>✕</button></>}>
      {job.status === 'parsing' && <div className="progress"><div style={{ width: `${100 * (job.progress ?? 0.3)}%` }} /></div>}
      {job.error && <Msgs items={[{ level: 'CRITICAL', text: job.error }]} />}
      <Msgs items={job.messages} />
      {job.parsed && <LasJob job={job} upd={upd} wells={wells} />}
      {job.dlis && <DlisJob job={job} upd={upd} wells={wells} />}
      {job.preview && <TableJob job={job} upd={upd} wells={wells} />}
    </Box>
  );
}

function TargetPicker({ wells, value, onChange, suggested }: { wells: { id: string; name: string }[]; value: string; onChange: (v: string) => void; suggested?: string }) {
  return <select value={value} onChange={(e) => onChange(e.target.value)}>
    <option value="__new">New well{suggested ? ` "${suggested}"` : ''}</option>
    {wells.map((w) => <option key={w.id} value={w.id}>Merge into {w.name} (resample to well grid)</option>)}
  </select>;
}
/** Depth-unit sanity check against the target well (m). Feet are converted explicitly and reported — never silently. */
function depthUnitFactor(d: ArrayLike<number>, unit: string, w: { start: number; stop: number; depthUnit: string; name: string }): { factor: number; note: string } {
  const wu = (w.depthUnit || 'm').toLowerCase(); if (!/^m/.test(wu)) return { factor: 1, note: '' };
  if (/^(ft|f|feet|foot)$/i.test(unit.trim())) return { factor: 0.3048, note: `Depth column unit "${unit}" → converted ft → m (× 0.3048) to match ${w.name}.` };
  if (unit && /^m/i.test(unit.trim())) return { factor: 1, note: '' };
  const inside = (f: number) => { let n = 0, k = 0; for (let i = 0; i < d.length; i++) { const x = d[i]; if (!(x === x)) continue; n++; if (x * f >= w.start - 5 && x * f <= w.stop + 5) k++; } return n ? k / n : 0; };
  const m = inside(1), ft = inside(0.3048);
  if (ft > 0.8 && m < 0.5) return { factor: 0.3048, note: `Depth unit not stated: ${Math.round(ft * 100)} % of the depths fall inside ${w.name} (${w.start.toFixed(0)}–${w.stop.toFixed(0)} m) only if read as FEET → converted ft → m. Undo (Ctrl+Z) if this is wrong.` };
  if (m < 0.5) return { factor: 1, note: `Only ${Math.round(m * 100)} % of the depths fall inside ${w.name} (${w.start.toFixed(0)}–${w.stop.toFixed(0)} m) — check the depth column and unit.` };
  return { factor: 1, note: '' };
}
const norm0 = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
function lev(a: string, b: string) { const m = a.length, n = b.length; const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 1; j <= n; j++) d[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; }
/** Well-name matching tolerant to the usual spelling drift between vendor files (e.g. "Gorgonicthys-1" vs "GORGONICHTHYS-1"). */
const norm = (s: string) => { const n = norm0(s); const ws = S().wells.map((w) => norm0(w.name)); if (ws.includes(n)) return n; const c = ws.map((w) => ({ w, d: lev(w, n) })).filter((x) => x.d <= Math.max(1, Math.floor(n.length / 6))).sort((a, b) => a.d - b.d); return c.length && (c.length === 1 || c[0].d < c[1].d) ? c[0].w : n; };

function commitLog(parsed: ParsedLog, target: string, upd: (p: Partial<Job>) => void, msgs: Job['messages']) {
  try {
    const r = ingestLog(parsed, target === '__new' ? { mode: 'new' } : { mode: 'merge', wellId: target });
    const w = S().wells.find((x) => x.id === r.wellId)!;
    S().log(`Loaded ${parsed.fileName} → ${w.name}: ${r.added.length} curves`);
    S().set({ activeWellId: r.wellId }); S().bump();
    upd({ status: 'done', messages: [...msgs, { level: 'OK', text: `Loaded ${r.added.length} curves into "${w.name}".` }, ...r.warnings.filter((x) => !msgs.some((m) => m.text === x)).map((t) => ({ level: 'WARNING' as const, text: t })), ...(r.renamed.length ? [{ level: 'INFO' as const, text: `Renamed duplicate mnemonics: ${r.renamed.join(', ')}` }] : [])] });
  } catch (e: any) { upd({ messages: [...msgs, { level: 'CRITICAL', text: e.message }] }); }
}

function LasJob({ job, upd, wells }: { job: Job; upd: (p: Partial<Job>) => void; wells: { id: string; name: string }[] }) {
  const p = job.parsed!;
  const match = wells.find((w) => norm(w.name) === norm(p.wellName));
  const [target, setTarget] = useState(match?.id ?? '__new');
  const step = p.depth.length > 1 ? (p.depth[p.depth.length - 1] - p.depth[0]) / (p.depth.length - 1) : 0;
  return (
    <div className="col">
      <div className="kv" style={{ gridTemplateColumns: 'repeat(6, auto 1fr)' }}>
        <span>Well</span><span>{p.wellName}</span><span>UWI/API</span><span>{p.uwi || '—'}</span><span>LAS version</span><span>{p.lasVersion || '—'}{p.wrap ? ' (wrapped)' : ''}</span>
        <span>Depth start</span><span>{fmt(p.depth[0], 6)} {p.depthUnit}</span><span>Depth stop</span><span>{fmt(p.depth[p.depth.length - 1], 6)} {p.depthUnit}</span><span>Sampling</span><span>{fmt(step, 4)} {p.depthUnit}</span>
        <span>Curves</span><span>{p.curves.length}</span><span>Samples</span><span>{p.depth.length.toLocaleString()}</span><span>Null value</span><span>{p.nullValue}</span>
      </div>
      <div className="mono dim" style={{ fontSize: 10.5 }}>{p.curves.map((c) => `${c.mnemonic}${c.unit ? ` [${c.unit}]` : ''}`).join('  ·  ')}</div>
      {job.status !== 'done' && <div className="row"><span className="hint">Target:</span><TargetPicker wells={wells} value={target} onChange={setTarget} suggested={p.wellName} /><button className="btn pri" onClick={() => commitLog(p, target, upd, job.messages)}>Load</button>{match && <span className="hint">Matched existing well by name.</span>}</div>}
    </div>
  );
}

function DlisJob({ job, upd, wells }: { job: Job; upd: (p: Partial<Job>) => void; wells: { id: string; name: string }[] }) {
  const d = job.dlis!;
  const frames = d.logicalFiles.flatMap((lf) => lf.frames.map((f) => ({ lf, f })));
  const [sel, setSel] = useState(() => { const best = [...frames].sort((a, b) => b.f.nFrames - a.f.nFrames)[0]; return best ? `${best.lf.index}::${best.f.key}` : ''; });
  const cur = frames.find((x) => `${x.lf.index}::${x.f.key}` === sel);
  const [chk, setChk] = useState<Set<string>>(new Set());
  const [depthKey, setDepthKey] = useState<string>('');
  useEffect(() => { if (cur) { setChk(new Set(cur.f.channels.slice(1).filter((c) => c.dim === 1).map((c) => c.key))); const tdep = cur.f.channels.find((c) => /^(TDEP|DEPT|DEPTH|MD)$/i.test(c.name)); setDepthKey(tdep?.key ?? cur.f.channels[0]?.key ?? ''); } }, [sel]);
  const match = wells.find((w) => norm(w.name) === norm(cur?.lf.wellName ?? ''));
  const [target, setTarget] = useState(match?.id ?? '__new');
  const [busy, setBusy] = useState(false); const [expand, setExpand] = useState(false);
  const doImport = async () => {
    if (!cur) return; setBusy(true);
    try {
      const parsed = await call<ParsedLog>('parse', 'readDLISFrame', [job.file, cur.lf.index, cur.f.key, [...chk], depthKey, expand]);
      commitLog(parsed, target, upd, [...job.messages, ...parsed.warnings.map((t) => ({ level: 'WARNING' as const, text: t }))]);
    } catch (e: any) { upd({ messages: [...job.messages, { level: 'CRITICAL', text: e.message }] }); } finally { setBusy(false); }
  };
  return (
    <div className="grid2" style={{ gridTemplateColumns: '420px 1fr' }}>
      <div className="tbl-wrap" style={{ maxHeight: 260 }}>
        <table className="t"><thead><tr><th>Logical file / Frame</th><th>Index</th><th>Frames</th><th>Range</th><th>Ch.</th></tr></thead>
          <tbody>{d.logicalFiles.map((lf) => [
            <tr key={'lf' + lf.index}><td colSpan={5}><b>LF {lf.index}</b> {lf.fileId} · {lf.wellName} {lf.company && <span className="dim">({lf.company})</span>}</td></tr>,
            ...lf.frames.map((f) => { const k = `${lf.index}::${f.key}`; return (
              <tr key={k} className={sel === k ? 'sel' : ''} onClick={() => setSel(k)} style={{ cursor: 'pointer' }}>
                <td>&nbsp;&nbsp;{f.name} <span className="dim">{f.direction}</span></td><td>{f.channels[0]?.name} <span className="dim">{f.indexType}</span></td><td className="num">{f.nFrames}</td>
                <td className="num">{fmt(f.indexMin, 6)} – {fmt(f.indexMax, 6)} <span className="dim">{f.indexUnits}</span></td><td className="num">{f.channels.length}</td>
              </tr>); }),
          ])}</tbody></table>
      </div>
      {cur && <div className="col">
        <div className="row"><span className="hint">Depth channel</span><select value={depthKey} onChange={(e) => setDepthKey(e.target.value)}>{cur.f.channels.filter((c) => c.dim === 1).map((c) => <option key={c.key} value={c.key}>{c.name} ({c.units})</option>)}</select>
          <button className="btn sm" onClick={() => setChk(new Set(cur.f.channels.slice(1).filter((c) => c.dim === 1).map((c) => c.key)))}>all scalar</button><label className="cb"><input type="checkbox" checked={expand} onChange={(e) => setExpand(e.target.checked)} />expand array channels (≤ 64 elements)</label><button className="btn sm" onClick={() => setChk(new Set())}>none</button><span className="hint">{chk.size} selected</span></div>
        <div className="tbl-wrap" style={{ maxHeight: 190 }}>
          <table className="t"><thead><tr><th></th><th>Channel</th><th>Units</th><th>Repr.</th><th>Dim</th><th>Description</th></tr></thead>
            <tbody>{cur.f.channels.map((c, i) => (
              <tr key={c.key} className={i === 0 ? 'dim' : ''}><td><input type="checkbox" disabled={i === 0 || (c.dim > 1 && (!expand || c.dim > 64))} checked={chk.has(c.key)} onChange={(e) => { const s = new Set(chk); e.target.checked ? s.add(c.key) : s.delete(c.key); setChk(s); }} /></td>
                <td>{c.name}{i === 0 ? ' (index)' : ''}</td><td>{c.units}</td><td>{c.reprName}</td><td className="num">{c.dim}</td><td className="dim">{c.longName}</td></tr>))}
            </tbody></table>
        </div>
        {job.status !== 'done' && <div className="row"><span className="hint">Target:</span><TargetPicker wells={wells} value={target} onChange={setTarget} suggested={cur.lf.wellName} /><button className="btn pri" disabled={busy || !chk.size} onClick={doImport}>{busy ? 'Decoding…' : `Import ${chk.size} channels`}</button></div>}
        <span className="hint">Only the selected frame/channels are decoded; array channels (dim &gt; 1, e.g. T2 distributions) are imported element-by-element only when expansion is enabled.</span>
      </div>}
    </div>
  );
}

function guessRow(rows: string[][]) {
  // header row = first row with mostly non-numeric cells followed by numeric rows
  for (let r = 0; r < Math.min(rows.length - 1, 30); r++) {
    const cells = rows[r].filter((c) => c.trim() !== ''); if (cells.length < 2) continue;
    const txt = cells.filter((c) => isNaN(Number(c))).length;
    if (txt >= cells.length * 0.6) {
      const next = rows[r + 1] ?? []; const nextTxt = next.filter((c) => c.trim() !== '' && isNaN(Number(c))).length;
      const nextIsUnits = next.length > 0 && nextTxt >= next.filter((c) => c.trim() !== '').length * 0.6 && next.some((c) => /^(m|ft|md|%|v\/v|g\/cc|g\/cm3|kpa|mD|gapi|us\/ft|ohmm|ohm\.m)$/i.test(c.trim()));
      return { header: r, units: nextIsUnits ? r + 1 : -1, start: nextIsUnits ? r + 2 : r + 1 };
    }
  }
  return { header: 0, units: -1, start: 1 };
}
const findCol = (cols: string[], ...res: RegExp[]) => { for (const re of res) { const c = cols.find((x) => re.test(x)); if (c) return c; } return ''; };

function TableJob({ job, upd, wells }: { job: Job; upd: (p: Partial<Job>) => void; wells: { id: string; name: string }[] }) {
  const pv = job.preview!;
  const g = guessRow(pv.rows);
  const [opt, setOpt] = useState<TableOptions>({ sheet: pv.sheet, delimiter: pv.delimiter ?? '', decimal: '.', headerRow: g.header, unitRow: g.units, dataStart: g.start, nullValues: ['-999.25', '-999', '-9999', 'NA', 'N/A', 'NaN', 'null', ''] });
  const [preview, setPreview] = useState(pv);
  const header = (preview.rows[opt.headerRow] ?? []).map((h, i) => h.trim() || `COL${i + 1}`);
  const unitsRow = opt.unitRow >= 0 ? preview.rows[opt.unitRow] ?? [] : [];
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [units, setUnits] = useState<Record<string, string>>({});
  useEffect(() => {
    setRoles({
      depth: findCol(header, /^(DEPT|DEPTH|MD)$/i, /top depth/i, /depth/i, /^MD/i),
      phi: findCol(header, /^PHI_?CORE$/i, /^CORE_?PHI$/i, /^porosity \(%\)$/i, /^porosity$/i, /poro/i, /phi/i),
      k: findCol(header, /^PERMEABILITY_?CORE$/i, /^CORE_?K$/i, /^permeability \(md\)$/i, /^perm/i, /^k(air|h)?$/i),
      facies: findCol(header, /facies/i, /litholog/i), grain: findCol(header, /grain/i), sample: findCol(header, /sample/i),
      well: findCol(header, /^well(name| name)?$/i, /^well$/i), top: findCol(header, /^(top|tops|formation|surface|marker|name|zone|zones|horizon)$/i, /formation|zone|horizon|marker|surface|strat/i), tvd: findCol(header, /^tvd$/i), tvdss: findCol(header, /tvdss/i),
    });
  }, [preview, opt.headerRow]);
  const reprev = async (sheet?: string) => { const p = await call<TablePreview>('parse', 'previewTable', [job.file, sheet]); setPreview(p); setOpt((o) => ({ ...o, sheet: p.sheet })); };
  const match = wells.find((w) => job.file.name.toUpperCase().includes(w.name.toUpperCase().replace(/[^A-Z0-9-]/g, ''))) ?? wells[0];
  const [target, setTarget] = useState(job.kind === 'well' ? '__new' : match?.id ?? '');
  const [wellName, setWellName] = useState(job.file.name.replace(/\.[^.]+$/, ''));
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (job.kind !== 'well' && target === '__new' && wells[0]) setTarget(match?.id ?? wells[0].id); }, [job.kind]);
  const R = (k: string, label: string, opts: { none?: boolean } = {}) => (
    <Field label={label}><select value={roles[k] ?? ''} onChange={(e) => setRoles({ ...roles, [k]: e.target.value })}>{opts.none !== false && <option value="">—</option>}{header.map((h) => <option key={h} value={h}>{h}</option>)}</select></Field>
  );
  const doImport = async () => {
    setBusy(true);
    try {
      const unitMap: Record<string, string> = {}; header.forEach((h, i) => { unitMap[h] = units[h] ?? unitsRow[i] ?? ''; });
      const t = await call<ParsedTable>('parse', 'parseTable', [job.file, { ...opt, units: unitMap }]);
      const msgs: Job['messages'] = t.warnings.map((x) => ({ level: 'WARNING' as const, text: x }));
      const col = (n: string) => t.columns.find((c) => c.name === n);
      if (job.kind === 'tops') {
        const mdC = col(roles.depth), nmC = col(roles.top); if (!mdC?.num || !nmC) throw new Error('Select MD and Formation/Top columns.');
        { const w = S().wells.find((x) => x.id === target) ?? S().wells[0]; if (w) { const f = depthUnitFactor(mdC.num, mdC.unit, w); if (f.factor !== 1) mdC.num = Float64Array.from(mdC.num, (x) => x * f.factor); if (f.note) msgs.push({ level: f.factor !== 1 ? 'WARNING' : 'INFO', text: f.note }); } }
        const wC = roles.well ? col(roles.well) : undefined; let added = 0, unmatched = new Set<string>();
        const tops = [...S().tops];
        for (let i = 0; i < t.nRows; i++) {
          const md = mdC.num[i]; if (!(md === md)) continue;
          let wid = target; if (wC) { const wn = wC.text?.[i] ?? String(wC.num?.[i]); const w = S().wells.find((x) => norm(x.name) === norm(wn)); if (!w) { unmatched.add(wn); continue; } wid = w.id; }
          tops.push({ id: uid('t_'), wellId: wid, name: nmC.text?.[i] ?? String(nmC.num?.[i]), md, tvd: roles.tvd ? col(roles.tvd)?.num?.[i] : undefined, tvdss: roles.tvdss ? col(roles.tvdss)?.num?.[i] : undefined, color: hfuColor((tops.length % 8) + 2) });
          added++;
        }
        S().set({ tops }); S().log(`Loaded ${added} tops from ${job.file.name}`); S().bump();
        if (unmatched.size) msgs.push({ level: 'WARNING', text: `Tops for unknown wells skipped: ${[...unmatched].join(', ')}` });
        upd({ status: 'done', messages: [...msgs, { level: 'OK', text: `${added} tops loaded.` }] });
      } else if (job.kind === 'core') {
        const dC = col(roles.depth); if (!dC?.num) throw new Error('Select a numeric depth column.');
        if (!target || target === '__new') throw new Error('Core data must be attached to an existing well. Load the well logs first.');
        { const w = S().wells.find((x) => x.id === target); if (w) { const f = depthUnitFactor(dC.num, dC.unit, w); if (f.factor !== 1) { dC.num = Float64Array.from(dC.num, (x) => x * f.factor); dC.unit = 'm'; } if (f.note) msgs.push({ level: f.factor !== 1 ? 'WARNING' : 'INFO', text: f.note }); } }
        const num: Record<string, { data: Float64Array; unit: string }> = {}; const text: Record<string, string[]> = {};
        for (const c of t.columns) { if (c.name === roles.depth) continue; if (c.kind === 'num') num[c.name] = { data: c.num!, unit: c.unit }; else text[c.name] = c.text!; }
        const { messages } = createCore({ wellId: target, name: job.file.name.replace(/\.[^.]+$/, ''), source: job.file.name, depthUnit: dC.unit || 'm', depth: dC.num, num, text, map: { phi: roles.phi || undefined, k: roles.k || undefined, facies: roles.facies || undefined, grainDensity: roles.grain || undefined, sampleId: roles.sample || undefined } });
        S().bump();
        upd({ status: 'done', messages: [...msgs, ...messages.map((m) => ({ level: /NOT confirmed|Removed/.test(m) ? ('WARNING' as const) : ('INFO' as const), text: m })), { level: 'OK', text: `Core dataset loaded (${t.nRows} rows). Review QC and units in Core Data.` }] });
      } else {
        const dC = col(roles.depth); if (!dC?.num) throw new Error('Select a numeric depth column.');
        const curves = t.columns.filter((c) => c.kind === 'num' && c.name !== roles.depth).map((c) => ({ mnemonic: c.name.replace(/\s+/g, '_'), unit: c.unit, description: c.name, data: Float32Array.from(c.num!) }));
        const parsed: ParsedLog = { format: job.format, fileName: job.file.name, fileSize: job.file.size, wellName: target === '__new' ? wellName : '', uwi: '', field: '', depthUnit: dC.unit || 'm', depthMnemonic: dC.name, depth: Float64Array.from(dC.num), curves, header: [], warnings: [], reversed: false };
        const skipped = t.columns.filter((c) => c.kind === 'text').map((c) => c.name); if (skipped.length) msgs.push({ level: 'INFO', text: `Text columns not imported as curves: ${skipped.join(', ')}` });
        commitLog(parsed, target, upd, msgs);
      }
    } catch (e: any) { upd({ messages: [...job.messages, { level: 'CRITICAL', text: e.message }] }); }
    finally { setBusy(false); }
  };
  return (
    <div className="grid2" style={{ gridTemplateColumns: '330px 1fr' }}>
      <div className="col">
        {preview.sheets.length > 1 && <Field label="Sheet"><select value={opt.sheet} onChange={(e) => reprev(e.target.value)}>{preview.sheets.map((s) => <option key={s}>{s}</option>)}</select></Field>}
        {job.format === 'CSV' && <Field label="Delimiter"><Sel value={opt.delimiter || 'auto'} onChange={(v) => setOpt({ ...opt, delimiter: v === 'auto' ? '' : v })} options={[{ v: 'auto', l: `auto (${preview.delimiter === '\t' ? 'tab' : preview.delimiter})` }, { v: ',', l: 'comma' }, { v: ';', l: 'semicolon' }, { v: '\t', l: 'tab' }, { v: '|', l: 'pipe' }, { v: 'ws', l: 'whitespace' }]} /></Field>}
        <Field label="Decimal separator"><Sel value={opt.decimal!} onChange={(v) => setOpt({ ...opt, decimal: v })} options={[{ v: '.', l: '. (point)' }, { v: ',', l: ', (comma)' }]} /></Field>
        <Field label="Header row"><input type="number" value={opt.headerRow + 1} min={1} onChange={(e) => setOpt({ ...opt, headerRow: +e.target.value - 1, dataStart: Math.max(opt.dataStart, +e.target.value) })} /></Field>
        <Field label="Units row"><input type="number" value={opt.unitRow + 1} min={0} onChange={(e) => setOpt({ ...opt, unitRow: +e.target.value - 1 })} /></Field>
        <Field label="First data row"><input type="number" value={opt.dataStart + 1} min={1} onChange={(e) => setOpt({ ...opt, dataStart: +e.target.value - 1 })} /></Field>
        <Field label="Null values"><input value={opt.nullValues.join(', ')} onChange={(e) => setOpt({ ...opt, nullValues: e.target.value.split(',').map((s) => s.trim()) })} /></Field>
        {R('depth', job.kind === 'tops' ? 'MD column' : 'Depth column', { none: false })}
        {job.kind === 'core' && <>{R('phi', 'Porosity')}{R('k', 'Permeability')}{R('facies', 'Facies')}{R('grain', 'Grain density')}{R('sample', 'Sample ID')}</>}
        {job.kind === 'tops' && <>{R('top', 'Top / Formation')}{R('well', 'Well (optional)')}{R('tvd', 'TVD')}{R('tvdss', 'TVDSS')}</>}
        <Field label={job.kind === 'core' || job.kind === 'tops' ? 'Attach to well' : 'Target'}>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {(job.kind === 'well' || job.kind === 'aux') && <option value="__new">New well</option>}
            {wells.map((w) => <option key={w.id} value={w.id}>{job.kind === 'well' || job.kind === 'aux' ? 'Merge into ' : ''}{w.name}</option>)}
          </select>
        </Field>
        {target === '__new' && <Field label="New well name"><input value={wellName} onChange={(e) => setWellName(e.target.value)} /></Field>}
        {job.status !== 'done' && <button className="btn pri" disabled={busy} onClick={doImport}>{busy ? 'Parsing…' : `Import as ${job.kind === 'well' ? 'well logs' : job.kind}`}</button>}
      </div>
      <div className="tbl-wrap" style={{ maxHeight: 330 }}>
        <table className="t"><thead><tr><th>#</th>{header.map((h, i) => <th key={i} style={{ color: Object.values(roles).includes(h) ? '#4ea1ff' : undefined }}>{h}<br />
          <input style={{ width: 70, height: 17, fontSize: 10 }} placeholder="unit" value={units[h] ?? unitsRow[i] ?? ''} onChange={(e) => setUnits({ ...units, [h]: e.target.value })} /></th>)}</tr></thead>
          <tbody>{preview.rows.slice(opt.dataStart, opt.dataStart + 40).map((r, i) => <tr key={i}><td className="dim">{opt.dataStart + i + 1}</td>{header.map((_, c) => <td key={c}>{r[c]}</td>)}</tr>)}</tbody></table>
      </div>
    </div>
  );
}
