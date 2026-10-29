import { describe, expect, it } from 'vitest';
import type { Annotation, Item } from '../../../src/core/types.ts';
import {
  applyLexical,
  createLexicalJudge,
  fitLexical,
  lexicalFeature,
  overlapFeature,
  referenceText,
} from '../../../src/core/judge/lexical.ts';
import { createModalJudge, fitModal, MODAL_KAPPA_NOTE } from '../../../src/core/judge/modal.ts';
import { computeSplit } from '../../../src/core/goldset/split.ts';
import { createRubric } from '../../../src/core/rubric/rubric.ts';
import { unwrap } from '../../../src/core/result.ts';
import { generateSyntheticSet, SYNTHETIC_RUBRIC_V1 } from '../../../src/core/fixtures/synthetic.ts';
import { judgeAgreement, qwk } from '../../../src/core/judgestats/index.ts';

const syn = generateSyntheticSet(36);
const split = unwrap(computeSplit({ items: syn.items, annotations: syn.annotations, seed: 36, heldoutFraction: 0.5 })).manifest;
const rubric = unwrap(createRubric({ setId: 's', ...SYNTHETIC_RUBRIC_V1 }, syn.scale));
const ctx = { runId: 'r', replicate: 0, presentation: 'ascending' as const, seed: 36, split: 'dev' as const };

describe('lexical baseline', () => {
  const fit = unwrap(fitLexical(syn.items, split, 5));

  it('fits on dev only, with K-1 non-decreasing cut points', () => {
    expect(fit.fittedOn).toBe('dev');
    expect(fit.nDev).toBe(split.dev.length);
    expect(fit.featureKind).toBe('overlap-or-length');
    expect(fit.cutPoints).toHaveLength(4);
    for (let i = 1; i < fit.cutPoints.length; i++) expect(fit.cutPoints[i]!).toBeGreaterThanOrEqual(fit.cutPoints[i - 1]!);
  });

  it('held-out items never influence the fit', () => {
    const heldout = new Set(split.heldout);
    const scrambled: Item[] = syn.items.map((i) => (heldout.has(i.key) ? { ...i, answer: 'completely different words here' } : i));
    expect(unwrap(fitLexical(scrambled, split, 5))).toEqual(fit);
    expect(fitLexical(syn.items, { dev: [] }, 5).ok).toBe(false);
  });

  it('the overlap feature tracks the planted level (higher truth => higher mean level)', () => {
    const dev = syn.items.filter((i) => split.dev.includes(i.key));
    const mean = (t: number): number => {
      const xs = dev.filter((i) => syn.truth[i.key] === t).map((i) => applyLexical(fit, i));
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    expect(mean(4)).toBeGreaterThan(mean(0));
    expect(mean(4)).toBeGreaterThan(mean(1));
  });

  it('empty answer => lowest level; reference falls back to task text', () => {
    expect(applyLexical(fit, { taskText: 't', answer: '   ', source: 's' })).toBe(0);
    expect(referenceText({ taskText: 'task words', source: '  ' })).toBe('task words');
    expect(referenceText({ taskText: 'task words', source: 'src' })).toBe('src');
  });

  it('overlap feature = mean of unigram and bigram shares', () => {
    // answer tokens: a b c d ; reference: a b x c -> unigram 3/4, bigrams (a b, b c, c d) hits 1/3
    expect(overlapFeature({ taskText: '', source: 'a b x c', answer: 'a b c d' })).toBeCloseTo((3 / 4 + 1 / 3) / 2, 12);
    expect(overlapFeature({ taskText: '', source: 'a', answer: 'a' })).toBe(1);
    expect(overlapFeature({ taskText: '', answer: 'a' })).toBeNull();
  });

  it('duplicate cut points collapse: equal feature takes the lower level, the middle level is unreachable', () => {
    // No reference text => length feature. Word counts 1,1,1,1,5 with K = 3 => cuts [1, 1].
    const items: Item[] = [1, 1, 1, 1, 5].map((w, i) => ({ key: `k${i}`, taskText: '', answer: Array(w).fill('w').join(' ') }));
    const f = unwrap(fitLexical(items, { dev: items.map((i) => i.key) }, 3));
    expect(f.featureKind).toBe('overlap-or-length');
    expect(f.cutPoints).toEqual([1, 1]);
    expect(applyLexical(f, { taskText: '', answer: 'one' })).toBe(0);
    expect(applyLexical(f, { taskText: '', answer: 'one two three' })).toBe(2);
    expect(lexicalFeature({ taskText: '', answer: 'one two three' }, 'length')).toBe(3);
  });

  it('uses per-item length fallback during fit and apply without replacing usable overlaps', () => {
    const items: Item[] = [
      { key: 'zero', taskText: 'unrelated text', answer: 'a b' },
      { key: 'half', taskText: 'a x', answer: 'a' },
      { key: 'missing-reference', taskText: '', answer: 'a b c d' },
    ];
    // Features are [0, 1, 4], not the whole-fit word lengths [2, 1, 4].
    const f = unwrap(fitLexical(items, { dev: items.map((item) => item.key) }, 3));
    expect(f.featureKind).toBe('overlap-or-length');
    expect(f.cutPoints[0]).toBeCloseTo(2 / 3, 12);
    expect(f.cutPoints[1]).toBeCloseTo(2, 12);
    expect(lexicalFeature(items[0]!)).toBe(0);
    expect(lexicalFeature(items[1]!)).toBe(1);
    expect(lexicalFeature(items[2]!)).toBe(4);
    expect(items.map((item) => applyLexical(f, item))).toEqual([0, 1, 2]);
    // A held-out item without reference takes the same fallback even when all dev items have references.
    const allReferences = unwrap(fitLexical(items.slice(0, 2), { dev: ['zero', 'half'] }, 3));
    expect(applyLexical(allReferences, items[2]!)).toBe(2);
    // A usable reference still takes overlap even when all dev items needed length fallback.
    const noReferences = unwrap(fitLexical(items.slice(2), { dev: ['missing-reference'] }, 3));
    expect(applyLexical(noReferences, { taskText: 'a b c d e f', answer: 'a b c d e f' })).toBe(0);
  });

  it('the lexical judge emits parseable raw JSON matching applyLexical', async () => {
    const judge = createLexicalJudge(fit);
    const it0 = syn.items[0]!;
    const r = await judge.score(it0, rubric, ctx);
    expect(r).toEqual({ kind: 'score', score: applyLexical(fit, it0), raw: JSON.stringify({ score: applyLexical(fit, it0) + 1 }) });
  });
});

describe('modal baseline', () => {
  it('is the dev mode with ties to the lower level, ignoring non-dev labels', () => {
    const ann: Annotation[] = [
      { itemKey: 'd1', annotatorId: 'x', score: 1 },
      { itemKey: 'd1', annotatorId: 'y', score: 1 },
      { itemKey: 'd2', annotatorId: 'x', score: 3 },
      { itemKey: 'd2', annotatorId: 'y', score: 3 },
      { itemKey: 'h1', annotatorId: 'x', score: 4 },
      { itemKey: 'h1', annotatorId: 'y', score: 4 },
      { itemKey: 'h1', annotatorId: 'z', score: 4 },
    ];
    const f = unwrap(fitModal(ann, { dev: ['d1', 'd2'] }, 5));
    expect(f.level).toBe(1);
    expect(f.counts).toEqual([0, 2, 0, 2, 0]);
    expect(f.nLabels).toBe(4);
    expect(f.fittedOn).toBe('dev');
    expect(fitModal(ann, { dev: [] }, 5).ok).toBe(false);
  });

  it('modal kappa is undefined by construction (constant judge), never 0', async () => {
    const f = unwrap(fitModal(syn.annotations, split, 5));
    expect(f.kappaNote).toBe(MODAL_KAPPA_NOTE);
    const judge = createModalJudge(f);
    const dev = syn.items.filter((i) => split.dev.includes(i.key));
    const scores: { itemKey: string; score: number | null }[] = [];
    for (const it of dev) {
      const r = await judge.score(it, rubric, ctx);
      expect(r.kind).toBe('score');
      scores.push({ itemKey: it.key, score: r.kind === 'score' ? r.score : null });
    }
    expect(new Set(scores.map((s) => s.score)).size).toBe(1);
    const devAnn = syn.annotations.filter((a) => split.dev.includes(a.itemKey));
    const agreement = judgeAgreement(scores, devAnn, 5);
    expect(agreement.value.kind).toBe('undefined');
    const ann1 = devAnn.filter((a) => a.annotatorId === 'ann-1');
    const k = qwk(
      ann1.map(() => f.level),
      ann1.map((a) => a.score),
      5,
    );
    expect(k.kind).toBe('undefined');
  });
});
