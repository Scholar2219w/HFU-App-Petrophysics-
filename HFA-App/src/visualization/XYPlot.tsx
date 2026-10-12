// Generic canvas XY plot: scatter / line / bars / step, log axes, lasso,
// hexbin & density contours, hover read-out. Renders only what is visible.
import { useEffect, useRef, useState } from 'react';
import { isNum, niceTicks, fmt } from '../util/num';
import { exportFigure } from '../export/io';

export interface Series {
  kind: 'scatter' | 'line' | 'bars' | 'step';
  x: ArrayLike<number>; y: ArrayLike<number>;
  color?: string; colors?: string[]; size?: number; width?: number; label?: string; dash?: boolean; alpha?: number;
  symbol?: Symbol; symbols?: Symbol[];
  selectable?: boolean; highlight?: Set<number>;
  tip?: (i: number) => string;
  barWidth?: number;
}
export type Symbol = 'circle' | 'square' | 'triangle' | 'diamond' | 'cross';
export interface XYPlotProps {
  series: Series[];
  logX?: boolean; logY?: boolean; invertY?: boolean;
  xLabel?: string; yLabel?: string; title?: string;
  xRange?: [number, number]; yRange?: [number, number];
  density?: 'none' | 'hexbin' | 'contours';
  onLasso?: (sel: number[]) => void;
  notes?: string[];
  legend?: { label: string; color: string; symbol?: Symbol }[];
  height?: number | string;
  refLines?: { x1: number; y1: number; x2: number; y2: number; color?: string; dash?: boolean; label?: string }[];
  onClickPoint?: (seriesIdx: number, i: number) => void;
  light?: boolean;              // conventional white crossplot (Techlog look)
}

const M = { l: 52, r: 10, t: 18, b: 32 };

function ext(series: Series[], key: 'x' | 'y', log: boolean): [number, number] {
  let mn = Infinity, mx = -Infinity;
  for (const s of series) { const a = s[key]; for (let i = 0; i < a.length; i++) { const v = a[i]; if (!isNum(v) || (log && v <= 0)) continue; if (v < mn) mn = v; if (v > mx) mx = v; } }
  if (mn === Infinity) return log ? [0.1, 10] : [0, 1];
  if (mn === mx) { if (log) return [mn / 2, mx * 2]; const d = Math.abs(mn) * 0.1 || 1; return [mn - d, mx + d]; }
  if (log) { return [Math.pow(10, Math.floor(Math.log10(mn) * 10) / 10), Math.pow(10, Math.ceil(Math.log10(mx) * 10) / 10)]; }
  const pad = (mx - mn) * 0.04; return [mn - pad, mx + pad];
}
function logTicks(a: number, b: number) {
  const out: { v: number; major: boolean }[] = [];
  for (let e = Math.floor(Math.log10(a)); e <= Math.ceil(Math.log10(b)); e++) for (let m = 1; m < 10; m++) { const v = m * Math.pow(10, e); if (v >= a * 0.999 && v <= b * 1.001) out.push({ v, major: m === 1 }); }
  return out;
}
export function drawSymbol(ctx: CanvasRenderingContext2D, sym: Symbol | undefined, x: number, y: number, r: number) {
  ctx.beginPath();
  switch (sym) {
    case 'square': ctx.rect(x - r, y - r, 2 * r, 2 * r); break;
    case 'triangle': ctx.moveTo(x, y - r * 1.2); ctx.lineTo(x + r * 1.1, y + r * 0.8); ctx.lineTo(x - r * 1.1, y + r * 0.8); ctx.closePath(); break;
    case 'diamond': ctx.moveTo(x, y - r * 1.3); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r * 1.3); ctx.lineTo(x - r, y); ctx.closePath(); break;
    case 'cross': ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); break;
    default: ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}
const ramp = (t: number) => { // perceptual-ish dark→bright ramp for density
  const c = [[20, 30, 60], [30, 90, 160], [40, 170, 180], [180, 220, 90], [250, 240, 150]];
  const x = Math.max(0, Math.min(0.9999, t)) * (c.length - 1); const i = Math.floor(x), f = x - i;
  const m = c[i].map((v, k) => Math.round(v + (c[i + 1][k] - v) * f)); return `rgb(${m[0]},${m[1]},${m[2]})`;
};

export function renderXY(ctx: CanvasRenderingContext2D, w: number, h: number, p: XYPlotProps, lassoPts: [number, number][] = []) {
  const L_ = !!p.light; const P = L_ ? { bg: '#ffffff', txt: '#333', maj: '#cfcfcf', min: '#ececec', bd: '#555', title: '#111', lab: '#222', ref: '#666', note: 'rgba(255,255,255,.9)', noteTx: '#333' } : { bg: '#0f1318', txt: '#8a95a5', maj: '#26303c', min: '#171d25', bd: '#3a4452', title: '#cfd6df', lab: '#aab3c0', ref: '#aaa', note: 'rgba(13,16,20,.85)', noteTx: '#e8d9a0' };
  ctx.fillStyle = P.bg; ctx.fillRect(0, 0, w, h);
  const [x0, x1] = p.xRange ?? ext(p.series, 'x', !!p.logX); const [y0, y1] = p.yRange ?? ext(p.series, 'y', !!p.logY);
  const pw = w - M.l - M.r, ph = h - M.t - M.b;
  const lx = (v: number) => (p.logX ? Math.log10(v) : v), ly = (v: number) => (p.logY ? Math.log10(v) : v);
  const X = (v: number) => M.l + ((lx(v) - lx(x0)) / (lx(x1) - lx(x0))) * pw;
  const Y = (v: number) => (p.invertY ? M.t + ((ly(v) - ly(y0)) / (ly(y1) - ly(y0))) * ph : M.t + ph - ((ly(v) - ly(y0)) / (ly(y1) - ly(y0))) * ph);
  const iX = (px: number) => { const t = lx(x0) + ((px - M.l) / pw) * (lx(x1) - lx(x0)); return p.logX ? Math.pow(10, t) : t; };
  const iY = (py: number) => { const f = p.invertY ? (py - M.t) / ph : (M.t + ph - py) / ph; const t = ly(y0) + f * (ly(y1) - ly(y0)); return p.logY ? Math.pow(10, t) : t; };
  const T = { X, Y, iX, iY };
  // grid + ticks
  ctx.font = '10px Consolas, monospace'; ctx.fillStyle = P.txt; ctx.strokeStyle = P.maj; ctx.lineWidth = 1;
  const xt = p.logX ? logTicks(x0, x1) : niceTicks(x0, x1, Math.max(2, Math.floor(pw / 70))).map((v) => ({ v, major: true }));
  const yt = p.logY ? logTicks(y0, y1) : niceTicks(y0, y1, Math.max(2, Math.floor(ph / 40))).map((v) => ({ v, major: true }));
  ctx.textAlign = 'center';
  for (const t of xt) { const px = Math.round(X(t.v)) + 0.5; ctx.strokeStyle = t.major ? P.maj : P.min; ctx.beginPath(); ctx.moveTo(px, M.t); ctx.lineTo(px, M.t + ph); ctx.stroke(); if (t.major) ctx.fillText(fmt(t.v, 3), px, M.t + ph + 12); }
  ctx.textAlign = 'right';
  for (const t of yt) { const py = Math.round(Y(t.v)) + 0.5; ctx.strokeStyle = t.major ? P.maj : P.min; ctx.beginPath(); ctx.moveTo(M.l, py); ctx.lineTo(M.l + pw, py); ctx.stroke(); if (t.major) ctx.fillText(fmt(t.v, 3), M.l - 4, py + 3); }
  ctx.strokeStyle = P.bd; ctx.strokeRect(M.l + 0.5, M.t + 0.5, pw, ph);
  ctx.fillStyle = P.lab; ctx.textAlign = 'center'; ctx.font = '11px Segoe UI, sans-serif';
  if (p.xLabel) ctx.fillText(p.xLabel, M.l + pw / 2, h - 4);
  if (p.yLabel) { ctx.save(); ctx.translate(11, M.t + ph / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(p.yLabel, 0, 0); ctx.restore(); }
  if (p.title) { ctx.textAlign = 'left'; ctx.fillStyle = P.title; ctx.fillText(p.title, M.l + 2, 12); }
  ctx.save(); ctx.beginPath(); ctx.rect(M.l, M.t, pw, ph); ctx.clip();
  const ok = (xv: number, yv: number) => isNum(xv) && isNum(yv) && (!p.logX || xv > 0) && (!p.logY || yv > 0);
  // density layers (first selectable/scatter series)
  const ds = p.series.find((s) => s.kind === 'scatter');
  if (ds && p.density === 'hexbin') {
    const R = 7, dx = R * Math.sqrt(3), dy = R * 1.5; const bins = new Map<string, number>(); let mx = 0;
    for (let i = 0; i < ds.x.length; i++) { if (!ok(ds.x[i], ds.y[i])) continue; const px = X(ds.x[i]), py = Y(ds.y[i]); let r = Math.round(py / dy); const q = Math.round((px - (r & 1 ? dx / 2 : 0)) / dx); const k = q + ',' + r; const v = (bins.get(k) ?? 0) + 1; bins.set(k, v); if (v > mx) mx = v; }
    for (const [k, v] of bins) { const [q, r] = k.split(',').map(Number); const cx = q * dx + (r & 1 ? dx / 2 : 0), cy = r * dy; ctx.fillStyle = ramp(Math.log(1 + v) / Math.log(1 + mx)); ctx.beginPath(); for (let a = 0; a < 6; a++) { const ang = Math.PI / 6 + (a * Math.PI) / 3; ctx.lineTo(cx + R * Math.cos(ang), cy + R * Math.sin(ang)); } ctx.fill(); }
  }
  if (ds && p.density === 'contours') {
    const G = 64; const grid = new Float64Array(G * G);
    for (let i = 0; i < ds.x.length; i++) { if (!ok(ds.x[i], ds.y[i])) continue; const gx = Math.floor(((X(ds.x[i]) - M.l) / pw) * G), gy = Math.floor(((Y(ds.y[i]) - M.t) / ph) * G); if (gx >= 0 && gx < G && gy >= 0 && gy < G) grid[gy * G + gx]++; }
    const blur = (a: Float64Array) => { const o = new Float64Array(G * G); const k = [0.06, 0.24, 0.4, 0.24, 0.06]; for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) { let s = 0; for (let t = -2; t <= 2; t++) { const xx = x + t; if (xx >= 0 && xx < G) s += a[y * G + xx] * k[t + 2]; } o[y * G + x] = s; } const o2 = new Float64Array(G * G); for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) { let s = 0; for (let t = -2; t <= 2; t++) { const yy = y + t; if (yy >= 0 && yy < G) s += o[yy * G + x] * k[t + 2]; } o2[y * G + x] = s; } return o2; };
    const g2 = blur(blur(grid)); let mx = 0; for (const v of g2) if (v > mx) mx = v;
    const cw = pw / G, chh = ph / G;
    [0.1, 0.25, 0.45, 0.7].forEach((lvF, li) => {
      const lv = lvF * mx; ctx.strokeStyle = ramp(0.3 + li * 0.22); ctx.lineWidth = 1.2; ctx.beginPath();
      for (let y = 0; y < G - 1; y++) for (let x = 0; x < G - 1; x++) {
        const a = g2[y * G + x], b = g2[y * G + x + 1], c2 = g2[(y + 1) * G + x + 1], d = g2[(y + 1) * G + x];
        const idx = (a > lv ? 8 : 0) | (b > lv ? 4 : 0) | (c2 > lv ? 2 : 0) | (d > lv ? 1 : 0); if (idx === 0 || idx === 15) continue;
        const px = M.l + (x + 0.5) * cw, py = M.t + (y + 0.5) * chh;
        const e = (v1: number, v2: number) => (lv - v1) / (v2 - v1 || 1e-9);
        const top = [px + e(a, b) * cw, py], right = [px + cw, py + e(b, c2) * chh], bot = [px + e(d, c2) * cw, py + chh], left = [px, py + e(a, d) * chh];
        const segs: Record<number, number[][][]> = { 1: [[left, bot]], 2: [[bot, right]], 3: [[left, right]], 4: [[top, right]], 5: [[left, top], [bot, right]], 6: [[top, bot]], 7: [[left, top]], 8: [[left, top]], 9: [[top, bot]], 10: [[left, bot], [top, right]], 11: [[top, right]], 12: [[left, right]], 13: [[bot, right]], 14: [[left, bot]] };
        for (const [s1, s2] of segs[idx] ?? []) { ctx.moveTo(s1[0], s1[1]); ctx.lineTo(s2[0], s2[1]); }
      }
      ctx.stroke();
    });
  }
  for (const s of p.series) {
    const col = s.color ?? '#4ea1ff'; ctx.globalAlpha = s.alpha ?? 1;
    if (s.kind === 'scatter') {
      if (p.density === 'hexbin' && s === ds) continue;
      const r = s.size ?? 2.6;
      for (let i = 0; i < s.x.length; i++) {
        if (!ok(s.x[i], s.y[i])) continue; const px = X(s.x[i]), py = Y(s.y[i]);
        const cc = s.colors?.[i] ?? col; const sym = s.symbols?.[i] ?? s.symbol;
        drawSymbol(ctx, sym, px, py, r);
        if (sym === 'cross') { ctx.strokeStyle = cc; ctx.lineWidth = 1.2; ctx.stroke(); } else { ctx.fillStyle = cc; ctx.fill(); }
      }
      if (s.highlight?.size) { ctx.globalAlpha = 1; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.4; for (const i of s.highlight) { if (!ok(s.x[i], s.y[i])) continue; drawSymbol(ctx, 'circle', X(s.x[i]), Y(s.y[i]), r + 2.5); ctx.stroke(); } }
    } else if (s.kind === 'line' || s.kind === 'step') {
      ctx.strokeStyle = col; ctx.lineWidth = s.width ?? 1.4; ctx.setLineDash(s.dash ? [5, 4] : []); ctx.beginPath(); let pen = false; let py0 = 0;
      for (let i = 0; i < s.x.length; i++) {
        if (!ok(s.x[i], s.y[i])) { pen = false; continue; } const px = X(s.x[i]), py = Y(s.y[i]);
        if (!pen) { ctx.moveTo(px, py); pen = true; } else if (s.kind === 'step') { ctx.lineTo(px, py0); ctx.lineTo(px, py); } else ctx.lineTo(px, py); py0 = py;
      }
      ctx.stroke(); ctx.setLineDash([]);
    } else if (s.kind === 'bars') {
      const bw = s.barWidth ?? (s.x.length > 1 ? Math.abs(s.x[1] - s.x[0]) : 1);
      for (let i = 0; i < s.x.length; i++) { if (!isNum(s.y[i])) continue; const a = X(s.x[i] - bw / 2), b = X(s.x[i] + bw / 2); const yb = Y(p.logY ? y0 : Math.max(y0, 0)); const yt = Y(s.y[i]); ctx.fillStyle = s.colors?.[i] ?? col; ctx.fillRect(Math.min(a, b) + 0.5, Math.min(yb, yt), Math.max(1, Math.abs(b - a) - 1), Math.abs(yb - yt)); }
    }
    ctx.globalAlpha = 1;
  }
  for (const L of p.refLines ?? []) {
    ctx.strokeStyle = L.color ?? P.ref; ctx.lineWidth = 1; ctx.setLineDash(L.dash ? [4, 4] : []);
    ctx.beginPath(); ctx.moveTo(X(L.x1), Y(L.y1)); ctx.lineTo(X(L.x2), Y(L.y2)); ctx.stroke(); ctx.setLineDash([]);
    if (L.label) { ctx.fillStyle = L.color ?? P.ref; ctx.font = '10px Consolas, monospace'; ctx.textAlign = 'left'; ctx.fillText(L.label, X(L.x2) - 60, Y(L.y2) + 12); }
  }
  ctx.restore();
  // notes / legend
  const lines = [...(p.notes ?? [])];
  if (lines.length) {
    ctx.font = '10.5px Consolas, monospace'; const wmax = Math.max(...lines.map((l) => ctx.measureText(l).width));
    ctx.fillStyle = P.note; ctx.fillRect(M.l + 6, M.t + 6, wmax + 10, lines.length * 13 + 6);
    ctx.fillStyle = P.noteTx; ctx.textAlign = 'left'; lines.forEach((l, i) => ctx.fillText(l, M.l + 11, M.t + 18 + i * 13));
  }
  if (p.legend?.length) {
    ctx.font = '10.5px Segoe UI, sans-serif'; const lw = Math.max(...p.legend.map((l) => ctx.measureText(l.label).width)) + 24;
    const lx0 = M.l + pw - lw - 6, ly0 = M.t + 6; ctx.fillStyle = P.note; ctx.fillRect(lx0, ly0, lw, p.legend.length * 14 + 6);
    p.legend.forEach((l, i) => { ctx.fillStyle = l.color; drawSymbol(ctx, l.symbol, lx0 + 9, ly0 + 10 + i * 14, 3.5); ctx.fill(); ctx.fillStyle = P.title; ctx.textAlign = 'left'; ctx.fillText(l.label, lx0 + 18, ly0 + 14 + i * 14); });
  }
  if (lassoPts.length > 1) { ctx.strokeStyle = '#fff'; ctx.setLineDash([3, 3]); ctx.beginPath(); lassoPts.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b))); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]); }
  return T;
}

export function XYPlot(p: XYPlotProps) {
  const wrap = useRef<HTMLDivElement>(null); const cv = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 300, h: 200 });
  const [lasso, setLasso] = useState(false);
  const pts = useRef<[number, number][]>([]);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const tf = useRef<{ X: (v: number) => number; Y: (v: number) => number; iX: (px: number) => number; iY: (py: number) => number } | null>(null);

  useEffect(() => {
    const el = wrap.current!; const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const draw = () => {
    const c = cv.current; if (!c) return; const dpr = window.devicePixelRatio || 1;
    const { w, h } = size; if (w < 20 || h < 20) return;
    c.width = w * dpr; c.height = h * dpr; c.style.width = w + 'px'; c.style.height = h + 'px';
    const ctx = c.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tf.current = renderXY(ctx, w, h, p, pts.current);
  };
  useEffect(draw);

  const pos = (e: React.MouseEvent) => { const r = cv.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as [number, number]; };
  const onDown = (e: React.MouseEvent) => { if (!lasso) return; pts.current = [pos(e)]; };
  const onMove = (e: React.MouseEvent) => {
    const [mx, my] = pos(e);
    if (lasso && pts.current.length && e.buttons === 1) { pts.current.push([mx, my]); draw(); return; }
    const T = tf.current; if (!T) return;
    let best: { d: number; text: string } | null = null;
    p.series.forEach((s) => { if (s.kind !== 'scatter') return; for (let i = 0; i < s.x.length; i++) { const xv = s.x[i], yv = s.y[i]; if (!isNum(xv) || !isNum(yv)) continue; const d = Math.hypot(T.X(xv) - mx, T.Y(yv) - my); if (d < 6 && (!best || d < best.d)) best = { d, text: s.tip ? s.tip(i) : `${fmt(xv, 4)}, ${fmt(yv, 4)}` }; } });
    const b = best as { d: number; text: string } | null;
    setTip(b ? { x: mx, y: my, text: b.text } : { x: mx, y: my, text: `x ${fmt(T.iX(mx), 4)}  y ${fmt(T.iY(my), 4)}` });
  };
  const onUp = () => {
    if (!lasso || pts.current.length < 3) { pts.current = []; return; }
    const poly = pts.current; const T = tf.current!; const sel: number[] = [];
    const s = p.series.find((q) => q.selectable) ?? p.series[0];
    const inside = (x: number, y: number) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
    for (let i = 0; i < s.x.length; i++) if (isNum(s.x[i]) && isNum(s.y[i]) && inside(T.X(s.x[i]), T.Y(s.y[i]))) sel.push(i);
    pts.current = []; p.onLasso?.(sel); draw();
  };
  const onClick = (e: React.MouseEvent) => {
    if (lasso || !p.onClickPoint) return; const [mx, my] = pos(e); const T = tf.current!;
    p.series.forEach((s, si) => { if (s.kind !== 'scatter') return; for (let i = 0; i < s.x.length; i++) if (isNum(s.x[i]) && Math.hypot(T.X(s.x[i]) - mx, T.Y(s.y[i]) - my) < 5) { p.onClickPoint!(si, i); return; } });
  };
  return (
    <div ref={wrap} className="canvas-wrap" style={{ height: p.height ?? '100%' }}>
      <canvas ref={cv} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={() => setTip(null)} onClick={onClick} style={{ cursor: lasso ? 'crosshair' : 'default' }} />
      <div className="plot-tools exp" style={{ right: p.onLasso ? 70 : 4 }}>{(['png', 'svg', 'pdf'] as const).map((k) => <button key={k} className="btn sm" title={`Export ${k.toUpperCase()}`} onClick={() => exportFigure(k, p.title ?? 'crossplot', { p, w: size.w, h: size.h })}>{k.toUpperCase()}</button>)}</div>
      {p.onLasso && <div className="plot-tools"><button className={'btn sm' + (lasso ? ' on' : '')} title="Lasso selection (draw a polygon)" onClick={() => setLasso(!lasso)}>Lasso</button>{lasso && <button className="btn sm" onClick={() => p.onLasso?.([])}>Clear</button>}</div>}
      {tip && <div className="cursor-panel" style={{ left: Math.min(tip.x + 12, size.w - 180), top: tip.y + 12, minWidth: 0 }}>{tip.text.split('\n').map((l, i) => <div key={i}>{l}</div>)}</div>}
    </div>
  );
}
