// Word tokenizer (PLAN.md §3.7/§3.8): lowercase, strip Unicode punctuation, split on
// whitespace. These are word counts for the lexical baseline, length quantiles and the
// 1.5x pair check, NOT billable model tokens.

import { normalizeText } from './canonical.ts';

export const TOKENIZER_VERSION = 'nfc-lower-strip-punct-ws/v1';

/**
 * Tokens of `text`. Punctuation (Unicode category P) is deleted, not replaced by a space,
 * so "don't" -> "dont"; whitespace (any Unicode space) separates tokens.
 */
export function tokenize(text: string): string[] {
  const cleaned = normalizeText(text).toLowerCase().replace(/\p{P}+/gu, '');
  return cleaned.split(/\s+/u).filter((t) => t.length > 0);
}

export function wordCount(text: string): number {
  return tokenize(text).length;
}

/** Unigrams are the tokens themselves (copy). */
export function unigrams(tokens: readonly string[]): string[] {
  return tokens.slice();
}

/** Adjacent token pairs joined by a single space. */
export function bigrams(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]!} ${tokens[i + 1]!}`);
  return out;
}
