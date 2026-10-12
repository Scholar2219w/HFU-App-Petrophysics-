// Streaming LAS 1.2 / 2.0 / 3.0 parser (runs inside the parser Web Worker).
// Reads the File as a stream, never materialises the whole text, and writes
// numbers straight into a growable Float64 buffer → Float32 columns.
import type { HeaderItem } from '../types';
import type { ParsedLog } from './types';

class Growable {
  buf = new Float64Array(1 << 16); n = 0;
  push(v: number) {
    if (this.n === this.buf.length) { const b = new Float64Array(this.buf.length * 2); b.set(this.buf); this.buf = b; }
    this.buf[this.n++] = v;
  }
}

export function parseHeaderLine(line: string, section: string): HeaderItem | null {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const dot = t.indexOf('.');
  if (dot < 0) {
    const c = t.lastIndexOf(':');
    return { section, mnem: (c >= 0 ? t.slice(0, c) : t).trim(), unit: '', value: '', desc: c >= 0 ? t.slice(c + 1).trim() : '' };
  }
  const mnem = t.slice(0, dot).trim();
  const rest = t.slice(dot + 1);
  const sp = rest.search(/\s/);
  const unit = sp < 0 ? rest.split(':')[0] : rest.slice(0, sp);
  const afterUnit = sp < 0 ? rest.slice(unit.length) : rest.slice(sp);
  const c = afterUnit.lastIndexOf(':');
  let value = (c >= 0 ? afterUnit.slice(0, c) : afterUnit).trim();
  let desc = c >= 0 ? afterUnit.slice(c + 1).trim() : '';
  // LAS 1.2 puts the value in the description for some well items
  return { section, mnem, unit: unit.includes(':') ? '' : unit, value, desc };
}

export async function parseLAS(file: File, onProgress?: (f: number) => void): Promise<ParsedLog> {
  const header: HeaderItem[] = [];
  const curveDefs: HeaderItem[] = [];
  const warnings: string[] = [];
  const otherSections: string[] = [];
  let section = '';
  let mode: 'hdr' | 'curve' | 'data' | 'skip' = 'hdr';
  let dataSectionsSeen = 0;
  let delimiter: RegExp = /[\s]+/;
  const nums = new Growable();
  let badTokens = 0;

  const handleLine = (line: string) => {
    if (line.charCodeAt(0) === 126 /* ~ */) {
      section = line.trim();
      const s = section.slice(1).toUpperCase();
      if (/^A/.test(s) || /_DATA/.test(s)) {
        if (/^A/.test(s) || /^LOG_DATA/.test(s)) {
          dataSectionsSeen++;
          mode = dataSectionsSeen === 1 ? 'data' : 'skip';
          if (dataSectionsSeen > 1) otherSections.push(section);
        } else { mode = 'skip'; otherSections.push(section); }
      } else if (/^C/.test(s) || /^LOG_DEFINITION/.test(s) || /^CURVE/.test(s)) mode = 'curve';
      else if (/_DEFINITION/.test(s)) { mode = 'skip'; otherSections.push(section); }
      else mode = 'hdr';
      return;
    }
    if (mode === 'data') {
      const t = line.trim(); if (!t || t[0] === '#') return;
      const toks = t.split(delimiter);
      for (let i = 0; i < toks.length; i++) {
        const tk = toks[i]; if (tk === '') continue;
        const v = +tk;
        if (v !== v) badTokens++;
        nums.push(v);
      }
      return;
    }
    if (mode === 'skip') return;
    const it = parseHeaderLine(line, section);
    if (!it) return;
    if (mode === 'curve') curveDefs.push(it); else {
      header.push(it);
      if (it.mnem.toUpperCase() === 'DLM') {
        const d = it.value.toUpperCase();
        if (d === 'COMMA') delimiter = /\s*,\s*/; else if (d === 'TAB') delimiter = /\t/;
      }
    }
  };

  // ── stream the file ──
  const reader = (file as any).stream().getReader();
  const dec = new TextDecoder('latin1');
  let rem = ''; let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    const txt = rem + dec.decode(value, { stream: true });
    let start = 0;
    for (;;) {
      const nl = txt.indexOf('\n', start);
      if (nl < 0) break;
      let line = txt.slice(start, nl);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      handleLine(line);
      start = nl + 1;
    }
    rem = txt.slice(start);
    onProgress?.(read / file.size);
  }
  if (rem.trim()) handleLine(rem.replace(/\r$/, ''));

  const hv = (m: string) => header.find((h) => h.mnem.toUpperCase() === m);
  const val = (m: string) => { const h = hv(m); if (!h) return ''; return h.value || h.desc; };
  const vers = val('VERS');
  const wrap = /^Y/i.test(val('WRAP'));
  let nullValue = parseFloat(hv('NULL')?.value ?? '');
  if (!isFinite(nullValue)) { nullValue = -999.25; warnings.push('NULL value not declared — assuming -999.25.'); }
  const nc = curveDefs.length;
  if (nc < 1) throw new Error(`LAS file "${file.name}" has no ~Curve section — cannot determine column layout.`);
  const total = nums.n;
  const nRows = Math.floor(total / nc);
  if (total % nc !== 0) warnings.push(`Data section contains ${total} values which is not a multiple of ${nc} curves; last partial row ignored.`);
  if (badTokens) warnings.push(`${badTokens} non-numeric data tokens were treated as missing (NaN).`);

  // depth column 0
  const depthRaw = new Float64Array(nRows);
  for (let r = 0; r < nRows; r++) depthRaw[r] = nums.buf[r * nc];
  const reversed = nRows > 1 && depthRaw[nRows - 1] < depthRaw[0];
  const idx = (r: number) => (reversed ? nRows - 1 - r : r);
  const depth = new Float64Array(nRows);
  for (let r = 0; r < nRows; r++) depth[r] = depthRaw[idx(r)];
  // check monotonic
  let nonMono = 0; for (let r = 1; r < nRows; r++) if (!(depth[r] > depth[r - 1])) nonMono++;
  if (nonMono) warnings.push(`Depth index is not strictly increasing at ${nonMono} samples (duplicates or reversals).`);

  const isNull = (v: number) => v === nullValue || v !== v || Math.abs(v - nullValue) < 1e-6 || Math.abs(v) >= 1e30;
  const curves = [] as ParsedLog['curves'];
  for (let c = 1; c < nc; c++) {
    const a = new Float32Array(nRows);
    for (let r = 0; r < nRows; r++) { const v = nums.buf[idx(r) * nc + c]; a[r] = isNull(v) ? NaN : v; }
    const d = curveDefs[c];
    curves.push({ mnemonic: d.mnem, unit: d.unit, description: d.desc || d.value, data: a });
  }
  const strt = hv('STRT');
  if (reversed) warnings.push('Depth index was decreasing (negative STEP); data re-ordered to increasing depth.');
  return {
    format: 'LAS', fileName: file.name, fileSize: file.size,
    wellName: val('WELL') || file.name.replace(/\.[^.]+$/, ''), uwi: val('UWI') || val('API'), field: val('FLD'),
    lasVersion: vers, nullValue, depthUnit: (strt?.unit || curveDefs[0].unit || 'm').toLowerCase(),
    depthMnemonic: curveDefs[0].mnem, depth, curves, header, warnings, reversed, wrap, otherSections,
  };
}
