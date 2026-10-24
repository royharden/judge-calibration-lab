// Hyndman–Fan type 7 quantile (R's default):
//   h = (n - 1) * p,  Q(p) = x[floor(h)] + (h - floor(h)) * (x[floor(h) + 1] - x[floor(h)])
// on the ascending-sorted sample. Used for bootstrap percentiles and lexical cut points.

import type { Stat } from '../types.ts';
import { undef, value } from './undefined.ts';

export const QUANTILE_ALGO_VERSION = 'hyndman-fan-type7/v1';

function assertP(p: number): void {
  if (!(p >= 0 && p <= 1)) throw new RangeError(`quantile p must be in [0, 1], got ${String(p)}`);
}

/** Type-7 quantile of an already ascending-sorted, non-empty array. Throws on empty input. */
export function quantile7Sorted(sorted: readonly number[], p: number): number {
  assertP(p);
  const n = sorted.length;
  if (n === 0) throw new RangeError('quantile7Sorted: empty sample');
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  const xlo = sorted[lo]!;
  const xhi = sorted[hi]!;
  return xlo + (h - lo) * (xhi - xlo);
}

/** Type-7 quantile of an unsorted sample (copied, not mutated); undefined when empty. */
export function quantile7(values: readonly number[], p: number): Stat {
  assertP(p);
  if (values.length === 0) return undef('empty sample');
  const sorted = values.slice().sort((a, b) => a - b);
  return value(quantile7Sorted(sorted, p));
}
