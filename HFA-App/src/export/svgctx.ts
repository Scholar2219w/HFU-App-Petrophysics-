// Minimal Canvas2D → SVG recorder. Implements the subset of the Canvas API used
// by renderXY / renderLog, so every plot can be exported as true vector SVG
// by replaying the same renderer (no rasterisation).
type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r2 = (v: number) => Math.round(v * 100) / 100;

let measurer: CanvasRenderingContext2D | null = null;

export class SvgContext {
  fillStyle: any = '#000'; strokeStyle: any = '#000'; lineWidth = 1; font = '10px sans-serif'; textAlign: CanvasTextAlign = 'start'; globalAlpha = 1; textBaseline: CanvasTextBaseline = 'alphabetic';
  private m: M = [1, 0, 0, 1, 0, 0]; private dash: number[] = []; private d = ''; private out: string[] = []; private defs: string[] = [];
  private stack: { m: M; fillStyle: any; strokeStyle: any; lineWidth: number; font: string; textAlign: CanvasTextAlign; globalAlpha: number; dash: number[]; groups: number }[] = [];
  private groups = 0; private clipN = 0;
  constructor(public width: number, public height: number) {}
  private pt(x: number, y: number) { const m = this.m; return `${r2(m[0] * x + m[2] * y + m[4])},${r2(m[1] * x + m[3] * y + m[5])}`; }
  private op() { return this.globalAlpha < 1 ? ` opacity="${this.globalAlpha}"` : ''; }
  private dashAttr() { return this.dash.length ? ` stroke-dasharray="${this.dash.join(',')}"` : ''; }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { this.m = [a, b, c, d, e, f]; }
  translate(x: number, y: number) { this.m = mul(this.m, [1, 0, 0, 1, x, y]); }
  rotate(t: number) { const c = Math.cos(t), s = Math.sin(t); this.m = mul(this.m, [c, s, -s, c, 0, 0]); }
  scale(x: number, y: number) { this.m = mul(this.m, [x, 0, 0, y, 0, 0]); }
  save() { this.stack.push({ m: this.m, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, font: this.font, textAlign: this.textAlign, globalAlpha: this.globalAlpha, dash: this.dash, groups: this.groups }); this.groups = 0; }
  restore() { const s = this.stack.pop(); if (!s) return; for (let i = 0; i < this.groups; i++) this.out.push('</g>'); Object.assign(this, { m: s.m, fillStyle: s.fillStyle, strokeStyle: s.strokeStyle, lineWidth: s.lineWidth, font: s.font, textAlign: s.textAlign, globalAlpha: s.globalAlpha, dash: s.dash, groups: s.groups }); }
  setLineDash(d: number[]) { this.dash = [...d]; }
  getLineDash() { return this.dash; }
  beginPath() { this.d = ''; }
  moveTo(x: number, y: number) { this.d += `M${this.pt(x, y)}`; }
  lineTo(x: number, y: number) { this.d += `L${this.pt(x, y)}`; }
  closePath() { this.d += 'Z'; }
  rect(x: number, y: number, w: number, h: number) { this.d += `M${this.pt(x, y)}L${this.pt(x + w, y)}L${this.pt(x + w, y + h)}L${this.pt(x, y + h)}Z`; }
  arc(x: number, y: number, r: number, a0: number, a1: number) {
    const sc = Math.hypot(this.m[0], this.m[1]); const rr = r2(r * sc);
    if (Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6) { const [cx, cy] = this.pt(x, y).split(',').map(Number); this.d += `M${r2(cx - rr)},${cy}a${rr},${rr} 0 1,0 ${2 * rr},0a${rr},${rr} 0 1,0 ${-2 * rr},0`; return; }
    const n = 24; for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; this.d += `${i || this.d ? 'L' : 'M'}${this.pt(x + r * Math.cos(a), y + r * Math.sin(a))}`; }
  }
  fill() { if (this.d) this.out.push(`<path d="${this.d}" fill="${this.fillStyle}"${this.op()}/>`); }
  stroke() { if (this.d) this.out.push(`<path d="${this.d}" fill="none" stroke="${this.strokeStyle}" stroke-width="${this.lineWidth}"${this.dashAttr()}${this.op()}/>`); }
  clip() { const id = `c${++this.clipN}`; this.defs.push(`<clipPath id="${id}"><path d="${this.d}"/></clipPath>`); this.out.push(`<g clip-path="url(#${id})">`); this.groups++; }
  fillRect(x: number, y: number, w: number, h: number) { this.beginPath(); this.rect(x, y, w, h); this.fill(); }
  strokeRect(x: number, y: number, w: number, h: number) { this.beginPath(); this.rect(x, y, w, h); this.stroke(); }
  clearRect() { /* no-op */ }
  measureText(t: string) { if (!measurer) measurer = document.createElement('canvas').getContext('2d'); measurer!.font = this.font; return measurer!.measureText(t); }
  fillText(t: string, x: number, y: number) {
    const anchor = this.textAlign === 'center' ? 'middle' : this.textAlign === 'right' || this.textAlign === 'end' ? 'end' : 'start';
    const m = mul(this.m, [1, 0, 0, 1, x, y]);
    const fm = /(bold\s+)?(\d+(?:\.\d+)?)px\s+(.*)/.exec(this.font);
    this.out.push(`<text transform="matrix(${m.map(r2).join(' ')})" font-size="${fm?.[2] ?? 10}" font-family="${esc(fm?.[3] ?? 'sans-serif')}"${fm?.[1] ? ' font-weight="bold"' : ''} text-anchor="${anchor}" fill="${this.fillStyle}"${this.op()}>${esc(t)}</text>`);
  }
  toString() {
    const close = '</g>'.repeat(this.groups + this.stack.reduce((s, x) => s + x.groups, 0));
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}"><defs>${this.defs.join('')}</defs>${this.out.join('')}${close}</svg>`;
  }
}
