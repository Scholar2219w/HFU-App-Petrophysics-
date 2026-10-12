// Minimal IndexedDB wrapper — local-first persistence (nothing leaves the browser).
const DB = 'hfa-suite';
const STORES = ['arrays', 'projects', 'settings'] as const;
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return db().then((d) => new Promise<T>((res, rej) => {
    const t = d.transaction(store, mode); const s = t.objectStore(store);
    const r = fn(s) as IDBRequest<T> | undefined;
    t.oncomplete = () => res(r ? r.result : (undefined as any));
    t.onerror = () => rej(t.error);
  }));
}
export const idbAvailable = () => typeof indexedDB !== 'undefined';
export const idbGet = (k: string, store = 'arrays') => tx<any>(store, 'readonly', (s) => s.get(k)).catch(() => undefined);
export const idbPut = (k: string, v: any, store = 'arrays') => tx<any>(store, 'readwrite', (s) => s.put(v, k));
export const idbDel = (k: string, store = 'arrays') => tx<any>(store, 'readwrite', (s) => s.delete(k));
export const idbKeys = (store = 'arrays') => tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys()).catch(() => [] as IDBValidKey[]);
export async function idbDelPrefix(prefix: string, store = 'arrays') {
  const ks = (await idbKeys(store)) as string[];
  await Promise.all(ks.filter((k) => String(k).startsWith(prefix)).map((k) => idbDel(k, store)));
}
export async function idbCopyPrefix(from: string, to: string, store = 'arrays') {
  const ks = (await idbKeys(store)) as string[];
  for (const k of ks) if (String(k).startsWith(from)) { const v = await idbGet(k, store); await idbPut(to + String(k).slice(from.length), v, store); }
}
export async function idbEntriesPrefix(prefix: string, store = 'arrays') {
  const ks = ((await idbKeys(store)) as string[]).filter((k) => String(k).startsWith(prefix));
  const out: [string, any][] = [];
  for (const k of ks) out.push([k, await idbGet(k, store)]);
  return out;
}
