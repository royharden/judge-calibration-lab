import { describe, expect, it } from 'vitest';
import { missingnessGuard, missingnessThreshold } from '../../../src/core/heldoutlock/missingness.ts';

describe('missingness threshold T = max(2, floor(0.05·N))', () => {
  it.each([
    [0, 2],
    [12, 2],
    [39, 2],
    [40, 2],
    [59, 2],
    [60, 3],
    [79, 3],
    [80, 4],
    [100, 5],
    [119, 5],
    [120, 6],
  ])('N=%i => T=%i', (n, t) => {
    expect(missingnessThreshold(n)).toBe(t);
  });

  it('rejects a non-integer N', () => {
    expect(() => missingnessThreshold(10.5)).toThrow(RangeError);
    expect(() => missingnessThreshold(-1)).toThrow(RangeError);
  });
});

describe('missingness guard boundaries', () => {
  // [N, U_b, U_c, common n, ok, reasons]
  it.each([
    // N = 40 -> T = 2
    [40, 2, 2, 36, true, []],
    [40, 0, 2, 38, true, []],
    [40, 3, 0, 37, false, ['unusable_over_threshold', 'unusable_gap_over_threshold']],
    [40, 3, 3, 37, false, ['unusable_over_threshold']],
    [40, 0, 3, 37, false, ['unusable_over_threshold', 'unusable_gap_over_threshold']],
    // N = 60 -> T = 3
    [60, 3, 3, 57, true, []],
    [60, 0, 3, 57, true, []],
    [60, 4, 1, 56, false, ['unusable_over_threshold']],
    [60, 0, 4, 56, false, ['unusable_over_threshold', 'unusable_gap_over_threshold']],
    // N = 100 -> T = 5
    [100, 5, 5, 95, true, []],
    [100, 0, 5, 95, true, []],
    [100, 6, 2, 94, false, ['unusable_over_threshold']],
    [100, 0, 6, 94, false, ['unusable_over_threshold', 'unusable_gap_over_threshold']],
  ])('N=%i U_b=%i U_c=%i n=%i', (n, ub, uc, common, ok, reasons) => {
    const g = missingnessGuard({ plannedN: n, unusableBaseline: ub, unusableChosen: uc, commonEvaluableN: common });
    expect(g.ok).toBe(ok);
    expect(g.reasons).toEqual(reasons);
  });

  it('common evaluable n below 20 cannot support (n=12 trap), n = 20 is enough', () => {
    const g12 = missingnessGuard({ plannedN: 12, unusableBaseline: 0, unusableChosen: 0, commonEvaluableN: 12 });
    expect(g12.ok).toBe(false);
    expect(g12.reasons).toEqual(['common_n_below_floor']);
    expect(missingnessGuard({ plannedN: 40, unusableBaseline: 0, unusableChosen: 0, commonEvaluableN: 19 }).ok).toBe(false);
    expect(missingnessGuard({ plannedN: 40, unusableBaseline: 0, unusableChosen: 0, commonEvaluableN: 20 }).ok).toBe(true);
  });

  it('reports T and the floor', () => {
    const g = missingnessGuard({ plannedN: 60, unusableBaseline: 1, unusableChosen: 1, commonEvaluableN: 58 });
    expect(g.threshold).toBe(3);
    expect(g.nFloor).toBe(20);
    expect(g.messages).toEqual([]);
  });
});
