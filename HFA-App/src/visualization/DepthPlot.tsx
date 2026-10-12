// Conventional depth-track plot: every "property vs depth" figure in the app is
// drawn like a well-log print — depth down the page, narrow tall tracks, white
// background, curve header with name / scale / unit, formation and reservoir
// columns. Zoom: wheel · pan: drag · reset: double-click · readout: hover.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { isNum, niceTicks, fmt } from '../util/num';
import { exportFigure } from '../export/io';
import { THEMES, themed } from './theme';
import { zonesForWell, reservoirsForWell } from '../data-engine/zones';

export interface DepthSeries {
  depth: ArrayLike<number>; values: ArrayLike<number>; label: string; unit?: string; color: string;
  kind?: 'line' | 'dots'; size?: number; colors?: (string | undefined)[]; dash?: boolean; width?: number;
  min?: number; max?: number; log?: boolean; reverse?: boolean; fill?: 'left' | 'right'; fillColor?: string;
  hollow?: boolean;
}
export interface DepthTrack { title?: string; width?: number; series: DepthSeries[] }
export interface DepthBand { top: number; base: number; color: string; label?: string }
export interface DepthPlotProps {
  tracks: DepthTrack[]; title?: string; wellId?: string; height?: number | string;
  range?: [number, number]; bands?: DepthBand[]; markers?: { depth: number; label: string; color?: string }[];
  onPick?: (depth: number, track: number, value: number | null) => void; depthLabel?: string; showZones?: boolean;
}

const DEPTH_W = 54, ZONE_W = 18, RES_W = 10;

function autoScale(s: DepthSeries, top: number, base: number): [number, number] {
  if (isNum(s.min as number) && isNum(s.max as number)) return [s.min!, s.max!];
  const v: number[] = []; for (let i = 0; i < s.values.length; i++) { const d = s.depth[i], x = s.values[i]; if (isNum(x) && isNum(d) && d >= top && d <= base && (!s.log || x > 0)) v.push(x); }
  if (!v.length) return s.log ? [0.01, 100] : [0, 1];
  v.sort((a, b) => a - b); const lo = v[Math.floor(v.length * 0.01)], hi = v[Math.min(v.length - 1, Math.ceil(v.length * 0.99) - 1)];
  if (s.log) return [Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, v[0])))), Math.pow(10, Math.ceil(Math.log10(Math.max(1e-6, v[v.length - 1]))))];
  if (lo === hi) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.08; return [lo - pad, hi + pad];
}
const nearest = (d: ArrayLike<number>, x: number) => { let bi = -1, bd = Infinity; for (let i = 0; i < d.length; i++) { const e = Math.abs(d[i] - x); if (e < bd) { bd = e; bi = i; } } return { i: bi, dist: bd }; };

export interface DepthLayout { xs: number[]; ws: number[]; W: number; headH: number; hasZones: boolean; hasRes: boolean }
export function depthLayout(p: DepthPlotProps, width: number): DepthLayout {
  const hasZones = !!p.wellId && p.showZones !== false && zonesForWell(p.wellId).length > 0;
  const hasRes = !!p.wellId && p.showZones !== false && reservoirsForWell(p.wellId).length > 0;
  const fixed = DEPTH_W + (hasZones ? ZONE_W : 0) + (hasRes ? RES_W : 0);
  const base = p.tracks.map((t) => t.width ?? 150); const sum = base.reduce((a, b) => a + b, 0);
  const extra = Math.max(0, width - fixed - sum); const shrink = width > 0 && sum > width - fixed - 2 ? Math.max(0.45, (width - fixed - 2) / sum) : 1;
  const ws = base.map((w) => (shrink < 1 ? Math.max(30, Math.floor(w * shrink)) : Math.min(w + extra / Math.max(1, base.length), Math.max(w, 280))));
  const xs: number[] = []; let x = fixed; for (const w of ws) { xs.push(x); x += w; }
  const headH = 16 + 26 * Math.max(1, ...p.tracks.map((t) => t.series.length));
  return { xs, ws, W: x, headH, hasZones, hasRes };
}

/** Pure renderer (screen + PNG/SVG/PDF export). */
export function renderDepthPlot(ctx: CanvasRenderingContext2D, W: number, H: number, p: DepthPlotProps, L: DepthLayout, view: { top: number; base: number }, hoverY: number | null, themeName: 'light' | 'dark') {
  const T = THEMES[themeName]; const { top, base } = view; const hh = L.headH; const plotH = H - hh;
  const Y = (d: number) => hh + ((d - top) / (base - top)) * plotH;
  ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
  const ticks = niceTicks(top, base, Math.max(3, Math.floor(plotH / 42)));
  const minor = ticks.length > 1 ? (ticks[1] - ticks[0]) / 5 : 1;
  const colX = (i: number) => L.xs[i], colW = (i: number) => L.ws[i];
  // header
  ctx.font = '10px Segoe UI, Arial, sans-serif'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = T.headBg; ctx.fillRect(0, 0, W, hh);
  ctx.fillStyle = T.text; ctx.textAlign = 'center'; ctx.fillText(p.depthLabel ?? 'MD (m)', DEPTH_W / 2, hh - 6);
  let zx = DEPTH_W;
  if (L.hasZones) { ctx.save(); ctx.translate(zx + ZONE_W / 2 + 3, hh - 4); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'left'; ctx.fillStyle = T.dim; ctx.fillText('Zones', 0, 0); ctx.restore(); zx += ZONE_W; }
  if (L.hasRes) { ctx.save(); ctx.translate(zx + RES_W / 2 + 3, hh - 4); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'left'; ctx.fillStyle = T.dim; ctx.fillText('RES', 0, 0); ctx.restore(); }
  const scales: [number, number][][] = p.tracks.map((t) => t.series.map((s) => autoScale(s, top, base)));
  p.tracks.forEach((t, ti) => {
    const x0 = colX(ti), w = colW(ti);
    t.series.forEach((s, k) => {
      const y = 14 + k * 26; const [mn, mx] = scales[ti][k]; const c = themed(s.color, themeName);
      ctx.fillStyle = c; ctx.textAlign = 'center'; ctx.font = 'bold 10px Segoe UI, Arial, sans-serif'; ctx.fillText(s.label, x0 + w / 2, y);
      ctx.font = '9.5px Segoe UI, Arial, sans-serif'; ctx.fillStyle = T.dim; ctx.fillText(s.unit ?? '', x0 + w / 2, y + 11);
      ctx.fillStyle = c; ctx.textAlign = 'left'; ctx.fillText(fmt(s.reverse ? mx : mn, 3), x0 + 3, y + 11); ctx.textAlign = 'right'; ctx.fillText(fmt(s.reverse ? mn : mx, 3), x0 + w - 3, y + 11);
      if (s.kind === 'dots') { ctx.beginPath(); ctx.arc(x0 + 6, y - 4, 3, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(x0 + w - 6, y - 4, 3, 0, 7); ctx.fill(); }
      ctx.strokeStyle = c; ctx.lineWidth = 1.4; ctx.setLineDash(s.dash ? [4, 3] : []); ctx.beginPath(); ctx.moveTo(x0 + 3, y + 14); ctx.lineTo(x0 + w - 3, y + 14); ctx.stroke(); ctx.setLineDash([]);
    });
    if (t.title && t.series.length === 0) { ctx.fillStyle = T.text; ctx.textAlign = 'center'; ctx.fillText(t.title, x0 + w / 2, 14); }
  });
  // body clip
  ctx.save(); ctx.beginPath(); ctx.rect(0, hh, W, plotH); ctx.clip();
  // depth column
  ctx.fillStyle = T.text; ctx.textAlign = 'right'; ctx.font = '10px Segoe UI, Arial, sans-serif';
  const dec = ticks.length > 1 && ticks[1] - ticks[0] < 1 ? 1 : 0;
  for (const d of ticks) { const y = Y(d); ctx.fillText(d.toFixed(dec), DEPTH_W - 6, y + 3.5); ctx.strokeStyle = T.major; ctx.beginPath(); ctx.moveTo(DEPTH_W - 4, Math.round(y) + 0.5); ctx.lineTo(DEPTH_W, Math.round(y) + 0.5); ctx.stroke(); }
  // zones
  let cx = DEPTH_W;
  if (L.hasZones && p.wellId) {
    const zs = zonesForWell(p.wellId); const pal = ['#f4d6a0', '#cfe3b5', '#b8d7ec', '#e8c3d8', '#d9d2ef', '#f2e3b3'];
    zs.forEach((z, i) => { const y0 = Y(z.top), y1 = Y(z.base); if (y1 < hh || y0 > H) return; ctx.fillStyle = themeName === 'light' ? pal[i % pal.length] : '#1b2533'; ctx.fillRect(cx, y0, ZONE_W, y1 - y0); ctx.strokeStyle = T.border; ctx.strokeRect(cx + 0.5, y0 + 0.5, ZONE_W - 1, y1 - y0);
      const a = Math.max(y0, hh), b = Math.min(y1, H); if (b - a > 40) { ctx.save(); ctx.beginPath(); ctx.rect(cx, a, ZONE_W, b - a); ctx.clip(); ctx.translate(cx + ZONE_W / 2 + 3.5, (a + b) / 2); ctx.rotate(-Math.PI / 2); ctx.fillStyle = T.text; ctx.textAlign = 'center'; ctx.font = '9.5px Segoe UI, Arial'; ctx.fillText(z.name, 0, 0); ctx.restore(); } });
    cx += ZONE_W;
  }
  if (L.hasRes && p.wellId) {
    for (const r of reservoirsForWell(p.wellId)) { const y0 = Y(r.top), y1 = Y(r.base); ctx.fillStyle = T.resFill; ctx.fillRect(cx + 1, y0, RES_W - 2, y1 - y0); }
  }
  // bands (behind curves)
  for (const b of p.bands ?? []) { ctx.fillStyle = b.color; ctx.fillRect(DEPTH_W, Y(b.top), W - DEPTH_W, Y(b.base) - Y(b.top)); }
  // tracks
  p.tracks.forEach((t, ti) => {
    const x0 = colX(ti), w = colW(ti);
    ctx.save(); ctx.beginPath(); ctx.rect(x0, hh, w, plotH); ctx.clip();
    ctx.fillStyle = T.trackBg === T.bg ? 'transparent' : T.trackBg;
    // horizontal grid
    ctx.strokeStyle = T.minor; ctx.lineWidth = 1; ctx.beginPath(); for (let d = Math.ceil(top / minor) * minor; d < base; d += minor) { const y = Math.round(Y(d)) + 0.5; ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); } ctx.stroke();
    ctx.strokeStyle = T.major; ctx.beginPath(); for (const d of ticks) { const y = Math.round(Y(d)) + 0.5; ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); } ctx.stroke();
    // vertical grid from the first series' scale
    const s0 = t.series[0]; ctx.strokeStyle = T.vgrid; ctx.beginPath();
    if (s0?.log) { const [mn, mx] = scales[ti][0]; const a = Math.log10(mn), b = Math.log10(mx); for (let e = Math.floor(Math.min(a, b)); e <= Math.max(a, b); e++) for (let m = 1; m < 10; m++) { const v = Math.log10(m * Math.pow(10, e)); if (v < Math.min(a, b) || v > Math.max(a, b)) continue; const f = (v - a) / (b - a); const x = Math.round(x0 + (s0.reverse ? 1 - f : f) * w) + 0.5; if (m === 1) { ctx.stroke(); ctx.strokeStyle = T.major; ctx.beginPath(); ctx.moveTo(x, hh); ctx.lineTo(x, H); ctx.stroke(); ctx.strokeStyle = T.vgrid; ctx.beginPath(); } else { ctx.moveTo(x, hh); ctx.lineTo(x, H); } } }
    else for (let k = 1; k < 10; k++) { const x = Math.round(x0 + (k * w) / 10) + 0.5; ctx.moveTo(x, hh); ctx.lineTo(x, H); }
    ctx.stroke();
    t.series.forEach((s, k) => {
      const [mn, mx] = scales[ti][k]; const lg = !!s.log; const a = lg ? Math.log10(mn) : mn, b = lg ? Math.log10(mx) : mx;
      const X = (v: number) => { const f = ((lg ? Math.log10(v) : v) - a) / (b - a); return x0 + (s.reverse ? 1 - f : f) * w; };
      const c = themed(s.color, themeName); const ok = (v: number) => isNum(v) && (!lg || v > 0);
      if (s.kind === 'dots') {
        const r = s.size ?? 3;
        for (let i = 0; i < s.values.length; i++) { const v = s.values[i], d = s.depth[i]; if (!ok(v) || !isNum(d) || d < top || d > base) continue;
          const x = Math.max(x0 + 2, Math.min(x0 + w - 2, X(v))); ctx.beginPath(); ctx.arc(x, Y(d), r, 0, 7);
          if (s.hollow) { ctx.strokeStyle = s.colors?.[i] ?? c; ctx.lineWidth = 1.3; ctx.stroke(); } else { ctx.fillStyle = s.colors?.[i] ?? c; ctx.fill(); ctx.strokeStyle = themeName === 'light' ? 'rgba(0,0,0,0.55)' : '#000'; ctx.lineWidth = 0.6; ctx.stroke(); } }
        return;
      }
      // line (assumes depth-ordered samples — sort defensively)
      const idx: number[] = []; for (let i = 0; i < s.values.length; i++) { const d = s.depth[i]; if (isNum(d) && d >= top - (base - top) * 0.02 && d <= base + (base - top) * 0.02) idx.push(i); }
      let sorted = true; for (let j = 1; j < idx.length; j++) if (s.depth[idx[j]] < s.depth[idx[j - 1]]) { sorted = false; break; }
      if (!sorted) idx.sort((i, j) => s.depth[i] - s.depth[j]);
      if (s.fill) { ctx.fillStyle = s.fillColor ?? c + '40'; const edge = s.fill === 'left' ? x0 : x0 + w; let open = false; ctx.beginPath(); let last = 0;
        for (const i of idx) { const v = s.values[i]; if (!ok(v)) { if (open) { ctx.lineTo(edge, last); ctx.closePath(); open = false; } continue; } const y = Y(s.depth[i]); const x = Math.max(x0, Math.min(x0 + w, X(v))); if (!open) { ctx.moveTo(edge, y); open = true; } ctx.lineTo(x, y); last = y; }
        if (open) { ctx.lineTo(edge, last); ctx.closePath(); } ctx.fill(); }
      ctx.strokeStyle = c; ctx.lineWidth = s.width ?? 1.1; ctx.setLineDash(s.dash ? [4, 3] : []); ctx.beginPath(); let pen = false;
      const dense = idx.length > plotH * 2;
      if (dense) { let row = -1, lo = 0, hi = 0; const flush = () => { if (row < 0) return; if (!pen) { ctx.moveTo(lo, row); pen = true; } else ctx.lineTo(lo, row); ctx.lineTo(hi, row + 0.5); };
        for (const i of idx) { const v = s.values[i]; if (!ok(v)) { flush(); row = -1; pen = false; continue; } const r = Math.floor(Y(s.depth[i])); const x = X(v); if (r !== row) { flush(); row = r; lo = hi = x; } else { if (x < lo) lo = x; if (x > hi) hi = x; } } flush(); }
      else for (const i of idx) { const v = s.values[i]; if (!ok(v)) { pen = false; continue; } const x = X(v), y = Y(s.depth[i]); if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y); }
      ctx.stroke(); ctx.setLineDash([]);
    });
    ctx.restore();
  });
  // tops lines
  if (p.wellId && p.showZones !== false) { ctx.font = '9.5px Segoe UI, Arial'; for (const z of zonesForWell(p.wellId)) { if (z.top < top || z.top > base) continue; const y = Math.round(Y(z.top)) + 0.5; ctx.strokeStyle = themeName === 'light' ? '#8a5a00' : '#e8c547'; ctx.setLineDash([6, 3]); ctx.beginPath(); ctx.moveTo(DEPTH_W, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]); } }
  for (const m of p.markers ?? []) { if (m.depth < top || m.depth > base) continue; const y = Math.round(Y(m.depth)) + 0.5; ctx.strokeStyle = m.color ?? '#0066cc'; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(DEPTH_W, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = m.color ?? '#0066cc'; ctx.textAlign = 'right'; ctx.fillText(m.label, W - 4, y - 3); }
  if (hoverY != null && hoverY > hh) { ctx.strokeStyle = T.cursor; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, hoverY + 0.5); ctx.lineTo(W, hoverY + 0.5); ctx.stroke(); }
  ctx.restore();
  // borders
  ctx.strokeStyle = T.border; ctx.lineWidth = 1;
  const edges = [DEPTH_W, ...(L.hasZones ? [DEPTH_W + ZONE_W] : []), ...(L.hasRes ? [DEPTH_W + (L.hasZones ? ZONE_W : 0) + RES_W] : []), ...L.xs.map((x, i) => x + L.ws[i])];
  ctx.beginPath(); for (const x of [0.5, ...edges.map((e) => Math.round(e) - 0.5)]) { ctx.moveTo(x, 0); ctx.lineTo(x, H); } ctx.moveTo(0, hh + 0.5); ctx.lineTo(W, hh + 0.5); ctx.moveTo(0, 0.5); ctx.lineTo(W, 0.5); ctx.moveTo(0, H - 0.5); ctx.lineTo(W, H - 0.5); ctx.stroke();
  return { Y, scales };
}

function fullRange(p: DepthPlotProps): [number, number] {
  if (p.range) return p.range;
  let mn = Infinity, mx = -Infinity;
  for (const t of p.tracks) for (const s of t.series) for (let i = 0; i < s.depth.length; i++) { const d = s.depth[i]; if (!isNum(d) || !isNum(s.values[i])) continue; if (d < mn) mn = d; if (d > mx) mx = d; }
  if (mn === Infinity) return [0, 1];
  const pad = Math.max(1, (mx - mn) * 0.04); return [mn - pad, mx + pad];
}

export function DepthPlot(p: DepthPlotProps) {
  const theme = useStore((s) => s.logTheme); useStore((s) => s.reservoirs); useStore((s) => s.tops);
  const box = useRef<HTMLDivElement>(null); const cv = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 400, h: 500 });
  const full = useMemo(() => fullRange(p), [p.tracks, p.range?.[0], p.range?.[1]]);
  const [view, setView] = useState<{ top: number; base: number } | null>(null);
  const v = view ?? { top: full[0], base: full[1] };
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ y: number; top: number; base: number; moved: boolean } | null>(null);
  useEffect(() => { setView(null); }, [full[0], full[1]]);
  useEffect(() => { const el = box.current!; const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el); return () => ro.disconnect(); }, []);
  const L = depthLayout(p, size.w);
  const res = useRef<{ Y: (d: number) => number; scales: [number, number][][] } | null>(null);
  useEffect(() => {
    const c = cv.current; if (!c) return; const dpr = window.devicePixelRatio || 1; const W = Math.max(size.w, L.W), H = size.h;
    c.width = W * dpr; c.height = H * dpr; c.style.width = W + 'px'; c.style.height = H + 'px';
    const ctx = c.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    res.current = renderDepthPlot(ctx, W, H, p, L, v, hover?.y ?? null, theme);
  });
  const dAt = (y: number) => v.top + ((y - L.headH) / (size.h - L.headH)) * (v.base - v.top);
  const onWheel = (e: React.WheelEvent) => { const d = dAt(e.nativeEvent.offsetY); const f = e.deltaY > 0 ? 1.2 : 1 / 1.2; setView({ top: d - (d - v.top) * f, base: d + (v.base - d) * f }); };
  const trackAt = (x: number) => L.xs.findIndex((x0, i) => x >= x0 && x < x0 + L.ws[i]);
  const readout = () => {
    if (!hover || hover.y < L.headH || !res.current) return null; const d = dAt(hover.y); const rows: [string, string, string][] = [['Depth', fmt(d, 6), '#888']];
    const tol = (v.base - v.top) / 120;
    p.tracks.forEach((t) => t.series.forEach((s) => { const n = nearest(s.depth, d); if (n.i >= 0 && n.dist <= Math.max(tol, s.kind === 'dots' ? tol * 2 : tol)) { const x = s.values[n.i]; if (isNum(x)) rows.push([s.label, fmt(x, 4) + (s.unit ? ' ' + s.unit : ''), themed(s.color, theme)]); } }));
    return rows;
  };
  const rows = readout();
  return <div className={'dplot ' + theme} style={{ height: p.height ?? '100%' }}>
    {p.title && <div className="dplot-title">{p.title}</div>}
    <div ref={box} className="dplot-body" onWheel={onWheel}
      onMouseDown={(e) => { drag.current = { y: e.nativeEvent.offsetY, top: v.top, base: v.base, moved: false }; }}
      onMouseMove={(e) => { const y = e.nativeEvent.offsetY; setHover({ x: e.nativeEvent.offsetX, y }); const g = drag.current; if (g) { const dy = ((y - g.y) / (size.h - L.headH)) * (g.base - g.top); if (Math.abs(y - g.y) > 3) g.moved = true; if (g.moved) setView({ top: g.top - dy, base: g.base - dy }); } }}
      onMouseUp={(e) => { const g = drag.current; drag.current = null; if (g && !g.moved && p.onPick && res.current) { const x = e.nativeEvent.offsetX, y = e.nativeEvent.offsetY; if (y < L.headH) return; const ti = trackAt(x); let val: number | null = null; if (ti >= 0) { const s = p.tracks[ti].series[0]; if (s) { const [mn, mx] = res.current.scales[ti][0]; const f0 = (x - L.xs[ti]) / L.ws[ti]; const f = s.reverse ? 1 - f0 : f0; val = s.log ? Math.pow(10, Math.log10(mn) + f * (Math.log10(mx) - Math.log10(mn))) : mn + f * (mx - mn); } } p.onPick(dAt(y), ti, val); } }}
      onMouseLeave={() => { setHover(null); drag.current = null; }} onDoubleClick={() => setView(null)}>
      <canvas ref={cv} />
      {rows && hover && <div className="cursor-panel light" style={{ left: Math.min(hover.x + 14, Math.max(0, size.w - 170)), top: Math.min(hover.y + 10, size.h - rows.length * 14 - 16) }}>{rows.map(([k, val, c]) => <div key={k}><span style={{ color: c }}>{k}</span><span>{val}</span></div>)}</div>}
      <div className="plot-tools exp">{(['png', 'svg', 'pdf'] as const).map((k) => <button key={k} className="btn sm" onClick={(e) => { e.stopPropagation(); const H = 1100; const L2 = depthLayout(p, L.W); exportFigure(k, p.title ?? 'depth_plot', undefined, undefined, { w: L2.W, h: H, render: (ctx) => renderDepthPlot(ctx, L2.W, H, p, L2, v, null, 'light') }); }}>{k.toUpperCase()}</button>)}</div>
    </div>
  </div>;
}
