// Wilson score interval (z = 1.96) — only for item-level proportions: consensus exact
// agreement (ties excluded), unusable rate, repeatability exact-match (PLAN.md §3.6).
// Never applied to correlated annotator rows.

import type { Stat } from '../types.ts';
import { undef, value } from './undefined.ts';

export const WILSON_Z95 = 1.96;

export type ProportionInterval = {
  successes: number;
  n: number;
  point: Stat;
  lo: Stat;
  hi: Stat;
};

export function wilsonInterval(successes: number, n: number, z = WILSON_Z95): ProportionInterval {
  if (!Number.isInteger(n) || n < 0 || !Number.isInteger(successes) || successes < 0 || successes > n) {
    throw new RangeError(`wilsonInterval: need integers 0 <= successes <= n, got ${String(successes)}/${String(n)}`);
  }
  if (n === 0) {
    const u = undef('n = 0');
    return { successes, n, point: u, lo: u, hi: u };
  }
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    successes,
    n,
    point: value(p),
    lo: value(Math.max(0, centre - half)),
    hi: value(Math.min(1, centre + half)),
  };
}
