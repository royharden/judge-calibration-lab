import { describe, expect, it } from 'vitest';
import { colMarginals, confusionMatrix, rowMarginals } from '../../../src/core/judgestats/confusion.ts';

describe('confusionMatrix', () => {
  it('counts[row][col] with rows = first argument', () => {
    // human (rows) = [4,4,4,3], judge (cols) = [3,3,4,3]  ->  "2 of 3 human-4 items scored 3"
    const m = confusionMatrix([4, 4, 4, 3], [3, 3, 4, 3], 5);
    expect(m.n).toBe(4);
    expect(m.counts[4]![3]).toBe(2);
    expect(m.counts[4]![4]).toBe(1);
    expect(m.counts[3]![3]).toBe(1);
    expect(rowMarginals(m)).toEqual([0, 0, 0, 1, 3]);
    expect(colMarginals(m)).toEqual([0, 0, 0, 3, 1]);
  });

  it('empty input yields an all-zero K x K matrix', () => {
    const m = confusionMatrix([], [], 3);
    expect(m.counts).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });

  it('rejects out-of-range indices', () => {
    expect(() => confusionMatrix([0, 5], [0, 1], 5)).toThrow(RangeError);
    expect(() => confusionMatrix([-1], [0], 5)).toThrow(RangeError);
  });
});
