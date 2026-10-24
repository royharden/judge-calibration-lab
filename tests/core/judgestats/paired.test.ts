import { describe, expect, it } from 'vitest';
import { judgeAgreement } from '../../../src/core/judgestats/agreement.ts';
import { drawUnitIndices, unitsFromItems } from '../../../src/core/judgestats/bootstrap.ts';
import { pairedBootstrapInterval, pairedJudgeDelta } from '../../../src/core/judgestats/paired.ts';
import { meanStat } from '../../../src/core/judgestats/undefined.ts';
import type { Annotation, JudgeScore, Stat } from '../../../src/core/types.ts';

function num(s: Stat): number {
  if (s.kind !== 'value') throw new Error(`expected a defined stat, got undefined (${s.reason})`);
  return s.value;
}

const K = 5;
const items = Array.from({ length: 40 }, (_, i) => `i${String(i).padStart(2, '0')}`);
const truth = items.map((_, i) => i % 5);
const clamp = (x: number): number => Math.max(0, Math.min(K - 1, x));

function annotate(annotatorId: string, keys: readonly string[], scores: readonly number[]): Annotation[] {
  return keys.map((itemKey, i) => ({ itemKey, annotatorId, score: scores[i]! }));
}

const annotations: Annotation[] = [
  ...annotate('A', items, truth),
  ...annotate('B', items, truth.map((t, i) => (i % 5 === 0 ? clamp(t + 1) : t))),
  ...annotate('C', items, truth.map((t, i) => (i % 7 === 0 ? clamp(t - 1) : t))),
];

const units = unitsFromItems(items.map((key) => ({ key })));
const chosen: JudgeScore[] = items.map((itemKey, i) => ({ itemKey, score: truth[i]! }));
// Baseline: every odd item scrambled by +2 (mod 5) -> clearly worse agreement.
const baseline: JudgeScore[] = items.map((itemKey, i) => ({ itemKey, score: i % 2 === 0 ? truth[i]! : (truth[i]! + 2) % 5 }));

describe('pairedJudgeDelta — constructed improvement', () => {
  it('chosen better than baseline => positive delta with lower bound > 0', () => {
    const r = pairedJudgeDelta(baseline, chosen, annotations, K, units, { seed: 36 });
    expect(num(r.chosenKappa)).toBeGreaterThan(num(r.baselineKappa));
    expect(num(r.delta.point)).toBeCloseTo(num(r.chosenKappa) - num(r.baselineKappa), 12);
    expect(num(r.delta.lo)).toBeGreaterThan(0);
    expect(r.delta.draws).toBe(2000);
    expect(r.basis.map((b) => b.annotatorId)).toEqual(['A', 'B', 'C']);
  });

  it('swapping the versions flips the sign (upper bound < 0)', () => {
    const r = pairedJudgeDelta(chosen, baseline, annotations, K, units, { seed: 36 });
    expect(num(r.delta.hi)).toBeLessThan(0);
  });

  it('identical versions => every draw has delta exactly 0 (identical draws, not independent ones)', () => {
    const r = pairedJudgeDelta(baseline, baseline, annotations, K, units, { seed: 36 });
    expect(num(r.delta.lo)).toBe(0);
    expect(num(r.delta.hi)).toBe(0);
    expect(r.delta.droppedDraws).toBe(0);
  });

  it('is reproducible for a fixed seed', () => {
    const a = pairedJudgeDelta(baseline, chosen, annotations, K, units, { seed: 36, resamples: 300 });
    const b = pairedJudgeDelta(baseline, chosen, annotations, K, units, { seed: 36, resamples: 300 });
    expect(a).toEqual(b);
  });
});

describe('pairedJudgeDelta — frozen annotator basis', () => {
  it('basis uses common usable items only; annotators below the floor there are excluded and listed', () => {
    // D rates 12 items; the baseline is unusable on 5 of them -> common overlap 7 < 10.
    const d = annotate('D', items.slice(0, 12), truth.slice(0, 12));
    const base = baseline.map((s, i) => (i < 5 ? { itemKey: s.itemKey, score: null } : s));
    const r = pairedJudgeDelta(base, chosen, [...annotations, ...d], K, units, { seed: 36, resamples: 200 });
    expect(r.commonItemKeys).toHaveLength(35);
    expect(r.unitsUsed).toBe(35);
    expect(r.excludedAnnotators).toEqual([{ annotatorId: 'D', nBaseline: 7, nChosen: 7 }]);
    expect(r.basis.map((b) => [b.annotatorId, b.nBaseline])).toEqual([
      ['A', 35],
      ['B', 35],
      ['C', 35],
    ]);
  });

  it('a basis member undefined in either version makes the whole comparison undefined (not skipped)', () => {
    // E is a constant annotator with full overlap: in the basis, but QWK(judge, E) is undefined.
    const e = annotate('E', items, items.map(() => 2));
    const ann = [...annotations, ...e];
    const r = pairedJudgeDelta(baseline, chosen, ann, K, units, { seed: 36, resamples: 200 });
    expect(r.basis.map((b) => b.annotatorId)).toContain('E');
    expect(r.baselineKappa.kind).toBe('undefined');
    expect(r.chosenKappa.kind).toBe('undefined');
    expect(r.delta.point.kind).toBe('undefined');
    expect(r.delta.lo.kind).toBe('undefined');
    // Contrast: single-version judge agreement skips the undefined pair and stays defined.
    expect(judgeAgreement(chosen, ann, K).value.kind).toBe('value');
  });

  it('a constant baseline judge => undefined delta', () => {
    const constant: JudgeScore[] = items.map((itemKey) => ({ itemKey, score: 2 }));
    const r = pairedJudgeDelta(constant, chosen, annotations, K, units, { seed: 36, resamples: 100 });
    expect(r.baselineKappa.kind).toBe('undefined');
    expect(r.delta.lo.kind).toBe('undefined');
  });
});

describe('pairedBootstrapInterval — generic', () => {
  it('evaluates both statistics on the same draw keys', () => {
    const seen: string[][] = [];
    const statA = (keys: readonly string[]): Stat => {
      seen.push([...keys]);
      return meanStat(keys.map((k) => Number(k.slice(1))));
    };
    const statB = (keys: readonly string[]): Stat => {
      // must receive exactly the keys statA just received
      const last = seen[seen.length - 1]!;
      expect(keys).toEqual(last);
      return meanStat(keys.map((k) => Number(k.slice(1)) + 1));
    };
    const r = pairedBootstrapInterval(units, statA, statB, { seed: 36, resamples: 50 });
    // statB = statA + 1 on every draw -> delta exactly 1
    expect(num(r.delta.lo)).toBeCloseTo(1, 12);
    expect(num(r.delta.hi)).toBeCloseTo(1, 12);
  });

  it('draws depend only on (seed, label, unit count, resamples), so separate comparisons share them', () => {
    expect(drawUnitIndices(units.length, { seed: 36, resamples: 10 })).toEqual(
      drawUnitIndices(units.length, { seed: 36, resamples: 10 }),
    );
  });
});
