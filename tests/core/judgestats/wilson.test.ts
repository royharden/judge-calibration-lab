import { describe, expect, it } from 'vitest';
import { wilsonInterval } from '../../../src/core/judgestats/wilson.ts';
import type { Stat } from '../../../src/core/types.ts';

function num(s: Stat): number {
  if (s.kind !== 'value') throw new Error(`expected a defined stat, got undefined (${s.reason})`);
  return s.value;
}

// Known values (z = 1.96):
//   5/10  -> centre 0.5, half = 1.96*sqrt(0.025 + 3.8416/400)/1.38416 ~= 0.263410 -> [0.236590, 0.763410]
//   0/10  -> [0, 0.277540]   (centre = half = 0.19208/1.38416)
//   10/10 -> [0.722460, 1]
describe('wilsonInterval', () => {
  it('5 of 10', () => {
    const w = wilsonInterval(5, 10);
    expect(num(w.point)).toBeCloseTo(0.5, 12);
    expect(num(w.lo)).toBeCloseTo(0.23659, 4);
    expect(num(w.hi)).toBeCloseTo(0.76341, 4);
  });

  it('0 of 10', () => {
    const w = wilsonInterval(0, 10);
    expect(num(w.lo)).toBeCloseTo(0, 12);
    expect(num(w.hi)).toBeCloseTo(0.277540, 5);
  });

  it('10 of 10', () => {
    const w = wilsonInterval(10, 10);
    expect(num(w.lo)).toBeCloseTo(0.722460, 5);
    expect(num(w.hi)).toBeCloseTo(1, 12);
  });

  it('bounds stay within [0, 1] and bracket the point', () => {
    for (const [x, n] of [
      [1, 3],
      [7, 9],
      [50, 120],
    ] as const) {
      const w = wilsonInterval(x, n);
      expect(num(w.lo)).toBeGreaterThanOrEqual(0);
      expect(num(w.hi)).toBeLessThanOrEqual(1);
      expect(num(w.lo)).toBeLessThanOrEqual(num(w.point));
      expect(num(w.hi)).toBeGreaterThanOrEqual(num(w.point));
    }
  });

  it('n = 0 is undefined, never 0', () => {
    const w = wilsonInterval(0, 0);
    expect(w.point.kind).toBe('undefined');
    expect(w.lo.kind).toBe('undefined');
    expect(w.hi.kind).toBe('undefined');
  });

  it('rejects invalid counts', () => {
    expect(() => wilsonInterval(11, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(-1, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(1.5, 10)).toThrow(RangeError);
  });
});
