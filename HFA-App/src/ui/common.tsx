import { RESERVOIR_KEY } from '../data-engine/zones';
import { useState, type ReactNode } from 'react';
import { useStore, activeWell } from '../store/store';
import type { Message } from '../types';

export function Box(p: { title: ReactNode; right?: ReactNode; children: ReactNode; style?: React.CSSProperties; bodyStyle?: React.CSSProperties; className?: string }) {
  return (
    <div className={'box ' + (p.className ?? '')} style={p.style}>
      <div className="bh">{p.title}{p.right && <div className="r">{p.right}</div>}</div>
      <div className="bb" style={p.bodyStyle}>{p.children}</div>
    </div>
  );
}
export function ModHead(p: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return <div className="mod-h"><h2>{p.title}</h2>{p.sub && <span className="sub">{p.sub}</span>}<div style={{ flex: 1 }} />{p.children}</div>;
}
export function Field(p: { label: ReactNode; children: ReactNode; w90?: boolean; title?: string }) {
  return <label className={'f' + (p.w90 ? ' w90' : '')} title={p.title}><span>{p.label}</span>{p.children}</label>;
}
export function Sel<T extends string>(p: { value: T; onChange: (v: T) => void; options: (T | { v: T; l: string; disabled?: boolean })[]; style?: React.CSSProperties; title?: string }) {
  return (
    <select value={p.value} onChange={(e) => p.onChange(e.target.value as T)} style={p.style} title={p.title}>
      {p.options.map((o) => (typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.v} value={o.v} disabled={o.disabled}>{o.l}</option>))}
    </select>
  );
}
export function Num(p: { value: number | undefined; onChange: (v: number) => void; step?: number; style?: React.CSSProperties; placeholder?: string }) {
  const [txt, setTxt] = useState<string | null>(null);
  return <input type="number" step={p.step ?? 'any'} style={p.style} placeholder={p.placeholder}
    value={txt ?? (p.value === undefined || Number.isNaN(p.value) ? '' : String(p.value))}
    onChange={(e) => { setTxt(e.target.value); const v = parseFloat(e.target.value); if (!Number.isNaN(v)) p.onChange(v); }}
    onBlur={() => setTxt(null)} />;
}
export function Msgs({ items }: { items: (Message | { level: Message['level']; text: string })[] }) {
  if (!items.length) return null;
  return <div className="msgs">{items.map((m, i) => <div key={i} className={'msg ' + m.level}><b>{m.level}</b>{m.text}</div>)}</div>;
}
export function Tabs<T extends string>(p: { value: T; onChange: (v: T) => void; tabs: { v: T; l: string }[] }) {
  return <div className="tabs">{p.tabs.map((t) => <button key={t.v} className={p.value === t.v ? 'on' : ''} onClick={() => p.onChange(t.v)}>{t.l}</button>)}</div>;
}
export function Modal(p: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className="modal" style={{ width: p.width }}>
        <div className="mh"><span>{p.title}</span><button className="btn sm" onClick={p.onClose}>✕</button></div>
        <div className="mb">{p.children}</div>
        {p.footer && <div className="mf">{p.footer}</div>}
      </div>
    </div>
  );
}
export function WellPicker({ value, onChange, allowAll }: { value?: string; onChange: (id: string) => void; allowAll?: boolean }) {
  const wells = useStore((s) => s.wells);
  return <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
    {allowAll && <option value="__all">All wells</option>}
    {wells.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
  </select>;
}
export function useActiveWell() { return useStore((s) => activeWell(s)); }
export function CurvePicker({ wellId, value, onChange, allowNone, filter, style }: { wellId?: string; value?: string; onChange: (m: string) => void; allowNone?: string; filter?: (m: string) => boolean; style?: React.CSSProperties }) {
  const w = useStore((s) => s.wells.find((x) => x.id === wellId));
  const names = (w?.curves ?? []).map((c) => c.mnemonic).filter((m) => !filter || filter(m));
  return <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} style={style}>
    {allowNone !== undefined && <option value="">{allowNone}</option>}
    {value && !names.includes(value) && <option value={value}>{value} (missing)</option>}
    {names.map((m) => <option key={m} value={m}>{m}</option>)}
  </select>;
}
export function Empty({ children }: { children: ReactNode }) { return <div className="hint" style={{ padding: 16 }}>{children}</div>; }
export function Kv({ rows }: { rows: [ReactNode, ReactNode][] }) { return <div className="kv">{rows.map(([k, v], i) => [<span key={'k' + i}>{k}</span>, <span key={'v' + i}>{v}</span>])}</div>; }

/** Global analysis scope (reservoir interval(s) / formation / whole well). */
export function ZoneSelect({ label = true }: { label?: boolean }) {
  const zone = useStore((s) => s.zone); const tops = useStore((s) => s.tops); const res = useStore((s) => s.reservoirs);
  const names = [...new Set(tops.map((t) => t.name))];
  const wells = useStore((s) => s.wells);
  return <span className="row" style={{ gap: 4 }}>{label && <span className="hint">Scope</span>}<select value={zone} onChange={(e) => { useStore.getState().set({ zone: e.target.value }); }} title="Analysis scope — reservoir interval(s), a formation, or the whole well" className={zone === RESERVOIR_KEY || zone.startsWith('RES:') ? 'scope-res' : ''}>
    <option value="">Whole well</option>
    {res.length > 0 && <optgroup label="Reservoir"><option value={RESERVOIR_KEY}>★ Reservoir intervals ({res.filter((r) => r.active).length})</option>
      {res.map((r) => <option key={r.id} value={'RES:' + r.id}>{wells.length > 1 ? (wells.find((w) => w.id === r.wellId)?.name ?? '') + ' · ' : ''}{r.name} ({r.top}–{r.base})</option>)}</optgroup>}
    {names.length > 0 && <optgroup label="Formations">{names.map((n) => <option key={n}>{n}</option>)}</optgroup>}
    {zone && zone !== RESERVOIR_KEY && !zone.startsWith('RES:') && !names.includes(zone) && <option value={zone}>{zone} (missing)</option>}
  </select></span>;
}
export function download(data: any, name: string, type = "application/octet-stream") {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
