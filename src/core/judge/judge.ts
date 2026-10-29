// Judge interface (PLAN.md §3.7). A judge scores ONE item against ONE rubric version in a
// context (presentation order, replicate, seed) and returns either a usable level INDEX or an
// unusable reason code, always with the raw text it produced (never repaired).
// Network adapters live in src/shared/providers.ts (pure builders/parsers) and the edge
// function (fetch); this module stays pure.

import type { Item, Presentation, Rubric, Split, UnusableReason, Verdict } from '../types.ts';

/** Planted true level index per item key (fixtures only; never derived from annotations). */
export type TruthMap = Readonly<Record<string, number>>;

/** Reference length for the verbosity mock (PLAN.md §3.7). */
export type LengthReference =
  /** Pair probe: +1 when answer words >= 1.5x the pair's short text words. */
  | { kind: 'pair_short'; words: number }
  /** Ordinary item: +1 when answer words > the dev median answer length. */
  | { kind: 'dev_median'; words: number };

export type JudgeContext = {
  runId: string;
  /** Replicate id (repeatability probe uses 3 distinct ids). */
  replicate: number;
  /** Order in which rubric levels are shown (scale-order probe uses 'reversed'). */
  presentation: Presentation;
  /** Run seed; seeded judges derive per-item/per-replicate streams from it. */
  seed: number;
  split: Split;
  /** Mock judges only: planted truth from the fixture generator. */
  truth?: TruthMap;
  /** Verbosity mock only. */
  lengthReference?: LengthReference;
};

export type JudgeResult =
  | { kind: 'score'; /** Level index 0..K-1. */ score: number; raw: string }
  | { kind: 'unusable'; unusable: UnusableReason; raw: string };

export type Judge = {
  /** Stable identifier (config hash or baseline name). */
  id: string;
  score(item: Item, rubric: Rubric, ctx: JudgeContext): Promise<JudgeResult>;
};

export function isUsable(r: JudgeResult): r is Extract<JudgeResult, { kind: 'score' }> {
  return r.kind === 'score';
}

/** Verdict row for a judge result (exactly one of score / unusableReason non-null). */
export function toVerdict(runId: string, itemKey: string, replicate: number, r: JudgeResult): Verdict {
  return r.kind === 'score'
    ? { runId, itemKey, replicate, score: r.score, unusableReason: null, raw: r.raw }
    : { runId, itemKey, replicate, score: null, unusableReason: r.unusable, raw: r.raw };
}

/** Run a judge over items sequentially (one call at a time, as the edge function does). */
export async function scoreAll(judge: Judge, items: readonly Item[], rubric: Rubric, ctx: JudgeContext): Promise<Verdict[]> {
  const out: Verdict[] = [];
  for (const it of items) out.push(toVerdict(ctx.runId, it.key, ctx.replicate, await judge.score(it, rubric, ctx)));
  return out;
}
