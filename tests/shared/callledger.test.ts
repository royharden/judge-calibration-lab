import { beforeEach, describe, expect, it } from 'vitest';
import type { PriceBook } from '../../src/core/plan/costBound.ts';
import { unwrap } from '../../src/core/result.ts';
import {
  canStartAttempt,
  createCallLedger,
  DEFAULT_CAP_USD,
  DEFAULT_LEASE_MS,
  InjectedFaultError,
  MAX_ATTEMPTS_PER_ITEM,
  type CallLedger,
} from '../../src/shared/callledger.ts';

// $1 / MTok in, $5 / MTok out: a 1,000-byte prompt with 64 max output tokens reserves
// (1000 × 1 + 64 × 5) / 1e6 = $0.00132.
const book: PriceBook = [{ provider: 'anthropic', model: 'claude-small', usdPerInputMTok: 1, usdPerOutputMTok: 5, effectiveDate: '2026-01-01' }];
const WORST_1000 = (1000 * 1 + 64 * 5) / 1e6;

let t = 0;
let ledger: CallLedger;

function register(runId = 'run-1', provider: 'anthropic' | 'mock' | 'openai_compatible' = 'anthropic', judgeConfigId = 'jc-1'): void {
  unwrap(ledger.registerRun({ runId, owner: 'u1', judgeConfigId, provider, model: provider === 'mock' ? 'merges-3-4' : 'claude-small', maxOutputTokens: 64 }));
}

function claimSend(token: number, itemKey: string, replicate = 0, runId = 'run-1'): string {
  const c = unwrap(ledger.claimAttempt({ runId, claimToken: token, itemKey, replicate, promptBytes: 1000 }));
  unwrap(ledger.markSent({ attemptId: c.attemptId, claimToken: token }));
  return c.attemptId;
}

function settle(attemptId: string, token: number, inputTokens = 300, outputTokens = 6): number {
  return unwrap(
    ledger.settleAttempt({ attemptId, claimToken: token, usage: { inputTokens, outputTokens }, rawResponse: '{"score": 4}', verdict: { score: 3, unusableReason: null } }),
  ).actualUsd;
}

beforeEach(() => {
  t = 1_000_000;
  ledger = createCallLedger({ now: () => t, priceBook: book });
});

describe('budget-time guard', () => {
  it('starts an attempt only when remaining ≥ 20 s timeout + 5 s margin', () => {
    expect(canStartAttempt(25_000)).toBe(true);
    expect(canStartAttempt(24_999)).toBe(false);
    expect(canStartAttempt(0)).toBe(false);
    expect(canStartAttempt(45_000)).toBe(true);
    expect(canStartAttempt(10_000, 5_000, 5_000)).toBe(true);
    expect(canStartAttempt(9_999, 5_000, 5_000)).toBe(false);
  });
});

describe('lease and claim token', () => {
  it('one active chunk per run; tokens increase monotonically', () => {
    register();
    const a = unwrap(ledger.acquireRunLease('run-1'));
    expect(a.claimToken).toBe(1);
    const busy = ledger.acquireRunLease('run-1');
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.error.reason).toBe('busy');
    t += DEFAULT_LEASE_MS;
    const b = unwrap(ledger.acquireRunLease('run-1'));
    expect(b.claimToken).toBe(2);
    unwrap(ledger.releaseRunLease('run-1', 2));
    expect(unwrap(ledger.acquireRunLease('run-1')).claimToken).toBe(3);
  });

  it('a stale token is refused for claim / mark_sent / settle', () => {
    register();
    const { claimToken } = unwrap(ledger.acquireRunLease('run-1'));
    const c = unwrap(ledger.claimAttempt({ runId: 'run-1', claimToken, itemKey: 'i1', replicate: 0, promptBytes: 1000 }));
    t += DEFAULT_LEASE_MS;
    const next = unwrap(ledger.acquireRunLease('run-1'));
    expect(next.releasedClaims).toEqual([c.attemptId]);
    const r = ledger.claimAttempt({ runId: 'run-1', claimToken, itemKey: 'i2', replicate: 0, promptBytes: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('stale_claim_token');
    const s = ledger.markSent({ attemptId: c.attemptId, claimToken });
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error.reason).toBe('stale_claim_token');
  });
});

describe('claim → mark_sent → settle', () => {
  it('reserves the worst case, settles at usage × price (never caller-supplied), releases the reservation', () => {
    register();
    const { claimToken } = unwrap(ledger.acquireRunLease('run-1'));
    const c = unwrap(ledger.claimAttempt({ runId: 'run-1', claimToken, itemKey: 'i1', replicate: 0, promptBytes: 1000 }));
    expect(c.reservedUsd).toBeCloseTo(WORST_1000, 15);
    expect(ledger.getBudget('u1', 'jc-1').reservedUsd).toBeCloseTo(WORST_1000, 15);
    unwrap(ledger.markSent({ attemptId: c.attemptId, claimToken }));
    const actual = settle(c.attemptId, claimToken, 300, 6);
    expect(actual).toBeCloseTo((300 * 1 + 6 * 5) / 1e6, 15);
    const b = ledger.getBudget('u1', 'jc-1');
    expect(b.spentUsd).toBeCloseTo(actual, 15);
    expect(b.reservedUsd).toBeCloseTo(0, 15);
    const a = ledger.getAttempt(c.attemptId)!;
    expect(a.state).toBe('settled');
    expect(a.verdictRef).toBe('run-1:i1:0');
    expect(ledger.snapshot().verdicts).toHaveLength(1);
    expect(ledger.snapshot().events.map((e) => e.kind)).toEqual(['reserve', 'settle']);
    expect(ledger.reconcile().ok).toBe(true);
  });

  it('a settled item/replicate is never re-called', () => {
    register();
    const { claimToken } = unwrap(ledger.acquireRunLease('run-1'));
    settle(claimSend(claimToken, 'i1'), claimToken);
    const r = ledger.claimAttempt({ runId: 'run-1', claimToken, itemKey: 'i1', replicate: 0, promptBytes: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('already_settled');
    // A different replicate is a different call.
    expect(ledger.claimAttempt({ runId: 'run-1', claimToken, itemKey: 'i1', replicate: 1, promptBytes: 1000 }).ok).toBe(true);
  });

  it('verdict must have exactly one of score / unusableReason', () => {
    register();
    const { claimToken } = unwrap(ledger.acquireRunLease('run-1'));
    const id = claimSend(claimToken, 'i1');
    const r = ledger.settleAttempt({ attemptId: id, claimToken, usage: { inputTokens: 1, outputTokens: 1 }, rawResponse: '', verdict: { score: null, unusableReason: null } });
    expect(r.ok).toBe(false);
    const u = ledger.settleAttempt({ attemptId: id, claimToken, usage: { inputTokens: 1, outputTokens: 0 }, rawResponse: 'oops', verdict: { score: null, unusableReason: 'malformed_json' } });
    expect(u.ok).toBe(true);
  });

  it('fail_before_call releases the reservation; max 2 attempts per item/replicate', () => {
    register();
    const { claimToken } = unwrap(ledger.acquireRunLease('run-1'));
    expect(MAX_ATTEMPTS_PER_ITEM).toBe(2);
    for (let i = 0; i < 2; i++) {
      const c = unwrap(ledger.claimAttempt({ runId: 'run-1', claimToken, itemKey: 'i1', replicate: 0, promptBytes: 1000 }));
      expect(c.attemptNo).toBe(i + 1);
      unwrap(ledger.failBeforeCall({ attemptId: c.attemptId, claimToken }));
    }
    expect(ledger.getBudget('u1', 'jc-1').reservedUsd).toBeCloseTo(0, 15);
    const third = ledger.claimAttempt({ runId: 'run-1', claimToken, itemKey: 'i1', replicate: 0, promptBytes: 1000 });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error.reason).toBe('max_attempts');
    expect(ledger.reconcile().ok).toBe(true);
  });

  it('fail_before_call is refused once the attempt was sent', () => {
    register();
    const { claimToken } = unwrap(ledger.acquireRunLease('run-1'));
    const id = claimSend(claimToken, 'i1');
    const r = ledger.failBeforeCall({ attemptId: id, claimToken });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('invalid_state');
  });
});

describe('cap and price', () => {
  it('refuses a claim when spent + reserved + worst case > cap', () => {
    ledger = createCallLedger({ now: () => t, priceBook: book, defaultCapUsd: WORST_1000 * 2.5 });
    register();
    const { claimToken } = unwrap(ledger.acquireRunLease('run-1'));
    claimSend(claimToken, 'i1');
    claimSend(claimToken, 'i2');
    const r = ledger.claimAttempt({ runId: 'run-1', claimToken, itemKey: 'i3', replicate: 0, promptBytes: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('budget_exceeded');
    // Exactly at the cap is allowed (≤ cap).
    const small = ledger.claimAttempt({ runId: 'run-1', claimToken, itemKey: 'i3', replicate: 0, promptBytes: 340 });
    // 340 bytes + 64 × 5 = 660 µ$ = 0.5 × 1320 µ$, so 2 × 1320 + 660 = 3300 = 2.5 × 1320.
    expect(small.ok).toBe(true);
  });

  it('default cap is $5 per judge config', () => {
    expect(DEFAULT_CAP_USD).toBe(5);
    expect(ledger.getBudget('u1', 'jc-new').capUsd).toBe(5);
  });

  it('missing price refuses the claim for a live provider; mock costs $0', () => {
    register('run-x', 'openai_compatible');
    const { claimToken } = unwrap(ledger.acquireRunLease('run-x'));
    const r = ledger.claimAttempt({ runId: 'run-x', claimToken, itemKey: 'i1', replicate: 0, promptBytes: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('missing_price');

    register('run-m', 'mock', 'jc-mock');
    const m = unwrap(ledger.acquireRunLease('run-m'));
    const c = unwrap(ledger.claimAttempt({ runId: 'run-m', claimToken: m.claimToken, itemKey: 'i1', replicate: 0, promptBytes: 1000 }));
    expect(c.reservedUsd).toBe(0);
  });

  it('set_budget is refused while a lease is unexpired, allowed after; changes are audited', () => {
    register();
    const { claimToken } = unwrap(ledger.acquireRunLease('run-1'));
    const r = ledger.setBudget({ owner: 'u1', judgeConfigId: 'jc-1', capUsd: 10, reason: 'raise' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('lease_active');
    unwrap(ledger.releaseRunLease('run-1', claimToken));
    expect(unwrap(ledger.setBudget({ owner: 'u1', judgeConfigId: 'jc-1', capUsd: 10, reason: 'raise' })).capUsd).toBe(10);
    expect(ledger.snapshot().budgetChanges).toMatchObject([{ oldCapUsd: 5, newCapUsd: 10, reason: 'raise' }]);
    expect(ledger.setBudget({ owner: 'u1', judgeConfigId: 'jc-1', capUsd: -1, reason: 'x' }).ok).toBe(false);
  });
});

describe('crash and expiry (fault injection)', () => {
  it('crash after send before settle ⇒ ambiguous, reservation kept, never re-sent', () => {
    register();
    const first = unwrap(ledger.acquireRunLease('run-1'));
    const id = claimSend(first.claimToken, 'i1');
    // The settle transaction crashes before commit: nothing changes.
    ledger.faults.arm('settle');
    expect(() => settle(id, first.claimToken)).toThrow(InjectedFaultError);
    expect(ledger.getAttempt(id)!.state).toBe('sent');
    expect(ledger.snapshot().verdicts).toHaveLength(0);
    expect(ledger.getBudget('u1', 'jc-1').spentUsd).toBe(0);

    // The worker is gone; its lease expires. A new chunk acquires the run.
    t += DEFAULT_LEASE_MS;
    const second = unwrap(ledger.acquireRunLease('run-1'));
    expect(second.markedAmbiguous).toEqual([id]);
    expect(ledger.getAttempt(id)!.state).toBe('ambiguous');
    expect(ledger.getBudget('u1', 'jc-1').reservedUsd).toBeCloseTo(WORST_1000, 15);

    // The ambiguous item/replicate is never claimed (hence never sent) again.
    const again = ledger.claimAttempt({ runId: 'run-1', claimToken: second.claimToken, itemKey: 'i1', replicate: 0, promptBytes: 1000 });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.reason).toBe('attempt_ambiguous');
    // The late settle from the dead worker is fenced off too.
    const late = ledger.settleAttempt({ attemptId: id, claimToken: first.claimToken, usage: { inputTokens: 1, outputTokens: 1 }, rawResponse: 'x', verdict: { score: 1, unusableReason: null } });
    expect(late.ok).toBe(false);
    expect(ledger.attemptsFor('run-1', 'i1', 0)).toHaveLength(1);
    expect(ledger.reconcile().ok).toBe(true);
  });

  it('an expired lease never sends or settles: mark_sent and settle are refused after expiry', () => {
    register();
    const { claimToken } = unwrap(ledger.acquireRunLease('run-1'));
    const c = unwrap(ledger.claimAttempt({ runId: 'run-1', claimToken, itemKey: 'i1', replicate: 0, promptBytes: 1000 }));
    t += DEFAULT_LEASE_MS;
    const sent = ledger.markSent({ attemptId: c.attemptId, claimToken });
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.error.reason).toBe('lease_expired');

    const c2 = unwrap(ledger.acquireRunLease('run-1'));
    const id = claimSend(c2.claimToken, 'i2');
    t += DEFAULT_LEASE_MS;
    const s = ledger.settleAttempt({ attemptId: id, claimToken: c2.claimToken, usage: { inputTokens: 1, outputTokens: 1 }, rawResponse: 'x', verdict: { score: 1, unusableReason: null } });
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error.reason).toBe('lease_expired');
    unwrap(ledger.markAmbiguous(id));
    expect(ledger.getAttempt(id)!.state).toBe('ambiguous');
  });

  it('mark_ambiguous is refused while the sending lease is active', () => {
    register();
    const { claimToken } = unwrap(ledger.acquireRunLease('run-1'));
    const id = claimSend(claimToken, 'i1');
    const r = ledger.markAmbiguous(id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('lease_active');
  });

  it('owner resolves an ambiguous attempt: charge the reservation or release it', () => {
    register();
    const first = unwrap(ledger.acquireRunLease('run-1'));
    const a1 = claimSend(first.claimToken, 'i1');
    const a2 = claimSend(first.claimToken, 'i2');
    t += DEFAULT_LEASE_MS;
    unwrap(ledger.acquireRunLease('run-1'));
    expect(ledger.resolveAmbiguous({ attemptId: a1, owner: 'u2', resolution: 'release' }).ok).toBe(false);
    unwrap(ledger.resolveAmbiguous({ attemptId: a1, owner: 'u1', resolution: 'charge_reserved' }));
    unwrap(ledger.resolveAmbiguous({ attemptId: a2, owner: 'u1', resolution: 'release' }));
    const b = ledger.getBudget('u1', 'jc-1');
    expect(b.spentUsd).toBeCloseTo(WORST_1000, 15);
    expect(b.reservedUsd).toBeCloseTo(0, 15);
    expect(ledger.getAttempt(a1)!.resolution).toBe('charge_reserved');
    expect(ledger.reconcile().ok).toBe(true);
  });

  it('a crashed claim commits nothing', () => {
    register();
    const { claimToken } = unwrap(ledger.acquireRunLease('run-1'));
    ledger.faults.arm('claim');
    expect(() => ledger.claimAttempt({ runId: 'run-1', claimToken, itemKey: 'i1', replicate: 0, promptBytes: 1000 })).toThrow(InjectedFaultError);
    expect(ledger.attemptsFor('run-1', 'i1', 0)).toHaveLength(0);
    expect(ledger.getBudget('u1', 'jc-1').reservedUsd).toBe(0);
    expect(ledger.snapshot().events).toHaveLength(0);
    // The fault fired once; the retry succeeds.
    expect(ledger.claimAttempt({ runId: 'run-1', claimToken, itemKey: 'i1', replicate: 0, promptBytes: 1000 }).ok).toBe(true);
  });
});

describe('reconcile', () => {
  it('counters equal the event sums after a mixed workload', () => {
    register();
    register('run-2', 'anthropic', 'jc-2');
    const l1 = unwrap(ledger.acquireRunLease('run-1'));
    const l2 = unwrap(ledger.acquireRunLease('run-2'));
    settle(claimSend(l1.claimToken, 'a'), l1.claimToken, 400, 5);
    settle(claimSend(l2.claimToken, 'a', 0, 'run-2'), l2.claimToken, 250, 7);
    const c = unwrap(ledger.claimAttempt({ runId: 'run-1', claimToken: l1.claimToken, itemKey: 'b', replicate: 0, promptBytes: 900 }));
    unwrap(ledger.failBeforeCall({ attemptId: c.attemptId, claimToken: l1.claimToken }));
    claimSend(l1.claimToken, 'c');
    const rep = ledger.reconcile();
    expect(rep.ok).toBe(true);
    expect(rep.rows).toHaveLength(2);
    for (const row of rep.rows) {
      expect(row.spentCounter).toBeCloseTo(row.spentFromEvents, 12);
      expect(row.reservedCounter).toBeCloseTo(row.reservedFromEvents, 12);
      expect(row.reservedCounter).toBeCloseTo(row.reservedOpenAttempts, 12);
    }
  });
});
