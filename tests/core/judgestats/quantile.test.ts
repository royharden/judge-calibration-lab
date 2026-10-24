import { describe, expect, it } from 'vitest';
import { quantile7, quantile7Sorted } from '../../../src/core/judgestats/quantile.ts';
import type { Stat } from '../../../src/core/types.ts';

function num(s: Stat): number {
  if (s.kind !== 'value') throw new Error(`expected a defined stat, got undefined (${s.reason})`);
  return s.value;
}

describe('type-7 quantile', () => {
  it('known values on [1,2,3,4]', () => {
    // h = (n-1)p = 3p
    expect(quantile7Sorted([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile7Sorted([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 12); // h = 0.75
    expect(quantile7Sorted([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 12); // h = 1.5
    expect(quantile7Sorted([1, 2, 3, 4], 1)).toBe(4);
  });

  it('matches R quantile(x, 0.025/0.975, type = 7) on 1..11', () => {
    const xs = Array.from({ length: 11 }, (_, i) => i + 1);
    expect(quantile7Sorted(xs, 0.025)).toBeCloseTo(1.25, 12); // h = 0.25
    expect(quantile7Sorted(xs, 0.975)).toBeCloseTo(10.75, 12); // h = 9.75
  });

  it('sorts unsorted input without mutating it', () => {
    const xs = [4, 1, 3, 2];
    expect(num(quantile7(xs, 0.5))).toBeCloseTo(2.5, 12);
    expect(xs).toEqual([4, 1, 3, 2]);
  });

  it('single value', () => {
    expect(num(quantile7([7], 0.3))).toBe(7);
  });

  it('empty sample is undefined; sorted variant throws', () => {
    expect(quantile7([], 0.5).kind).toBe('undefined');
    expect(() => quantile7Sorted([], 0.5)).toThrow(RangeError);
  });

  it('rejects p outside [0, 1]', () => {
    expect(() => quantile7([1, 2], 1.1)).toThrow(RangeError);
    expect(() => quantile7([1, 2], Number.NaN)).toThrow(RangeError);
  });
});
