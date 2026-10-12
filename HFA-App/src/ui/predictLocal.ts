import type { RegressionModel, SubModel } from '../types';
import { buildDataset } from '../regression/prepare';
import { predictSub } from '../regression/engine';

/** In-sample predictions for plotting a sub-model (main thread; core-sized data). */
export function predictLocal(m: RegressionModel, s: SubModel) {
  try {
    const b = buildDataset(m.params.ds); const d = b.ds;
    const actual: number[] = [], pred: number[] = [], depth: number[] = [], group: number[] = [];
    const lim = Math.min(d.n, 20000);
    for (let i = 0; i < lim; i++) {
      if (m.groupBy === 'hfu' && d.group[i] !== s.groupId) continue;
      actual.push(d.y[i]); pred.push(predictSub(s, d.X, i * d.p)); depth.push(d.depth[i]); group.push(d.group[i]);
    }
    return { actual, pred, depth, group };
  } catch { return null; }
}
