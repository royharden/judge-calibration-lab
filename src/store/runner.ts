import type { Item, JudgeConfig, Rubric, RunKind, Verdict } from '../core/types.ts';
import type { Judge, JudgeContext, JudgeResult, TruthMap } from '../core/judge/judge.ts';
import { toVerdict } from '../core/judge/judge.ts';
import { createMockJudge, medianWordCount } from '../core/judge/mock.ts';
import { buildPrompt } from '../core/judge/prompt.ts';
import { deriveStream } from '../core/prng.ts';
import { canonicalHash } from '../core/canonical.ts';
import { utf8Bytes } from '../core/sha256.ts';
import { fingerprintItem } from '../core/goldset/fingerprint.ts';
import { pairToItems, injectionToItems, type ProbeSets } from '../core/goldset/probesets.ts';
import { pairCheck } from '../core/probes/pairCheck.ts';
import { runRepeatability } from '../core/probes/repeatability.ts';
import { runScaleOrder } from '../core/probes/scaleOrder.ts';
import { runVerbosity } from '../core/probes/verbosity.ts';
import { runInjection } from '../core/probes/injection.ts';
import { buildRunPlan, type RunPlan } from '../core/plan/runPlan.ts';
import { err, fail, ok } from '../core/result.ts';
import { canStartAttempt, CHUNK_MAX_ITEMS, CHUNK_WORK_BUDGET_MS, type CallLedger } from '../shared/callledger.ts';
import type { StoreResult } from './Store.ts';

export type RunJob = { id: string; kind: RunKind; item: Item; context: JudgeContext & { cacheBypass: boolean }; ledgerReplicate: number; promptBytes: number };
export type RunnerState = { jobs: RunJob[]; results: Map<string, JudgeResult> };
export type RunnerInput = { runId: string; items: readonly Item[]; probes: ProbeSets; rubric: Rubric; config: JudgeConfig; split: 'dev' | 'heldout'; includeProbes: boolean; seed: number; truth?: TruthMap; devMedianWords?: number };
export function jobId(kind: RunKind, itemKey: string, replicate: number, presentation: string): string { return canonicalHash({ kind, itemKey, replicate, presentation }); }

/** Separate ledger replicate slots prevent score/repeat/order calls from sharing a verdict. */
export function buildJobs(input: RunnerInput): RunJob[] {
  const jobs: RunJob[] = [];
  const add = (kind: RunKind, item: Item, replicate: number, ledgerReplicate: number, presentation: 'ascending' | 'reversed' = 'ascending', lengthReference?: JudgeContext['lengthReference']): void => {
    const id = jobId(kind, item.key, replicate, presentation);
    const context = { runId: input.runId, seed: input.seed, truth: input.truth, split: input.split, presentation, replicate, lengthReference, cacheBypass: kind !== 'score' };
    const prompt = buildPrompt(item, input.rubric, presentation, deriveStream(input.seed, `runner-prompt:${id}`));
    // Serialize prompt framing as well as text; no endpoint or authentication enters a plan.
    const promptBytes = utf8Bytes(JSON.stringify({ system: prompt.system, messages: [{ role: 'user', content: prompt.user }] })).length;
    jobs.push({ id, kind, item: structuredClone(item), context, ledgerReplicate, promptBytes });
  };
  const median = input.devMedianWords ?? medianWordCount(input.items);
  for (const item of input.items) add('score', item, 0, 0, 'ascending', { kind: 'dev_median', words: median });
  if (!input.includeProbes || input.split !== 'dev') return jobs;
  for (const item of input.items) {
    for (let replicate = 0; replicate < 3; replicate++) add('repeat', item, replicate, replicate + 1);
    add('order', item, 0, 4);
    add('order', item, 1, 5, 'reversed');
  }
  for (const pair of input.probes.pairs) {
    const checked = pairCheck({ short: pair.shortText, long: pair.longText, facts: pair.facts });
    if (!checked.pass) continue;
    const items = pairToItems(pair);
    const lengthReference = { kind: 'pair_short' as const, words: checked.shortWords };
    add('verbosity', items.short, 0, 6, 'ascending', lengthReference);
    add('verbosity', items.long, 0, 6, 'ascending', lengthReference);
  }
  for (const injection of input.probes.injections) {
    const items = injectionToItems(injection);
    add('injection', items.base, 0, 7);
    add('injection', items.injected, 0, 7);
  }
  return jobs;
}
export function planJobs(jobs: readonly RunJob[], config: JudgeConfig, scoreItems: number): StoreResult<RunPlan> {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const plan = buildRunPlan({ itemKeys: jobs.map((j) => j.id), replicates: 1, kinds: ['score'], promptBytes: (id) => byId.get(id)!.promptBytes, config, priceBook: [] });
  if (!plan.ok) return plan;
  return ok({ ...plan.value, items: scoreItems, kinds: [...new Set(jobs.map((j) => j.kind))] });
}
export function runnerVerdicts(runId: string, state: RunnerState): Verdict[] {
  return state.jobs.filter((j) => j.kind === 'score' && state.results.has(j.id)).map((j) => toVerdict(runId, j.item.key, 0, state.results.get(j.id)!));
}
export function cacheKey(owner: string, config: JudgeConfig, rubric: Rubric, job: RunJob): string {
  return canonicalHash({ owner, provider: config.provider, model: config.model, decoding: config.params,
    promptTemplateVersion: config.promptTemplateVersion, rubricHash: rubric.contentHash, levelMapVersion: config.levelMapVersion,
    readout: config.scoreReadout, split: job.context.split, fingerprint: fingerprintItem(job.item), presentation: job.context.presentation, replicate: job.context.replicate });
}
export type ChunkExecution = { processed: number; remaining: number };
/** No networking in MemoryStore. The call ledger is the authority for every fresh mock call. */
export async function executeChunk(input: {
  runId: string; owner: string; state: RunnerState; config: JudgeConfig; rubric: Rubric; ledger: CallLedger;
  cache: Map<string, JudgeResult>; now: () => number; maxItems?: number;
}): Promise<StoreResult<ChunkExecution>> {
  if (input.config.provider !== 'mock') return fail('live_unavailable', 'MemoryStore cannot call live providers; connect a live Store explicitly');
  const maxItems = input.maxItems ?? CHUNK_MAX_ITEMS;
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > CHUNK_MAX_ITEMS) return fail('bad_request', `maxItems must be 1..${CHUNK_MAX_ITEMS}`);
  const lease = input.ledger.acquireRunLease(input.runId);
  if (!lease.ok) return lease;
  const claimToken = lease.value.claimToken;
  const start = input.now();
  let processed = 0;
  let activeAttempt: string | null = null;
  let sent = false;
  const judge = createMockJudge(input.config.params.mockDefect ?? 'clean');
  try {
    for (const job of input.state.jobs) {
      if (input.state.results.has(job.id)) continue;
      if (processed >= maxItems || !canStartAttempt(CHUNK_WORK_BUDGET_MS - (input.now() - start))) break;
      const key = cacheKey(input.owner, input.config, input.rubric, job);
      const cached = job.context.cacheBypass ? undefined : input.cache.get(key);
      if (cached !== undefined) { input.state.results.set(job.id, structuredClone(cached)); processed++; continue; }
      // A settled attempt can be recovered; it is never sent again even if a projection was lost.
      const settled = input.ledger.snapshot().verdicts.find((v) => v.runId === input.runId && v.itemKey === job.item.key && v.replicate === job.ledgerReplicate);
      if (settled) {
        input.state.results.set(job.id, settled.score !== null ? { kind: 'score', score: settled.score, raw: settled.raw } : { kind: 'unusable', unusable: settled.unusableReason!, raw: settled.raw });
        processed++; continue;
      }
      const claim = input.ledger.claimAttempt({ runId: input.runId, claimToken, itemKey: job.item.key, replicate: job.ledgerReplicate, promptBytes: job.promptBytes });
      if (!claim.ok) return claim;
      activeAttempt = claim.value.attemptId;
      sent = false;
      const marked = input.ledger.markSent({ attemptId: activeAttempt, claimToken });
      if (!marked.ok) return marked;
      sent = true;
      const result = await judge.score(job.item, input.rubric, job.context);
      const settledResult = input.ledger.settleAttempt({ attemptId: activeAttempt, claimToken,
        usage: { inputTokens: 0, outputTokens: 0 }, rawResponse: result.raw,
        verdict: result.kind === 'score' ? { score: result.score, unusableReason: null } : { score: null, unusableReason: result.unusable } });
      if (!settledResult.ok) return settledResult;
      input.state.results.set(job.id, result);
      if (!job.context.cacheBypass) input.cache.set(key, structuredClone(result));
      activeAttempt = null;
      sent = false;
      processed++;
    }
    return ok({ processed, remaining: input.state.jobs.length - input.state.results.size });
  } catch (error) {
    return err({ reason: sent ? 'attempt_ambiguous' : 'runner_error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    // Release first: a sent attempt is ambiguous once its lease is no longer active.
    if (activeAttempt !== null && !sent) input.ledger.failBeforeCall({ attemptId: activeAttempt, claimToken });
    input.ledger.releaseRunLease(input.runId, claimToken);
    if (activeAttempt !== null && sent) input.ledger.markAmbiguous(activeAttempt);
  }
}

/** Analyze settled probe rows by replaying them through the same M3 estimators, with no calls. */
export async function replayProbes(state: RunnerState, input: RunnerInput) {
  const replay = (kind: RunKind): Judge => ({ id: `settled:${kind}`, score(item, _rubric, ctx) {
    const result = state.results.get(jobId(kind, item.key, ctx.replicate, ctx.presentation));
    return Promise.resolve(result ?? { kind: 'unusable' as const, unusable: 'provider_error' as const, raw: 'missing settled probe result' });
  } });
  if (!input.includeProbes || input.split !== 'dev') return {};
  const items = input.items.map((i) => ({ ...i, split: 'dev' as const }));
  const options = { split: 'dev' as const, runId: input.runId, seed: input.seed };
  return {
    repeatability: await runRepeatability(replay('repeat'), items, input.rubric, options),
    scaleOrder: await runScaleOrder(replay('order'), items, input.rubric, options),
    verbosity: await runVerbosity(replay('verbosity'), [...input.probes.pairs, ...input.probes.rejectedPairs].map((p) => ({ ...p, split: 'probe' as const })), input.rubric, options),
    injection: await runInjection(replay('injection'), input.probes.injections.map((i) => ({ ...i, split: 'probe' as const })), input.rubric, options),
  };
}
