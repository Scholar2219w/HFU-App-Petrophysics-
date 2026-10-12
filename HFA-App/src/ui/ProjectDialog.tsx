import { useEffect, useState } from 'react';
import { S, useStore } from '../store/store';
import { Field, Modal } from './common';
import { deleteProject, duplicateProject, listProjects, loadProject, newProject } from '../project/project';
import type { ProjectMeta } from '../types';

const FIELDS: [keyof ProjectMeta, string][] = [['name', 'Project Name'], ['field', 'Field'], ['basin', 'Basin'], ['formation', 'Formation'], ['operator', 'Operator'], ['region', 'Region'], ['analyst', 'Analyst'], ['date', 'Date']];

export function ProjectProps({ mode, onClose }: { mode: 'new' | 'edit'; onClose: () => void }) {
  const cur = useStore((s) => s.project);
  const [p, setP] = useState<ProjectMeta>(mode === 'edit' ? cur : { ...cur, name: 'New Project', field: '', basin: '', formation: '', operator: '', region: '', analyst: cur.analyst, notes: '', date: new Date().toISOString().slice(0, 10) });
  const ok = () => {
    if (mode === 'new') { if (S().dirty && S().wells.length && !confirm('Discard unsaved changes in the current project?')) return; newProject(p); }
    else { S().set({ project: p, dirty: true }); S().log('Updated project properties'); }
    onClose();
  };
  return <Modal title={mode === 'new' ? 'New Project' : 'Project Properties'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" onClick={ok}>{mode === 'new' ? 'Create' : 'Apply'}</button></>}>
    {FIELDS.map(([k, l]) => <Field key={k} label={l}><input type={k === 'date' ? 'date' : 'text'} value={String(p[k] ?? '')} onChange={(e) => setP({ ...p, [k]: e.target.value })} /></Field>)}
    <Field label="Notes"><textarea rows={4} value={p.notes} onChange={(e) => setP({ ...p, notes: e.target.value })} /></Field>
    <div className="hint">Projects are stored locally in this browser (IndexedDB). Raw LAS/DLIS files are not stored — only normalised curves, calculated curves, depth shifts, HFU sets, models and settings.</div>
  </Modal>;
}

export function OpenProject({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<(ProjectMeta & { _wells?: number })[]>([]);
  const refresh = () => listProjects().then(setList);
  useEffect(() => { refresh(); }, []);
  return <Modal title="Open Project (local)" onClose={onClose} width={720}>
    {list.length ? <table className="t"><thead><tr><th>Name</th><th>Field</th><th>Wells</th><th>Saved</th><th /></tr></thead><tbody>
      {list.map((p) => <tr key={p.id}><td><b>{p.name}</b></td><td>{p.field}</td><td className="num">{p._wells}</td><td>{p.savedAt?.slice(0, 16).replace('T', ' ')}</td>
        <td><button className="btn sm pri" onClick={async () => { try { await loadProject(p.id); onClose(); } catch (e: any) { S().notify('CRITICAL', e.message); } }}>Open</button>{' '}
          <button className="btn sm" onClick={async () => { const n = prompt('Name of the copy', p.name + ' (copy)'); if (n) { await duplicateProject(p.id, n); refresh(); S().log(`Duplicated project ${p.name} → ${n}`); } }}>Duplicate</button>{' '}
          <button className="btn sm danger" onClick={async () => { if (confirm(`Delete project "${p.name}" from local storage? This cannot be undone.`)) { await deleteProject(p.id); refresh(); } }}>Delete</button></td></tr>)}
    </tbody></table> : <div className="hint">No saved projects in this browser. Use Project → Save (Ctrl+S) first.</div>}
  </Modal>;
}
