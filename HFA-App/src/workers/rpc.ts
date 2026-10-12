// Main-thread side of the worker RPC. Workers are inlined into the single-file
// build (?worker&inline) so the app keeps working fully offline.
import WorkerCtor from './worker.ts?worker&inline';

type Pool = 'parse' | 'analysis';
const workers: Partial<Record<Pool, Worker>> = {};
const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; onProgress?: (p: number) => void }>();
let seq = 0;

function get(pool: Pool): Worker {
  if (workers[pool]) return workers[pool]!;
  const w = new WorkerCtor();
  w.onmessage = (e) => {
    const { id, ok, res, err, progress } = e.data; const p = pending.get(id); if (!p) return;
    if (progress !== undefined) { p.onProgress?.(progress); return; }
    pending.delete(id); ok ? p.res(res) : p.rej(new Error(err));
  };
  w.onerror = (e) => { for (const [id, p] of pending) { p.rej(new Error(`Worker error: ${e.message ?? 'the browser blocked or failed to start the compute worker (check that scripts are allowed for this page)'}`)); pending.delete(id); } };
  workers[pool] = w; return w;
}

export function call<T = any>(pool: Pool, fn: string, args: any[], opts: { transfer?: Transferable[]; onProgress?: (p: number) => void } = {}): Promise<T> {
  const id = ++seq;
  return new Promise<T>((res, rej) => {
    pending.set(id, { res, rej, onProgress: opts.onProgress });
    get(pool).postMessage({ id, fn, args }, opts.transfer ?? []);
  });
}
