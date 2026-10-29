// In-memory call ledger mirroring the server RPC semantics (PLAN.md §3.11, §3.13 item 2; K4, K10, K14).
//
// Used by MemoryStore (keyless demo) and as the executable reference for the SQL RPCs
// `acquire_run_lease`, `claim_attempt`, `mark_sent`, `settle_attempt`, `fail_before_call`,
// `mark_ambiguous`, `resolve_ambiguous`, `set_budget` and the `ledger_reconcile` view.
//
// Rules
//  - One active chunk per run: a lease plus a monotonically increasing claim token (fencing). Every
//    mark_sent / settle / fail_before_call must present the CURRENT token under an unexpired lease.
//  - claim: cap check spent + reserved + worstCase ≤ cap (default $5 per judge config); max 2
//    attempts per (run, item, replicate); live provider without a price ⇒ refused (missing_price).
//    The worst case is reserved at claim time.
//  - settle: actual cost = provider usage × the price captured at claim (never caller-supplied);
//    records the verdict; releases the reservation; appends a ledger event — all-or-nothing.
//  - A `sent` attempt whose lease expired is NEVER re-sent: it becomes `ambiguous`, its reservation
//    is kept at worst case until the owner resolves it explicitly.
//  - Every counter change appends a ledger event with its deltas; reconcile() checks
//    counters == event sums (the `ledger_reconcile` view).
//  - Clock is injected; no Date.now() inside the logic. Fault-injection hooks let tests crash an
//    operation before it commits (state unchanged).

import { err, ok, type Err, type Reason, type Result } from '../core/result.ts';
import type { Provider, UnusableReason } from '../core/types.ts';
import { actualCostUsd, resolvePrice, worstCaseAttemptUsd, type PriceBook, type PriceBookEntry, type ResolvedPrice, type Usage } from '../core/plan/costBound.ts';

// ---------------------------------------------------------------------------
// Constants (proposals, verified at activation — PLAN.md §6.4)
// ---------------------------------------------------------------------------

export const DEFAULT_CAP_USD = 5;
export const MAX_ATTEMPTS_PER_ITEM = 2;
export const PROVIDER_TIMEOUT_MS = 20_000;
export const SETTLE_MARGIN_MS = 5_000;
export const CHUNK_WORK_BUDGET_MS = 45_000;
export const CHUNK_MAX_ITEMS = 10;
/** Lease length; longer than the chunk work budget so a healthy chunk never loses its lease. */
export const DEFAULT_LEASE_MS = 60_000;
/** Tolerance for floating-point money comparisons. */
export const MONEY_EPSILON = 1e-9;

/**
 * Budget-time guard: start a provider attempt only when the remaining chunk budget covers the
 * provider timeout plus the settle margin (20 s + 5 s by default); otherwise the chunk yields.
 */
export function canStartAttempt(remainingMs: number, timeoutMs: number = PROVIDER_TIMEOUT_MS, marginMs: number = SETTLE_MARGIN_MS): boolean {
  return remainingMs >= timeoutMs + marginMs;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AttemptState = 'claimed' | 'sent' | 'settled' | 'failed_before_call' | 'ambiguous' | 'resolved';

export type LedgerErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'bad_request'
  | 'busy'
  | 'stale_claim_token'
  | 'lease_expired'
  | 'lease_active'
  | 'missing_price'
  | 'budget_exceeded'
  | 'max_attempts'
  | 'already_settled'
  | 'attempt_in_flight'
  | 'attempt_ambiguous'
  | 'invalid_state'
  | 'verdict_exists';

export type LedgerError = Reason<LedgerErrorCode>;

export type LedgerRun = {
  readonly runId: string;
  readonly owner: string;
  readonly judgeConfigId: string;
  readonly provider: Provider;
  readonly model: string;
  readonly maxOutputTokens: number;
  /** ms epoch; null = never leased. */
  readonly leaseUntil: number | null;
  /** 0 = never leased; increases by 1 on every acquisition. */
  readonly claimToken: number;
};

export type Attempt = {
  readonly attemptId: string;
  readonly runId: string;
  readonly itemKey: string;
  readonly replicate: number;
  readonly attemptNo: number;
  readonly state: AttemptState;
  readonly claimToken: number;
  readonly promptBytes: number;
  readonly price: ResolvedPrice;
  readonly reservedUsd: number;
  readonly actualUsd: number | null;
  readonly usage: Usage | null;
  readonly rawResponse: string | null;
  readonly verdictRef: string | null;
  readonly resolution: 'charge_reserved' | 'release' | null;
  readonly claimedAt: number;
  readonly sentAt: number | null;
  readonly finishedAt: number | null;
};

export type Budget = {
  readonly owner: string;
  readonly judgeConfigId: string;
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly reservedUsd: number;
};

export type BudgetChange = {
  readonly seq: number;
  readonly owner: string;
  readonly judgeConfigId: string;
  readonly oldCapUsd: number;
  readonly newCapUsd: number;
  readonly reason: string;
  readonly at: number;
};

export type LedgerEventKind = 'reserve' | 'settle' | 'release' | 'ambiguous' | 'resolve';

export type LedgerEvent = {
  readonly seq: number;
  readonly kind: LedgerEventKind;
  readonly attemptId: string;
  readonly runId: string;
  readonly owner: string;
  readonly judgeConfigId: string;
  readonly deltaSpentUsd: number;
  readonly deltaReservedUsd: number;
  readonly at: number;
};

export type VerdictRecord = {
  readonly runId: string;
  readonly itemKey: string;
  readonly replicate: number;
  readonly attemptId: string;
  readonly score: number | null;
  readonly unusableReason: UnusableReason | null;
  readonly raw: string;
};

export type FaultPoint = 'acquire' | 'claim' | 'mark_sent' | 'settle' | 'fail_before_call' | 'mark_ambiguous' | 'resolve' | 'set_budget';

/** Thrown by an armed fault point BEFORE the operation commits (state unchanged). */
export class InjectedFaultError extends Error {
  readonly point: FaultPoint;
  constructor(point: FaultPoint) {
    super(`injected fault at ${point}`);
    this.name = 'InjectedFaultError';
    this.point = point;
  }
}

export type ReconcileRow = {
  owner: string;
  judgeConfigId: string;
  spentCounter: number;
  spentFromEvents: number;
  reservedCounter: number;
  reservedFromEvents: number;
  /** Sum of reservations of attempts still holding one (claimed | sent | ambiguous). */
  reservedOpenAttempts: number;
  ok: boolean;
};

export type ReconcileReport = { ok: boolean; rows: ReconcileRow[] };

export type LedgerSnapshot = {
  runs: LedgerRun[];
  attempts: Attempt[];
  budgets: Budget[];
  budgetChanges: BudgetChange[];
  events: LedgerEvent[];
  verdicts: VerdictRecord[];
  priceBook: PriceBookEntry[];
};

export type RegisterRunInput = {
  runId: string;
  owner: string;
  judgeConfigId: string;
  provider: Provider;
  model: string;
  maxOutputTokens: number;
};

export type ClaimInput = { runId: string; claimToken: number; itemKey: string; replicate: number; promptBytes: number };
export type TokenInput = { attemptId: string; claimToken: number };
export type SettleInput = TokenInput & {
  usage: Usage;
  rawResponse: string;
  verdict: { score: number | null; unusableReason: UnusableReason | null };
};

export type CallLedger = {
  registerRun(input: RegisterRunInput): Result<LedgerRun, LedgerError>;
  /** Insert-only price book. */
  addPrice(entry: PriceBookEntry): void;
  acquireRunLease(runId: string): Result<{ claimToken: number; leaseUntil: number; markedAmbiguous: string[]; releasedClaims: string[] }, LedgerError>;
  /** Clean yield: end the current lease early (token must be current). */
  releaseRunLease(runId: string, claimToken: number): Result<void, LedgerError>;
  claimAttempt(input: ClaimInput): Result<{ attemptId: string; attemptNo: number; reservedUsd: number }, LedgerError>;
  markSent(input: TokenInput): Result<void, LedgerError>;
  settleAttempt(input: SettleInput): Result<{ actualUsd: number; verdictRef: string }, LedgerError>;
  failBeforeCall(input: TokenInput): Result<void, LedgerError>;
  markAmbiguous(attemptId: string): Result<void, LedgerError>;
  resolveAmbiguous(input: { attemptId: string; owner: string; resolution: 'charge_reserved' | 'release' }): Result<void, LedgerError>;
  setBudget(input: { owner: string; judgeConfigId: string; capUsd: number; reason: string }): Result<Budget, LedgerError>;
  getBudget(owner: string, judgeConfigId: string): Budget;
  getAttempt(attemptId: string): Attempt | null;
  attemptsFor(runId: string, itemKey: string, replicate: number): Attempt[];
  reconcile(): ReconcileReport;
  snapshot(): LedgerSnapshot;
  faults: { arm(point: FaultPoint, times?: number): void; clear(): void };
};

export type CallLedgerOptions = {
  /** Injected clock (ms epoch). */
  now: () => number;
  priceBook?: PriceBook;
  defaultCapUsd?: number;
  leaseMs?: number;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function fail(reason: LedgerErrorCode, message: string): Err<LedgerError> {
  return err({ reason, message });
}

function budgetKey(owner: string, judgeConfigId: string): string {
  return `${owner}\u0000${judgeConfigId}`;
}

function verdictKey(runId: string, itemKey: string, replicate: number): string {
  return `${runId}\u0000${itemKey}\u0000${String(replicate)}`;
}

function isCount(v: number): boolean {
  return Number.isInteger(v) && v >= 0;
}

export function createCallLedger(opts: CallLedgerOptions): CallLedger {
  const now = opts.now;
  const defaultCap = opts.defaultCapUsd ?? DEFAULT_CAP_USD;
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const priceBook: PriceBookEntry[] = [...(opts.priceBook ?? [])];
  const runs = new Map<string, LedgerRun>();
  const attempts = new Map<string, Attempt>();
  const attemptOrder: string[] = [];
  const budgets = new Map<string, Budget>();
  const budgetChanges: BudgetChange[] = [];
  const events: LedgerEvent[] = [];
  const verdicts = new Map<string, VerdictRecord>();
  const armed = new Map<FaultPoint, number>();
  let seq = 0;

  function trip(point: FaultPoint): void {
    const n = armed.get(point) ?? 0;
    if (n > 0) {
      if (n === 1) armed.delete(point);
      else armed.set(point, n - 1);
      throw new InjectedFaultError(point);
    }
  }

  function budgetOf(owner: string, judgeConfigId: string): Budget {
    return budgets.get(budgetKey(owner, judgeConfigId)) ?? { owner, judgeConfigId, capUsd: defaultCap, spentUsd: 0, reservedUsd: 0 };
  }

  function leaseLive(run: LedgerRun, t: number): boolean {
    return run.leaseUntil !== null && t < run.leaseUntil;
  }

  function checkToken(run: LedgerRun, claimToken: number, t: number): LedgerError | null {
    if (claimToken !== run.claimToken) return { reason: 'stale_claim_token', message: `claim token ${claimToken} is not the current token ${run.claimToken}` };
    if (!leaseLive(run, t)) return { reason: 'lease_expired', message: 'the run lease has expired' };
    return null;
  }

  /** Apply a money movement: counters and event together (same "transaction"). */
  function move(kind: LedgerEventKind, a: Attempt, run: LedgerRun, deltaSpentUsd: number, deltaReservedUsd: number, t: number): void {
    const b = budgetOf(run.owner, run.judgeConfigId);
    budgets.set(budgetKey(run.owner, run.judgeConfigId), {
      ...b,
      spentUsd: b.spentUsd + deltaSpentUsd,
      reservedUsd: b.reservedUsd + deltaReservedUsd,
    });
    seq += 1;
    events.push(
      Object.freeze({ seq, kind, attemptId: a.attemptId, runId: run.runId, owner: run.owner, judgeConfigId: run.judgeConfigId, deltaSpentUsd, deltaReservedUsd, at: t }),
    );
  }

  function attemptsOf(runId: string, itemKey: string, replicate: number): Attempt[] {
    const out: Attempt[] = [];
    for (const id of attemptOrder) {
      const a = attempts.get(id)!;
      if (a.runId === runId && a.itemKey === itemKey && a.replicate === replicate) out.push(a);
    }
    return out;
  }

  function lookupAttempt(attemptId: string): { a: Attempt; run: LedgerRun } | LedgerError {
    const a = attempts.get(attemptId);
    if (a === undefined) return { reason: 'not_found', message: `no attempt ${attemptId}` };
    const run = runs.get(a.runId);
    if (run === undefined) return { reason: 'not_found', message: `no run ${a.runId}` };
    return { a, run };
  }

  const ledger: CallLedger = {
    registerRun(input) {
      if (runs.has(input.runId)) return fail('bad_request', `run ${input.runId} already registered`);
      if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1) return fail('bad_request', 'maxOutputTokens must be a positive integer');
      const run: LedgerRun = Object.freeze({ ...input, leaseUntil: null, claimToken: 0 });
      runs.set(run.runId, run);
      return ok(run);
    },

    addPrice(entry) {
      priceBook.push(Object.freeze({ ...entry }));
    },

    acquireRunLease(runId) {
      const run = runs.get(runId);
      if (run === undefined) return fail('not_found', `no run ${runId}`);
      const t = now();
      if (leaseLive(run, t)) return fail('busy', 'another chunk holds the run lease');
      trip('acquire');
      // Sweep attempts left behind by the expired lease: never-sent claims are released; sent
      // attempts become ambiguous (never re-sent; reservation kept).
      const markedAmbiguous: string[] = [];
      const releasedClaims: string[] = [];
      for (const id of attemptOrder) {
        const a = attempts.get(id)!;
        if (a.runId !== runId) continue;
        if (a.state === 'sent') {
          attempts.set(id, { ...a, state: 'ambiguous', finishedAt: t });
          move('ambiguous', a, run, 0, 0, t);
          markedAmbiguous.push(id);
        } else if (a.state === 'claimed') {
          attempts.set(id, { ...a, state: 'failed_before_call', finishedAt: t });
          move('release', a, run, 0, -a.reservedUsd, t);
          releasedClaims.push(id);
        }
      }
      const next: LedgerRun = Object.freeze({ ...run, claimToken: run.claimToken + 1, leaseUntil: t + leaseMs });
      runs.set(runId, next);
      return ok({ claimToken: next.claimToken, leaseUntil: t + leaseMs, markedAmbiguous, releasedClaims });
    },

    releaseRunLease(runId, claimToken) {
      const run = runs.get(runId);
      if (run === undefined) return fail('not_found', `no run ${runId}`);
      const bad = checkToken(run, claimToken, now());
      if (bad) return err(bad);
      runs.set(runId, Object.freeze({ ...run, leaseUntil: now() }));
      return ok(undefined);
    },

    claimAttempt(input) {
      const run = runs.get(input.runId);
      if (run === undefined) return fail('not_found', `no run ${input.runId}`);
      const t = now();
      const bad = checkToken(run, input.claimToken, t);
      if (bad) return err(bad);
      if (!isCount(input.promptBytes)) return fail('bad_request', 'promptBytes must be a non-negative integer');
      if (!isCount(input.replicate)) return fail('bad_request', 'replicate must be a non-negative integer');
      const prior = attemptsOf(run.runId, input.itemKey, input.replicate);
      if (prior.some((a) => a.state === 'settled')) return fail('already_settled', 'this item/replicate is already settled; it is never re-called');
      if (prior.some((a) => a.state === 'ambiguous')) return fail('attempt_ambiguous', 'an earlier attempt is ambiguous; it must be resolved by the owner and is never re-sent automatically');
      if (prior.some((a) => a.state === 'claimed' || a.state === 'sent')) return fail('attempt_in_flight', 'an attempt for this item/replicate is in flight');
      if (prior.length >= MAX_ATTEMPTS_PER_ITEM) return fail('max_attempts', `at most ${MAX_ATTEMPTS_PER_ITEM} attempts per item/replicate`);
      if (verdicts.has(verdictKey(run.runId, input.itemKey, input.replicate))) return fail('verdict_exists', 'a verdict already exists for this item/replicate');

      const priced = resolvePrice(priceBook, run.provider, run.model);
      if (!priced.ok) return fail('missing_price', priced.error.message);
      const worst = worstCaseAttemptUsd(input.promptBytes, run.maxOutputTokens, priced.value);
      const b = budgetOf(run.owner, run.judgeConfigId);
      if (b.spentUsd + b.reservedUsd + worst - b.capUsd > MONEY_EPSILON) {
        return fail(
          'budget_exceeded',
          `spent $${b.spentUsd.toFixed(4)} + reserved $${b.reservedUsd.toFixed(4)} + worst case $${worst.toFixed(4)} exceeds the cap $${b.capUsd.toFixed(2)}`,
        );
      }
      trip('claim');
      seq += 1;
      const attempt: Attempt = {
        attemptId: `attempt-${seq}`,
        runId: run.runId,
        itemKey: input.itemKey,
        replicate: input.replicate,
        attemptNo: prior.length + 1,
        state: 'claimed',
        claimToken: input.claimToken,
        promptBytes: input.promptBytes,
        price: priced.value,
        reservedUsd: worst,
        actualUsd: null,
        usage: null,
        rawResponse: null,
        verdictRef: null,
        resolution: null,
        claimedAt: t,
        sentAt: null,
        finishedAt: null,
      };
      attempts.set(attempt.attemptId, attempt);
      attemptOrder.push(attempt.attemptId);
      move('reserve', attempt, run, 0, worst, t);
      return ok({ attemptId: attempt.attemptId, attemptNo: attempt.attemptNo, reservedUsd: worst });
    },

    markSent(input) {
      const found = lookupAttempt(input.attemptId);
      if ('reason' in found) return err(found);
      const { a, run } = found;
      const t = now();
      const bad = checkToken(run, input.claimToken, t);
      if (bad) return err(bad);
      if (a.claimToken !== input.claimToken) return fail('stale_claim_token', 'the attempt was claimed under another token');
      if (a.state !== 'claimed') return fail('invalid_state', `attempt is ${a.state}, expected claimed`);
      trip('mark_sent');
      attempts.set(a.attemptId, { ...a, state: 'sent', sentAt: t });
      return ok(undefined);
    },

    settleAttempt(input) {
      const found = lookupAttempt(input.attemptId);
      if ('reason' in found) return err(found);
      const { a, run } = found;
      const t = now();
      const bad = checkToken(run, input.claimToken, t);
      if (bad) return err(bad);
      if (a.claimToken !== input.claimToken) return fail('stale_claim_token', 'the attempt was claimed under another token');
      if (a.state !== 'sent') return fail('invalid_state', `attempt is ${a.state}, expected sent`);
      if (!isCount(input.usage.inputTokens) || !isCount(input.usage.outputTokens)) return fail('bad_request', 'usage tokens must be non-negative integers');
      const v = input.verdict;
      if ((v.score === null) === (v.unusableReason === null)) return fail('bad_request', 'exactly one of score / unusableReason must be non-null');
      if (v.score !== null && !isCount(v.score)) return fail('bad_request', 'score must be a level index');
      const vKey = verdictKey(a.runId, a.itemKey, a.replicate);
      if (verdicts.has(vKey)) return fail('verdict_exists', 'a verdict already exists for this item/replicate');
      const actual = actualCostUsd(input.usage, a.price);
      trip('settle');
      // --- commit (single step) ---
      const verdictRef = `${a.runId}:${a.itemKey}:${String(a.replicate)}`;
      verdicts.set(
        vKey,
        Object.freeze({ runId: a.runId, itemKey: a.itemKey, replicate: a.replicate, attemptId: a.attemptId, score: v.score, unusableReason: v.unusableReason, raw: input.rawResponse }),
      );
      attempts.set(a.attemptId, {
        ...a,
        state: 'settled',
        actualUsd: actual,
        usage: { inputTokens: input.usage.inputTokens, outputTokens: input.usage.outputTokens },
        rawResponse: input.rawResponse,
        verdictRef,
        finishedAt: t,
      });
      move('settle', a, run, actual, -a.reservedUsd, t);
      return ok({ actualUsd: actual, verdictRef });
    },

    failBeforeCall(input) {
      const found = lookupAttempt(input.attemptId);
      if ('reason' in found) return err(found);
      const { a, run } = found;
      const t = now();
      const bad = checkToken(run, input.claimToken, t);
      if (bad) return err(bad);
      if (a.claimToken !== input.claimToken) return fail('stale_claim_token', 'the attempt was claimed under another token');
      if (a.state !== 'claimed') return fail('invalid_state', `attempt is ${a.state}; only a claimed (never sent) attempt can fail before the call`);
      trip('fail_before_call');
      attempts.set(a.attemptId, { ...a, state: 'failed_before_call', finishedAt: t });
      move('release', a, run, 0, -a.reservedUsd, t);
      return ok(undefined);
    },

    markAmbiguous(attemptId) {
      const found = lookupAttempt(attemptId);
      if ('reason' in found) return err(found);
      const { a, run } = found;
      const t = now();
      if (a.state !== 'sent') return fail('invalid_state', `attempt is ${a.state}, expected sent`);
      if (leaseLive(run, t) && run.claimToken === a.claimToken) return fail('lease_active', 'the lease that sent this attempt is still active');
      trip('mark_ambiguous');
      attempts.set(a.attemptId, { ...a, state: 'ambiguous', finishedAt: t });
      move('ambiguous', a, run, 0, 0, t);
      return ok(undefined);
    },

    resolveAmbiguous(input) {
      const found = lookupAttempt(input.attemptId);
      if ('reason' in found) return err(found);
      const { a, run } = found;
      if (run.owner !== input.owner) return fail('forbidden', 'only the run owner can resolve an ambiguous attempt');
      if (a.state !== 'ambiguous') return fail('invalid_state', `attempt is ${a.state}, expected ambiguous`);
      const t = now();
      trip('resolve');
      attempts.set(a.attemptId, { ...a, state: 'resolved', resolution: input.resolution, finishedAt: t });
      if (input.resolution === 'charge_reserved') move('resolve', a, run, a.reservedUsd, -a.reservedUsd, t);
      else move('resolve', a, run, 0, -a.reservedUsd, t);
      return ok(undefined);
    },

    setBudget(input) {
      if (!Number.isFinite(input.capUsd) || input.capUsd < 0) return fail('bad_request', 'cap must be a finite, non-negative USD amount');
      const t = now();
      for (const run of runs.values()) {
        if (run.owner === input.owner && run.judgeConfigId === input.judgeConfigId && leaseLive(run, t)) {
          return fail('lease_active', `run ${run.runId} of this judge config holds an unexpired lease; pause it first`);
        }
      }
      trip('set_budget');
      const b = budgetOf(input.owner, input.judgeConfigId);
      const next: Budget = { ...b, capUsd: input.capUsd };
      budgets.set(budgetKey(input.owner, input.judgeConfigId), next);
      seq += 1;
      budgetChanges.push(
        Object.freeze({ seq, owner: input.owner, judgeConfigId: input.judgeConfigId, oldCapUsd: b.capUsd, newCapUsd: input.capUsd, reason: input.reason, at: t }),
      );
      return ok({ ...next });
    },

    getBudget(owner, judgeConfigId) {
      return { ...budgetOf(owner, judgeConfigId) };
    },

    getAttempt(attemptId) {
      const a = attempts.get(attemptId);
      return a === undefined ? null : { ...a };
    },

    attemptsFor(runId, itemKey, replicate) {
      return attemptsOf(runId, itemKey, replicate).map((a) => ({ ...a }));
    },

    reconcile() {
      const keys = new Set<string>(budgets.keys());
      for (const e of events) keys.add(budgetKey(e.owner, e.judgeConfigId));
      const rows: ReconcileRow[] = [];
      for (const key of [...keys].sort()) {
        const [owner, judgeConfigId] = key.split('\u0000') as [string, string];
        const b = budgetOf(owner, judgeConfigId);
        let spentEv = 0;
        let reservedEv = 0;
        for (const e of events) {
          if (e.owner !== owner || e.judgeConfigId !== judgeConfigId) continue;
          spentEv += e.deltaSpentUsd;
          reservedEv += e.deltaReservedUsd;
        }
        let open = 0;
        for (const a of attempts.values()) {
          const run = runs.get(a.runId);
          if (run === undefined || run.owner !== owner || run.judgeConfigId !== judgeConfigId) continue;
          if (a.state === 'claimed' || a.state === 'sent' || a.state === 'ambiguous') open += a.reservedUsd;
        }
        const rowOk =
          Math.abs(b.spentUsd - spentEv) <= MONEY_EPSILON &&
          Math.abs(b.reservedUsd - reservedEv) <= MONEY_EPSILON &&
          Math.abs(b.reservedUsd - open) <= MONEY_EPSILON;
        rows.push({
          owner,
          judgeConfigId,
          spentCounter: b.spentUsd,
          spentFromEvents: spentEv,
          reservedCounter: b.reservedUsd,
          reservedFromEvents: reservedEv,
          reservedOpenAttempts: open,
          ok: rowOk,
        });
      }
      return { ok: rows.every((r) => r.ok), rows };
    },

    snapshot() {
      return {
        runs: [...runs.values()].map((r) => ({ ...r })),
        attempts: attemptOrder.map((id) => ({ ...attempts.get(id)! })),
        budgets: [...budgets.values()].map((b) => ({ ...b })),
        budgetChanges: budgetChanges.map((c) => ({ ...c })),
        events: events.map((e) => ({ ...e })),
        verdicts: [...verdicts.values()].map((v) => ({ ...v })),
        priceBook: priceBook.map((p) => ({ ...p })),
      };
    },

    faults: {
      arm(point, times = 1) {
        if (!Number.isInteger(times) || times < 1) throw new RangeError('times must be a positive integer');
        armed.set(point, times);
      },
      clear() {
        armed.clear();
      },
    },
  };
  return ledger;
}
