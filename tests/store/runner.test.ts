import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/MemoryStore.ts';
import { unwrap } from '../../src/core/result.ts';
import { createCallLedger } from '../../src/shared/callledger.ts';
import { cacheKey, buildJobs, type RunnerInput } from '../../src/store/runner.ts';
import { generateSyntheticSet } from '../../src/core/fixtures/synthetic.ts';
import { createRubric } from '../../src/core/rubric/rubric.ts';
import type { JudgeConfig } from '../../src/core/types.ts';

async function finish(store: MemoryStore, id: string) {
  for (let n = 0; n < 150; n++) { const p = unwrap(await store.runChunk({ runId: id })); if (p.status === 'complete') return; }
  throw new Error('bounded run did not complete');
}

describe('ledger-backed chunk execution and cache boundaries', () => {
  it('crash before settle becomes ambiguous, cannot resend until explicit owner resolution', async () => {
    // what_bug_this_catches: resume repeats a call whose provider effect is unknown.
    let now = 1_800_000_000_000;
    const ledger = createCallLedger({ now: () => now });
    const store = new MemoryStore({ ledger, now: () => now });
    const ids = unwrap(await store.loadDemo());
    unwrap(await store.freezeSet({ setId: ids.setId }));
    const run = unwrap(await store.createDevRun({ ...ids, includeProbes: false, confirmed: true }));
    ledger.faults.arm('settle');
    const failed = await store.runChunk({ runId: run.id, maxItems: 1 });
    expect(failed.ok).toBe(false);
    const attempt = ledger.snapshot().attempts[0]!;
    expect(attempt.state).toBe('ambiguous');
    expect(ledger.snapshot().verdicts).toHaveLength(0);
    const retry = await store.runChunk({ runId: run.id, maxItems: 1 });
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.reason).toBe('attempt_ambiguous');
    expect(ledger.snapshot().attempts).toHaveLength(1);
    unwrap(await store.resolveAmbiguous({ attemptId: attempt.attemptId, resolution: 'release' }));
    now += 1;
    await finish(store, run.id);
    expect(ledger.attemptsFor(run.id, attempt.itemKey, attempt.replicate)).toHaveLength(2);
    expect(unwrap(await store.reconcileLedger()).ok).toBe(true);
  }, 30_000);
  it('fresh repeat replicates bypass a populated score cache and retain distinct ledger identities', async () => {
    const ledger = createCallLedger({ now: () => 1_800_000_000_000 });
    const store = new MemoryStore({ ledger, now: () => 1_800_000_000_000 });
    const ids = unwrap(await store.loadDemo());
    const set = unwrap(await store.freezeSet({ setId: ids.setId }));
    const first = unwrap(await store.createDevRun({ ...ids, includeProbes: false, confirmed: true }));
    await finish(store, first.id);
    const second = unwrap(await store.createDevRun({ ...ids, includeProbes: true, confirmed: true }));
    await finish(store, second.id);
    const calls = ledger.snapshot().attempts.filter((a) => a.runId === second.id);
    expect(calls.filter((a) => a.replicate >= 1 && a.replicate <= 3)).toHaveLength(set.split!.dev.length * 3);
    expect(calls.filter((a) => a.replicate === 0)).toHaveLength(0);
    expect(calls.every((a) => a.state === 'settled')).toBe(true);
    expect(unwrap(await store.listVerdicts({ runId: second.id }))).toHaveLength(60);
    expect(unwrap(await store.getDevResults({ runId: second.id })).probes?.repeatability?.completeN).toBe(60);
  }, 30_000);
  it('refuses live execution explicitly without any mock fallback', async () => {
    const store = new MemoryStore(); const ids = unwrap(await store.loadDemo());
    unwrap(await store.freezeSet({ setId: ids.setId }));
    const original = unwrap(await store.getSnapshot()).judgeConfigs[0]!;
    const live = unwrap(await store.createJudgeConfig({ provider: 'anthropic', model: 'activation-pinned-model', params: { maxOutputTokens: 32 }, promptTemplateVersion: original.promptTemplateVersion, outputSchemaVersion: original.outputSchemaVersion, levelMapVersion: original.levelMapVersion, scoreReadout: 'json_score' }));
    const refused = await store.createDevRun({ ...ids, judgeConfigId: live.id, confirmed: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.reason).toBe('live_unavailable');
    expect(unwrap(await store.getSnapshot()).runs).toEqual([]);
  });
  it('cache keys separate split, presentation and replicate; probes are marked bypass', () => {
    const s = generateSyntheticSet(36);
    const rubric = unwrap(createRubric({ setId: 's', ...s.rubricV1 }, s.scale));
    const config: JudgeConfig = { id: 'j', configHash: 'h', provider: 'mock', model: 'mock', params: { maxOutputTokens: 32, mockDefect: 'clean' }, scoreReadout: 'json_score', promptTemplateVersion: 'p', outputSchemaVersion: 'o', levelMapVersion: 'l' };
    const input: RunnerInput = { runId: 'r', items: [s.items[0]!], probes: { pairs: [], rejectedPairs: [], injections: [] }, rubric, config, split: 'dev', includeProbes: true, seed: 36, truth: s.truth };
    const jobs = buildJobs(input);
    expect(jobs.filter((j) => j.kind === 'repeat').every((j) => j.context.cacheBypass)).toBe(true);
    expect(new Set(jobs.map((j) => j.ledgerReplicate)).size).toBe(6);
    const job = jobs[0]!;
    const a = cacheKey('owner', config, rubric, job);
    expect(cacheKey('owner', config, rubric, { ...job, context: { ...job.context, split: 'heldout' } })).not.toBe(a);
    expect(cacheKey('owner', config, rubric, { ...job, context: { ...job.context, replicate: 2 } })).not.toBe(a);
    expect(cacheKey('owner', config, rubric, { ...job, context: { ...job.context, presentation: 'reversed' } })).not.toBe(a);
  });
});
