import { describe, expect, it } from 'vitest';
import { decideJevGate, jevGate, type JevGateJudge } from '../../../src/core/heldoutlock/jevGate.ts';
import { unitsFromItems } from '../../../src/core/judgestats/bootstrap.ts';
import { undef, value } from '../../../src/core/judgestats/undefined.ts';
import type { Annotation, Interval, JudgeScore } from '../../../src/core/types.ts';

const K = 5;
const items = Array.from({ length: 40 }, (_, i) => `h${String(i).padStart(2, '0')}`);
const truth = items.map((_, i) => i % 5);
const clamp = (x: number): number => Math.max(0, Math.min(K - 1, x));
const annotate = (id: string, scores: readonly number[]): Annotation[] => items.map((itemKey, i) => ({ itemKey, annotatorId: id, score: scores[i]! }));
const annotations: Annotation[] = [
  ...annotate('A', truth),
  ...annotate('B', truth.map((t, i) => (i % 5 === 0 ? clamp(t + 1) : t))),
  ...annotate('C', truth.map((t, i) => (i % 7 === 0 ? clamp(t - 1) : t))),
];
const units = unitsFromItems(items.map((key) => ({ key })));
const perfect: JudgeScore[] = items.map((itemKey, i) => ({ itemKey, score: truth[i]! }));

function judge(overrides: Partial<JevGateJudge>): JevGateJudge {
  return {
    judgeConfigHash: 'jc-gen',
    provider: 'anthropic',
    preregId: 'p-gen',
    chosenRubricHash: 'r2',
    splitHash: 'split-1',
    contentHash: 'content-1',
    confirmed: true,
    heldoutVerdicts: perfect,
    lexicalKappa: value(0.2),
    costPer100Usd: 0.5,
    ...overrides,
  };
}

const jev = judge({ judgeConfigHash: 'jc-jev', provider: 'typesafe', preregId: 'p-jev', costPer100Usd: 0.1 });
const gen = judge({});

describe('jevGate (computes κ and paired Δκ from held-out rows)', () => {
  it('identical judges: Δκ CI is [0, 0] => promoted on b1 when Jev beats lexical', () => {
    const r = jevGate({ jev, generative: gen, heldoutAnnotations: annotations, k: K, units });
    expect(r.outcome).toBe('promoted');
    expect(r.reasons).toEqual(['equivalent_within_margin']);
    expect(r.criteria).toEqual({ a: true, b1: true, b2: true });
    expect(r.delta.lo).toEqual(value(0));
    expect(r.delta.hi).toEqual(value(0));
    expect(r.commonItemCount).toBe(40);
    expect(r.basisSize).toBe(3);
    expect(r.margin).toBe(0.05);
  });

  it('lexical κ undefined => cannot assess usefulness', () => {
    const r = jevGate({ jev: { ...jev, lexicalKappa: undef('constant feature') }, generative: gen, heldoutAnnotations: annotations, k: K, units });
    expect(r.outcome).toBe('cannot_assess');
    expect(r.reasons).toEqual(['lexical_undefined']);
    expect(r.messages[0]).toContain('cannot assess usefulness');
  });

  it('Jev not above lexical => not promoted', () => {
    const r = jevGate({ jev: { ...jev, lexicalKappa: value(0.999999) }, generative: gen, heldoutAnnotations: annotations, k: K, units });
    expect(r.outcome).toBe('not_promoted');
    expect(r.reasons).toEqual(['not_better_than_lexical']);
  });

  it.each([
    ['different chosen rubric hash', { chosenRubricHash: 'r3' }, 'rubric_hash_differs'],
    ['different split', { splitHash: 'split-2' }, 'split_differs'],
    ['different content', { contentHash: 'content-2' }, 'split_differs'],
    ['unconfirmed report', { confirmed: false }, 'report_not_confirmed'],
  ] as const)('cross-judge pairing: %s => cannot assess', (_n, patch, reason) => {
    const r = jevGate({ jev: { ...jev, ...patch }, generative: gen, heldoutAnnotations: annotations, k: K, units });
    expect(r.outcome).toBe('cannot_assess');
    expect(r.reasons).toContain(reason);
  });

  it('the Jev side must be typesafe and the other side generative', () => {
    expect(jevGate({ jev: gen, generative: { ...gen, judgeConfigHash: 'jc-x' }, heldoutAnnotations: annotations, k: K, units }).reasons).toContain('jev_not_typesafe');
    expect(jevGate({ jev, generative: { ...jev, judgeConfigHash: 'jc-y' }, heldoutAnnotations: annotations, k: K, units }).reasons).toContain('generative_is_typesafe');
    expect(jevGate({ jev, generative: { ...gen, judgeConfigHash: 'jc-jev' }, heldoutAnnotations: annotations, k: K, units }).reasons).toContain('same_judge_config');
  });
});

function iv(lo: number, hi: number): Interval {
  return { lo: value(lo), hi: value(hi), point: value((lo + hi) / 2), draws: 2000, droppedDraws: 0 };
}

const base = { jevKappa: value(0.6), lexicalKappa: value(0.3), margin: 0.05 };
const cheaper = { jev: 0.1, generative: 0.5 };
const pricier = { jev: 0.9, generative: 0.5 };
const unmeasured = { jev: null, generative: 0.5 };

describe('decideJevGate (§3.12 rule)', () => {
  it('an interval that overlaps 0 is NOT equivalence', () => {
    const d = decideJevGate({ ...base, delta: iv(-0.2, 0.15), costPer100Usd: unmeasured });
    expect(d.outcome).toBe('inconclusive');
    expect(d.reasons).toEqual(['interval_straddles_margin']);
    expect(d.criteria.b1).toBe(false);
  });

  it('overlap with 0 plus lower cost is still not promoted when the lower bound is below −margin', () => {
    expect(decideJevGate({ ...base, delta: iv(-0.1, 0.03), costPer100Usd: cheaper }).outcome).toBe('inconclusive');
  });

  it('b1: whole CI within ±0.05 (inclusive) => promoted regardless of cost', () => {
    expect(decideJevGate({ ...base, delta: iv(-0.04, 0.04), costPer100Usd: pricier }).outcome).toBe('promoted');
    expect(decideJevGate({ ...base, delta: iv(-0.05, 0.05), costPer100Usd: pricier }).reasons).toEqual(['equivalent_within_margin']);
  });

  it('b2: lower bound > −0.05 and measured cheaper => promoted', () => {
    const d = decideJevGate({ ...base, delta: iv(-0.03, 0.2), costPer100Usd: cheaper });
    expect(d.outcome).toBe('promoted');
    expect(d.reasons).toEqual(['non_inferior_and_cheaper']);
    expect(d.criteria).toEqual({ a: true, b1: false, b2: true });
  });

  it('b2 boundary: lower bound exactly −0.05 is not > −0.05', () => {
    const d = decideJevGate({ ...base, delta: iv(-0.05, 0.2), costPer100Usd: cheaper });
    expect(d.outcome).toBe('inconclusive');
  });

  it('non-inferior but not cheaper => not promoted; cost not measured => inconclusive', () => {
    expect(decideJevGate({ ...base, delta: iv(-0.03, 0.2), costPer100Usd: pricier }).reasons).toEqual(['non_inferior_but_not_cheaper']);
    expect(decideJevGate({ ...base, delta: iv(-0.03, 0.2), costPer100Usd: unmeasured }).reasons).toEqual(['cost_unmeasured']);
  });

  it('CI entirely below −margin => not promoted', () => {
    expect(decideJevGate({ ...base, delta: iv(-0.3, -0.1), costPer100Usd: cheaper }).reasons).toEqual(['worse_beyond_margin']);
  });

  it('(a) fails => not promoted before looking at the CI', () => {
    const d = decideJevGate({ ...base, jevKappa: value(0.3), delta: iv(-0.01, 0.01), costPer100Usd: cheaper });
    expect(d.outcome).toBe('not_promoted');
    expect(d.reasons).toEqual(['not_better_than_lexical']);
  });

  it('lexical undefined => cannot assess; Jev κ undefined => cannot assess', () => {
    expect(decideJevGate({ ...base, lexicalKappa: undef('x'), delta: iv(-0.01, 0.01), costPer100Usd: cheaper }).outcome).toBe('cannot_assess');
    expect(decideJevGate({ ...base, jevKappa: undef('x'), delta: iv(-0.01, 0.01), costPer100Usd: cheaper }).reasons).toEqual(['jev_kappa_undefined']);
  });

  it('undefined paired interval => inconclusive', () => {
    const delta: Interval = { lo: undef('dropped'), hi: undef('dropped'), point: value(0), draws: 2000, droppedDraws: 300 };
    expect(decideJevGate({ ...base, delta, costPer100Usd: cheaper }).reasons).toEqual(['paired_interval_undefined']);
  });
});
