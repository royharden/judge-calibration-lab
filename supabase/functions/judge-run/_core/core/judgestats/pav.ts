// PAV remap comparator fit (PLAN.md §3.6).
// Isotonic (non-decreasing) fit of judge level index -> mean human level index, weighted by
// the number of items per judge level, fitted on the BASELINE rubric's DEV verdicts only.
//   1. per seen judge level j: weight w_j = item count, y_j = mean of the items' mean-human values;
//   2. weighted pool-adjacent-violators over seen levels in ascending order;
//   3. each fitted value rounded HALF-DOWN to the nearest index (x.5 -> x), clamped to [0, K-1];
//   4. judge levels never seen on dev carry the nearest LOWER level's mapped value, else the
//      nearest UPPER one (keeps the map monotone and total).
// Rounding and the fill are monotone operations, so the final map is non-decreasing.

import type { Reason, Result } from '../result.ts';
import { fail, ok } from '../result.ts';
import { assertLevelCount } from './confusion.ts';

export const PAV_ALGO_VERSION = 'weighted-pav-halfdown-fill-lower/v1';

export type PavPoint = {
  /** Judge level index 0..K-1. */
  judge: number;
  /** Mean human level index for the same item (may be fractional). */
  human: number;
};

export type PavMap = {
  k: number;
  /** map[judgeIndex] = remapped index (total, monotone non-decreasing). */
  map: number[];
  /** Raw isotonic fitted value per level; null for levels unseen on dev. */
  fitted: (number | null)[];
  /** Item count per judge level on the fitting data. */
  weights: number[];
};

/** Nearest integer with exact halves rounded DOWN (tolerant to 1e-9 float noise). */
export function roundHalfDown(x: number): number {
  const f = Math.floor(x);
  return x - f > 0.5 + 1e-9 ? f + 1 : f;
}

/** Fit the monotone remap. Err('no_data') when there are no points. */
export function fitPav(points: readonly PavPoint[], k: number): Result<PavMap, Reason<'no_data'>> {
  assertLevelCount(k);
  if (points.length === 0) return fail('no_data', 'PAV fit needs at least one dev verdict');

  const sumY = new Array<number>(k).fill(0);
  const weights = new Array<number>(k).fill(0);
  for (const p of points) {
    if (!Number.isInteger(p.judge) || p.judge < 0 || p.judge >= k) {
      throw new RangeError(`fitPav: judge index ${String(p.judge)} not in [0, ${k})`);
    }
    if (!Number.isFinite(p.human)) throw new RangeError('fitPav: human value must be finite');
    sumY[p.judge] = sumY[p.judge]! + p.human;
    weights[p.judge] = weights[p.judge]! + 1;
  }

  // Weighted PAV over seen levels: each block holds (sum of w*y, sum of w, member levels).
  type Block = { wy: number; w: number; levels: number[] };
  const stack: Block[] = [];
  for (let j = 0; j < k; j++) {
    const w = weights[j]!;
    if (w === 0) continue;
    stack.push({ wy: sumY[j]!, w, levels: [j] });
    while (stack.length >= 2) {
      const last = stack[stack.length - 1]!;
      const prev = stack[stack.length - 2]!;
      if (prev.wy / prev.w <= last.wy / last.w) break;
      stack.splice(stack.length - 2, 2, { wy: prev.wy + last.wy, w: prev.w + last.w, levels: [...prev.levels, ...last.levels] });
    }
  }

  const fitted: (number | null)[] = new Array<number | null>(k).fill(null);
  for (const b of stack) for (const j of b.levels) fitted[j] = b.wy / b.w;

  // Round half-down and clamp the seen levels.
  const mapped: (number | null)[] = fitted.map((f) => (f === null ? null : Math.min(k - 1, Math.max(0, roundHalfDown(f)))));

  // Fill unseen levels: nearest lower mapped value, else nearest upper.
  const map = new Array<number>(k).fill(0);
  let lastSeen: number | null = null;
  for (let j = 0; j < k; j++) {
    const m = mapped[j] ?? null;
    if (m !== null) lastSeen = m;
    if (lastSeen !== null) map[j] = m ?? lastSeen;
  }
  const firstSeen = mapped.find((m) => m !== null);
  if (firstSeen === undefined || firstSeen === null) return fail('no_data', 'PAV fit produced no seen level');
  for (let j = 0; j < k && mapped[j] === null; j++) map[j] = firstSeen;

  return ok({ k, map, fitted, weights });
}

/** Apply a fitted map to one judge level index. */
export function applyPav(pav: PavMap, judgeIndex: number): number {
  const m = pav.map[judgeIndex];
  if (m === undefined) throw new RangeError(`applyPav: index ${String(judgeIndex)} not in [0, ${pav.k})`);
  return m;
}
