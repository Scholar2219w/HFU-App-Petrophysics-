// LIS-79 (Log Information Standard) reader — worker side.
// Supports raw LIS and TIF-wrapped LIS, physical-record continuation, well-site
// (CONS) data, Data Format Specification records (entry blocks + datum spec
// blocks, sub-type 0/1) and normal data records in both depth-recording modes.
// Representation codes 49, 50, 56, 65, 66, 68, 70, 73, 77, 79.
import type { HeaderItem } from '../types';
import type { ParsedLog } from './types';
import { looksLikeTif, unwrapTif } from './tif';

const RSIZE: Record<number, number> = { 49: 2, 50: 4, 56: 1, 66: 1, 68: 4, 70: 4, 73: 4, 77: 1, 79: 2 };

function val(dv: DataView, p: number, code: number): number {
  switch (code) {
    case 68: { let u = dv.getUint32(p); let neg = false; if (u & 0x80000000) { u = (~u + 1) >>> 0; neg = true; } const e = (u >>> 23) & 0xff; const f = (u & 0x7fffff) / 8388608; if (!e && !f) return 0; const v = f * Math.pow(2, e - 128); return neg ? -v : v; }
    case 49: { const x = dv.getInt16(p); return ((x >> 4) / 2048) * Math.pow(2, x & 0xf); }
    case 50: { const e = dv.getInt16(p), f = dv.getInt16(p + 2); return (f / 32768) * Math.pow(2, e); }
    case 56: return dv.getInt8(p);
    case 66: case 77: return dv.getUint8(p);
    case 70: return dv.getInt32(p) / 65536;
    case 73: return dv.getInt32(p);
    case 79: return dv.getInt16(p);
    default: return NaN;
  }
}
const ascii = (u8: Uint8Array, p: number, n: number) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8[p + i]); return s; };

interface LR { type: number; body: Uint8Array }
function* logicalRecords(buf: ArrayBuffer): Generator<LR> {
  const data = looksLikeTif(buf) ? unwrapTif(buf).data : buf;
  const dv = new DataView(data); const u8 = new Uint8Array(data);
  let p = 0; let parts: Uint8Array[] = []; let type = -1;
  while (p + 4 <= data.byteLength) {
    const len = dv.getUint16(p), attr = dv.getUint16(p + 2);
    if (len < 4 || p + len > data.byteLength) break;
    const trailer = (attr & 0x0200 ? 2 : 0) + (attr & 0x0400 ? 2 : 0) + (attr & 0x3000 ? 2 : 0);
    let body = u8.subarray(p + 4, p + len - trailer);
    const pred = !!(attr & 0x0002), succ = !!(attr & 0x0001);
    if (!pred) { if (body.length < 2) { p += len; continue; } type = body[0]; body = body.subarray(2); parts = []; }
    parts.push(body);
    if (!succ) {
      const n = parts.reduce((s, x) => s + x.length, 0); const b = new Uint8Array(n); let o = 0; for (const x of parts) { b.set(x, o); o += x.length; }
      yield { type, body: b }; parts = [];
    }
    p += len;
  }
}

interface Spec { mnem: string; service: string; units: string; size: number; repr: number; n: number }

function depthFactor(u: string): [number, string] {
  const s = u.trim().toUpperCase();
  if (s === '.1IN' || s === '0.1IN') return [0.00254, 'm'];
  if (s === '.5MS') return [1, 'ms'];
  if (s === 'IN') return [0.0254, 'm'];
  if (s === 'CM') return [0.01, 'm'];
  if (s === 'MM') return [0.001, 'm'];
  if (s === 'FT' || s === 'F') return [1, 'ft'];
  return [1, s.toLowerCase() || 'm'];
}

export async function parseLIS(file: File): Promise<ParsedLog> {
  const buf = await file.arrayBuffer();
  const warnings: string[] = []; const header: HeaderItem[] = [];
  let wellName = '', field = '', company = '';
  let specs: Spec[] = []; let entries: Record<number, any> = {}; let got = false;
  const depthVals: number[] = []; let cols: number[][] = []; let nRec = 0;
  if (looksLikeTif(buf)) warnings.push('TIF-wrapped LIS detected and unwrapped.');
  for (const lr of logicalRecords(buf)) {
    const dv = new DataView(lr.body.buffer, lr.body.byteOffset, lr.body.byteLength); const u8 = lr.body;
    if (lr.type === 34) { // well-site data: component blocks
      let p = 0; let lastMnem = '';
      while (p + 12 <= u8.length) {
        const repr = u8[p + 1], size = u8[p + 2]; const mn = ascii(u8, p + 4, 4).trim(); const unit = ascii(u8, p + 8, 4).trim(); p += 12;
        const v = repr === 65 ? ascii(u8, p, size).trim() : RSIZE[repr] ? val(dv, p, repr) : ''; p += size;
        if (mn === 'MNEM') lastMnem = String(v);
        else if (mn === 'VALU') { header.push({ section: 'CONS', mnem: lastMnem, unit, value: String(v), desc: '' }); if (lastMnem === 'WN') wellName = String(v); if (lastMnem === 'FN') field = String(v); if (lastMnem === 'CN') company = String(v); }
      }
    } else if (lr.type === 64) { // DFSR
      if (got) { warnings.push('Additional Data Format Specification record found; only the first logical file is imported.'); break; }
      let p = 0; entries = {};
      while (p + 3 <= u8.length) {
        const t = u8[p], size = u8[p + 1], repr = u8[p + 2]; p += 3;
        if (t === 0) { p += size; break; }
        entries[t] = repr === 65 ? ascii(u8, p, size).trim() : size && RSIZE[repr] ? val(dv, p, repr) : size ? u8[p] : undefined; p += size;
      }
      specs = [];
      while (p + 40 <= u8.length) {
        const s: Spec = { mnem: ascii(u8, p, 4).trim(), service: ascii(u8, p + 4, 6).trim(), units: ascii(u8, p + 18, 4).trim(), size: dv.getUint16(p + 28), repr: u8[p + 34], n: 0 };
        s.n = RSIZE[s.repr] ? s.size / RSIZE[s.repr] : 0; specs.push(s); p += 40;
      }
      got = true; cols = specs.map(() => []);
    } else if ((lr.type === 0 || lr.type === 1) && got) {
      nRec++;
      const mode = entries[13] ?? 0; const dRepr = entries[15] ?? 68; const frameSize = specs.reduce((s, c) => s + c.size, 0);
      let p = 0; let d0 = NaN;
      if (mode === 1) { d0 = val(dv, 0, dRepr); p = RSIZE[dRepr] ?? 4; }
      const spacing = entries[8] ?? NaN; const dir = entries[4] === 1 ? -1 : 1;
      let k = 0;
      while (p + frameSize <= u8.length) {
        let q = p;
        specs.forEach((s, ci) => { cols[ci].push(s.n >= 1 && RSIZE[s.repr] ? val(dv, q, s.repr) : NaN); q += s.size; });
        depthVals.push(mode === 1 ? d0 + dir * k * spacing : NaN); k++; p += frameSize;
      }
    }
  }
  if (!got) throw new Error('LIS file contains no Data Format Specification record — cannot decode data.');
  if (!depthVals.length) throw new Error('LIS file contains no data frames.');
  const mode = entries[13] ?? 0;
  const absent = entries[12] ?? -999.25;
  let depthRaw: number[]; let depthMnem = 'DEPT'; let dUnitRaw = String(entries[14] ?? entries[9] ?? '');
  let first = 0;
  if (mode === 1) depthRaw = depthVals;
  else { depthRaw = cols[0]; depthMnem = specs[0].mnem; dUnitRaw = specs[0].units || dUnitRaw; first = 1; }
  const [fac, dUnit] = depthFactor(dUnitRaw);
  const n = depthRaw.length; const order = Array.from({ length: n }, (_, i) => i);
  const reversed = n > 1 && depthRaw[n - 1] < depthRaw[0]; if (reversed) order.reverse();
  const depth = Float64Array.from(order, (i) => depthRaw[i] * fac);
  const curves: ParsedLog['curves'] = []; const arrays: string[] = [];
  specs.forEach((s, ci) => {
    if (ci < first) return;
    if (s.n !== 1) { arrays.push(`${s.mnem}[${s.n}]`); return; }
    curves.push({ mnemonic: s.mnem, unit: s.units, description: s.service, data: Float32Array.from(order, (i) => { const v = cols[ci][i]; return v === absent || Math.abs(v - absent) < 1e-3 || !isFinite(v) ? NaN : v; }) });
  });
  if (arrays.length) warnings.push(`Array / multi-sample channels not imported: ${arrays.join(', ')}`);
  if (fac !== 1) warnings.push(`Depth converted from "${dUnitRaw}" to ${dUnit} (×${fac}).`);
  if (reversed) warnings.push('Data recorded up-hole; re-ordered to increasing depth.');
  warnings.push(`LIS: ${nRec} data records, ${n} frames, depth mode ${mode}, absent value ${absent}. LIS support is new — cross-check against a LAS export for critical work.`);
  header.push({ section: 'DFSR', mnem: 'FRAME', unit: '', value: `${specs.length} channels`, desc: `spacing ${entries[8] ?? '?'} ${entries[9] ?? ''}` });
  if (company) header.push({ section: 'CONS', mnem: 'COMP', unit: '', value: company, desc: 'Company' });
  return { format: 'LIS', fileName: file.name, fileSize: file.size, wellName: wellName || file.name.replace(/\.[^.]+$/, ''), uwi: '', field, depthUnit: dUnit, depthMnemonic: depthMnem, depth, curves, header, warnings, reversed };
}
