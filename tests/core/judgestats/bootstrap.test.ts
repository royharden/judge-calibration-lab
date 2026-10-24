import { describe, expect, it } from 'vitest';
import {
  allItemKeys,
  bootstrapInterval,
  drawUnitIndices,
  restrictUnits,
  unitsFromItems,
  type ResampleUnit,
} from '../../../src/core/judgestats/bootstrap.ts';
import { meanStat, undef, value } from '../../../src/core/judgestats/undefined.ts';
import type { Stat } from '../../../src/core/types.ts';

function num(s: Stat): number {
  if (s.kind !== 'value') throw new Error(`expected a defined stat, got undefined (${s.reason})`);
  return s.value;
}

const items = Array.from({ length: 20 }, (_, i) => ({ key: `i${String(i).padStart(2, '0')}` }));
const valueOf = new Map(items.map((it, i) => [it.key, (i * 7) % 11]));
const meanOfItems = (keys: readonly string[]): Stat => meanStat(keys.map((k) => valueOf.get(k)!));
const singletonUnits = unitsFromItems(items);

describe('bootstrapInterval — reproducibility', () => {
  it('same seed => identical interval; different seed => different draws', () => {
    const a = bootstrapInterval(singletonUnits, meanOfItems, { seed: 36 });
    const b = bootstrapInterval(singletonUnits, meanOfItems, { seed: 36 });
    expect(a).toEqual(b);
    expect(a.draws).toBe(2000);
    expect(a.droppedDraws).toBe(0);
    // Interval bounds of a discrete statistic can coincide across seeds, so compare the draws.
    expect(drawUnitIndices(singletonUnits.length, { seed: 37, resamples: 5 })).not.toEqual(
      drawUnitIndices(singletonUnits.length, { seed: 36, resamples: 5 }),
    );
  });

  it('defaults to 2000 resamples; the point is the statistic over all items', () => {
    const r = bootstrapInterval(singletonUnits, meanOfItems, { seed: 1 });
    expect(r.draws).toBe(2000);
    expect(num(r.point)).toBeCloseTo(num(meanOfItems(allItemKeys(singletonUnits))), 12);
    expect(num(r.lo)).toBeLessThan(num(r.hi));
  });

  it('a constant statistic gives a degenerate interval', () => {
    const r = bootstrapInterval(singletonUnits, () => value(5), { seed: 1, resamples: 50 });
    expect([num(r.lo), num(r.hi)]).toEqual([5, 5]);
  });

  it('drawUnitIndices is deterministic and in range', () => {
    const d1 = drawUnitIndices(7, { seed: 36, resamples: 25 });
    const d2 = drawUnitIndices(7, { seed: 36, resamples: 25 });
    expect(d1).toEqual(d2);
    expect(d1).toHaveLength(25);
    for (const draw of d1) {
      expect(draw).toHaveLength(7);
      for (const i of draw) expect(i >= 0 && i < 7).toBe(true);
    }
    expect(drawUnitIndices(7, { seed: 36, resamples: 25, streamLabel: 'other' })).not.toEqual(d1);
  });
});

describe('bootstrapInterval — group resampling', () => {
  const units: ResampleUnit[] = [
    { id: 'group:g1', itemKeys: ['a1', 'a2'] },
    { id: 'group:g2', itemKeys: ['b1', 'b2', 'b3'] },
    { id: 'item:c', itemKeys: ['c'] },
  ];

  it('every draw contains whole groups only', () => {
    let violations = 0;
    let calls = 0;
    const stat = (keys: readonly string[]): Stat => {
      calls += 1;
      const count = (k: string): number => keys.filter((x) => x === k).length;
      if (count('a1') !== count('a2')) violations += 1;
      if (count('b1') !== count('b2') || count('b2') !== count('b3')) violations += 1;
      return value(keys.length);
    };
    bootstrapInterval(units, stat, { seed: 36, resamples: 200 });
    expect(calls).toBe(201); // point + 200 draws
    expect(violations).toBe(0);
  });

  it('unitsFromItems groups by groupId, singletons otherwise, independent of row order', () => {
    const rows = [
      { key: 'x2', groupId: 'g' },
      { key: 'y' },
      { key: 'x1', groupId: 'g' },
      { key: 'z', groupId: '' },
    ];
    const u1 = unitsFromItems(rows);
    const u2 = unitsFromItems([...rows].reverse());
    expect(u1).toEqual(u2);
    expect(u1).toEqual([
      { id: 'group:g', itemKeys: ['x1', 'x2'] },
      { id: 'item:y', itemKeys: ['y'] },
      { id: 'item:z', itemKeys: ['z'] },
    ]);
  });

  it('restrictUnits drops filtered items and empty units', () => {
    expect(restrictUnits(units, new Set(['a1', 'c']))).toEqual([
      { id: 'group:g1', itemKeys: ['a1'] },
      { id: 'item:c', itemKeys: ['c'] },
    ]);
  });
});

describe('bootstrapInterval — undefined draws', () => {
  // Statistic call 0 is the point estimate; calls 1..resamples are the draws.
  function failingFirst(nUndefined: number): (keys: readonly string[]) => Stat {
    let call = 0;
    return () => {
      const c = call++;
      return c >= 1 && c <= nUndefined ? undef('synthetic') : value(c % 3);
    };
  }

  it('10% undefined (10 of 100) => interval still defined, drops counted', () => {
    const r = bootstrapInterval(singletonUnits, failingFirst(10), { seed: 36, resamples: 100 });
    expect(r.droppedDraws).toBe(10);
    expect(r.draws).toBe(100);
    expect(r.lo.kind).toBe('value');
    expect(r.hi.kind).toBe('value');
  });

  it('11% undefined (11 of 100) => interval undefined, drops counted', () => {
    const r = bootstrapInterval(singletonUnits, failingFirst(11), { seed: 36, resamples: 100 });
    expect(r.droppedDraws).toBe(11);
    expect(r.lo.kind).toBe('undefined');
    expect(r.hi.kind).toBe('undefined');
    expect(r.point.kind).toBe('value');
  });

  it('boundary also holds at the default 2000 resamples (200 vs 201)', () => {
    expect(bootstrapInterval(singletonUnits, failingFirst(200), { seed: 36 }).lo.kind).toBe('value');
    expect(bootstrapInterval(singletonUnits, failingFirst(201), { seed: 36 }).lo.kind).toBe('undefined');
  });

  it('undefined point statistic => undefined interval without resampling', () => {
    let calls = 0;
    const r = bootstrapInterval(
      singletonUnits,
      () => {
        calls += 1;
        return undef('constant judge');
      },
      { seed: 36 },
    );
    expect(calls).toBe(1);
    expect(r.point).toEqual({ kind: 'undefined', reason: 'constant judge' });
    expect(r.lo.kind).toBe('undefined');
    expect(r.draws).toBe(0);
  });

  it('rejects invalid options', () => {
    expect(() => bootstrapInterval(singletonUnits, meanOfItems, { seed: 1, resamples: 0 })).toThrow(RangeError);
    expect(() => bootstrapInterval(singletonUnits, meanOfItems, { seed: 1, confidence: 1 })).toThrow(RangeError);
  });
});
