import { describe, expect, it } from 'vitest';
import { applyPav, fitPav, roundHalfDown, type PavPoint } from '../../../src/core/judgestats/pav.ts';
import { createPrng } from '../../../src/core/prng.ts';
import { unwrap } from '../../../src/core/result.ts';

describe('roundHalfDown', () => {
  it('rounds exact halves down and other values to nearest', () => {
    expect(roundHalfDown(1.5)).toBe(1);
    expect(roundHalfDown(2.5)).toBe(2);
    expect(roundHalfDown(1.5000000000001)).toBe(1); // float noise tolerated
    expect(roundHalfDown(1.6)).toBe(2);
    expect(roundHalfDown(1.4)).toBe(1);
    expect(roundHalfDown(3)).toBe(3);
  });
});

describe('fitPav', () => {
  it('known answer: pools the violating pair and rounds half-down', () => {
    // K = 4. Level means y = [0, 2, 1, 3] with weights [2, 1, 1, 2].
    // PAV: 0 | 2 > 1 violates -> pool (2*1 + 1*1) / 2 = 1.5 | 3  => fitted [0, 1.5, 1.5, 3]
    // half-down rounding => map [0, 1, 1, 3]
    const pts: PavPoint[] = [
      { judge: 0, human: 0 },
      { judge: 0, human: 0 },
      { judge: 1, human: 2 },
      { judge: 2, human: 1 },
      { judge: 3, human: 3 },
      { judge: 3, human: 3 },
    ];
    const r = unwrap(fitPav(pts, 4));
    expect(r.fitted).toEqual([0, 1.5, 1.5, 3]);
    expect(r.map).toEqual([0, 1, 1, 3]);
    expect(r.weights).toEqual([2, 1, 1, 2]);
  });

  it('weighting matters: a heavy level dominates the pooled value', () => {
    // level 0 mean 3 (weight 3), level 1 mean 0 (weight 1) -> pooled (9 + 0) / 4 = 2.25 -> 2
    const pts: PavPoint[] = [
      { judge: 0, human: 3 },
      { judge: 0, human: 3 },
      { judge: 0, human: 3 },
      { judge: 1, human: 0 },
    ];
    const r = unwrap(fitPav(pts, 4));
    expect(r.fitted[0]).toBeCloseTo(2.25, 12);
    expect(r.fitted[1]).toBeCloseTo(2.25, 12);
    expect(r.map.slice(0, 2)).toEqual([2, 2]);
  });

  it('unseen levels carry the nearest lower value, else the nearest upper', () => {
    // K = 5, seen levels 1 (-> 1) and 3 (-> 4) only.
    const r = unwrap(
      fitPav(
        [
          { judge: 1, human: 1 },
          { judge: 3, human: 4 },
        ],
        5,
      ),
    );
    expect(r.fitted).toEqual([null, 1, null, 4, null]);
    expect(r.map).toEqual([1, 1, 1, 4, 4]);
  });

  it('clamps to [0, K-1]', () => {
    const r = unwrap(
      fitPav(
        [
          { judge: 0, human: -2 },
          { judge: 1, human: 9 },
        ],
        3,
      ),
    );
    expect(r.map).toEqual([0, 2, 2]);
  });

  it('output is monotone non-decreasing and total on random data', () => {
    const prng = createPrng(36);
    for (let trial = 0; trial < 20; trial++) {
      const pts: PavPoint[] = Array.from({ length: 60 }, () => ({ judge: prng.int(5), human: prng.nextFloat() * 4 }));
      const r = unwrap(fitPav(pts, 5));
      expect(r.map).toHaveLength(5);
      for (let j = 0; j < 5; j++) {
        expect(Number.isInteger(r.map[j])).toBe(true);
        expect(r.map[j]! >= 0 && r.map[j]! <= 4).toBe(true);
        if (j > 0) expect(r.map[j]!).toBeGreaterThanOrEqual(r.map[j - 1]!);
      }
      const seen = r.fitted.filter((f): f is number => f !== null);
      for (let j = 1; j < seen.length; j++) expect(seen[j]!).toBeGreaterThanOrEqual(seen[j - 1]! - 1e-12);
    }
  });

  it('no data => Err(no_data); bad judge index throws', () => {
    const r = fitPav([], 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('no_data');
    expect(() => fitPav([{ judge: 5, human: 1 }], 5)).toThrow(RangeError);
  });

  it('applyPav maps indices and rejects out-of-range ones', () => {
    const r = unwrap(fitPav([{ judge: 2, human: 2 }], 5));
    expect([0, 1, 2, 3, 4].map((j) => applyPav(r, j))).toEqual([2, 2, 2, 2, 2]);
    expect(() => applyPav(r, 5)).toThrow(RangeError);
  });
});
