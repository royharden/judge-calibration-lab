// Seeded mock judges with planted defects (PLAN.md §3.7). Every mock emits RAW JSON text
// ({"score": <displayed value>}) that goes through the real strict parser (parse.ts), exactly
// like a provider response. Planted truth comes from ctx.truth (the fixture generator's truth
// map), never from annotations. All offsets are in level units and clamped to the scale.
//
//   clean            truth
//   lenient          truth + 1
//   verbosity        truth + 1 when the answer is long: >= 1.5x the pair's short text words
//                    (pair probes) or > the dev median answer words (ordinary items)
//   merges-3-4       truth level shown as 4 is scored as 3, UNLESS the rubric's level-4
//                    description contains MERGE_FIX_MARKER
//   flip-flop        with probability 0.3 a uniform random level, else truth; the draw uses
//                    stream deriveStream(ctx.seed, 'mock/flip-flop/v1:<item>:<replicate>')
//   order-sensitive  truth + 1 when the levels are presented reversed
//   injection        top level when the answer contains INJECTION_MARKER
//   constant         always the level shown as 3 (middle level when the scale has no 3)

import type { Item, MockDefect, Rubric } from '../types.ts';
import { deriveStream } from '../prng.ts';
import { wordCount } from '../tokenize.ts';
import type { Judge, JudgeContext, JudgeResult } from './judge.ts';
import { formatScoreJson, parseJudgeOutput } from './parse.ts';

export const MOCK_JUDGE_VERSION = 'mock-judges/v1';
export const MERGE_FIX_MARKER = '[[fixture:distinguish-3-4]]';
export const INJECTION_MARKER = '[[fixture:inject-top-score]]';
export const FLIP_FLOP_RATE = 0.3;
export const VERBOSITY_PAIR_RATIO = 1.5;

export const MOCK_DEFECTS: readonly MockDefect[] = [
  'clean',
  'lenient',
  'verbosity',
  'merges-3-4',
  'flip-flop',
  'order-sensitive',
  'injection',
  'constant',
];

function clamp(i: number, k: number): number {
  return Math.min(k - 1, Math.max(0, i));
}

function indexOfValue(rubric: Rubric, value: number): number {
  return rubric.levels.findIndex((l) => l.value === value);
}

/**
 * Median answer word count of the given items (callers pass DEV items only) — the
 * `dev_median` length reference of the verbosity mock. Even counts use the mean of the two
 * middle values. 0 for an empty list.
 */
export function medianWordCount(items: readonly Pick<Item, 'answer'>[]): number {
  if (items.length === 0) return 0;
  const w = items.map((i) => wordCount(i.answer)).sort((a, b) => a - b);
  const mid = Math.floor(w.length / 2);
  return w.length % 2 === 1 ? w[mid]! : (w[mid - 1]! + w[mid]!) / 2;
}

/** True when the verbosity mock treats the answer as "long" in this context. */
export function isLongAnswer(item: Item, ctx: JudgeContext): boolean {
  const ref = ctx.lengthReference;
  if (ref === undefined) return false;
  const words = wordCount(item.answer);
  return ref.kind === 'pair_short' ? words >= VERBOSITY_PAIR_RATIO * ref.words : words > ref.words;
}

/** Semantic index the mock intends to output, or null when it has no planted truth. */
export function mockIntendedIndex(defect: MockDefect, item: Item, rubric: Rubric, ctx: JudgeContext): number | null {
  const k = rubric.levels.length;
  const truth = ctx.truth !== undefined && Object.hasOwn(ctx.truth, item.key) ? ctx.truth[item.key] : undefined;
  if (truth === undefined || !Number.isInteger(truth) || truth < 0 || truth >= k) return null;
  switch (defect) {
    case 'clean':
      return truth;
    case 'lenient':
      return clamp(truth + 1, k);
    case 'verbosity':
      return isLongAnswer(item, ctx) ? clamp(truth + 1, k) : truth;
    case 'merges-3-4': {
      const i4 = indexOfValue(rubric, 4);
      const i3 = indexOfValue(rubric, 3);
      if (i4 < 0 || i3 < 0 || truth !== i4) return truth;
      return rubric.levels[i4]!.description.includes(MERGE_FIX_MARKER) ? truth : i3;
    }
    case 'flip-flop': {
      const rng = deriveStream(ctx.seed, `mock/flip-flop/v1:${item.key}:${ctx.replicate}`);
      return rng.nextFloat() < FLIP_FLOP_RATE ? rng.int(k) : truth;
    }
    case 'order-sensitive':
      return ctx.presentation === 'reversed' ? clamp(truth + 1, k) : truth;
    case 'injection':
      return item.answer.includes(INJECTION_MARKER) ? k - 1 : truth;
    case 'constant': {
      const i3 = indexOfValue(rubric, 3);
      return i3 >= 0 ? i3 : Math.floor((k - 1) / 2);
    }
  }
}

/** Raw text the mock "returns" (what a provider body would contain). */
export function mockRaw(defect: MockDefect, item: Item, rubric: Rubric, ctx: JudgeContext): string | null {
  const idx = mockIntendedIndex(defect, item, rubric, ctx);
  return idx === null ? null : formatScoreJson(rubric.levels[idx]!.value);
}

/** Synchronous scoring (same result the async judge resolves to). */
export function mockScoreSync(defect: MockDefect, item: Item, rubric: Rubric, ctx: JudgeContext): JudgeResult {
  const raw = mockRaw(defect, item, rubric, ctx);
  if (raw === null) return { kind: 'unusable', unusable: 'provider_error', raw: `mock: no planted truth for item "${item.key}"` };
  const parsed = parseJudgeOutput(
    raw,
    rubric.levels.map((l) => l.value),
  );
  return parsed.kind === 'score' ? { kind: 'score', score: parsed.index, raw } : { kind: 'unusable', unusable: parsed.reason, raw };
}

export function createMockJudge(defect: MockDefect, id: string = `mock:${defect}`): Judge {
  return {
    id,
    score(item, rubric, ctx) {
      return Promise.resolve(mockScoreSync(defect, item, rubric, ctx));
    },
  };
}

/**
 * Judge that replays a fixed raw string per item (malformed-output fixtures): the raw text
 * goes through the strict parser unchanged.
 */
export function createReplayJudge(rawByItem: Readonly<Record<string, string>>, id = 'mock:replay'): Judge {
  return {
    id,
    score(item, rubric) {
      const raw = Object.hasOwn(rawByItem, item.key) ? rawByItem[item.key] ?? '' : '';
      const parsed = parseJudgeOutput(
        raw,
        rubric.levels.map((l) => l.value),
      );
      const result: JudgeResult =
        parsed.kind === 'score' ? { kind: 'score', score: parsed.index, raw } : { kind: 'unusable', unusable: parsed.reason, raw };
      return Promise.resolve(result);
    },
  };
}
