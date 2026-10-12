// Export writers (spec §30): CSV · XLSX · LAS 2.0 · JSON · PNG · SVG · PDF.
import { S } from '../store/store';
import { registry } from '../data-engine/registry';
import { call } from '../workers/rpc';
import { renderXY, type XYPlotProps } from '../visualization/XYPlot';
import { renderLog, renderLogHeader, type RenderLogOpts } from '../visualization/LogViewer';
import { SvgContext } from '../export/svgctx';
import { download } from '../ui/common';
import type { WellMeta } from '../types';
import { isNum, nowIso } from '../util/num';

export const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_');

export interface Col { name: string; unit?: string; data: ArrayLike<number> | string[] }
export function toCSV(cols: Col[], withUnits = true): string {
  const n = Math.max(0, ...cols.map((c) => c.data.length));
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [cols.map((c) => q(c.name)).join(',')];
  if (withUnits) lines.push(cols.map((c) => q(c.unit ?? '')).join(','));
  for (let i = 0; i < n; i++) lines.push(cols.map((c) => { const v = (c.data as any)[i]; return typeof v === 'string' ? q(v) : isNum(v) ? String(+v.toPrecision(8)) : ''; }).join(','));
  return lines.join('\n');
}
export async function toXLSX(sheets: { name: string; rows: any[][] }[]): Promise<Uint8Array> {
  return call<Uint8Array>('parse', 'writeXlsx', [sheets]);
}
export const colsToRows = (cols: Col[], withUnits = true) => {
  const n = Math.max(0, ...cols.map((c) => c.data.length)); const rows: any[][] = [cols.map((c) => c.name)];
  if (withUnits) rows.push(cols.map((c) => c.unit ?? ''));
  for (let i = 0; i < n; i++) rows.push(cols.map((c) => { const v = (c.data as any)[i]; return typeof v === 'string' ? v : isNum(v) ? v : null; }));
  return rows;
};

/** LAS 2.0 writer — NULL -999.25, one line per depth step, full provenance in ~Other. */
export function toLAS(well: WellMeta, curves: string[]): string {
  const d = registry.depth(well.id)!; const arrs = curves.map((m) => registry.curve(well.id, m)!);
  const metas = curves.map((m) => well.curves.find((c) => c.mnemonic === m)!);
  const pad = (s: string, n: number) => (s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length));
  const L: string[] = ['~Version Information', ' VERS.                2.0 : CWLS LOG ASCII STANDARD - VERSION 2.0', ' WRAP.                 NO : ONE LINE PER DEPTH STEP', '~Well Information',
    ` STRT.${pad(well.depthUnit.toUpperCase(), 6)}${pad(d[0].toFixed(4), 16)}: START DEPTH`, ` STOP.${pad(well.depthUnit.toUpperCase(), 6)}${pad(d[d.length - 1].toFixed(4), 16)}: STOP DEPTH`,
    ` STEP.${pad(well.depthUnit.toUpperCase(), 6)}${pad(well.regular ? well.step.toFixed(4) : '0', 16)}: STEP`, ` NULL.      ${pad('-999.25', 16)}: NULL VALUE`,
    ` WELL.      ${pad(well.name, 16)}: WELL`, ` UWI .      ${pad(well.uwi || '', 16)}: UNIQUE WELL ID`, ` FLD .      ${pad(well.field || '', 16)}: FIELD`, ` DATE.      ${pad(nowIso().slice(0, 10), 16)}: EXPORT DATE (HFA Suite)`,
    '~Curve Information', ` DEPT.${well.depthUnit.toUpperCase()}                   : DEPTH`,
    ...metas.map((c) => ` ${pad(c.mnemonic.replace(/\s/g, '_') + '.' + (c.unit || '').replace(/\s/g, ''), 22)}: ${c.description}`),
    '~Other', ...metas.filter((c) => c.calc).map((c) => ` ${c.mnemonic}: ${c.calc!.formula.replace(/\n/g, ' ')} [${c.calc!.kind} v${c.calc!.version}]`), '~A'];
  for (let i = 0; i < d.length; i++) L.push([d[i].toFixed(4), ...arrs.map((a) => (isNum(a[i]) ? (+a[i].toPrecision(7)).toString() : '-999.25'))].map((s) => s.padStart(12)).join(' '));
  return L.join('\n');
}

// ── plot rendering to PNG / SVG ──
export function xyToCanvas(p: XYPlotProps, w = 900, h = 600, scale = 2) {
  const c = document.createElement('canvas'); c.width = w * scale; c.height = h * scale; const ctx = c.getContext('2d')!; ctx.setTransform(scale, 0, 0, scale, 0, 0); renderXY(ctx, w, h, p); return c;
}
export function xyToSVG(p: XYPlotProps, w = 900, h = 600) { const s = new SvgContext(w, h); renderXY(s as any, w, h, p); return s.toString(); }

const HEADER_H = 60;
export function logToCanvas(o: RenderLogOpts, H = 1000, scale = 2) {
  const W = o.xs[o.xs.length - 1] + o.widths[o.widths.length - 1];
  const c = document.createElement('canvas'); c.width = W * scale; c.height = (H + HEADER_H) * scale; const ctx = c.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0); renderLogHeader(ctx, W, HEADER_H, o); ctx.translate(0, HEADER_H); renderLog(ctx, W, H, o); return c;
}
export function logToSVG(o: RenderLogOpts, H = 1000) {
  const W = o.xs[o.xs.length - 1] + o.widths[o.widths.length - 1]; const s = new SvgContext(W, H + HEADER_H);
  renderLogHeader(s as any, W, HEADER_H, o); s.translate(0, HEADER_H); renderLog(s as any, W, H, o); return s.toString();
}
export const canvasBlob = (c: HTMLCanvasElement) => new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'));

export interface CustomFigure { w: number; h: number; render: (ctx: CanvasRenderingContext2D) => void }
export function customToCanvas(f: CustomFigure, scale = 2) { const c = document.createElement('canvas'); c.width = f.w * scale; c.height = f.h * scale; const ctx = c.getContext('2d')!; ctx.setTransform(scale, 0, 0, scale, 0, 0); f.render(ctx); return c; }
export function customToSVG(f: CustomFigure) { const s = new SvgContext(f.w, f.h); f.render(s as any); return s.toString(); }
export async function exportFigure(kind: 'png' | 'svg' | 'pdf', name: string, xy?: { p: XYPlotProps; w?: number; h?: number }, log?: { o: RenderLogOpts; h?: number }, custom?: CustomFigure) {
  try {
    if (kind === 'svg') download(custom ? customToSVG(custom) : xy ? xyToSVG(xy.p, xy.w, xy.h) : logToSVG(log!.o, log!.h), `${safeName(name)}.svg`, 'image/svg+xml');
    else {
      const c = custom ? customToCanvas(custom) : xy ? xyToCanvas(xy.p, xy.w, xy.h) : logToCanvas(log!.o, log!.h);
      if (kind === 'png') download(await canvasBlob(c), `${safeName(name)}.png`, 'image/png');
      else {
        const { jsPDF } = await import('jspdf');
        const w = c.width / 2, h = c.height / 2; const pdf = new jsPDF({ orientation: w > h ? 'landscape' : 'portrait', unit: 'pt', format: [w + 40, h + 60] });
        pdf.setFontSize(10); pdf.text(`${name} — HFA Suite — ${nowIso().slice(0, 16).replace('T', ' ')}`, 20, 20);
        pdf.addImage(c.toDataURL('image/png'), 'PNG', 20, 34, w, h); download(pdf.output('blob'), `${safeName(name)}.pdf`, 'application/pdf');
      }
    }
    S().log(`Exported figure "${name}" as ${kind.toUpperCase()}`);
  } catch (e: any) { S().notify('CRITICAL', `Figure export failed: ${e.message}`); }
}
