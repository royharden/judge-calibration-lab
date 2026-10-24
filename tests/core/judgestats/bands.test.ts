import { describe, expect, it } from 'vitest';
import { bandFlag, DEFAULT_BAND, type BandStatus } from '../../../src/core/judgestats/bands.ts';
import { undef, value } from '../../../src/core/judgestats/undefined.ts';
import type { Stat } from '../../../src/core/types.ts';

// Truth table for the +/-0.25 innocent band: flag only when the WHOLE CI is outside.
const cases: { name: string; lo: Stat; hi: Stat; flagged: boolean; status: BandStatus }[] = [
  { name: 'whole CI above band', lo: value(0.3), hi: value(0.6), flagged: true, status: 'outside_high' },
  { name: 'whole CI below band', lo: value(-0.6), hi: value(-0.3), flagged: true, status: 'outside_low' },
  { name: 'lower bound exactly on +band', lo: value(0.25), hi: value(0.5), flagged: false, status: 'straddles' },
  { name: 'upper bound exactly on -band', lo: value(-0.5), hi: value(-0.25), flagged: false, status: 'straddles' },
  { name: 'straddles the upper edge', lo: value(0.1), hi: value(0.6), flagged: false, status: 'straddles' },
  { name: 'wider than the band on both sides', lo: value(-0.4), hi: value(0.4), flagged: false, status: 'straddles' },
  { name: 'inside the band', lo: value(-0.2), hi: value(0.2), flagged: false, status: 'inside' },
  { name: 'inside, touching both edges', lo: value(-0.25), hi: value(0.25), flagged: false, status: 'inside' },
  { name: 'undefined lower bound', lo: undef('x'), hi: value(0.9), flagged: false, status: 'undefined' },
  { name: 'undefined upper bound', lo: value(0.9), hi: undef('x'), flagged: false, status: 'undefined' },
];

describe('bandFlag truth table', () => {
  for (const c of cases) {
    it(c.name, () => {
      const f = bandFlag({ lo: c.lo, hi: c.hi });
      expect(f.flagged).toBe(c.flagged);
      expect(f.status).toBe(c.status);
      expect(f.band).toBe(DEFAULT_BAND);
    });
  }
});

describe('bandFlag options', () => {
  it('reports the band as a share of the full scale when K is given', () => {
    expect(bandFlag({ lo: value(0), hi: value(0) }, { k: 5 }).bandShareOfScale).toBeCloseTo(0.0625, 12);
    expect(bandFlag({ lo: value(0), hi: value(0) }).bandShareOfScale).toBeNull();
  });

  it('honours a custom band', () => {
    expect(bandFlag({ lo: value(0.3), hi: value(0.6) }, { band: 0.5 }).flagged).toBe(false);
  });
});
