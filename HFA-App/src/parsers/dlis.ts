// RP66 V1 (DLIS) reader — browser-side, runs in the parser worker.
// Two-phase: scanDLIS() lists Logical Files / Frames / Channels without
// decoding sample data; readDLISFrame() decodes ONLY the selected frame and
// channels, so the whole DLIS is never expanded into memory.
import type { HeaderItem } from '../types';
import type { ParsedLog } from './types';
import { looksLikeTif, unwrapTif } from './tif';

const REPR_NAMES: Record<number, string> = {
  1: 'FSHORT', 2: 'FSINGL', 3: 'FSING1', 4: 'FSING2', 5: 'ISINGL', 6: 'VSINGL', 7: 'FDOUBL', 8: 'FDOUB1', 9: 'FDOUB2',
  10: 'CSINGL', 11: 'CDOUBL', 12: 'SSHORT', 13: 'SNORM', 14: 'SLONG', 15: 'USHORT', 16: 'UNORM', 17: 'ULONG', 18: 'UVARI',
  19: 'IDENT', 20: 'ASCII', 21: 'DTIME', 22: 'ORIGIN', 23: 'OBNAME', 24: 'OBJREF', 25: 'ATTREF', 26: 'STATUS', 27: 'UNITS',
};
const FIXED_SIZE: Record<number, number> = { 1: 2, 2: 4, 3: 8, 4: 12, 5: 4, 6: 4, 7: 8, 8: 16, 9: 24, 10: 8, 11: 16, 12: 1, 13: 2, 14: 4, 15: 1, 16: 2, 17: 4, 21: 8, 26: 1 };

interface ObName { origin: number; copy: number; id: string }
const obKey = (o: ObName) => `${o.origin}|${o.copy}|${o.id}`;

class Cur {
  constructor(public v: DataView, public p: number, public end: number) {}
  u8() { return this.v.getUint8(this.p++); }
  u16() { const x = this.v.getUint16(this.p); this.p += 2; return x; }
  u32() { const x = this.v.getUint32(this.p); this.p += 4; return x; }
  uvari() {
    const b = this.v.getUint8(this.p);
    if ((b & 0x80) === 0) { this.p += 1; return b; }
    if ((b & 0xc0) === 0x80) { const x = this.v.getUint16(this.p) & 0x3fff; this.p += 2; return x; }
    const x = this.v.getUint32(this.p) & 0x3fffffff; this.p += 4; return x;
  }
  str(n: number) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.v.getUint8(this.p + i)); this.p += n; return s; }
  ident() { return this.str(this.u8()); }
  ascii() { return this.str(this.uvari()); }
  obname(): ObName { const origin = this.uvari(); const copy = this.u8(); const id = this.ident(); return { origin, copy, id }; }
  value(code: number): any {
    const v = this.v; const p = this.p;
    switch (code) {
      case 1: { const x = v.getInt16(p); this.p += 2; return ((x >> 4) / 2048) * Math.pow(2, x & 0xf); }
      case 2: this.p += 4; return v.getFloat32(p);
      case 3: this.p += 8; return v.getFloat32(p);
      case 4: this.p += 12; return v.getFloat32(p);
      case 5: { const u = v.getUint32(p); this.p += 4; if (!(u & 0x00ffffff)) return 0; const s = u >>> 31 ? -1 : 1; const e = (u >>> 24) & 0x7f; return s * ((u & 0xffffff) / 16777216) * Math.pow(16, e - 64); }
      case 6: { const b0 = v.getUint8(p), b1 = v.getUint8(p + 1), b2 = v.getUint8(p + 2), b3 = v.getUint8(p + 3); this.p += 4; const u = ((b1 << 24) | (b0 << 16) | (b3 << 8) | b2) >>> 0; const e = (u >>> 23) & 0xff; if (!e) return 0; return (u >>> 31 ? -1 : 1) * (0.5 + (u & 0x7fffff) / 16777216) * Math.pow(2, e - 128); }
      case 7: this.p += 8; return v.getFloat64(p);
      case 8: this.p += 16; return v.getFloat64(p);
      case 9: this.p += 24; return v.getFloat64(p);
      case 10: this.p += 8; return v.getFloat32(p);
      case 11: this.p += 16; return v.getFloat64(p);
      case 12: this.p += 1; return v.getInt8(p);
      case 13: this.p += 2; return v.getInt16(p);
      case 14: this.p += 4; return v.getInt32(p);
      case 15: this.p += 1; return v.getUint8(p);
      case 16: this.p += 2; return v.getUint16(p);
      case 17: this.p += 4; return v.getUint32(p);
      case 18: return this.uvari();
      case 19: return this.ident();
      case 20: return this.ascii();
      case 21: { const y = v.getUint8(p) + 1900, tzm = v.getUint8(p + 1), d = v.getUint8(p + 2), h = v.getUint8(p + 3), mi = v.getUint8(p + 4), s = v.getUint8(p + 5), ms = v.getUint16(p + 6); this.p += 8; return `${y}-${String(tzm & 0xf).padStart(2, '0')}-${String(d).padStart(2, '0')} ${h}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ms}`; }
      case 22: return this.uvari();
      case 23: return this.obname();
      case 24: { const t = this.ident(); const o = this.obname(); return { type: t, ...o }; }
      case 25: { const t = this.ident(); const o = this.obname(); const l = this.ident(); return { type: t, ...o, label: l }; }
      case 26: this.p += 1; return v.getUint8(p);
      case 27: return this.ident();
      default: throw new Error(`Unsupported DLIS representation code ${code}`);
    }
  }
}

interface LR { type: number; eflr: boolean; body: Uint8Array }

/** Iterate logical records (assembling multi-segment records). */
function* logicalRecords(buf0: ArrayBuffer): Generator<LR> {
  const buf = looksLikeTif(buf0) ? unwrapTif(buf0).data : buf0;
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let p = 80; // Storage Unit Label
  if (!(dv.getUint8(p + 2) === 0xff && dv.getUint8(p + 3) === 0x01)) {
    // Some files are wrapped in TIF 12-byte tape marks
    throw new Error('DLIS: unexpected visible-record structure after the storage unit label — the file is not RP66 V1 DLIS (or is corrupted).');
  }
  let parts: Uint8Array[] = []; let curType = 0, curE = false;
  while (p + 4 <= buf.byteLength) {
    const vrLen = dv.getUint16(p);
    if (vrLen < 4) break;
    const vrEnd = Math.min(p + vrLen, buf.byteLength);
    let q = p + 4;
    while (q + 4 <= vrEnd) {
      const segLen = dv.getUint16(q);
      const attrs = dv.getUint8(q + 2); const type = dv.getUint8(q + 3);
      if (segLen < 4) { q = vrEnd; break; }
      let bodyEnd = q + segLen;
      if (attrs & 0x02) bodyEnd -= 2; // trailing length
      if (attrs & 0x04) bodyEnd -= 2; // checksum
      if (attrs & 0x01) bodyEnd -= dv.getUint8(bodyEnd - 1); // padding
      const body = u8.subarray(q + 4, Math.max(q + 4, bodyEnd));
      const pred = !!(attrs & 0x40), succ = !!(attrs & 0x20);
      if (!pred) { parts = []; curType = type; curE = !!(attrs & 0x80); }
      if (!(attrs & 0x10)) parts.push(body); // skip encrypted
      if (!succ) {
        let body2: Uint8Array;
        if (parts.length === 1) body2 = parts[0];
        else { const n = parts.reduce((s, x) => s + x.length, 0); body2 = new Uint8Array(n); let o = 0; for (const x of parts) { body2.set(x, o); o += x.length; } }
        yield { type: curType, eflr: curE, body: body2 };
        parts = [];
      }
      q += segLen;
    }
    p = vrEnd;
  }
}

interface EObj { name: ObName; attrs: Record<string, { value: any[]; units: string; code: number }> }
interface ESet { type: string; name: string; objects: EObj[] }

function parseEFLR(body: Uint8Array): ESet | null {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const c = new Cur(dv, 0, body.byteLength);
  let set: ESet | null = null;
  const template: { label: string; count: number; code: number; units: string; value: any[] | null }[] = [];
  let cur: EObj | null = null; let ai = 0;
  while (c.p < c.end) {
    const desc = c.u8(); const role = desc >> 5;
    if (role === 7 || role === 6 || role === 5) { // SET / RSET / RDSET
      const type = desc & 0x10 ? c.ident() : ''; const name = desc & 0x08 ? c.ident() : '';
      set = { type, name, objects: [] }; continue;
    }
    if (!set) return null;
    if (role === 3) { // OBJECT
      const name = c.obname(); cur = { name, attrs: {} }; set.objects.push(cur); ai = 0; continue;
    }
    if (role === 1 || role === 2 || role === 0) { // ATTRIB / INVATR / ABSATR
      if (!cur) { // template
        const label = desc & 0x10 ? c.ident() : '';
        const count = desc & 0x08 ? c.uvari() : 1;
        const code = desc & 0x04 ? c.u8() : 19;
        const units = desc & 0x02 ? c.ident() : '';
        let value: any[] | null = null;
        if (desc & 0x01) { value = []; for (let i = 0; i < count; i++) value.push(c.value(code)); }
        template.push({ label, count, code, units, value });
        continue;
      }
      const t = template[ai++]; if (!t) { continue; }
      if (role === 0) continue; // absent
      if (desc & 0x10) c.ident(); // label (ignored for objects)
      const count = desc & 0x08 ? c.uvari() : t.count;
      const code = desc & 0x04 ? c.u8() : t.code;
      const units = desc & 0x02 ? c.ident() : t.units;
      let value: any[] = t.value ?? [];
      if (desc & 0x01) { value = []; for (let i = 0; i < count; i++) value.push(c.value(code)); }
      cur.attrs[t.label] = { value, units, code };
      continue;
    }
    break; // reserved role
  }
  return set;
}

export interface DlisChannel { key: string; name: string; longName: string; units: string; repr: number; reprName: string; dim: number; size: number }
export interface DlisFrame { key: string; name: string; indexType: string; direction: string; spacing: string; channels: DlisChannel[]; nFrames: number; indexMin?: number; indexMax?: number; indexUnits: string }
export interface DlisLogicalFile { index: number; fileId: string; wellName: string; field: string; company: string; frames: DlisFrame[]; params: HeaderItem[] }
export interface DlisScan { fileName: string; fileSize: number; logicalFiles: DlisLogicalFile[]; warnings: string[] }

const av = (o: EObj, k: string) => o.attrs[k]?.value ?? [];
const a1 = (o: EObj, k: string) => { const v = av(o, k); return v.length ? v[0] : undefined; };

export async function scanDLIS(file: File): Promise<DlisScan> {
  const buf = await file.arrayBuffer();
  const warnings: string[] = [];
  const lfs: DlisLogicalFile[] = [];
  let lf: DlisLogicalFile | null = null;
  let channels = new Map<string, EObj>();
  let framesObj: EObj[] = [];
  const counts = new Map<string, number>();
  const firstIdx = new Map<string, number>(), lastIdx = new Map<string, number>();
  const frameIdxCode = new Map<string, number>();
  const finish = () => {
    if (!lf) return;
    for (const f of framesObj) {
      const k = obKey(f.name);
      const chans: DlisChannel[] = (av(f, 'CHANNELS') as ObName[]).map((cn) => {
        const co = channels.get(obKey(cn));
        const repr = co ? (a1(co, 'REPRESENTATION-CODE') ?? 2) : 2;
        const dims = co ? (av(co, 'DIMENSION') as number[]) : [1];
        const dim = dims.length ? dims.reduce((a, b) => a * b, 1) : 1;
        return { key: obKey(cn), name: cn.id, longName: co ? String(a1(co, 'LONG-NAME') ?? '') : '', units: co ? String(a1(co, 'UNITS') ?? co.attrs['UNITS']?.units ?? '') : '', repr, reprName: REPR_NAMES[repr] ?? String(repr), dim, size: (FIXED_SIZE[repr] ?? -1) * dim };
      });
      const im = a1(f, 'INDEX-MIN'), ix = a1(f, 'INDEX-MAX');
      lf.frames.push({
        key: k, name: f.name.id, indexType: String(a1(f, 'INDEX-TYPE') ?? ''), direction: String(a1(f, 'DIRECTION') ?? ''),
        spacing: `${a1(f, 'SPACING') ?? ''} ${f.attrs['SPACING']?.units ?? ''}`.trim(), channels: chans,
        nFrames: counts.get(k) ?? 0, indexMin: typeof im === 'number' ? im : firstIdx.get(k), indexMax: typeof ix === 'number' ? ix : lastIdx.get(k),
        indexUnits: chans[0]?.units || f.attrs['INDEX-MIN']?.units || '',
      });
    }
    lfs.push(lf);
  };
  for (const lr of logicalRecords(buf)) {
    if (lr.eflr) {
      let set: ESet | null = null;
      try { set = parseEFLR(lr.body); } catch (e: any) { warnings.push(`EFLR type ${lr.type} could not be decoded: ${e.message}`); continue; }
      if (!set) continue;
      if (set.type === 'FILE-HEADER') {
        finish();
        lf = { index: lfs.length, fileId: String(a1(set.objects[0], 'ID') ?? '').trim(), wellName: '', field: '', company: '', frames: [], params: [] };
        channels = new Map(); framesObj = []; counts.clear(); firstIdx.clear(); lastIdx.clear();
      } else if (!lf) {
        lf = { index: 0, fileId: '', wellName: '', field: '', company: '', frames: [], params: [] };
      }
      if (set.type === 'ORIGIN' && set.objects[0]) {
        const o = set.objects[0];
        lf!.wellName = String(a1(o, 'WELL-NAME') ?? '').trim(); lf!.field = String(a1(o, 'FIELD-NAME') ?? '').trim(); lf!.company = String(a1(o, 'COMPANY') ?? '').trim();
      } else if (set.type === 'CHANNEL') for (const o of set.objects) channels.set(obKey(o.name), o);
      else if (set.type === 'FRAME') { framesObj.push(...set.objects); for (const f of set.objects) { const ch0 = (av(f, 'CHANNELS') as ObName[])[0]; const co = ch0 && channels.get(obKey(ch0)); frameIdxCode.set(obKey(f.name), co ? a1(co, 'REPRESENTATION-CODE') ?? 2 : 2); } }
      else if (set.type === 'PARAMETER' && lf && lf.params.length < 400) {
        for (const o of set.objects) { const v = av(o, 'VALUES'); if (v.length === 1 && (typeof v[0] === 'number' || typeof v[0] === 'string')) lf.params.push({ section: 'PARAMETER', mnem: o.name.id, unit: o.attrs['VALUES']?.units ?? '', value: String(v[0]), desc: String(a1(o, 'LONG-NAME') ?? '') }); }
      }
    } else if (lr.type === 0 && lf) {
      const dv = new DataView(lr.body.buffer, lr.body.byteOffset, lr.body.byteLength);
      const c = new Cur(dv, 0, lr.body.byteLength);
      const fr = c.obname(); c.uvari();
      const k = obKey(fr);
      counts.set(k, (counts.get(k) ?? 0) + 1);
      try { const iv = c.value(frameIdxCode.get(k) ?? 2); if (typeof iv === 'number') { if (!firstIdx.has(k)) firstIdx.set(k, iv); lastIdx.set(k, iv); } } catch { /* ignore */ }
    }
  }
  finish();
  if (!lfs.length) throw new Error('DLIS contains no logical files.');
  return { fileName: file.name, fileSize: file.size, logicalFiles: lfs, warnings };
}

/** Convert an index value to metres/feet. Returns [factor, unitLabel]. */
function depthFactor(u: string): [number, string] {
  const s = u.trim().toLowerCase();
  if (s === '0.1 in' || s === '.1 in' || s === '0.1in') return [0.00254, 'm'];
  if (s === 'in') return [0.0254, 'm'];
  if (s === 'cm') return [0.01, 'm'];
  if (s === 'mm') return [0.001, 'm'];
  if (s === 'ft' || s === 'f' || s === 'feet') return [1, 'ft'];
  if (s === '0.1 ft') return [0.1, 'ft'];
  return [1, s || 'm'];
}

export async function readDLISFrame(file: File, lfIndex: number, frameKey: string, channelKeys: string[], depthKey?: string, expandArrays = false): Promise<ParsedLog> {
  const scan = await scanDLIS(file); // cheap relative to decode; guarantees consistent metadata
  const lf = scan.logicalFiles[lfIndex];
  if (!lf) throw new Error(`Logical file ${lfIndex} not found.`);
  const fr = lf.frames.find((f) => f.key === frameKey);
  if (!fr) throw new Error(`Frame ${frameKey} not found in logical file ${lfIndex}.`);
  const warnings = [...scan.warnings];
  const chans = fr.channels;
  const want = new Set(channelKeys);
  const n = fr.nFrames;
  const idx = new Float64Array(n);
  const out = new Map<string, Float32Array>();
  const skipped: string[] = [];
  const dIdx = Math.max(0, depthKey ? chans.findIndex((c) => c.key === depthKey) : 0);
  const dCh = chans[dIdx];
  const arr = new Map<string, Float32Array[]>();
  chans.forEach((c, i) => { if (i !== dIdx && want.has(c.key)) { if (c.dim === 1) out.set(c.key, new Float32Array(n)); else if (expandArrays && c.dim <= 64) arr.set(c.key, Array.from({ length: c.dim }, () => new Float32Array(n))); else skipped.push(`${c.name}[${c.dim}]`); } });
  if (skipped.length) warnings.push(`Array channels not imported (enable "expand array channels" to import channels with ≤ 64 elements): ${skipped.join(', ')}`);
  const buf = await file.arrayBuffer();
  let lfi = -1; let r = 0;
  for (const lr of logicalRecords(buf)) {
    if (lr.eflr) { if (lr.type === 0 /* FHLR */) { try { const s = parseEFLR(lr.body); if (s?.type === 'FILE-HEADER') lfi++; } catch { /* */ } } if (lfi < 0) lfi = 0; continue; }
    if (lr.type !== 0 || lfi !== lfIndex) continue;
    const dv = new DataView(lr.body.buffer, lr.body.byteOffset, lr.body.byteLength);
    const c = new Cur(dv, 0, lr.body.byteLength);
    const f = c.obname(); if (obKey(f) !== frameKey) continue;
    c.uvari();
    if (r >= n) break;
    for (let i = 0; i < chans.length; i++) {
      const ch = chans[i]; const tgt = out.get(ch.key);
      if (i === dIdx) { idx[r] = c.value(ch.repr); for (let d = 1; d < ch.dim; d++) c.value(ch.repr); continue; }
      const ta = arr.get(ch.key);
      if (ta) { for (let d = 0; d < ch.dim; d++) ta[d][r] = c.value(ch.repr); continue; }
      if (tgt) { tgt[r] = c.value(ch.repr); for (let d = 1; d < ch.dim; d++) c.value(ch.repr); }
      else if (ch.size > 0) c.p += ch.size; else for (let d = 0; d < ch.dim; d++) c.value(ch.repr);
    }
    r++;
  }
  const [fac, dUnit] = depthFactor(dCh.units);
  if (dIdx !== 0) warnings.push(`Depth taken from channel ${dCh.name} (frame index is ${chans[0]?.name}).`);
  if (fac !== 1) warnings.push(`Depth converted from "${dCh.units}" to ${dUnit} (×${fac}).`);
  const reversed = n > 1 && idx[n - 1] < idx[0];
  const depth = new Float64Array(r);
  for (let i = 0; i < r; i++) depth[i] = idx[reversed ? r - 1 - i : i] * fac;
  const curves = [...out.entries()].map(([k, a]) => {
    const ch = chans.find((c) => c.key === k)!;
    const d = new Float32Array(r);
    for (let i = 0; i < r; i++) { const v = a[reversed ? r - 1 - i : i]; d[i] = v === -999.25 || v === -9999 || Math.abs(v) > 1e30 ? NaN : v; }
    return { mnemonic: ch.name, unit: ch.units, description: ch.longName, data: d };
  });
  for (const [k, list] of arr) {
    const ch = chans.find((c) => c.key === k)!;
    list.forEach((a, e) => { const d = new Float32Array(r); for (let i = 0; i < r; i++) { const v = a[reversed ? r - 1 - i : i]; d[i] = v === -999.25 || v === -9999 || Math.abs(v) > 1e30 ? NaN : v; } curves.push({ mnemonic: `${ch.name}_${e + 1}`, unit: ch.units, description: `${ch.longName} [element ${e + 1}/${ch.dim}]`, data: d }); });
  }
  if (arr.size) warnings.push(`Array channels expanded into element curves: ${[...arr.keys()].map((k) => chans.find((c) => c.key === k)!.name).join(', ')}`);
  if (reversed) warnings.push('Frame index was decreasing (logged up); data re-ordered to increasing depth.');
  warnings.push('DLIS absent values -999.25 / -9999 mapped to missing.');
  const header: HeaderItem[] = [
    { section: 'ORIGIN', mnem: 'WELL', unit: '', value: lf.wellName, desc: 'Well name' },
    { section: 'ORIGIN', mnem: 'FLD', unit: '', value: lf.field, desc: 'Field' },
    { section: 'ORIGIN', mnem: 'COMP', unit: '', value: lf.company, desc: 'Company' },
    { section: 'FRAME', mnem: 'FRAME', unit: '', value: fr.name, desc: `Index ${fr.indexType}, spacing ${fr.spacing}` },
    ...lf.params,
  ];
  return {
    format: 'DLIS', fileName: file.name, fileSize: file.size, wellName: lf.wellName || file.name, uwi: '', field: lf.field,
    depthUnit: dUnit, depthMnemonic: dCh?.name ?? 'INDEX', depth, curves, header, warnings, reversed,
  };
}
