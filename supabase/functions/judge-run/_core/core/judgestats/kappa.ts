// Quadratic weighted kappa (PLAN.md §3.6).
//   w(i,j) = (i - j)^2 / (K - 1)^2
//   O(i,j) = observed counts, E(i,j) = row_i * col_j / n
//   kappa  = 1 - sum(w * O) / sum(w * E)
// Undefined (never 0 by default) when:
//   1. n < 2;
//   2. the expected weighted disagreement sum(w * E) is 0 (e.g. both raters constant
//      at the same level);
//   3. either rater's marginal is constant (only one level used) — the formula would
//      otherwise return exactly 0, which is the constant-judge trap.

import type { Stat } from '../types.ts';
import { colMarginals, confusionMatrix, rowMarginals, type ConfusionMatrix } from './confusion.ts';
import { undef, value } from './undefined.ts';

export const KAPPA_UNDEFINED = {
  tooFew: 'n < 2',
  zeroExpected: 'expected disagreement is 0',
  constantMarginal: 'constant rater marginal',
} as const;

/** QWK from an existing confusion matrix (rows = rater A, cols = rater B). */
export function kappaFromConfusion(m: ConfusionMatrix): Stat {
  const { k, counts, n } = m;
  if (n < 2) return undef(KAPPA_UNDEFINED.tooFew);

  const row = rowMarginals(m);
  const col = colMarginals(m);
  const scale = (k - 1) * (k - 1);

  let observed = 0;
  let expected = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const w = ((i - j) * (i - j)) / scale;
      observed += w * counts[i]![j]!;
      expected += (w * row[i]! * col[j]!) / n;
    }
  }

  if (expected === 0) return undef(KAPPA_UNDEFINED.zeroExpected);
  const usedRow = row.filter((c) => c > 0).length;
  const usedCol = col.filter((c) => c > 0).length;
  if (usedRow < 2 || usedCol < 2) return undef(KAPPA_UNDEFINED.constantMarginal);

  return value(1 - observed / expected);
}

/**
 * QWK of two aligned score arrays (level indices 0..k-1; a[i] and b[i] rate the same item).
 * Throws RangeError on contract violations (length mismatch, non-index scores, k < 2).
 */
export function quadraticWeightedKappa(a: readonly number[], b: readonly number[], k: number): Stat {
  return kappaFromConfusion(confusionMatrix(a, b, k));
}

/** Short alias. */
export const qwk = quadraticWeightedKappa;
