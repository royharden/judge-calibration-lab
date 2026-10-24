import { describe, expect, it } from 'vitest';
import {
  formatInterval,
  formatStat,
  isDefined,
  meanStat,
  statToNullable,
  undef,
  undefinedInterval,
  value,
} from '../../../src/core/judgestats/undefined.ts';

describe('Stat helpers', () => {
  it('value / undef / isDefined', () => {
    expect(value(0.5)).toEqual({ kind: 'value', value: 0.5 });
    expect(isDefined(value(0))).toBe(true);
    expect(isDefined(undef('n < 2'))).toBe(false);
  });

  it('non-finite numbers become undefined instead of leaking NaN', () => {
    expect(value(Number.NaN).kind).toBe('undefined');
    expect(value(Number.POSITIVE_INFINITY).kind).toBe('undefined');
  });

  it('formatStat never prints 0 for an undefined stat', () => {
    const text = formatStat(undef('constant judge'));
    expect(text).toBe('undefined (constant judge)');
    expect(text).not.toMatch(/^0/);
    expect(formatStat(value(0))).toBe('0.000');
    expect(formatStat(value(0.71234), 2)).toBe('0.71');
  });

  it('statToNullable maps undefined to null, not 0', () => {
    expect(statToNullable(undef('x'))).toBeNull();
    expect(statToNullable(value(0))).toBe(0);
  });

  it('meanStat of an empty list is undefined', () => {
    expect(meanStat([]).kind).toBe('undefined');
    expect(meanStat([1, 2, 3])).toEqual({ kind: 'value', value: 2 });
  });

  it('formatInterval', () => {
    expect(formatInterval({ point: value(0.5), lo: value(0.4), hi: value(0.6), draws: 10, droppedDraws: 0 })).toBe(
      '0.500 [0.400, 0.600]',
    );
    expect(formatInterval(undefinedInterval(value(0.5), 'too many undefined draws'))).toBe(
      '0.500 [interval undefined (too many undefined draws)]',
    );
    expect(formatInterval(undefinedInterval(undef('n < 2'), 'point statistic undefined'))).toBe('undefined (n < 2)');
  });
});
