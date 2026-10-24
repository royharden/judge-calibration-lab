import { describe, expect, it } from 'vitest';
import { KAPPA_UNDEFINED, kappaFromConfusion, quadraticWeightedKappa } from '../../../src/core/judgestats/kappa.ts';
import { confusionMatrix } from '../../../src/core/judgestats/confusion.ts';
import type { Stat } from '../../../src/core/types.ts';

function num(s: Stat): number {
  if (s.kind !== 'value') throw new Error(`expected a defined stat, got undefined (${s.reason})`);
  return s.value;
}

describe('quadraticWeightedKappa — hand-computed vectors', () => {
  it('3-level vector: kappa = 0.75', () => {
    // K = 3, weights w(i,j) = (i-j)^2 / (K-1)^2 = (i-j)^2 / 4:
    //   w = [[0, .25, 1], [.25, 0, .25], [1, .25, 0]]
    // a = [0,0,1,1,2,2], b = [0,1,1,2,2,2], n = 6
    // Observed counts O (rows a, cols b):
    //   O[0][0]=1, O[0][1]=1, O[1][1]=1, O[1][2]=1, O[2][2]=2
    //   sum(w*O) = .25*1 (0,1) + .25*1 (1,2) = 0.5
    // Marginals: row(a) = [2,2,2], col(b) = [1,2,3]
    // Expected E[i][j] = row_i * col_j / 6 = col_j / 3  => every row is [1/3, 2/3, 1]
    //   row 0: 0*1/3 + .25*2/3 + 1*1   = 1/6 + 1  = 7/6
    //   row 1: .25*1/3 + 0*2/3 + .25*1 = 1/12+1/4 = 1/3
    //   row 2: 1*1/3 + .25*2/3 + 0*1   = 1/3 + 1/6 = 1/2
    //   sum(w*E) = 7/6 + 2/6 + 3/6 = 2
    // kappa = 1 - 0.5 / 2 = 0.75
    const k = quadraticWeightedKappa([0, 0, 1, 1, 2, 2], [0, 1, 1, 2, 2, 2], 3);
    expect(num(k)).toBeCloseTo(0.75, 12);
  });

  it('5-level vector: kappa = 15/17', () => {
    // K = 5, w = (i-j)^2 / 16. Work with unnormalised d^2 = (i-j)^2 (the 1/16 cancels).
    // a = [0,1,2,3,4,0,2,4], b = [0,1,2,4,4,1,1,3], n = 8
    // Pairs: (0,0) (1,1) (2,2) (3,4) (4,4) (0,1) (2,1) (4,3) -> four pairs off by one
    //   sum(d^2 * O) = 4
    // Marginals: row(a) = [2,1,2,1,2], col(b) = [1,3,1,1,2]
    // sum_ij r_i c_j (i-j)^2 = (sum c)(sum r_i i^2) - 2(sum r_i i)(sum c_j j) + (sum r)(sum c_j j^2)
    //   sum r_i i = 0+1+4+3+8 = 16,  sum r_i i^2 = 0+1+8+9+32 = 50
    //   sum c_j j = 0+3+2+3+8 = 16,  sum c_j j^2 = 0+3+4+9+32 = 48
    //   = 8*50 - 2*16*16 + 8*48 = 400 - 512 + 384 = 272
    //   sum(d^2 * E) = 272 / n = 34
    // kappa = 1 - 4/34 = 15/17 ~= 0.882353
    const k = quadraticWeightedKappa([0, 1, 2, 3, 4, 0, 2, 4], [0, 1, 2, 4, 4, 1, 1, 3], 5);
    expect(num(k)).toBeCloseTo(15 / 17, 12);
  });

  it('perfect agreement with varied levels = 1', () => {
    expect(num(quadraticWeightedKappa([0, 1, 2, 3, 4], [0, 1, 2, 3, 4], 5))).toBeCloseTo(1, 12);
  });

  it('is symmetric in its two raters', () => {
    const a = [0, 1, 2, 3, 4, 0, 2, 4];
    const b = [0, 1, 2, 4, 4, 1, 1, 3];
    expect(num(quadraticWeightedKappa(a, b, 5))).toBeCloseTo(num(quadraticWeightedKappa(b, a, 5)), 12);
  });

  it('total reversal is negative', () => {
    expect(num(quadraticWeightedKappa([0, 1, 2], [2, 1, 0], 3))).toBeLessThan(0);
  });
});

describe('quadraticWeightedKappa — undefined conditions (never 0)', () => {
  it('n < 2 => undefined', () => {
    expect(quadraticWeightedKappa([], [], 5)).toEqual({ kind: 'undefined', reason: KAPPA_UNDEFINED.tooFew });
    expect(quadraticWeightedKappa([2], [2], 5)).toEqual({ kind: 'undefined', reason: KAPPA_UNDEFINED.tooFew });
  });

  it('constant judge against varied humans => undefined (the formula alone would give exactly 0)', () => {
    const k = quadraticWeightedKappa([2, 2, 2, 2, 2], [0, 1, 2, 3, 4], 5);
    expect(k).toEqual({ kind: 'undefined', reason: KAPPA_UNDEFINED.constantMarginal });
  });

  it('constant humans against a varied judge => undefined', () => {
    const k = quadraticWeightedKappa([0, 1, 2, 3], [1, 1, 1, 1], 5);
    expect(k).toEqual({ kind: 'undefined', reason: KAPPA_UNDEFINED.constantMarginal });
  });

  it('both raters constant at the same level => zero expected disagreement => undefined (not 1)', () => {
    const k = quadraticWeightedKappa([3, 3, 3], [3, 3, 3], 5);
    expect(k).toEqual({ kind: 'undefined', reason: KAPPA_UNDEFINED.zeroExpected });
  });

  it('both constant at different levels => undefined (constant marginal)', () => {
    const k = quadraticWeightedKappa([1, 1, 1], [3, 3, 3], 5);
    expect(k).toEqual({ kind: 'undefined', reason: KAPPA_UNDEFINED.constantMarginal });
  });
});

describe('quadraticWeightedKappa — contract checks', () => {
  it('throws on length mismatch, non-index scores and K < 2', () => {
    expect(() => quadraticWeightedKappa([0, 1], [0], 3)).toThrow(RangeError);
    expect(() => quadraticWeightedKappa([0, 3], [0, 1], 3)).toThrow(RangeError);
    expect(() => quadraticWeightedKappa([0, 1.5], [0, 1], 3)).toThrow(RangeError);
    expect(() => quadraticWeightedKappa([0, 0], [0, 0], 1)).toThrow(RangeError);
  });

  it('kappaFromConfusion matches the array form', () => {
    const a = [0, 0, 1, 1, 2, 2];
    const b = [0, 1, 1, 2, 2, 2];
    expect(kappaFromConfusion(confusionMatrix(a, b, 3))).toEqual(quadraticWeightedKappa(a, b, 3));
  });
});
