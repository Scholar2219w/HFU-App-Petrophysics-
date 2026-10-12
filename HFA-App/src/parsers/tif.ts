// TIF (Tape Image Format) unwrapping, used by both LIS and DLIS readers.
// Each block is preceded by a 12-byte little-endian marker: type, prev, next.
export function looksLikeTif(buf: ArrayBuffer) {
  if (buf.byteLength < 12) return false;
  const dv = new DataView(buf); const type = dv.getUint32(0, true), prev = dv.getUint32(4, true), next = dv.getUint32(8, true);
  return (type === 0 || type === 1) && prev === 0 && next > 12 && next <= buf.byteLength;
}

/** Returns records (for LIS: one physical record per TIF block) and the contiguous data. */
export function unwrapTif(buf: ArrayBuffer): { blocks: Uint8Array[]; data: ArrayBuffer } {
  const dv = new DataView(buf); const u8 = new Uint8Array(buf); const blocks: Uint8Array[] = [];
  let p = 0; let total = 0;
  while (p + 12 <= buf.byteLength) {
    const type = dv.getUint32(p, true), next = dv.getUint32(p + 8, true);
    if (next <= p || next > buf.byteLength) { if (type === 0) { const b = u8.subarray(p + 12); blocks.push(b); total += b.length; } break; }
    if (type === 0 && next - p > 12) { const b = u8.subarray(p + 12, next); blocks.push(b); total += b.length; }
    p = next;
  }
  const data = new Uint8Array(total); let o = 0; for (const b of blocks) { data.set(b, o); o += b.length; }
  return { blocks, data: data.buffer };
}
