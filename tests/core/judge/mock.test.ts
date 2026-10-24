import { describe, expect, it } from 'vitest';
import type { Item, MockDefect } from '../../../src/core/types.ts';
import type { JudgeContext } from '../../../src/core/judge/judge.ts';
import { isUsable, scoreAll, toVerdict } from '../../../src/core/judge/judge.ts';
import {
  createMockJudge,
  createReplayJudge,
  FLIP_FLOP_RATE,
  INJECTION_MARKER,
  medianWordCount,
  MERGE_FIX_MARKER,
  MOCK_DEFECTS,
  mockScoreSync,
} from '../../../src/core/judge/mock.ts';
import { parseJudgeOutput } from '../../../src/core/judge/parse.ts';
import { createChild, createRubric } from '../../../src/core/rubric/rubric.ts';
import { unwrap } from '../../../src/core/result.ts';
import { generateSyntheticSet, SYNTHETIC_RUBRIC_V1, syntheticRubricV2Edits } from '../../../src/core/fixtures/synthetic.ts';
import { importProbeSets, injectionToItems, pairToItems } from '../../../src/core/goldset/probesets.ts';
import { wordCount } from '../../../src/core/tokenize.ts';

const syn = generateSyntheticSet(36);
const v1 = unwrap(createRubric({ setId: 's', ...SYNTHETIC_RUBRIC_V1 }, syn.scale));
const v2 = unwrap(createChild(v1, syntheticRubricV2Edits(), 'fixture repair'));
const VALUES = v1.levels.map((l) => l.value);
const ctx: JudgeContext = { runId: 'run-1', replicate: 0, presentation: 'ascending', seed: 36, split: 'dev', truth: syn.truth };

function scores(defect: MockDefect, items: readonly Item[], c: JudgeContext = ctx, rubric = v1): number[] {
  return items.map((it) => {
    const r = mockScoreSync(defect, it, rubric, c);
    if (!isUsable(r)) throw new Error(`unusable: ${r.unusable}`);
    return r.score;
  });
}

const truths = syn.items.map((i) => syn.truth[i.key]!);

describe('every mock emits raw JSON that the strict parser accepts', () => {
  it('eight defects exist', () => {
    expect([...MOCK_DEFECTS].sort()).toEqual(
      ['clean', 'constant', 'flip-flop', 'injection', 'lenient', 'merges-3-4', 'order-sensitive', 'verbosity'].sort(),
    );
  });

  for (const d of MOCK_DEFECTS) {
    it(`${d}: raw parses to the reported index`, () => {
      for (const it of syn.items.slice(0, 20)) {
        const r = mockScoreSync(d, it, v1, { ...ctx, lengthReference: { kind: 'dev_median', words: 10 } });
        expect(r.kind).toBe('score');
        const p = parseJudgeOutput(r.raw, VALUES);
        expect(p.kind === 'score' && r.kind === 'score' && p.index === r.score).toBe(true);
      }
    });
  }
});

describe('planted behaviour', () => {
  it('clean returns the planted truth', () => {
    expect(scores('clean', syn.items)).toEqual(truths);
  });

  it('lenient adds one level, clamped at the top', () => {
    expect(scores('lenient', syn.items)).toEqual(truths.map((t) => Math.min(t + 1, 4)));
  });

  it('merges-3-4 scores true level "4" (index 3) as "3" (index 2) until the marker is in level 4', () => {
    const merged = scores('merges-3-4', syn.items);
    expect(merged).toEqual(truths.map((t) => (t === 3 ? 2 : t)));
    expect(truths.filter((t) => t === 3)).toHaveLength(24);
    expect(v2.levels.find((l) => l.value === 4)!.description).toContain(MERGE_FIX_MARKER);
    expect(scores('merges-3-4', syn.items, ctx, v2)).toEqual(truths);
  });

  it('constant always returns level "3" (index 2)', () => {
    expect(new Set(scores('constant', syn.items))).toEqual(new Set([2]));
  });

  it('order-sensitive adds one level only when presentation is reversed', () => {
    expect(scores('order-sensitive', syn.items)).toEqual(truths);
    expect(scores('order-sensitive', syn.items, { ...ctx, presentation: 'reversed' })).toEqual(truths.map((t) => Math.min(t + 1, 4)));
  });

  it('injection returns the top level only for answers carrying the marker', () => {
    for (const inj of syn.injections) {
      const { base, injected } = injectionToItems(inj);
      expect(injected.answer).toContain(INJECTION_MARKER);
      expect(scores('injection', [base, injected])).toEqual([inj.truth, 4]);
      expect(scores('clean', [base, injected])).toEqual([inj.truth, inj.truth]);
    }
    expect(scores('injection', syn.items)).toEqual(truths);
  });

  it('verbosity: +1 on the long text of a pair (>= 1.5x the short words), not on the short', () => {
    const probes = importProbeSets(syn.probeFiles);
    if (!probes.ok) throw new Error('probe import failed');
    for (const pair of probes.value.pairs) {
      const { short, long } = pairToItems(pair);
      const c: JudgeContext = { ...ctx, lengthReference: { kind: 'pair_short', words: wordCount(pair.shortText) } };
      const t = syn.truth[short.key]!;
      expect(scores('verbosity', [short, long], c)).toEqual([t, Math.min(t + 1, 4)]);
      expect(scores('clean', [short, long], c)).toEqual([t, t]);
    }
  });

  it('verbosity: +1 on items longer than the dev median, none without a reference', () => {
    const median = medianWordCount(syn.items);
    const c: JudgeContext = { ...ctx, lengthReference: { kind: 'dev_median', words: median } };
    const expected = syn.items.map((it, i) => (wordCount(it.answer) > median ? Math.min(truths[i]! + 1, 4) : truths[i]!));
    expect(scores('verbosity', syn.items, c)).toEqual(expected);
    expect(scores('verbosity', syn.items)).toEqual(truths);
  });

  it('flip-flop: about 30% random draws, seeded per item and replicate', () => {
    const r0 = scores('flip-flop', syn.items);
    expect(scores('flip-flop', syn.items)).toEqual(r0);
    const r1 = scores('flip-flop', syn.items, { ...ctx, replicate: 1 });
    expect(r1).not.toEqual(r0);
    const changed = r0.filter((s, i) => s !== truths[i]).length / truths.length;
    // Expected share = 0.3 * 4/5 = 0.24 (a uniform draw equals the truth 1 time in 5).
    expect(FLIP_FLOP_RATE).toBe(0.3);
    expect(changed).toBeGreaterThan(0.1);
    expect(changed).toBeLessThan(0.4);
    expect(scores('flip-flop', syn.items, { ...ctx, seed: 37 })).not.toEqual(r0);
  });

  it('an item without planted truth is unusable (provider_error), never guessed', () => {
    const r = mockScoreSync('clean', { key: 'unknown', taskText: 't', answer: 'a' }, v1, ctx);
    expect(r).toMatchObject({ kind: 'unusable', unusable: 'provider_error' });
  });

  it('reads only own truth entries and accepts prototype-named ids when they are present', () => {
    const inherited: Record<string, number> = Object.create({ constructor: 2 }) as Record<string, number>;
    const item = { key: 'constructor', taskText: 't', answer: 'a' };
    expect(mockScoreSync('clean', item, v1, { ...ctx, truth: inherited })).toMatchObject({ kind: 'unusable', unusable: 'provider_error' });
    const truth = Object.fromEntries(['__proto__', 'constructor', 'toString'].map((key, i) => [key, i]));
    for (const [key, score] of Object.entries(truth)) {
      expect(mockScoreSync('clean', { ...item, key }, v1, { ...ctx, truth })).toMatchObject({ kind: 'score', score });
    }
  });
});

describe('async judge interface', () => {
  it('createMockJudge resolves to the sync result and scoreAll builds verdict rows', async () => {
    const judge = createMockJudge('lenient');
    const it0 = syn.items[0]!;
    expect(await judge.score(it0, v1, ctx)).toEqual(mockScoreSync('lenient', it0, v1, ctx));
    const verdicts = await scoreAll(judge, syn.items.slice(0, 5), v1, ctx);
    expect(verdicts).toHaveLength(5);
    for (const v of verdicts) {
      expect(v.runId).toBe('run-1');
      expect(v.score !== null && v.unusableReason === null).toBe(true);
    }
  });

  it('replay judge sends malformed raw text through the parser and keeps it verbatim', async () => {
    const judge = createReplayJudge({ a: '{"score": 4, "why": "x"}', b: '{"score": 4}' });
    const a = await judge.score({ key: 'a', taskText: 't', answer: 'x' }, v1, ctx);
    expect(a).toEqual({ kind: 'unusable', unusable: 'extra_keys', raw: '{"score": 4, "why": "x"}' });
    const va = toVerdict('r', 'a', 0, a);
    expect(va).toEqual({ runId: 'r', itemKey: 'a', replicate: 0, score: null, unusableReason: 'extra_keys', raw: '{"score": 4, "why": "x"}' });
    const b = await judge.score({ key: 'b', taskText: 't', answer: 'x' }, v1, ctx);
    expect(b).toEqual({ kind: 'score', score: 3, raw: '{"score": 4}' });
  });

  it('replay treats inherited item names as absent and supports own prototype-named entries', async () => {
    const missing = createReplayJudge({});
    const owned = createReplayJudge(Object.fromEntries(['__proto__', 'constructor', 'toString'].map((id) => [id, '{"score": 4}'])));
    for (const key of ['__proto__', 'constructor', 'toString']) {
      const item = { key, taskText: 't', answer: 'a' };
      expect(await missing.score(item, v1, ctx)).toEqual({ kind: 'unusable', unusable: 'empty', raw: '' });
      expect(await owned.score(item, v1, ctx)).toEqual({ kind: 'score', score: 3, raw: '{"score": 4}' });
    }
  });
});
