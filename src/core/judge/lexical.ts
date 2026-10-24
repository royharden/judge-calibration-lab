// Lexical baseline (PLAN.md §3.7) — a real, cheap judge every LLM judge must beat.
//  Feature (overlap kind): mean of the unigram share and the bigram share of the answer's
//    tokens / bigrams found in the reference text (the item's source, or its task text when it
//    has no source). An answer with a single token uses the unigram share alone.
//  Feature fallback: answer word count for each item that has no usable reference text.
//    Other items keep their overlap feature, even when another item needs the fallback.
//  Fit (DEV items only): cut points = type-7 quantiles of the dev features at j/K, j=1..K-1.
//  Apply: level = number of cut points strictly below the feature, so a feature equal to a
//    cut takes the lower level and duplicate cuts collapse onto one boundary (lower level wins;
//    the level between duplicates is unreachable). Empty answer => lowest level.
//  The fit is applied to held-out items unchanged.

import type { Item, Rubric, SplitManifest } from '../types.ts';
import type { Reason, Result } from '../result.ts';
import { fail, ok } from '../result.ts';
import { bigrams, tokenize, TOKENIZER_VERSION } from '../tokenize.ts';
import { quantile7Sorted, QUANTILE_ALGO_VERSION } from '../judgestats/quantile.ts';
import type { Judge, JudgeResult } from './judge.ts';
import { formatScoreJson, parseJudgeOutput } from './parse.ts';

export const LEXICAL_ALGO_VERSION = 'lexical-overlap-quantile/v2';

export type LexicalFeatureKind = 'overlap' | 'length' | 'overlap-or-length';

export type LexicalFit = {
  kind: 'lexical';
  algoVersion: string;
  tokenizerVersion: string;
  quantileVersion: string;
  featureKind: LexicalFeatureKind;
  k: number;
  /** K-1 non-decreasing cut points. */
  cutPoints: number[];
  /** Dev items with a non-empty answer used for the fit. */
  nDev: number;
  /** Always 'dev': the fit never sees held-out items. */
  fittedOn: 'dev';
};

/** Source when present and non-empty, else task text. */
export function referenceText(item: Pick<Item, 'taskText' | 'source'>): string {
  return item.source !== undefined && item.source.trim() !== '' ? item.source : item.taskText;
}

/** Overlap feature, or null when the answer or the reference has no tokens. */
export function overlapFeature(item: Pick<Item, 'taskText' | 'source' | 'answer'>): number | null {
  const a = tokenize(item.answer);
  const ref = tokenize(referenceText(item));
  if (a.length === 0 || ref.length === 0) return null;
  const refUni = new Set(ref);
  const refBi = new Set(bigrams(ref));
  let uniHits = 0;
  for (const t of a) if (refUni.has(t)) uniHits += 1;
  const uni = uniHits / a.length;
  const ab = bigrams(a);
  if (ab.length === 0) return uni;
  let biHits = 0;
  for (const b of ab) if (refBi.has(b)) biHits += 1;
  return (uni + biHits / ab.length) / 2;
}

/** Per-item feature by default; explicit overlap / length modes remain available to callers. */
export function lexicalFeature(
  item: Pick<Item, 'taskText' | 'source' | 'answer'>,
  kind: LexicalFeatureKind = 'overlap-or-length',
): number | null {
  const words = tokenize(item.answer).length;
  if (words === 0) return null;
  if (kind === 'length') return words;
  return overlapFeature(item) ?? (kind === 'overlap-or-length' ? words : 0);
}

export type LexicalRefusal = Reason<'no_dev_items' | 'bad_level_count'>;

/** Fit cut points on the DEV items only (items outside split.dev are ignored). */
export function fitLexical(items: readonly Item[], split: Pick<SplitManifest, 'dev'>, k: number): Result<LexicalFit, LexicalRefusal> {
  if (!Number.isInteger(k) || k < 2) return fail('bad_level_count', `level count must be >= 2, got ${String(k)}`);
  const devKeys = new Set(split.dev);
  const dev = items.filter((i) => devKeys.has(i.key) && tokenize(i.answer).length > 0);
  if (dev.length === 0) return fail('no_dev_items', 'no dev item with a non-empty answer to fit the lexical baseline');
  const featureKind: LexicalFeatureKind = 'overlap-or-length';
  const features = dev.map((i) => lexicalFeature(i, featureKind)!).sort((a, b) => a - b);
  const cutPoints: number[] = [];
  for (let j = 1; j < k; j++) cutPoints.push(quantile7Sorted(features, j / k));
  return ok({
    kind: 'lexical',
    algoVersion: LEXICAL_ALGO_VERSION,
    tokenizerVersion: TOKENIZER_VERSION,
    quantileVersion: QUANTILE_ALGO_VERSION,
    featureKind,
    k,
    cutPoints,
    nDev: dev.length,
    fittedOn: 'dev',
  });
}

/** Level index for an item under a fit. */
export function applyLexical(fit: LexicalFit, item: Pick<Item, 'taskText' | 'source' | 'answer'>): number {
  const f = lexicalFeature(item, fit.featureKind);
  if (f === null) return 0;
  let level = 0;
  for (const c of fit.cutPoints) if (f > c) level += 1;
  return Math.min(level, fit.k - 1);
}

function resultFor(rubric: Rubric, index: number, k: number): JudgeResult {
  if (rubric.levels.length !== k) {
    return { kind: 'unusable', unusable: 'provider_error', raw: `baseline fitted for K=${k}, rubric has ${rubric.levels.length} levels` };
  }
  const raw = formatScoreJson(rubric.levels[index]!.value);
  const p = parseJudgeOutput(
    raw,
    rubric.levels.map((l) => l.value),
  );
  return p.kind === 'score' ? { kind: 'score', score: p.index, raw } : { kind: 'unusable', unusable: p.reason, raw };
}

/** Judge that applies a fitted lexical baseline (raw JSON goes through the strict parser). */
export function createLexicalJudge(fit: LexicalFit, id = 'baseline:lexical'): Judge {
  return {
    id,
    score(item, rubric) {
      return Promise.resolve(resultFor(rubric, applyLexical(fit, item), fit.k));
    },
  };
}

export { resultFor as baselineResult };
