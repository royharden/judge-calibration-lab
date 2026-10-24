import { describe, expect, it } from 'vitest';
import { actualCostUsd, type PriceBook } from '../../../src/core/plan/costBound.ts';
import { buildRunPlan, requiresExplicitConfirm, type RunPlanInput } from '../../../src/core/plan/runPlan.ts';
import { unwrap } from '../../../src/core/result.ts';
import { createCallLedger } from '../../../src/shared/callledger.ts';
import type { RunKind } from '../../../src/core/types.ts';

const book: PriceBook = [{ provider: 'anthropic', model: 'claude-small', usdPerInputMTok: 1, usdPerOutputMTok: 5, effectiveDate: '2026-01-01' }];
const itemKeys = Array.from({ length: 12 }, (_, i) => `i${i}`);
// Deterministic fixture prompt sizes (bytes) that vary per item and kind.
const bytesFor = (key: string, kind: RunKind): number => 1800 + Number(key.slice(1)) * 37 + (kind === 'order' ? 11 : 0);

function input(overrides: Partial<RunPlanInput> = {}): RunPlanInput {
  return {
    itemKeys,
    replicates: 1,
    kinds: ['score'],
    promptBytes: bytesFor,
    config: { provider: 'anthropic', model: 'claude-small', params: { maxOutputTokens: 64, temperature: 0 } },
    priceBook: book,
    ...overrides,
  };
}

describe('buildRunPlan', () => {
  it('calls = items × replicates × kinds', () => {
    const p = unwrap(buildRunPlan(input({ replicates: 3, kinds: ['repeat', 'order'] })));
    expect(p.calls).toBe(12 * 3 * 2);
    expect(p.worstCaseOutputTokens).toBe(12 * 3 * 2 * 64);
  });

  it('worst case ≥ projected for tokens and USD', () => {
    const p = unwrap(buildRunPlan(input({ replicates: 3, kinds: ['score', 'order'] })));
    expect(p.worstCaseInputTokens).toBeGreaterThanOrEqual(p.projectedInputTokens);
    expect(p.worstCaseOutputTokens).toBeGreaterThanOrEqual(p.projectedOutputTokens);
    expect(p.worstCaseUsd).toBeGreaterThanOrEqual(p.projectedUsd);
    let bytes = 0;
    for (const k of ['score', 'order'] as const) for (const key of itemKeys) bytes += bytesFor(key, k);
    expect(p.worstCaseInputTokens).toBe(bytes * 3);
  });

  it('worst case ≥ the settled cost of the same calls on a fixture (via the ledger)', () => {
    const plan = unwrap(buildRunPlan(input()));
    let t = 0;
    const ledger = createCallLedger({ now: () => t, priceBook: book, defaultCapUsd: 100 });
    unwrap(ledger.registerRun({ runId: 'run-1', owner: 'u1', judgeConfigId: 'jc', provider: 'anthropic', model: 'claude-small', maxOutputTokens: 64 }));
    const { claimToken } = unwrap(ledger.acquireRunLease('run-1'));
    let settled = 0;
    for (const key of itemKeys) {
      const bytes = bytesFor(key, 'score');
      const c = unwrap(ledger.claimAttempt({ runId: 'run-1', claimToken, itemKey: key, replicate: 0, promptBytes: bytes }));
      unwrap(ledger.markSent({ attemptId: c.attemptId, claimToken }));
      // Fixture usage: ~3.7 bytes per token in, short JSON out.
      const s = unwrap(
        ledger.settleAttempt({
          attemptId: c.attemptId,
          claimToken,
          usage: { inputTokens: Math.ceil(bytes / 3.7), outputTokens: 7 },
          rawResponse: '{"score": 3}',
          verdict: { score: 2, unusableReason: null },
        }),
      );
      expect(s.actualUsd).toBeLessThanOrEqual(c.reservedUsd);
      settled += s.actualUsd;
      t += 1000;
    }
    expect(plan.worstCaseUsd).toBeGreaterThanOrEqual(settled);
    expect(actualCostUsd({ inputTokens: 0, outputTokens: 0 }, plan.price)).toBe(0);
  });

  it('mock provider costs $0.00 and needs no explicit confirm', () => {
    const p = unwrap(buildRunPlan(input({ config: { provider: 'mock', model: 'merges-3-4', params: { maxOutputTokens: 64, mockDefect: 'merges-3-4' } }, priceBook: [] })));
    expect(p.worstCaseUsd).toBe(0);
    expect(p.projectedUsd).toBe(0);
    expect(p.price.kind).toBe('mock_free');
    expect(p.requiresExplicitConfirm).toBe(false);
    expect(p.dryRun).toBe(true);
  });

  it('live provider without a price => missing_price', () => {
    const r = buildRunPlan(input({ priceBook: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('missing_price');
  });

  it('live provider requires an explicit confirm', () => {
    expect(unwrap(buildRunPlan(input())).requiresExplicitConfirm).toBe(true);
    expect(requiresExplicitConfirm('typesafe')).toBe(true);
    expect(requiresExplicitConfirm('mock')).toBe(false);
  });

  it('rejects malformed inputs', () => {
    expect(buildRunPlan(input({ replicates: 0 })).ok).toBe(false);
    expect(buildRunPlan(input({ kinds: [] })).ok).toBe(false);
    expect(buildRunPlan(input({ kinds: ['score', 'score'] })).ok).toBe(false);
    expect(buildRunPlan(input({ itemKeys: ['a', 'a'] })).ok).toBe(false);
    expect(buildRunPlan(input({ promptBytes: () => -1 })).ok).toBe(false);
    expect(buildRunPlan(input({ config: { provider: 'anthropic', model: 'claude-small', params: { maxOutputTokens: 0 } } })).ok).toBe(false);
  });
});
