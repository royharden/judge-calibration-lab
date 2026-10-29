// Cost bounds and price lookup (PLAN.md §3.11).
//
//  - projected input tokens  ≈ ceil(bytes / 4)                (planning estimate only)
//  - worst-case input tokens  = UTF-8 bytes of the full prompt (assumes ≥ 1 byte per token)
//  - worst-case output tokens = the judge config's maxOutputTokens
//  - USD = input tokens × input price + output tokens × output price, priced SEPARATELY from a
//    dated price-book entry (USD per million tokens).
//  - mock provider ⇒ $0; a live provider without a price-book entry ⇒ Err('missing_price').
//
// Actual cost is always computed from provider-reported usage × the price entry, never supplied
// by a caller (the ledger uses `actualCostUsd`).

import { err, ok, type Reason, type Result } from '../result.ts';
import { utf8Bytes } from '../sha256.ts';
import type { Provider } from '../types.ts';

export type PriceBookEntry = {
  readonly provider: Provider;
  readonly model: string;
  readonly usdPerInputMTok: number;
  readonly usdPerOutputMTok: number;
  /** ISO date (YYYY-MM-DD) from which the entry applies. */
  readonly effectiveDate: string;
  readonly sourceNote?: string;
};

export type PriceBook = readonly PriceBookEntry[];

/** Resolved price: a dated entry, or the built-in zero price of the keyless mock provider. */
export type ResolvedPrice = {
  readonly kind: 'priced' | 'mock_free';
  readonly usdPerInputMTok: number;
  readonly usdPerOutputMTok: number;
  readonly entry: PriceBookEntry | null;
};

export type Usage = { readonly inputTokens: number; readonly outputTokens: number };

/** Projected output tokens of a `{"score": n}` answer (planning estimate; capped by maxOutputTokens). */
export const PROJECTED_OUTPUT_TOKENS = 8;

export const MOCK_FREE_PRICE: ResolvedPrice = Object.freeze({ kind: 'mock_free', usdPerInputMTok: 0, usdPerOutputMTok: 0, entry: null });

function validEntry(e: PriceBookEntry): boolean {
  return Number.isFinite(e.usdPerInputMTok) && e.usdPerInputMTok >= 0 && Number.isFinite(e.usdPerOutputMTok) && e.usdPerOutputMTok >= 0;
}

/**
 * Latest valid price-book entry for (provider, model) whose effectiveDate ≤ asOf (ISO strings
 * compare lexicographically). asOf omitted ⇒ latest entry.
 */
export function findPrice(book: PriceBook, provider: Provider, model: string, asOf?: string): PriceBookEntry | null {
  let best: PriceBookEntry | null = null;
  for (const e of book) {
    if (e.provider !== provider || e.model !== model || !validEntry(e)) continue;
    if (asOf !== undefined && e.effectiveDate > asOf) continue;
    if (best === null || e.effectiveDate > best.effectiveDate) best = e;
  }
  return best;
}

/** Price for a judge: mock ⇒ $0; live provider ⇒ price-book entry or Err('missing_price'). */
export function resolvePrice(
  book: PriceBook,
  provider: Provider,
  model: string,
  asOf?: string,
): Result<ResolvedPrice, Reason<'missing_price'>> {
  if (provider === 'mock') return ok(MOCK_FREE_PRICE);
  const entry = findPrice(book, provider, model, asOf);
  if (entry === null) {
    return err({ reason: 'missing_price', message: `no price-book entry for ${provider}/${model}; a live run is blocked until one is added` });
  }
  return ok({ kind: 'priced', usdPerInputMTok: entry.usdPerInputMTok, usdPerOutputMTok: entry.usdPerOutputMTok, entry });
}

function assertCount(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer, got ${String(v)}`);
}

/** Planning estimate: ceil(bytes / 4). */
export function projectedInputTokens(promptBytes: number): number {
  assertCount('promptBytes', promptBytes);
  return Math.ceil(promptBytes / 4);
}

/** Upper bound: one token per UTF-8 byte. */
export function worstCaseInputTokens(promptBytes: number): number {
  assertCount('promptBytes', promptBytes);
  return promptBytes;
}

export function projectedOutputTokens(maxOutputTokens: number): number {
  assertCount('maxOutputTokens', maxOutputTokens);
  return Math.min(PROJECTED_OUTPUT_TOKENS, maxOutputTokens);
}

/** USD for token counts, input and output priced separately. */
export function usdFor(inputTokens: number, outputTokens: number, price: ResolvedPrice): number {
  assertCount('inputTokens', inputTokens);
  assertCount('outputTokens', outputTokens);
  return (inputTokens * price.usdPerInputMTok + outputTokens * price.usdPerOutputMTok) / 1_000_000;
}

/** Worst-case USD of one attempt: prompt bytes as input tokens + maxOutputTokens as output. */
export function worstCaseAttemptUsd(promptBytes: number, maxOutputTokens: number, price: ResolvedPrice): number {
  return usdFor(worstCaseInputTokens(promptBytes), maxOutputTokens, price);
}

/** Projected USD of one attempt. */
export function projectedAttemptUsd(promptBytes: number, maxOutputTokens: number, price: ResolvedPrice): number {
  return usdFor(projectedInputTokens(promptBytes), projectedOutputTokens(maxOutputTokens), price);
}

/** Actual cost from provider-reported usage (never caller-supplied cost). */
export function actualCostUsd(usage: Usage, price: ResolvedPrice): number {
  return usdFor(usage.inputTokens, usage.outputTokens, price);
}

/** UTF-8 byte length of a string (same encoder as the hashes; lone surrogates count as U+FFFD). */
export function utf8ByteLength(text: string): number {
  return utf8Bytes(text).length;
}

/** "$0.0000" style formatting used by the run plan. */
export function formatUsd(usd: number, digits = 4): string {
  return `$${usd.toFixed(digits)}`;
}
