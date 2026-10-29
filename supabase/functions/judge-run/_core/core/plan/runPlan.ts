// Run plan (PLAN.md §3.11): shown BEFORE any run starts; dry-run is the default and a live
// (non-mock) run requires an explicit confirm.
//
//   calls             = items × replicates × kinds
//   projected tokens  ≈ Σ ceil(promptBytes / 4) input, min(8, maxOutputTokens) output per call
//   worst-case tokens = Σ promptBytes input (≥ 1 byte per token), maxOutputTokens output per call
//   USD               = priced separately (input, output) from the price book; mock ⇒ $0
//
// Prompt construction lives in judge/prompt.ts (another milestone); the caller passes
// `promptBytes(itemKey, kind)` = UTF-8 byte length of the FULL prompt (system + user) for that call.

import { err, ok, type Reason, type Result } from '../result.ts';
import type { JudgeConfig, RunKind } from '../types.ts';
import {
  projectedInputTokens,
  projectedOutputTokens,
  resolvePrice,
  usdFor,
  worstCaseInputTokens,
  type PriceBook,
  type ResolvedPrice,
} from './costBound.ts';

export type RunPlanInput = {
  itemKeys: readonly string[];
  /** Replicates per item (repeatability probe uses 3). */
  replicates: number;
  kinds: readonly RunKind[];
  /** UTF-8 bytes of the full prompt for this item (and kind; prompts may differ per kind). */
  promptBytes: (itemKey: string, kind: RunKind) => number;
  config: Pick<JudgeConfig, 'provider' | 'model' | 'params'>;
  priceBook: PriceBook;
  /** ISO date for the price lookup; default latest entry. */
  asOf?: string;
};

export type RunPlan = {
  provider: JudgeConfig['provider'];
  model: string;
  items: number;
  replicates: number;
  kinds: RunKind[];
  calls: number;
  projectedInputTokens: number;
  projectedOutputTokens: number;
  worstCaseInputTokens: number;
  worstCaseOutputTokens: number;
  projectedUsd: number;
  worstCaseUsd: number;
  /** Largest single-call worst case (what one claim reserves at most). */
  maxCallWorstCaseUsd: number;
  price: ResolvedPrice;
  /** Always true: the plan is a dry run until the user confirms. */
  dryRun: true;
  /** true for every non-mock provider: a live run needs an explicit confirm action. */
  requiresExplicitConfirm: boolean;
};

export type RunPlanError = Reason<'missing_price' | 'bad_request'>;

/** A live (non-mock) run needs an explicit confirm. */
export function requiresExplicitConfirm(provider: JudgeConfig['provider']): boolean {
  return provider !== 'mock';
}

export function buildRunPlan(input: RunPlanInput): Result<RunPlan, RunPlanError> {
  const { config } = input;
  if (!Number.isInteger(input.replicates) || input.replicates < 1) {
    return err({ reason: 'bad_request', message: `replicates must be a positive integer, got ${String(input.replicates)}` });
  }
  if (input.kinds.length === 0) return err({ reason: 'bad_request', message: 'at least one run kind is required' });
  if (new Set(input.kinds).size !== input.kinds.length) return err({ reason: 'bad_request', message: 'duplicate run kinds' });
  if (new Set(input.itemKeys).size !== input.itemKeys.length) return err({ reason: 'bad_request', message: 'duplicate item keys' });
  const maxOut = config.params.maxOutputTokens;
  if (!Number.isInteger(maxOut) || maxOut < 1) {
    return err({ reason: 'bad_request', message: `maxOutputTokens must be a positive integer, got ${String(maxOut)}` });
  }

  const priced = resolvePrice(input.priceBook, config.provider, config.model, input.asOf);
  if (!priced.ok) return priced;
  const price = priced.value;

  let projIn = 0;
  let worstIn = 0;
  let maxCallBytes = 0;
  for (const kind of input.kinds) {
    for (const key of input.itemKeys) {
      const bytes = input.promptBytes(key, kind);
      if (!Number.isInteger(bytes) || bytes < 0) {
        return err({ reason: 'bad_request', message: `promptBytes(${key}, ${kind}) must be a non-negative integer, got ${String(bytes)}` });
      }
      // The same prompt is sent once per replicate (replicate ids differ, bytes do not).
      projIn += projectedInputTokens(bytes) * input.replicates;
      worstIn += worstCaseInputTokens(bytes) * input.replicates;
      if (bytes > maxCallBytes) maxCallBytes = bytes;
    }
  }
  const calls = input.itemKeys.length * input.replicates * input.kinds.length;
  const projOut = projectedOutputTokens(maxOut) * calls;
  const worstOut = maxOut * calls;

  return ok({
    provider: config.provider,
    model: config.model,
    items: input.itemKeys.length,
    replicates: input.replicates,
    kinds: [...input.kinds],
    calls,
    projectedInputTokens: projIn,
    projectedOutputTokens: projOut,
    worstCaseInputTokens: worstIn,
    worstCaseOutputTokens: worstOut,
    projectedUsd: usdFor(projIn, projOut, price),
    worstCaseUsd: usdFor(worstIn, worstOut, price),
    maxCallWorstCaseUsd: calls === 0 ? 0 : usdFor(maxCallBytes, maxOut, price),
    price,
    dryRun: true,
    requiresExplicitConfirm: requiresExplicitConfirm(config.provider),
  });
}
