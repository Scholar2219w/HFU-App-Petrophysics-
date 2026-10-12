// Apache Parquet → table rows (worker side), via hyparquet (pure JS).
import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

export async function parquetRows(file: File, limit?: number): Promise<any[][]> {
  const buf = await file.arrayBuffer();
  const objs: Record<string, any>[] = await parquetReadObjects({ file: buf, compressors, ...(limit ? { rowEnd: limit } : {}) } as any);
  if (!objs.length) return [];
  const keys = Object.keys(objs[0]);
  const norm = (v: any) => (typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : v);
  return [keys, ...objs.map((o) => keys.map((k) => norm(o[k])))];
}
export const parseParquet = parquetRows;
