// Verbosity-pair equivalence check (PLAN.md §3.8). A short/long pair is REJECTED when:
//   1. short_in_long  — the short text is contained in the long text after normalisation
//                       (tokenize(): NFC, lowercase, punctuation stripped, whitespace split;
//                       containment is on whole-token boundaries) — catches padded filler;
//   2. missing_fact   — any `facts` string is absent from either text (same normalisation,
//                       contiguous token match);
//   3. length_ratio   — long has fewer than 1.5x the short's whitespace words;
//   (+ empty_text     — either text has no words, so the other rules cannot apply).
// Every failing rule is reported. Passing is a necessary check, not proof of semantic
// equivalence (LIMITATIONS.md).
//
// Written in M2 because fixtures and mocks need it; M3 owns the other probes.

import { tokenize } from '../tokenize.ts';

export const PAIR_CHECK_VERSION = 'pair-check/v1';
export const PAIR_MIN_RATIO = 1.5;

export type PairRejectReason = 'empty_text' | 'short_in_long' | 'missing_fact' | 'length_ratio';

export type PairCheckInput = { short: string; long: string; facts?: readonly string[] };

export type PairCheckResult = {
  pass: boolean;
  reasons: PairRejectReason[];
  shortWords: number;
  longWords: number;
  /** long / short word ratio; null when short has no words. */
  ratio: number | null;
  /** Facts missing from short or long (as given). */
  missingFacts: string[];
};

function joined(tokens: readonly string[]): string {
  return ` ${tokens.join(' ')} `;
}

/** Whole-token containment of `needle` in `hay` (both token lists). Empty needle => false. */
export function containsTokens(hay: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false;
  return joined(hay).includes(joined(needle));
}

export function pairCheck(input: PairCheckInput): PairCheckResult {
  const s = tokenize(input.short);
  const l = tokenize(input.long);
  const reasons: PairRejectReason[] = [];
  const missingFacts: string[] = [];

  if (s.length === 0 || l.length === 0) reasons.push('empty_text');
  if (s.length > 0 && containsTokens(l, s)) reasons.push('short_in_long');
  for (const f of input.facts ?? []) {
    const ft = tokenize(f);
    if (!containsTokens(s, ft) || !containsTokens(l, ft)) missingFacts.push(f);
  }
  if (missingFacts.length > 0) reasons.push('missing_fact');
  if (s.length > 0 && l.length < PAIR_MIN_RATIO * s.length) reasons.push('length_ratio');

  return {
    pass: reasons.length === 0,
    reasons,
    shortWords: s.length,
    longWords: l.length,
    ratio: s.length === 0 ? null : l.length / s.length,
    missingFacts,
  };
}
