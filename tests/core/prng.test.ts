import { describe, expect, it } from 'vitest';
import { createPrng, deriveSeed, deriveStream, splitmix32 } from '../../src/core/prng.ts';

function take(n: number, f: () => number): number[] {
  return Array.from({ length: n }, () => f());
}

describe('PRNG determinism', () => {
  it('same seed => identical sequence', () => {
    const a = createPrng(36);
    const b = createPrng(36);
    expect(take(100, a.nextUint32)).toEqual(take(100, b.nextUint32));
  });

  it('different seeds => different sequences', () => {
    expect(take(10, createPrng(36).nextUint32)).not.toEqual(take(10, createPrng(37).nextUint32));
  });

  it('splitmix32 is deterministic and outputs uint32', () => {
    const xs = take(50, splitmix32(0));
    expect(xs).toEqual(take(50, splitmix32(0)));
    for (const x of xs) expect(Number.isInteger(x) && x >= 0 && x < 2 ** 32).toBe(true);
  });

  it('nextUint32 stays in [0, 2^32) and nextFloat in [0, 1)', () => {
    const p = createPrng(1);
    for (let i = 0; i < 2000; i++) {
      const u = p.nextUint32();
      expect(u >= 0 && u < 2 ** 32 && Number.isInteger(u)).toBe(true);
      const f = p.nextFloat();
      expect(f >= 0 && f < 1).toBe(true);
    }
  });

  it('int(n) stays in range and hits every value for small n', () => {
    const p = createPrng(2);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const v = p.int(5);
      expect(v >= 0 && v < 5 && Number.isInteger(v)).toBe(true);
      seen.add(v);
    }
    expect(seen.size).toBe(5);
    expect(p.int(1)).toBe(0);
  });

  it('rejects bad seeds and bad n', () => {
    expect(() => createPrng(-1)).toThrow(RangeError);
    expect(() => createPrng(1.5)).toThrow(RangeError);
    expect(() => createPrng(2 ** 32)).toThrow(RangeError);
    expect(() => createPrng(3).int(0)).toThrow(RangeError);
  });

  it('shuffle returns a deterministic permutation copy and leaves the input untouched', () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    const s1 = createPrng(36).shuffle(input);
    const s2 = createPrng(36).shuffle(input);
    expect(s1).toEqual(s2);
    expect([...s1].sort((a, b) => a - b)).toEqual(input);
    expect(input).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(s1).not.toEqual(input); // 1/20! chance of a false failure
  });
});

describe('derived streams', () => {
  it('deriveSeed is deterministic and label-sensitive', () => {
    expect(deriveSeed(36, 'split')).toBe(deriveSeed(36, 'split'));
    expect(deriveSeed(36, 'split')).not.toBe(deriveSeed(36, 'bootstrap'));
    expect(deriveSeed(36, 'split')).not.toBe(deriveSeed(37, 'split'));
  });

  it('deriveStream sequences are reproducible and independent of other streams', () => {
    const a1 = deriveStream(36, 'bootstrap');
    const other = deriveStream(36, 'mock');
    take(500, other.nextUint32); // consuming another stream must not shift this one
    const a2 = deriveStream(36, 'bootstrap');
    expect(take(20, a1.nextUint32)).toEqual(take(20, a2.nextUint32));
  });
});
