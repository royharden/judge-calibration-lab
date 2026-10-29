import { describe, expect, it } from 'vitest';
import { missingnessGuard } from '../../../src/core/heldoutlock/missingness.ts';
import {
  compareFitHashes,
  computeVerdict,
  HALF_WIDTH_WORDING,
  intervalHalfWidth,
  VERDICT_LABELS,
} from '../../../src/core/heldoutlock/verdict.ts';
import { undef, value } from '../../../src/core/judgestats/undefined.ts';
import type { Interval } from '../../../src/core/types.ts';

function interval(lo: number, hi: number, point = (lo + hi) / 2, draws = 2000, droppedDraws = 0): Interval {
  return { lo: value(lo), hi: value(hi), point: value(point), draws, droppedDraws };
}

const okGuard = missingnessGuard({ plannedN: 60, unusableBaseline: 1, unusableChosen: 0, commonEvaluableN: 59 });

describe('verdict: four outcomes', () => {
  it('improved iff the paired 95% lower bound > 0', () => {
    const v = computeVerdict({ delta: interval(0.02, 0.2), guard: okGuard, fitMismatch: false });
    expect(v.outcome).toBe('improved');
    expect(v.label).toBe('improved');
    expect(v.reasons).toEqual(['lower_bound_above_zero']);
  });

  it('lower bound exactly 0 is no detectable change', () => {
    expect(computeVerdict({ delta: interval(0, 0.2), guard: okGuard, fitMismatch: false }).outcome).toBe('no_detectable_change');
  });

  it('worse iff the upper bound < 0', () => {
    const v = computeVerdict({ delta: interval(-0.3, -0.01), guard: okGuard, fitMismatch: false });
    expect(v.outcome).toBe('worse');
    expect(v.label).toBe('worse');
  });

  it('upper bound exactly 0 is no detectable change', () => {
    expect(computeVerdict({ delta: interval(-0.2, 0), guard: okGuard, fitMismatch: false }).outcome).toBe('no_detectable_change');
  });

  it('interval containing 0 is no detectable change', () => {
    const v = computeVerdict({ delta: interval(-0.05, 0.12), guard: okGuard, fitMismatch: false });
    expect(v.outcome).toBe('no_detectable_change');
    expect(v.label).toBe('no detectable change');
    expect(v.reasons).toEqual(['interval_includes_zero']);
  });

  it('n = 12 subset => cannot support, even with a clearly positive interval', () => {
    const guard = missingnessGuard({ plannedN: 12, unusableBaseline: 0, unusableChosen: 0, commonEvaluableN: 12 });
    const v = computeVerdict({ delta: interval(0.1, 0.5), guard, fitMismatch: false });
    expect(v.outcome).toBe('cannot_support');
    expect(v.label).toBe('cannot support');
    expect(v.reasons).toEqual(['missingness_guard']);
  });

  it('fit mismatch => cannot support', () => {
    const v = computeVerdict({ delta: interval(0.1, 0.3), guard: okGuard, fitMismatch: true, fitMismatchFields: ['pavMap'] });
    expect(v.outcome).toBe('cannot_support');
    expect(v.reasons).toEqual(['fit_mismatch']);
    expect(v.messages[0]).toContain('pavMap');
  });

  it('undefined interval => cannot support', () => {
    const delta: Interval = { lo: undef('dropped share 0.12 > 0.10'), hi: undef('dropped share 0.12 > 0.10'), point: value(0.1), draws: 2000, droppedDraws: 240 };
    const v = computeVerdict({ delta, guard: okGuard, fitMismatch: false });
    expect(v.outcome).toBe('cannot_support');
    expect(v.reasons).toEqual(['interval_undefined']);
    expect(v.halfWidth.kind).toBe('undefined');
  });

  it('too many unusable verdicts => cannot support', () => {
    const guard = missingnessGuard({ plannedN: 60, unusableBaseline: 0, unusableChosen: 4, commonEvaluableN: 56 });
    expect(computeVerdict({ delta: interval(0.1, 0.3), guard, fitMismatch: false }).outcome).toBe('cannot_support');
  });

  it('an interval not computed with the policy resample count => cannot support', () => {
    const v = computeVerdict({ delta: interval(0.1, 0.3, 0.2, 500), guard: okGuard, fitMismatch: false });
    expect(v.outcome).toBe('cannot_support');
    expect(v.reasons).toEqual(['resamples_mismatch']);
  });

  it('lists every failing condition together', () => {
    const guard = missingnessGuard({ plannedN: 12, unusableBaseline: 0, unusableChosen: 0, commonEvaluableN: 12 });
    const delta: Interval = { lo: undef('x'), hi: undef('x'), point: undef('x'), draws: 2000, droppedDraws: 2000 };
    const v = computeVerdict({ delta, guard, fitMismatch: true });
    expect(v.reasons).toEqual(['fit_mismatch', 'missingness_guard', 'interval_undefined']);
  });
});

describe('half-width wording', () => {
  it('uses the exact §3.9 wording', () => {
    expect(HALF_WIDTH_WORDING).toBe('observed precision: roughly the smallest change this set could resolve — not a power analysis');
    const v = computeVerdict({ delta: interval(0.1, 0.3), guard: okGuard, fitMismatch: false });
    expect(v.halfWidthText).toBe(`half-width 0.100 — ${HALF_WIDTH_WORDING}`);
  });

  it('half-width = (hi − lo) / 2', () => {
    const h = intervalHalfWidth(interval(-0.1, 0.3));
    expect(h.kind).toBe('value');
    if (h.kind === 'value') expect(h.value).toBeCloseTo(0.2, 12);
  });

  it('labels are the report words', () => {
    expect(Object.values(VERDICT_LABELS)).toEqual(['improved', 'no detectable change', 'worse', 'cannot support']);
  });
});

describe('compareFitHashes', () => {
  it('names the mismatching fits', () => {
    const pinned = { lexicalCutPoints: 'a', modalLevel: 'b', pavMap: 'c' };
    expect(compareFitHashes(pinned, { ...pinned })).toEqual({ mismatch: false, fields: [] });
    expect(compareFitHashes(pinned, { ...pinned, modalLevel: 'x', pavMap: 'y' })).toEqual({ mismatch: true, fields: ['modalLevel', 'pavMap'] });
  });
});
