// Word tokenizer (PLAN.md §3.7/§3.8): lowercase, strip Unicode punctuation, split on
// whitespace. Normalized token counts serve the lexical baseline and length quantiles;
// the 1.5x pair check uses whitespaceWordCount instead. Neither counts billable model tokens.

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

/** Whitespace-separated words, preserving punctuation-only segments (PLAN.md §3.8). */
export function whitespaceWordCount(text: string): number {
  return text.match(/\S+/gu)?.length ?? 0;
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
