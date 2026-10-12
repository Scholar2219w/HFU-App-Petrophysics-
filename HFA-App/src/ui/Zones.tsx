import { useState } from 'react';
import { S, useStore } from '../store/store';
import { zonesForWell } from '../data-engine/zones';
import { importBus } from './ImportManager';
import { Box, Empty, ModHead, Num, ZoneSelect, useActiveWell } from './common';
import { fmt, hfuColor, uid } from '../util/num';

export function Zones() {
  const well = useActiveWell(); const tops = useStore((s) => s.tops); const wells = useStore((s) => s.wells);
  const [name, setName] = useState(''); const [md, setMd] = useState<number | undefined>(undefined);
  if (!well) return <><ModHead title="Formations & Zones" /><Empty>No well.</Empty></>;
  const wt = tops.filter((t) => t.wellId === well.id).sort((a, b) => a.md - b.md);
  const upd = (id: string, p: Partial<(typeof tops)[number]>) => S().set({ tops: tops.map((t) => (t.id === id ? { ...t, ...p } : t)) });
  const add = () => { if (!name || md === undefined) return; S().set({ tops: [...tops, { id: uid('t_'), wellId: well.id, name, md, color: hfuColor((wt.length % 8) + 2) }] }); S().log(`Added top "${name}" at ${md} ${well.depthUnit} (${well.name})`); setName(''); setMd(undefined); };
  const zones = zonesForWell(well.id);
  return <>
    <ModHead title="Formation / Zone Management" sub="Tops define zones (top → next top). The global zone filter applies to QC, crossplots, reservoir quality, multi-well, transitions, data table and regression datasets.">
      <ZoneSelect /><button className="btn" onClick={() => { S().go('import'); setTimeout(() => importBus.open('tops'), 60); }}>Import tops (CSV / XLSX / LAS)…</button>
    </ModHead>
    <div className="mod-b">
      <div className="grid2">
        <Box title={`Tops — ${well.name}`}>
          <table className="t"><thead><tr><th>Top / formation</th><th>MD ({well.depthUnit})</th><th>TVD</th><th>TVDSS</th><th>Colour</th><th /></tr></thead><tbody>
            {wt.map((t) => <tr key={t.id}>
              <td><input value={t.name} onChange={(e) => upd(t.id, { name: e.target.value })} style={{ width: 170 }} /></td>
              <td><Num value={t.md} onChange={(v) => upd(t.id, { md: v })} /></td><td><Num value={t.tvd} onChange={(v) => upd(t.id, { tvd: v })} /></td><td><Num value={t.tvdss} onChange={(v) => upd(t.id, { tvdss: v })} /></td>
              <td><input type="color" value={t.color.slice(0, 7)} onChange={(e) => upd(t.id, { color: e.target.value })} style={{ width: 26, height: 20, padding: 0, border: 0 }} /></td>
              <td><button className="btn sm danger" onClick={() => { S().set({ tops: tops.filter((x) => x.id !== t.id) }); S().log(`Deleted top "${t.name}" (${well.name})`, 'warn'); }}>✕</button></td></tr>)}
            <tr><td><input value={name} onChange={(e) => setName(e.target.value)} placeholder="new top name" style={{ width: 170 }} /></td><td><Num value={md} onChange={setMd} /></td><td colSpan={3} /><td><button className="btn sm pri" onClick={add}>Add</button></td></tr>
          </tbody></table>
          <div className="hint">Tip: in the log viewer, the cursor panel shows the current zone. Changes are undoable (Ctrl+Z).</div>
        </Box>
        <Box title="Zones (derived)">
          <table className="t"><thead><tr><th>Zone</th><th>Top</th><th>Base</th><th>Thickness</th></tr></thead><tbody>
            {zones.map((z) => <tr key={z.name + z.top}><td>{z.name}</td><td className="num">{fmt(z.top, 6)}</td><td className="num">{fmt(z.base, 6)}</td><td className="num">{fmt(z.base - z.top, 4)}</td></tr>)}
          </tbody></table>
          <div className="hint" style={{ marginTop: 6 }}>Wells with tops: {wells.map((w) => `${w.name} (${tops.filter((t) => t.wellId === w.id).length})`).join(' · ')}</div>
        </Box>
      </div>
    </div>
  </>;
}
