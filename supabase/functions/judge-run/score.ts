import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.47.10';
import type { Item } from './_core/core/types.ts';
import { canonicalHash } from './_core/core/canonical.ts';
import { fingerprintItem } from './_core/core/goldset/fingerprint.ts';
import { checkProbeBaseItems, pairToItems, injectionToItems } from './_core/core/goldset/probesets.ts';
import { pairCheck } from './_core/core/probes/pairCheck.ts';
import { medianWordCount } from './_core/core/judge/mock.ts';
import { buildRequest } from './_core/shared/providers.ts';
import { utf8Bytes } from './_core/core/sha256.ts';
import { planForServerJobs } from './serverPlan.ts';
import { canStartAttempt, CHUNK_WORK_BUDGET_MS } from './_core/shared/callledger.ts';
import { ApiFault, rpc } from './runtime.ts';
import type { LiveJob, RunBundle } from './contracts.ts';
import { providerConnection, type ProviderCall } from './providers/transport.ts';
import { callAnthropic } from './providers/anthropic.ts';
import { callOpenAICompatible } from './providers/openaiCompatible.ts';
import { callTypesafe } from './providers/typesafe.ts';

export function buildServerJobs(bundle: RunBundle): LiveJob[] {
  const { set, run } = bundle;
  if (!set.split) throw new ApiFault('prerequisite_missing', 'set must be frozen');
  const linked = checkProbeBaseItems(set.probeSets, set.split);
  if (!linked.ok) throw new ApiFault('bad_request', 'probe links reference held-out or unknown base items');
  const wanted = new Set(set.split[run.split]);
  const items = set.items.filter((i) => wanted.has(i.key));
  const jobs: LiveJob[] = [];
  const median = medianWordCount(set.items.filter((i) => set.split!.dev.includes(i.key)));
  const add = (kind: LiveJob['kind'], item: Item, replicate: number, ledgerReplicate: number, presentation: LiveJob['presentation'] = 'ascending', lengthReference?: LiveJob['lengthReference']) => {
    jobs.push({ id: canonicalHash({ kind, itemKey: item.key, replicate, presentation }), kind, item, replicate, ledgerReplicate, presentation, cacheBypass: kind !== 'score', ...(lengthReference ? { lengthReference } : {}) });
  };
  for (const item of items) add('score', item, 0, 0, 'ascending', { kind: 'dev_median', words: median });
  if (run.split !== 'dev' || !run.includeProbes) return jobs;
  for (const item of items) { for (let r = 0; r < 3; r++) add('repeat', item, r, r + 1); add('order', item, 0, 4); add('order', item, 1, 5, 'reversed'); }
  for (const pair of set.probeSets.pairs) {
    const check = pairCheck({ short: pair.shortText, long: pair.longText, facts: pair.facts });
    if (!check.pass) continue;
    const pairItems = pairToItems(pair); const length = { kind: 'pair_short' as const, words: check.shortWords };
    add('verbosity', pairItems.short, 0, 6, 'ascending', length); add('verbosity', pairItems.long, 0, 6, 'ascending', length);
  }
  for (const injection of set.probeSets.injections) { const i = injectionToItems(injection); add('injection', i.base, 0, 7); add('injection', i.injected, 0, 7); }
  return jobs;
}
export function serverCacheKey(owner: string, b: RunBundle, job: LiveJob): string {
  const config = b.config;
  return canonicalHash({ owner, provider: config.provider, model: config.model, decoding: config.params, promptTemplateVersion: config.promptTemplateVersion,
    rubricHash: b.rubric.contentHash, levelMapVersion: config.levelMapVersion, readout: config.scoreReadout, split: b.run.split,
    fingerprint: fingerprintItem(job.item), presentation: job.presentation, replicate: job.replicate });
}
export async function scoreAction(client: SupabaseClient, owner: string, body: Record<string, unknown>) {
  const started = Date.now();
  const runId = String(body.run_id);
  const maxItems = body.max_items ?? 10;
  if (typeof maxItems !== 'number' || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 10) throw new ApiFault('bad_request', 'max_items must be an integer from 1 to 10');
  let bundle = await rpc<RunBundle>(client, 'server_run_bundle', { runId });
  if (bundle.config.provider === 'mock') throw new ApiFault('bad_request', 'mock judges require explicit offline demo; live execution does not invent fixture truth');
  providerConnection(bundle.config); // Resolve required secrets before any claim or mark_sent.
  const jobs = buildServerJobs(bundle);
  const bytes = new Map(jobs.map((job) => [job.id, utf8Bytes(JSON.stringify(buildRequest(job.item, bundle.rubric, bundle.config, job.presentation).body)).length]));
  const plan = planForServerJobs(bundle, jobs, (id) => bytes.get(id)!, bundle.set.split![bundle.run.split].length);
  if (!plan.ok) throw new ApiFault(plan.error.reason, plan.error.message);
  await rpc(client, 'ensure_run_jobs', { runId, jobs, plan: plan.value });
  bundle = await rpc<RunBundle>(client, 'server_run_bundle', { runId });
  if (bundle.run.status === 'complete') return progress(bundle, 0);
  const lease = await rpc<{ claimToken: number }>(client, 'acquire_run_lease', { runId, requestId: body.request_id });
  let activeAttempt: string | null = null;
  let sent = false;
  let processed = 0;
  let knownComplete = false;
  let leaseReleased = false;
  const completed = new Set(bundle.jobVerdicts.map((v) => v.jobId));
  try {
    for (const job of jobs) {
      if (completed.has(job.id)) continue;
      if (processed >= maxItems || !canStartAttempt(CHUNK_WORK_BUDGET_MS - (Date.now() - started))) break;
      const cacheKey = serverCacheKey(owner, bundle, job);
      const claimed = await rpc<{ attemptId: string }>(client, 'claim_attempt', { runId, claimToken: lease.claimToken, itemKey: job.id, replicate: job.ledgerReplicate, promptBytes: bytes.get(job.id)!, cacheKey });
      activeAttempt = claimed.attemptId; sent = false;
      await rpc(client, 'mark_sent', { attemptId: activeAttempt, claimToken: lease.claimToken }); sent = true;
      let call: ProviderCall;
      if (bundle.config.provider === 'anthropic') call = await callAnthropic(job.item, bundle.rubric, bundle.config, job.presentation);
      else if (bundle.config.provider === 'typesafe') call = await callTypesafe(job.item, bundle.rubric, bundle.config, job.presentation);
      else call = await callOpenAICompatible(job.item, bundle.rubric, bundle.config, job.presentation);
      if (call.usage === null) {
        const unresolvedAttempt = activeAttempt;
        await rpc(client, 'release_run_lease', { runId, claimToken: lease.claimToken, status: 'paused' });
        leaseReleased = true;
        await rpc(client, 'mark_ambiguous', { attemptId: activeAttempt, rawResponse: call.result.raw, providerRaw: call.rawResponse, reportedModel: call.reportedModel, unusableReason: call.result.kind === 'unusable' ? call.result.unusable : null });
        activeAttempt = null;
        throw new ApiFault('attempt_ambiguous', `Attempt ${unresolvedAttempt}: provider usage is missing after a sent call; reservation retained for explicit owner resolution`, true);
      }
      await rpc(client, 'settle_attempt', { attemptId: activeAttempt, claimToken: lease.claimToken, usage: call.usage, rawResponse: call.result.raw, providerRaw: call.rawResponse, reportedModel: call.reportedModel,
        score: call.result.kind === 'score' ? call.result.score : null, unusableReason: call.result.kind === 'unusable' ? call.result.unusable : null, cacheKey });
      activeAttempt = null; sent = false; processed++; completed.add(job.id);
    }
    knownComplete = completed.size === jobs.length;
    const after = await rpc<RunBundle>(client, 'server_run_bundle', { runId });
    return progress(after, processed);
  } catch (error) {
    if (activeAttempt !== null && sent) throw new ApiFault('attempt_ambiguous', `Attempt ${activeAttempt}: atomic settlement was not confirmed; resolve explicitly before resuming (${error instanceof Error ? error.message : String(error)})`, true);
    throw error;
  } finally {
    // A sent call with no atomic settlement is never replayed on resume.
    if (activeAttempt !== null && !sent) await rpc(client, 'fail_before_call', { attemptId: activeAttempt, claimToken: lease.claimToken });
    if (!leaseReleased) await rpc(client, 'release_run_lease', { runId, claimToken: lease.claimToken, status: knownComplete ? 'complete' : 'paused' });
    if (activeAttempt !== null && sent) await rpc(client, 'mark_ambiguous', { attemptId: activeAttempt });
  }
}
function progress(b: RunBundle, processed: number) {
  if (!b.budget) throw new ApiFault('prerequisite_missing', 'server budget receipt missing');
  return { run_id: b.run.id, status: b.run.status === 'complete' ? 'complete' : 'paused', processed, remaining: b.jobs.length - b.jobVerdicts.length,
    unusable_count: b.jobVerdicts.filter((v) => v.score === null).length, spent_usd: b.budget.spentUsd, reserved_usd: b.budget.reservedUsd };
}
