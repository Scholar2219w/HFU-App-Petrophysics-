// Industrial multi-track well-log viewer (Canvas 2D).
// • One canvas for all tracks → depth-synchronised cursor/scroll by construction
// • Min/max envelope downsampling for display ONLY (science uses full-resolution arrays)
// • Lazy curve loading from IndexedDB; requestAnimationFrame-throttled redraw
import { FLAG_RE } from '../curves/catalog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { S, useStore, type CurveDisplay, type TrackDef, type Selection, type Annotation } from '../store/store';
import { registry } from '../data-engine/registry';
import { coreCol, coreDepths } from '../data-engine/core';
import { findByFamily, CATEGORY_COLORS } from '../curves/catalog';
import type { CoreMeta, Top, WellMeta } from '../types';
import { fmt, hfuColor, isNum, lowerBound, nearestIndex, niceTicks, uid } from '../util/num';
import { exportFigure } from '../export/io';
import { THEMES, themed } from './theme';
import { zonesForWell, reservoirsForWell } from '../data-engine/zones';

export function resolveMnem(well: WellMeta, name: string): string | undefined {
  const names = well.curves.map((c) => c.mnemonic);
  if (names.includes(name)) return name;
  return findByFamily(names, name.toUpperCase(), S().aliases);
}

export interface BandInterval { top: number; base: number; value: number }
export function runLength(depth: Float64Array, v: ArrayLike<number>): BandInterval[] {
  const out: BandInterval[] = []; let cur: BandInterval | null = null;
  for (let i = 0; i < depth.length; i++) {
    const x = v[i]; const val = isNum(x) && x > 0 ? Math.round(x) : 0;
    if (cur && cur.value === val) { cur.base = depth[i]; continue; }
    if (cur && cur.value > 0) out.push(cur);
    cur = { top: depth[i], base: depth[i], value: val };
  }
  if (cur && cur.value > 0) out.push(cur);
  // extend by half-step for display continuity
  const step = depth.length > 1 ? (depth[depth.length - 1] - depth[0]) / (depth.length - 1) : 0;
  out.forEach((b) => { b.top -= step / 2; b.base += step / 2; });
  return out;
}

export interface LogViewerProps {
  wellId: string;
  tracks: TrackDef[];
  onTracksChange?: (t: TrackDef[]) => void;
  selectedTrack?: string | null;
  onSelectTrack?: (id: string | null) => void;
  onBandClick?: (b: BandInterval, curve: string) => void;
  cursorFields?: string[];
  showCore?: boolean;
}

const DEFAULT_CURSOR = ['GR', 'RHOB', 'NPHI', 'PHIE', 'RQI_LOG', 'FZI_LOG', 'FZI_PRED', 'HFU_PRED'];

export function defaultDisplayFor(well: WellMeta | undefined, mnem: string, idx = 0): CurveDisplay {
  const c = well?.curves.find((x) => x.mnemonic === mnem);
  const cat = c?.category ?? 'Other';
  const logScale = cat === 'Resistivity' || cat === 'Permeability' || /FZI|RQI|^K|PERM|KTIM|KSDR/i.test(mnem);
  const s = c?.stats;
  let min = s?.p05, max = s?.p95;
  if (logScale) { min = Math.max(1e-3, Math.pow(10, Math.floor(Math.log10(Math.max(1e-3, s?.min ?? 0.1))))); max = Math.pow(10, Math.ceil(Math.log10(Math.max(1e-2, s?.max ?? 100)))); }
  else if (isNum(min as number) && isNum(max as number)) { const pad = ((max as number) - (min as number)) * 0.1; min = (min as number) - pad; max = (max as number) + pad; }
  const pal = [CATEGORY_COLORS[cat] ?? '#4ea1ff', '#f5a623', '#b083f0', '#39c5cf'];
  return { mnem, color: pal[idx % pal.length], width: 1.2, scale: logScale ? 'log' : 'lin', min, max, discrete: undefined } as CurveDisplay;
}

export interface RenderLogOpts {
  well: WellMeta; tracks: TrackDef[]; widths: number[]; xs: number[]; range: { top: number; base: number };
  cores: CoreMeta[]; tops: Top[]; interval?: { wellId: string; top: number; base: number }; selection?: Selection;
  cursorY?: number | null; selectedTrack?: string | null; showCore?: boolean; annotations?: Annotation[]; theme?: 'light' | 'dark';
}
/** Pure renderer (used by the on-screen viewer and by PNG/SVG/PDF export). */
export function renderLog(ctx: CanvasRenderingContext2D, W: number, H: number, o: RenderLogOpts) {
  const { well, xs, widths, interval, selection, cores, tops } = o;
  const depth = registry.depth(well.id); const th = o.theme ?? 'light'; const T = THEMES[th]; const tc = (c: string) => themed(c, th);
  ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
    if (!depth) { ctx.fillStyle = T.dim; ctx.fillText('Loading depth index…', 10, 20); return; }
    const { top, base } = o.range; const Y = (d: number) => ((d - top) / (base - top)) * H;
    const i0 = Math.max(0, lowerBound(depth, top) - 1), i1 = Math.min(depth.length - 1, lowerBound(depth, base) + 1);
    const tickStep = niceTicks(top, base, Math.max(3, Math.floor(H / 45)));
    const minorStep = tickStep.length > 1 ? (tickStep[1] - tickStep[0]) / 5 : 1;
    o.tracks.forEach((t, ti) => {
      const x0 = xs[ti], w = widths[ti];
      ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, w, H); ctx.clip();
      if (o.selectedTrack === t.id) { ctx.fillStyle = T.selTrack; ctx.fillRect(x0, 0, w, H); }
      // depth grid
      if (t.kind === 'depth' || t.kind === 'curve') {
        if (t.minorGrid !== false && t.kind === 'curve') { ctx.strokeStyle = T.minor; ctx.lineWidth = 1; ctx.beginPath(); for (let d = Math.ceil(top / minorStep) * minorStep; d < base; d += minorStep) { const y = Math.round(Y(d)) + 0.5; ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); } ctx.stroke(); }
        ctx.strokeStyle = T.major; ctx.beginPath(); for (const d of tickStep) { const y = Math.round(Y(d)) + 0.5; ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); } ctx.stroke();
      }
      if (t.kind === 'depth') {
        ctx.fillStyle = T.text; ctx.font = '10px Consolas, monospace'; ctx.textAlign = 'right';
        for (const d of tickStep) ctx.fillText(d.toFixed(tickStep.length > 1 && tickStep[1] - tickStep[0] < 1 ? 1 : 0), x0 + w - 4, Y(d) + 3);
        // interval selection
        if (interval && interval.wellId === well.id) { ctx.fillStyle = 'rgba(78,161,255,0.25)'; ctx.fillRect(x0, Y(interval.top), w, Y(interval.base) - Y(interval.top)); }
      }
      if (t.kind === 'curve') {
        // vertical grid (4 divisions or decades)
        const first = t.curves.find((cd) => !cd.core);
        if (t.grid !== false) {
          ctx.strokeStyle = T.vgrid; ctx.beginPath();
          if (first?.scale === 'log' && first.min && first.max && first.min > 0) { const a = Math.log10(first.min), b = Math.log10(first.max); for (let e = Math.ceil(Math.min(a, b)); e <= Math.max(a, b); e++) { const x = x0 + ((e - a) / (b - a)) * w; ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, H); } }
          else for (let k = 1; k < 4; k++) { const x = Math.round(x0 + (k * w) / 4) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
          ctx.stroke();
        }
        // curves
        const xmap = (cd: CurveDisplay) => {
          const mn = cd.min ?? 0, mx = cd.max ?? 1; const lg = cd.scale === 'log';
          const a = lg ? Math.log10(Math.max(1e-12, mn)) : mn, b = lg ? Math.log10(Math.max(1e-12, mx)) : mx;
          const rev = !!cd.reverse;
          return (v: number) => { const f = ((lg ? Math.log10(v) : v) - a) / (b - a); return x0 + (rev ? 1 - f : f) * w; };
        };
        const drawn: Record<string, { X: (v: number) => number; data: Float32Array }> = {};
        for (const cd of t.curves) {
          if (cd.core) continue;
          const m = resolveMnem(well, cd.mnem); if (!m) continue;
          const data = registry.curve(well.id, m); if (!data) continue;
          const X = xmap(cd); drawn[cd.mnem] = { X, data };
          const isLog = cd.scale === 'log';
          // fills
          if (cd.fill === 'baseline' && isNum(cd.baseline as number)) {
            const xb = X(cd.baseline!); const cL = cd.fillColor ?? 'rgba(255,230,0,0.85)', cR = cd.fillColor2 ?? 'rgba(150,75,0,0.85)';
            for (let i = i0; i < i1; i++) { const v = data[i]; if (!isNum(v)) continue; const x = Math.max(x0, Math.min(x0 + w, X(v))); const y = Y(depth[i]), y2 = Y(depth[i + 1]); ctx.fillStyle = x < xb ? cL : cR; ctx.fillRect(Math.min(x, xb), y, Math.abs(xb - x), Math.max(1, y2 - y)); }
            ctx.strokeStyle = th === 'light' ? '#000' : '#ccc'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(xb, 0); ctx.lineTo(xb, H); ctx.stroke(); ctx.setLineDash([]);
          }
          if (cd.fill === 'left' || cd.fill === 'right') {
            ctx.fillStyle = cd.fillColor ?? tc(cd.color) + '33'; ctx.beginPath(); const edge = cd.fill === 'left' ? x0 : x0 + w; let open = false;
            for (let i = i0; i <= i1; i++) { const v = data[i]; if (!isNum(v) || (isLog && v <= 0)) { if (open) { ctx.lineTo(edge, Y(depth[i - 1])); ctx.closePath(); open = false; } continue; } const x = Math.max(x0, Math.min(x0 + w, X(v))); const y = Y(depth[i]); if (!open) { ctx.moveTo(edge, y); open = true; } ctx.lineTo(x, y); }
            if (open) { ctx.lineTo(edge, Y(depth[i1])); ctx.closePath(); }
            ctx.fill();
          }
          ctx.strokeStyle = tc(cd.color); ctx.lineWidth = cd.width; ctx.setLineDash(cd.dash ? [4, 3] : []); ctx.beginPath();
          const n = i1 - i0 + 1;
          if (n > H * 2) { // min/max envelope per pixel row (display-only downsampling)
            let row = -1, mnx = 0, mxx = 0, pen = false;
            const flush = () => { if (row >= 0) { if (!pen) { ctx.moveTo(mnx, row); pen = true; } else ctx.lineTo(mnx, row); ctx.lineTo(mxx, row + 0.5); } };
            for (let i = i0; i <= i1; i++) { const v = data[i]; if (!isNum(v) || (isLog && v <= 0)) { flush(); row = -1; pen = false; continue; } const r = Math.floor(Y(depth[i])); const x = X(v); if (r !== row) { flush(); row = r; mnx = mxx = x; } else { if (x < mnx) mnx = x; if (x > mxx) mxx = x; } }
            flush();
          } else {
            let pen = false;
            for (let i = i0; i <= i1; i++) { const v = data[i]; if (!isNum(v) || (isLog && v <= 0)) { pen = false; continue; } const x = X(v), y = Y(depth[i]); if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y); }
          }
          ctx.stroke(); ctx.setLineDash([]);
          // discrete curves (few distinct values) → markers
        }
        // crossover fill
        for (const cd of t.curves) {
          if (cd.fill !== 'crossover' || !cd.crossWith) continue;
          const A = drawn[cd.mnem], B = drawn[cd.crossWith]; if (!A || !B) continue;
          ctx.fillStyle = cd.fillColor ?? 'rgba(245,166,35,0.35)';
          for (let i = i0; i < i1; i++) { const a = A.data[i], b = B.data[i]; if (!isNum(a) || !isNum(b)) continue; const xa = A.X(a), xb = B.X(b); if (xa < xb) { const y = Y(depth[i]), y2 = Y(depth[i + 1]); ctx.fillRect(xa, y, xb - xa, Math.max(1, y2 - y)); } }
        }
        // core points
        if (o.showCore !== false) for (const cd of t.curves) {
          if (!cd.core) continue;
          const X = xmap(cd);
          for (const cm of cores) {
            if (cd.core.coreId && cd.core.coreId !== cm.id) continue;
            const arr = registry.core(cm.id); if (!arr) continue;
            const col = coreCol(cm, arr, cd.core.column); if (!col) continue;
            const { shifted } = coreDepths(cm, arr);
            ctx.fillStyle = tc(cd.color) === '#000000' && th === 'light' ? '#e00000' : tc(cd.color); ctx.strokeStyle = T.coreStroke;
            for (let i = 0; i < shifted.length; i++) { const v = col[i]; if (!isNum(v) || (cd.scale === 'log' && v <= 0) || arr.excluded[i]) continue; const y = Y(shifted[i]); if (y < -4 || y > H + 4) continue; ctx.beginPath(); ctx.arc(X(v), y, 2.6, 0, 7); ctx.fill(); ctx.lineWidth = 0.6; ctx.stroke(); }
          }
        }
        // extrapolation strip for predicted curves
        if (t.curves.some((cd) => /_PRED$/i.test(cd.mnem))) {
          const ex = well.curves.some((c) => c.mnemonic === 'EXTRAP') ? registry.curve(well.id, 'EXTRAP') : undefined;
          if (ex) { ctx.fillStyle = 'rgba(229,83,75,0.8)'; for (let i = i0; i <= i1; i++) if (ex[i] > 0) { const y = Y(depth[i]); ctx.fillRect(x0 + w - 4, y, 4, Math.max(1, Y(depth[Math.min(i + 1, depth.length - 1)]) - y)); } }
        }
      }
      if (t.kind === 'hfu') {
        const m = t.hfu?.curve ?? (well.curves.find((c) => c.mnemonic === 'HFU_PRED') ? 'HFU_PRED' : well.curves.find((c) => c.discrete && !FLAG_RE.test(c.mnemonic) && c.mnemonic !== 'HFU_CORE')?.mnemonic);
        const data = m ? registry.curve(well.id, m) : undefined;
        if (data) {
          for (const b of runLength(depth.subarray(i0, i1 + 1), data.subarray(i0, i1 + 1))) {
            const y0 = Y(b.top), y1 = Y(b.base); ctx.fillStyle = hfuColor(b.value); ctx.fillRect(x0, y0, w, Math.max(1, y1 - y0));
            if (y1 - y0 > 12) { ctx.fillStyle = T.bandText; ctx.font = 'bold 10px Consolas, monospace'; ctx.textAlign = 'center'; ctx.fillText(String(b.value), x0 + w / 2, (y0 + y1) / 2 + 3); }
          }
        } else { ctx.fillStyle = T.dim; ctx.font = '10px Segoe UI'; ctx.save(); ctx.translate(x0 + w / 2 + 3, 60); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'right'; ctx.fillText('no HFU curve', 0, 0); ctx.restore(); }
        // core HFU markers
        const coreH = well.curves.find((c) => c.mnemonic === 'HFU_CORE') ? registry.curve(well.id, 'HFU_CORE') : undefined;
        if (coreH) for (let i = i0; i <= i1; i++) if (coreH[i] > 0) { const y = Y(depth[i]); ctx.fillStyle = hfuColor(coreH[i]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0 + 1, y - 3); ctx.lineTo(x0 + 7, y); ctx.lineTo(x0 + 1, y + 3); ctx.closePath(); ctx.fill(); ctx.stroke(); }
      }
      if (t.kind === 'zone') {
        const zs = zonesForWell(well.id); const pal = th === 'light' ? ['#f4d6a0', '#cfe3b5', '#b8d7ec', '#e8c3d8', '#d9d2ef', '#f2e3b3'] : ['#2a2418', '#1d2a1a', '#18242e', '#2a1c26', '#211e2e', '#2a2716'];
        zs.forEach((z, i) => { const y0 = Y(z.top), y1 = Y(z.base); if (y1 < 0 || y0 > H) return; ctx.fillStyle = pal[i % pal.length]; ctx.fillRect(x0, y0, w, y1 - y0); ctx.strokeStyle = T.border; ctx.beginPath(); ctx.moveTo(x0, Math.round(y0) + 0.5); ctx.lineTo(x0 + w, Math.round(y0) + 0.5); ctx.stroke();
          const a = Math.max(y0, 0), b = Math.min(y1, H); if (b - a > 30) { ctx.save(); ctx.translate(x0 + w / 2 + 4, (a + b) / 2); ctx.rotate(-Math.PI / 2); ctx.fillStyle = T.text; ctx.font = 'bold 10.5px Segoe UI, Arial'; ctx.textAlign = 'center'; ctx.fillText(z.name, 0, 0); ctx.restore(); } });
      }
      if (t.kind === 'flag') {
        const fc = t.flag?.curve ?? 'RES_FLAG'; const col = t.flag?.color ?? T.resFill;
        const m = resolveMnem(well, fc); const data = m ? registry.curve(well.id, m) : undefined;
        if (data) { ctx.fillStyle = col; for (const b of runLength(depth.subarray(i0, i1 + 1), data.subarray(i0, i1 + 1))) { const y0 = Y(b.top), y1 = Y(b.base); ctx.fillRect(x0 + 1, y0, w - 2, Math.max(1, y1 - y0)); } }
        else if (fc === 'RES_FLAG') { ctx.fillStyle = col; for (const r of reservoirsForWell(well.id)) { const y0 = Y(r.top), y1 = Y(r.base); ctx.fillRect(x0 + 1, y0, w - 2, y1 - y0); } }
      }
      ctx.restore();
      ctx.strokeStyle = T.border; ctx.beginPath(); ctx.moveTo(x0 + w - 0.5, 0); ctx.lineTo(x0 + w - 0.5, H); ctx.stroke();
    });
    const totalW = xs[xs.length - 1] + widths[widths.length - 1];
    // tops
    const li = o.tracks.findIndex((t) => t.kind !== 'depth' && t.kind !== 'zone'); const labX = xs[li < 0 ? 1 : li] ?? 0;
    ctx.font = '10px Segoe UI, sans-serif';
    for (const t of tops) { if (t.md < top || t.md > base) continue; const y = Math.round(Y(t.md)) + 0.5; ctx.strokeStyle = t.color; ctx.setLineDash([6, 3]); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(totalW, y); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = t.color; ctx.textAlign = 'left'; ctx.fillText(t.name, labX + 3, y - 2); }
    // selection marks (lasso from crossplot)
    if (selection && selection.wellId === well.id) {
      ctx.strokeStyle = 'rgba(255,90,209,0.28)'; ctx.lineWidth = 1;
      for (const d of selection.depths) { if (d < top || d > base) continue; const y = Math.round(Y(d)) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(totalW, y); ctx.stroke(); ctx.fillStyle = '#ff5ad1'; ctx.beginPath(); ctx.moveTo(0, y - 4); ctx.lineTo(8, y); ctx.lineTo(0, y + 4); ctx.fill(); }
    }
    if (interval && interval.wellId === well.id) { ctx.strokeStyle = '#4ea1ff'; ctx.setLineDash([2, 2]); [interval.top, interval.base].forEach((d) => { const y = Y(d); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(totalW, y); ctx.stroke(); }); ctx.setLineDash([]); }
    if (o.cursorY != null) { ctx.strokeStyle = T.cursor; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, o.cursorY + 0.5); ctx.lineTo(totalW, o.cursorY + 0.5); ctx.stroke(); }
    // annotations / markers
    for (const a of o.annotations ?? []) {
      if (a.wellId !== well.id || a.depth < top || a.depth > base) continue;
      const y = Math.round(Y(a.depth)) + 0.5; ctx.strokeStyle = a.color; ctx.setLineDash([1, 3]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(totalW, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = a.color; ctx.beginPath(); ctx.arc(totalW - 6, y, 3.5, 0, 7); ctx.fill();
      ctx.font = '10.5px Segoe UI, sans-serif'; const tw = ctx.measureText(a.text).width; ctx.fillStyle = th === 'light' ? 'rgba(255,255,255,0.9)' : 'rgba(12,15,19,0.85)'; ctx.fillRect(totalW - tw - 16, y - 13, tw + 6, 13); ctx.fillStyle = a.color; ctx.textAlign = 'left'; ctx.fillText(a.text, totalW - tw - 13, y - 3);
    }
}

/** Header band (curve names + scales) drawn on canvas — for exports. */
export function renderLogHeader(ctx: CanvasRenderingContext2D, W: number, HH: number, o: RenderLogOpts) {
  const th = o.theme ?? 'light'; const T = THEMES[th];
  ctx.fillStyle = T.headBg; ctx.fillRect(0, 0, W, HH); ctx.font = '10px Consolas, monospace';
  o.tracks.forEach((t, ti) => {
    const x0 = o.xs[ti], w = o.widths[ti];
    ctx.strokeStyle = T.border; ctx.strokeRect(x0 + 0.5, 0.5, w, HH - 1);
    if (t.kind !== 'curve') { ctx.fillStyle = T.text; ctx.textAlign = 'center'; ctx.fillText(t.kind === 'depth' ? `${o.well.depthUnit.toUpperCase()} MD` : t.kind === 'zone' ? 'Zones' : t.kind === 'flag' ? (t.flag?.curve ?? 'RES_FLAG') : 'HFU', x0 + w / 2, 14); return; }
    t.curves.forEach((cd, k) => {
      const y = 12 + k * 14; const m = cd.core ? `core ${cd.core.column}` : resolveMnem(o.well, cd.mnem) ?? cd.mnem;
      ctx.fillStyle = themed(cd.color, th); ctx.textAlign = 'center'; ctx.fillText(m, x0 + w / 2, y);
      ctx.fillStyle = T.dim; ctx.textAlign = 'left'; ctx.fillText(fmt(cd.min!, 3), x0 + 2, y); ctx.textAlign = 'right'; ctx.fillText(fmt(cd.max!, 3), x0 + w - 2, y);
      ctx.fillStyle = themed(cd.color, th); ctx.fillRect(x0 + 2, y + 2, w - 4, 1.5);
    });
  });
}

export function LogViewer(p: LogViewerProps) {
  const well = useStore((s) => s.wells.find((w) => w.id === p.wellId));
  const cores = useStore((s) => s.cores.filter((c) => c.wellId === p.wellId));
  const tops = useStore((s) => s.tops.filter((t) => t.wellId === p.wellId));
  const dataVersion = useStore((s) => s.dataVersion);
  const viewRange = useStore((s) => s.viewRange);
  const interval = useStore((s) => s.interval);
  const selection = useStore((s) => s.selection);
  const annotations = useStore((s) => s.annotations);
  const theme = useStore((s) => s.logTheme); useStore((s) => s.reservoirs);
  const [hz, setHz] = useState(1);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [cursor, setCursor] = useState<{ x: number; y: number; depth: number } | null>(null);
  const [cursorOn, setCursorOn] = useState(true);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [lazyTick, setLazyTick] = useState(0);
  const body = useRef<HTMLDivElement>(null); const cv = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ mode: 'pan' | 'interval'; y0: number; top0: number; base0: number; d0: number } | null>(null);
  const raf = useRef(0);

  useEffect(() => { registry.setLazyListener(() => setLazyTick((t) => t + 1)); }, []);
  useEffect(() => { const el = body.current!; const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el); return () => ro.disconnect(); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.target as HTMLElement)?.tagName === 'INPUT') return; if (e.code === 'Space') { e.preventDefault(); setCursorOn((c) => !c); } if (e.key === 'Escape') S().set({ interval: undefined, selection: undefined }); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);

  const range = useMemo(() => {
    if (!well) return { top: 0, base: 1 };
    if (viewRange && viewRange.wellId === well.id) return viewRange;
    const rv = reservoirsForWell(well.id); if (rv.length) return { top: Math.min(...rv.map((r) => r.top)) - 10, base: Math.max(...rv.map((r) => r.base)) + 10 }; // open on the reservoir
    const span = Math.min(well.stop - well.start, 150);
    return { top: well.start, base: well.start + span };
  }, [well, viewRange, S().reservoirs]);
  const setRange = (top: number, base: number) => {
    if (!well) return; const full = well.stop - well.start; let span = Math.max(1, Math.min(base - top, full * 1.05));
    let t = Math.max(well.start - full * 0.02, Math.min(top, well.stop - span + full * 0.02)); S().set({ viewRange: { wellId: well.id, top: t, base: t + span } }); void span;
  };

  const widths = p.tracks.map((t) => Math.round(t.width * (t.kind === 'depth' ? 1 : hz)));
  const xs = widths.reduce<number[]>((a, w, i) => (a.push((a[i - 1] ?? 0) + (i ? widths[i - 1] : 0)), a), []);

  const draw = () => {
    const c = cv.current; if (!c || !well) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(size.w, xs[xs.length - 1] + widths[widths.length - 1] || 0), H = size.h;
    c.width = W * dpr; c.height = H * dpr; c.style.width = W + 'px'; c.style.height = H + 'px';
    const ctx = c.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderLog(ctx, W, H, { well, tracks: p.tracks, widths, xs, range, cores, tops, interval, selection, cursorY: cursor && cursorOn ? cursor.y : null, selectedTrack: p.selectedTrack, showCore: p.showCore, annotations, theme });
  };
  useEffect(() => { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(draw); });
  void dataVersion; void lazyTick;

  if (!well) return <div className="hint" style={{ padding: 20 }}>No well selected. Import data or load the demo dataset.</div>;

  const depthAt = (y: number) => range.top + (y / size.h) * (range.base - range.top);
  const trackAt = (x: number) => { for (let i = 0; i < xs.length; i++) if (x >= xs[i] && x < xs[i] + widths[i]) return i; return -1; };
  const onWheel = (e: React.WheelEvent) => {
    if (e.shiftKey) { setHz((h) => Math.max(0.4, Math.min(4, h * (e.deltaY > 0 ? 0.9 : 1.1)))); return; }
    const r = body.current!.getBoundingClientRect(); const d = depthAt(e.clientY - r.top);
    const f = e.deltaY > 0 ? 1.2 : 1 / 1.2; setRange(d - (d - range.top) * f, d + (range.base - d) * f);
  };
  const onDown = (e: React.MouseEvent) => {
    const r = body.current!.getBoundingClientRect(); const x = e.clientX - r.left + body.current!.scrollLeft, y = e.clientY - r.top;
    if (e.altKey) { // Alt+click → annotation / marker
      const dd = +depthAt(y).toFixed(2); const text = prompt(`Annotation at ${dd} ${well.depthUnit} (prefix with "!" for a marker):`); if (!text) return;
      const marker = text.startsWith('!');
      S().set({ annotations: [...S().annotations, { id: uid('a_'), wellId: well.id, depth: dd, text: marker ? text.slice(1).trim() : text, color: marker ? '#ff8c42' : '#e8c547', kind: marker ? 'marker' : 'annotation' }] });
      S().log(`Added ${marker ? 'marker' : 'annotation'} "${text}" at ${dd} ${well.depthUnit} (${well.name})`); return;
    }
    const ti = trackAt(x); const t = p.tracks[ti];
    if (t?.kind === 'hfu' && p.onBandClick) {
      const m = t.hfu?.curve ?? (well.curves.find((c) => c.mnemonic === 'HFU_PRED') ? 'HFU_PRED' : well.curves.find((c) => c.discrete && !FLAG_RE.test(c.mnemonic) && c.mnemonic !== 'HFU_CORE')?.mnemonic);
      const d = registry.depth(well.id); const data = m ? registry.curve(well.id, m) : undefined;
      if (d && data && m) { const dd = depthAt(y); const b = runLength(d, data).find((q) => dd >= q.top && dd <= q.base); if (b) { p.onBandClick(b, m); return; } }
    }
    drag.current = { mode: t?.kind === 'depth' ? 'interval' : 'pan', y0: y, top0: range.top, base0: range.base, d0: depthAt(y) };
    if (t) p.onSelectTrack?.(t.id);
  };
  const onMove = (e: React.MouseEvent) => {
    const r = body.current!.getBoundingClientRect(); const y = e.clientY - r.top; const x = e.clientX - r.left;
    const d = depthAt(y); setCursor({ x, y, depth: d }); S().set({ cursor: { wellId: well.id, depth: d } });
    const g = drag.current; if (!g || e.buttons !== 1) return;
    if (g.mode === 'pan') { const dd = ((y - g.y0) / size.h) * (g.base0 - g.top0); setRange(g.top0 - dd, g.base0 - dd); }
    else { const a = Math.min(g.d0, d), b = Math.max(g.d0, d); if (b - a > 0.05) S().set({ interval: { wellId: well.id, top: +a.toFixed(3), base: +b.toFixed(3) } }); }
  };
  const onUp = () => { drag.current = null; };

  const cursorRows = () => {
    if (!cursor) return null; const d = registry.depth(well.id); if (!d) return null;
    const i = nearestIndex(d, cursor.depth); const rows: [string, string][] = [['Depth', `${cursor.depth.toFixed(2)} ${well.depthUnit}`]];
    for (const f of p.cursorFields ?? DEFAULT_CURSOR) { const m = resolveMnem(well, f); if (!m) continue; const c = registry.curve(well.id, m); if (!c) continue; rows.push([m === f ? f : `${f} (${m})`, fmt(c[i], 4)]); }
    const tp = [...tops].filter((t) => t.md <= cursor.depth).sort((a, b) => b.md - a.md)[0]; if (tp) rows.push(['Zone', tp.name]);
    const rv = reservoirsForWell(well.id).find((r) => cursor.depth >= r.top && cursor.depth < r.base); rows.push(['Reservoir', rv ? rv.name : '—']);
    return rows;
  };

  const onDrop = (e: React.DragEvent, trackId: string | null) => {
    e.preventDefault(); setDragOver(null);
    const mnem = e.dataTransfer.getData('text/curve'); if (!mnem || !p.onTracksChange) return;
    if (trackId) p.onTracksChange(p.tracks.map((t) => (t.id === trackId ? { ...t, kind: t.kind === 'depth' ? t.kind : 'curve', curves: [...t.curves, defaultDisplayFor(well, mnem, t.curves.length)] } : t)));
    else p.onTracksChange([...p.tracks, { id: uid('t_'), kind: 'curve', width: 140, grid: true, curves: [defaultDisplayFor(well, mnem)] }]);
    S().log(`Log viewer: added ${mnem} to ${trackId ? 'track' : 'new track'}`);
  };
  const rows = cursorOn ? cursorRows() : null;
  return (
    <div className={'lv ' + theme} style={{ position: 'relative' }}>
        <div className="lv-export" style={{ position: 'absolute', bottom: 16, right: 10, zIndex: 5, opacity: 0.92, display: 'flex', gap: 4, alignItems: 'center', background: 'var(--bg1)', padding: '2px 6px', borderRadius: 4, border: '1px solid var(--bd2)' }} title="Export the visible log panel">
          <span className="dim" style={{ fontFamily: 'var(--sans)' }}>Export view</span>
          <span style={{ display: 'flex', gap: 2 }}>{(['png', 'svg', 'pdf'] as const).map((k) => <button key={k} className="btn sm" onClick={(e) => { e.stopPropagation(); exportFigure(k, `${well.name}_log_${range.top.toFixed(0)}-${range.base.toFixed(0)}`, undefined, { o: { well, tracks: p.tracks, widths, xs, range, cores, tops, interval, selection, showCore: p.showCore, annotations, theme }, h: size.h }); }}>{k.toUpperCase()}</button>)}</span>
        </div>
      <div className="lv-heads" style={{ overflowX: 'hidden' }}>
        {p.tracks.map((t, ti) => (
          <div key={t.id} className={'lv-head' + (p.selectedTrack === t.id ? ' sel' : '') + (dragOver === t.id ? ' dragover' : '')} style={{ width: widths[ti] }}
            onClick={() => p.onSelectTrack?.(t.id)} onDragOver={(e) => { e.preventDefault(); setDragOver(t.id); }} onDragLeave={() => setDragOver(null)} onDrop={(e) => onDrop(e, t.id)}>
            {t.kind === 'depth' && <div className="title">{well.depthUnit.toUpperCase()}<br />MD</div>}
            {t.kind === 'hfu' && <div className="title">HFU<br /><span className="mono">{t.hfu?.curve ?? 'auto'}</span></div>}
            {t.kind === 'zone' && <div className="title">Zones<br /><span className="mono">tops</span></div>}
            {t.kind === 'flag' && <div className="title" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', margin: '0 auto', fontSize: 9.5 }}>{t.flag?.curve ?? 'RES_FLAG'}</div>}
            {t.kind === 'curve' && t.curves.map((cd, k) => {
              const m = cd.core ? `core ${cd.core.column}` : resolveMnem(well, cd.mnem);
              return (<div key={k} style={{ opacity: m ? 1 : 0.35 }}>
                <div className="cn"><span className="sc">{fmt(cd.reverse ? cd.max! : cd.min!, 3)}</span><span className="nm" style={{ color: themed(cd.color, theme) }}>{cd.core ? '● ' : ''}{m ?? cd.mnem}</span><span className="sc">{fmt(cd.reverse ? cd.min! : cd.max!, 3)}</span></div>
                <div className="ln" style={{ background: themed(cd.color, theme), opacity: cd.dash ? 0.6 : 1 }} />
              </div>);
            })}
            {t.kind === 'curve' && !t.curves.length && <div className="title">drop curves here</div>}
          </div>
        ))}
        <div className="lv-head" style={{ width: 70, color: 'var(--tx3)' }} onDragOver={(e) => { e.preventDefault(); setDragOver('new'); }} onDragLeave={() => setDragOver(null)} onDrop={(e) => onDrop(e, null)}>
          <div className="title" style={{ paddingTop: 6 }}>+ new track<br />(drop)</div>
        </div>
      </div>
      <div className="lv-body" ref={body} onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={() => { setCursor(null); drag.current = null; }} onDoubleClick={() => setRange(well.start, well.stop)} style={{ overflowX: 'auto', overflowY: 'hidden', cursor: 'crosshair' }}>
        <canvas ref={cv} />
        {rows && cursor && <div className="cursor-panel" style={{ left: Math.min(cursor.x + 16, size.w - 200), top: Math.min(cursor.y + 10, size.h - rows.length * 14 - 14) }}>{rows.map(([k, v]) => <div key={k}><span>{k}</span><span>{v}</span></div>)}</div>}
      </div>
    </div>
  );
}
