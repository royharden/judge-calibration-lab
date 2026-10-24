import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { unwrap } from '../../src/core/result.ts';
import type { JudgeConfig } from '../../src/core/types.ts';
import type { PriceBookEntry } from '../../src/core/plan/costBound.ts';
import type { LiveJob } from '../../supabase/functions/judge-run/contracts.ts';
import { planForServerJobs } from '../../supabase/functions/judge-run/serverPlan.ts';

const config: JudgeConfig = { id: 'judge', configHash: 'hash', provider: 'anthropic', model: 'priced-model', params: { maxOutputTokens: 64 },
  promptTemplateVersion: 'prompt', outputSchemaVersion: 'output', levelMapVersion: 'levels', scoreReadout: 'json_score' };
const jobs: LiveJob[] = [{ id: 'job', kind: 'score', item: { key: 'answer', taskText: 'task', answer: 'answer' },
  replicate: 0, ledgerReplicate: 0, presentation: 'ascending', cacheBypass: false }];
const originalPrice: PriceBookEntry = { provider: 'anthropic', model: 'priced-model', usdPerInputMTok: 1, usdPerOutputMTok: 5, effectiveDate: '2026-01-01' };
const newerPrice: PriceBookEntry = { ...originalPrice, usdPerInputMTok: 4, usdPerOutputMTok: 20, effectiveDate: '2026-10-24' };
const promptBytes = () => 1000;

describe('installed server plan reuse', () => {
  it('keeps the saved estimate after a dated price change while fresh installations use the latest price', () => {
    // what_bug_this_catches: repricing a resumed chunk fails the immutable SQL plan equality check forever.
    const original = unwrap(planForServerJobs({ config, jobs: [], prices: [originalPrice], run: { plan: null } }, jobs, promptBytes, 1));
    const prices = [originalPrice, newerPrice];
    const fresh = unwrap(planForServerJobs({ config, jobs: [], prices, run: { plan: null } }, jobs, promptBytes, 1));
    expect(fresh.price.entry?.effectiveDate).toBe(newerPrice.effectiveDate);
    expect(fresh.worstCaseUsd).toBe(original.worstCaseUsd * 4);
    const resumed = unwrap(planForServerJobs({ config, jobs, prices, run: { plan: original } }, jobs, promptBytes, 1));
    expect(resumed).toBe(original);
    expect(resumed.price.entry?.effectiveDate).toBe(originalPrice.effectiveDate);
    expect(resumed).not.toEqual(fresh);
  });

  it('does not re-read prices for installed jobs, while new jobs still refuse missing prices', () => {
    const original = unwrap(planForServerJobs({ config, jobs: [], prices: [originalPrice], run: { plan: null } }, jobs, promptBytes, 1));
    const installed = { config, jobs, run: { plan: original }, get prices(): PriceBookEntry[] { throw new Error('installed plan must not reprice'); } };
    expect(unwrap(planForServerJobs(installed, jobs, promptBytes, 1))).toBe(original);
    expect(planForServerJobs({ config, jobs: [], prices: [], run: { plan: null } }, jobs, promptBytes, 1)).toMatchObject({ ok: false, error: { reason: 'missing_price' } });
    expect(planForServerJobs({ config, jobs, prices: [], run: { plan: null } }, jobs, promptBytes, 1)).toMatchObject({ ok: false, error: { reason: 'bad_request' } });
  });

  it('wires the tested plan selection into score without sending a price override to claims', () => {
    const source = readFileSync(new URL('../../supabase/functions/judge-run/score.ts', import.meta.url), 'utf8');
    expect(source).toContain('const plan = planForServerJobs(bundle, jobs,');
    expect(source).toContain("'ensure_run_jobs', { runId, jobs, plan: plan.value }");
    const claim = /'claim_attempt',\s*\{([^}]+)\}/.exec(source)?.[1] ?? '';
    expect(claim).toContain('promptBytes: bytes.get(job.id)!');
    expect(claim).not.toMatch(/price|plan/i);
    expect(source).toContain('call.usage === null');
    expect(source).toContain('usage: call.usage');
  });
});
