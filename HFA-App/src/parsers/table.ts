// CSV / TXT / XLSX / XLS / JSON table parsing (worker side).
import * as XLSX from 'xlsx';
import type { ParsedTable, TableOptions, TablePreview } from './types';
import { parquetRows } from './parquet';

export function detectDelimiter(sample: string): string {
  const lines = sample.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  const cands = [',', ';', '\t', '|'];
  let best = ',', bestScore = -1;
  for (const d of cands) {
    const counts = lines.map((l) => splitLine(l, d).length);
    const mode = counts.sort((a, b) => counts.filter((v) => v === a).length - counts.filter((v) => v === b).length).pop() || 1;
    const consistent = counts.filter((c) => c === mode).length;
    const score = mode > 1 ? consistent * 10 + mode : 0;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  if (bestScore <= 0) return 'ws'; // whitespace separated (ASCII log dumps)
  return best;
}

export function splitLine(line: string, d: string): string[] {
  if (d === 'ws') return line.trim().split(/\s+/);
  if (line.indexOf('"') < 0) return line.split(d);
  const out: string[] = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === d) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
}

/** Some writers store a wrong !ref (e.g. A1:A101) — recompute from actual cells. */
function fixRef(ws: XLSX.WorkSheet) {
  let r0 = Infinity, c0 = Infinity, r1 = -1, c1 = -1;
  for (const k of Object.keys(ws)) {
    if (k[0] === '!') continue;
    const a = XLSX.utils.decode_cell(k);
    if (a.r < r0) r0 = a.r; if (a.c < c0) c0 = a.c; if (a.r > r1) r1 = a.r; if (a.c > c1) c1 = a.c;
  }
  if (r1 >= 0) ws['!ref'] = XLSX.utils.encode_range({ s: { r: r0, c: c0 }, e: { r: r1, c: c1 } });
  return ws;
}

const isXls = (name: string) => /\.(xlsx|xlsm|xls|ods)$/i.test(name);

export async function previewTable(file: File, sheet?: string): Promise<TablePreview> {
  if (isXls(file.name)) {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sh = sheet && wb.SheetNames.includes(sheet) ? sheet : wb.SheetNames[0];
    const rows = (XLSX.utils.sheet_to_json<any[]>(fixRef(wb.Sheets[sh]), { header: 1, raw: false, defval: '' }) as any[][]).slice(0, 80);
    return { sheets: wb.SheetNames, sheet: sh, rows: rows.filter((r) => r.some((c) => c !== '' && c !== null)).map((r) => r.map((c) => String(c ?? ''))) };
  }
  if (/\.parquet$/i.test(file.name)) {
    const rows = await parquetRows(file, 80);
    return { sheets: ['parquet'], sheet: 'parquet', rows: rows.map((r) => r.map((c) => String(c ?? ''))) };
  }
  if (/\.json$/i.test(file.name)) {
    const rows = jsonToRows(JSON.parse(await file.text())).slice(0, 80);
    return { sheets: ['json'], sheet: 'json', rows: rows.map((r) => r.map((c) => String(c ?? ''))) };
  }
  const txt = await file.slice(0, 128 * 1024).text();
  const d = detectDelimiter(txt);
  const lines = txt.split(/\r?\n/).slice(0, 80);
  if (file.size > 128 * 1024) lines.pop();
  return { sheets: ['(text)'], sheet: '(text)', rows: lines.filter((l) => l.trim().length).map((l) => splitLine(l, d)), delimiter: d, totalRowsEstimate: Math.round((file.size / Math.max(1, txt.length)) * lines.length) };
}

function jsonToRows(j: any): any[][] {
  if (Array.isArray(j) && j.length && !Array.isArray(j[0]) && typeof j[0] === 'object') {
    const keys = Object.keys(j[0]); return [keys, ...j.map((o: any) => keys.map((k) => o[k]))];
  }
  if (Array.isArray(j)) return j;
  if (j && typeof j === 'object') { // column object {A:[..],B:[..]}
    const keys = Object.keys(j); const n = Math.max(...keys.map((k) => (Array.isArray(j[k]) ? j[k].length : 0)));
    const rows: any[][] = [keys]; for (let i = 0; i < n; i++) rows.push(keys.map((k) => j[k]?.[i])); return rows;
  }
  throw new Error('Unrecognised JSON table layout (expect array of records, array of arrays, or column object).');
}

function makeNum(opts: TableOptions) {
  const nulls = new Set(opts.nullValues.map((s) => s.trim().toUpperCase()));
  return (raw: any): number => {
    if (raw === null || raw === undefined) return NaN;
    if (typeof raw === 'number') return nulls.has(String(raw)) ? NaN : raw;
    let s = String(raw).trim();
    if (!s || nulls.has(s.toUpperCase())) return NaN;
    if (opts.decimal === ',') s = s.replace(/\./g, '').replace(',', '.');
    const v = Number(s);
    if (v !== v) return NaN;
    if (nulls.has(String(v))) return NaN;
    return v;
  };
}

function rowsToTable(rows: any[][], opts: TableOptions): ParsedTable {
  const warnings: string[] = [];
  const hdr = (rows[opts.headerRow] || []).map((h: any, i: number) => String(h ?? '').trim() || `COL${i + 1}`);
  const units = opts.unitRow >= 0 ? (rows[opts.unitRow] || []).map((u: any) => String(u ?? '').trim()) : [];
  const data = rows.slice(opts.dataStart);
  const toNum = makeNum(opts);
  // dedupe header names
  const seen: Record<string, number> = {};
  const names = hdr.map((h) => { const k = h; seen[k] = (seen[k] || 0) + 1; return seen[k] > 1 ? `${h}_${seen[k]}` : h; });
  const cols = names.map((name, c) => {
    let nNum = 0, nTxt = 0;
    for (let r = 0; r < Math.min(data.length, 2000); r++) {
      const raw = data[r]?.[c]; if (raw === '' || raw === undefined || raw === null) continue;
      if (toNum(raw) === toNum(raw)) nNum++; else if (!opts.nullValues.map((s) => s.toUpperCase()).includes(String(raw).trim().toUpperCase())) nTxt++;
    }
    const kind: 'num' | 'text' = nNum > 0 && nNum >= nTxt * 4 ? 'num' : 'text';
    const unit = opts.units?.[name] ?? units[c] ?? '';
    if (kind === 'num') {
      const a = new Float64Array(data.length);
      let bad = 0;
      for (let r = 0; r < data.length; r++) { const raw = data[r]?.[c]; const v = toNum(raw); a[r] = v; if (v !== v && raw !== '' && raw !== undefined && raw !== null) bad++; }
      if (bad) warnings.push(`Column "${name}": ${bad} non-numeric cells mapped to missing.`);
      return { name, unit, kind, num: a };
    }
    return { name, unit, kind, text: data.map((r) => String(r?.[c] ?? '')) };
  });
  return { columns: cols, nRows: data.length, warnings };
}

export async function parseTable(file: File, opts: TableOptions): Promise<ParsedTable> {
  if (isXls(file.name)) {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sh = opts.sheet && wb.SheetNames.includes(opts.sheet) ? opts.sheet : wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json<any[]>(fixRef(wb.Sheets[sh]), { header: 1, raw: true, defval: '' }) as any[][];
    return rowsToTable(rows.filter((r) => r.some((c) => c !== '' && c !== null)), opts);
  }
  if (/\.parquet$/i.test(file.name)) return rowsToTable(await parquetRows(file), opts);
  if (/\.json$/i.test(file.name)) return rowsToTable(jsonToRows(JSON.parse(await file.text())), opts);
  // Streaming text read (chunked); tokens are converted once into Float64 columns
  const d = opts.delimiter || detectDelimiter(await file.slice(0, 65536).text());
  const reader = (file as any).stream().getReader();
  const dec = new TextDecoder();
  let rem = ''; let li = 0;
  const rows: string[][] = []; // only header region + data as tokens (text)
  // For memory: we store tokens per row for text; numeric conversion happens once.
  // For very large ASCII dumps this is acceptable up to a few million cells.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const txt = rem + dec.decode(value, { stream: true });
    const parts = txt.split(/\r?\n/);
    rem = parts.pop() ?? '';
    for (const l of parts) { if (l.trim() === '') { li++; continue; } rows.push(splitLine(l, d)); li++; }
  }
  if (rem.trim()) rows.push(splitLine(rem, d));
  return rowsToTable(rows, opts);
}
