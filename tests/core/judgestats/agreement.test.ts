import { describe, expect, it } from 'vitest';
import {
  exactAgreement,
  judgeAgreement,
  judgeAgreementWithInterval,
  meanSignedOffset,
  referenceCeiling,
  referenceCeilingWithInterval,
  withinOneAgreement,
} from '../../../src/core/judgestats/agreement.ts';
import { unitsFromItems } from '../../../src/core/judgestats/bootstrap.ts';
import { quadraticWeightedKappa } from '../../../src/core/judgestats/kappa.ts';
import type { Annotation, JudgeScore, Stat } from '../../../src/core/types.ts';

function num(s: Stat): number {
  if (s.kind !== 'value') throw new Error(`expected a defined stat, got undefined (${s.reason})`);
  return s.value;
}

const keys = (n: number, prefix = 'i'): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);

function annotate(annotatorId: string, itemKeys: readonly string[], scores: readonly number[]): Annotation[] {
  return itemKeys.map((itemKey, i) => ({ itemKey, annotatorId, score: scores[i % scores.length]! }));
}

describe('item-level agreement', () => {
  const judge = [0, 1, 2, 3, 4];
  const human = [0, 2, 2, 1, 4];

  it('exact agreement', () => {
    expect(num(exactAgreement(judge, human))).toBeCloseTo(3 / 5, 12);
  });

  it('within-one agreement', () => {
    // |diffs| = [0,1,0,2,0] -> 4 of 5 within one
    expect(num(withinOneAgreement(judge, human))).toBeCloseTo(4 / 5, 12);
  });

  it('mean signed offset is judge - human (positive = lenient)', () => {
    // diffs = [0,-1,0,2,0] -> mean 0.2
    expect(num(meanSignedOffset(judge, human))).toBeCloseTo(0.2, 12);
    expect(num(meanSignedOffset([3, 3], [1, 1]))).toBeCloseTo(2, 12);
    expect(num(meanSignedOffset([0, 0], [2, 2]))).toBeCloseTo(-2, 12);
  });

  it('empty input is undefined, not 0', () => {
    expect(exactAgreement([], []).kind).toBe('undefined');
    expect(withinOneAgreement([], []).kind).toBe('undefined');
    expect(meanSignedOffset([], []).kind).toBe('undefined');
  });
});

describe('referenceCeiling — overlap floor', () => {
  // A and B rate 12 items; C rates only the first 9 -> A~C and B~C have n = 9 < 10.
  const items = keys(12);
  const scoresA = [0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 2, 3];
  const scoresB = [0, 1, 2, 3, 3, 0, 2, 2, 3, 4, 2, 4];
  const ann: Annotation[] = [
    ...annotate('A', items, scoresA),
    ...annotate('B', items, scoresB),
    ...annotate('C', items.slice(0, 9), [4, 3, 2, 1, 0, 4, 3, 2, 1]),
  ];

  it('excludes and lists pairs below 10 shared items, with their n', () => {
    const r = referenceCeiling(ann, 5);
    expect(r.overlapFloor).toBe(10);
    expect(r.excluded.map((p) => [p.id, p.n])).toEqual([
      ['A~C', 9],
      ['B~C', 9],
    ]);
    expect(r.basis.map((p) => [p.id, p.n])).toEqual([['A~B', 12]]);
    expect(r.pairs).toHaveLength(3);
  });

  it('ceiling = mean of the defined included pairs (here just A~B)', () => {
    const r = referenceCeiling(ann, 5);
    expect(num(r.value)).toBeCloseTo(num(quadraticWeightedKappa(scoresA, scoresB, 5)), 12);
  });

  it('a lower floor admits the excluded pairs', () => {
    const r = referenceCeiling(ann, 5, { overlapFloor: 9 });
    expect(r.excluded).toHaveLength(0);
    expect(r.basis).toHaveLength(3);
  });

  it('no qualifying pair => undefined ceiling', () => {
    const r = referenceCeiling(ann, 5, { overlapFloor: 13 });
    expect(r.value.kind).toBe('undefined');
  });

  it('itemKeys restricts the universe (n counts only those items)', () => {
    const r = referenceCeiling(ann, 5, { itemKeys: items.slice(0, 10), overlapFloor: 10 });
    expect(r.pairs.find((p) => p.id === 'A~B')!.n).toBe(10);
  });

  it('an included pair with undefined kappa is listed but not averaged', () => {
    const constD = annotate('D', items, [2]); // constant annotator
    const r = referenceCeiling([...annotate('A', items, scoresA), ...annotate('B', items, scoresB), ...constD], 5);
    const ad = r.pairs.find((p) => p.id === 'A~D')!;
    expect(ad.included).toBe(true);
    expect(ad.kappa.kind).toBe('undefined');
    expect(r.basis.map((p) => p.id)).toEqual(['A~B']);
  });
});

describe('judgeAgreement', () => {
  const items = keys(12);
  const scoresA = [0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 2, 3];
  const scoresB = [0, 1, 2, 3, 3, 0, 2, 2, 3, 4, 2, 4];
  const ann = [...annotate('A', items, scoresA), ...annotate('B', items, scoresB)];

  it('equal-weight mean of judge-vs-single-annotator QWK', () => {
    const judge: JudgeScore[] = items.map((itemKey, i) => ({ itemKey, score: scoresA[i]! }));
    const r = judgeAgreement(judge, ann, 5);
    const expected = (1 + num(quadraticWeightedKappa(scoresA, scoresB, 5))) / 2;
    expect(num(r.value)).toBeCloseTo(expected, 12);
    expect(r.basis.map((p) => p.id)).toEqual(['judge~A', 'judge~B']);
  });

  it('unusable judge rows (null) are skipped and count against the overlap floor', () => {
    const judge: JudgeScore[] = items.map((itemKey, i) => ({ itemKey, score: i < 3 ? null : scoresA[i]! }));
    const r = judgeAgreement(judge, ann, 5);
    // 9 usable items < floor 10 -> every annotator excluded -> undefined
    expect(r.excluded.map((p) => p.n)).toEqual([9, 9]);
    expect(r.value.kind).toBe('undefined');
  });

  it('constant judge => undefined agreement (never 0)', () => {
    const judge: JudgeScore[] = items.map((itemKey) => ({ itemKey, score: 2 }));
    expect(judgeAgreement(judge, ann, 5).value.kind).toBe('undefined');
  });
});

describe('bootstrap variants', () => {
  const items = keys(30);
  const truth = items.map((_, i) => i % 5);
  const noisy = truth.map((t, i) => (i % 4 === 0 ? Math.min(4, t + 1) : t));
  const ann = [...annotate('A', items, truth), ...annotate('B', items, noisy), ...annotate('C', items, truth)];
  const units = unitsFromItems(items.map((key) => ({ key })));

  it('ceiling interval is reproducible for a fixed seed; its point equals the ceiling', () => {
    const r1 = referenceCeilingWithInterval(ann, 5, units, { seed: 36, resamples: 300 });
    const r2 = referenceCeilingWithInterval(ann, 5, units, { seed: 36, resamples: 300 });
    expect(r1.interval).toEqual(r2.interval);
    expect(num(r1.interval.point)).toBeCloseTo(num(r1.value), 12);
    // Percentile intervals need not contain the point; only order the bounds.
    expect(num(r1.interval.lo)).toBeLessThanOrEqual(num(r1.interval.hi));
    expect(r1.interval.draws).toBe(300);
  });

  it('judge agreement interval with an empty basis is undefined', () => {
    const judge: JudgeScore[] = items.map((itemKey) => ({ itemKey, score: 1 }));
    const r = judgeAgreementWithInterval(judge, ann, 5, units, { seed: 36, resamples: 50 });
    expect(r.value.kind).toBe('undefined');
    expect(r.interval.lo.kind).toBe('undefined');
  });
});
