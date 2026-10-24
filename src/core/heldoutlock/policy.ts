// Held-out lock: pure state machine (PLAN.md §3.9, K5, K6, K13, K23, K24).
//
// The state is a plain immutable value: every operation returns a NEW LockState (the input is
// never mutated) inside a reason-coded Result. MemoryStore holds the state in page memory; the
// SQL in `…03_heldout.sql` implements the same transitions and is checked against the
// scenario table in `scenarios.ts`.
//
// Model
//  - Scope = (owner, contentHash, judgeConfigHash). contentHash is independent of row order,
//    item ids and set name, so a renamed / reordered re-import lands in the SAME scope (K24:
//    changed content = new contentHash = new scope).
//  - Preregistration pins the frozen records, both rubric hashes, the judge config hash, the
//    policy (s36-v1 only), algorithm versions, bootstrap seed/count and the fit hashes that the
//    server/store computed (K5). The policy stores the fit hashes; it never computes fits.
//  - heldout_log entries are `look` (one per (scope, rubricHash), ever) or `burn`.
//  - A held-out run exists per (scope, rubricHash) and is created when that hash is first looked;
//    later requests REUSE it (K13: one held-out scoring pass per (scope, rubric_hash), ever).
//  - A look is spent at authorization, even if its run later fails.

import { canonicalJson } from '../canonical.ts';
import { err, ok, type Err, type Reason, type Result } from '../result.ts';
import { sha256Hex } from '../sha256.ts';
import type { RunKind, Scale, Split } from '../types.ts';
import { assertStandardPolicy, assertStandardPolicyRef, policyHash, S36_V1, type AlgorithmVersions } from './policyConst.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LockReasonCode =
  | 'not_found'
  | 'forbidden'
  | 'bad_request'
  | 'prerequisite_missing'
  | 'prereg_mismatch'
  | 'heldout_exhausted'
  | 'custom_policy_refused'
  | 'already_burned'
  | 'confirmation_mismatch'
  | 'resplit_refused';

export type LockError = Reason<LockReasonCode>;

/** Fit hashes computed by server/store code (lexical cut points, modal level, PAV map). */
export type FitHashes = {
  readonly lexicalCutPoints: string;
  readonly modalLevel: string;
  readonly pavMap: string;
};

/** The CURRENT stored frozen records of a gold set, as read by the store at call time. */
export type FrozenSetRecord = {
  readonly setId: string;
  readonly owner: string;
  readonly contentHash: string;
  readonly annotationHash: string;
  /** null while the set is not frozen. */
  readonly splitHash: string | null;
  readonly frozen: boolean;
  readonly scale: Scale;
};

export type RunStatus = 'pending' | 'running' | 'paused' | 'complete' | 'failed';

/** A dev run record (store-owned) offered as the preregistration prerequisite. */
export type DevRunRecord = {
  readonly runId: string;
  readonly setId: string;
  readonly rubricHash: string;
  readonly judgeConfigHash: string;
  readonly kind: RunKind;
  readonly split: Split;
  readonly status: RunStatus;
};

export type Scope = {
  readonly key: string;
  readonly owner: string;
  readonly contentHash: string;
  readonly judgeConfigHash: string;
  readonly createdAt: string;
};

export type PreregPins = {
  readonly owner: string;
  readonly setId: string;
  readonly contentHash: string;
  readonly splitHash: string;
  readonly annotationHash: string;
  readonly scaleHash: string;
  readonly baselineRubricHash: string;
  readonly chosenRubricHash: string;
  readonly judgeConfigHash: string;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly algorithmVersions: AlgorithmVersions;
  readonly bootstrap: { readonly seed: number; readonly resamples: number };
  readonly fitHashes: FitHashes;
  readonly baselineDevRunId: string;
};

export type Preregistration = {
  readonly id: string;
  readonly scopeKey: string;
  readonly pins: PreregPins;
  readonly createdAt: string;
};

export type HeldoutLogEntry = {
  readonly seq: number;
  readonly scopeKey: string;
  readonly kind: 'look' | 'burn';
  /** Rubric hash for a look; null for a burn. */
  readonly rubricHash: string | null;
  /** Authorizing preregistration for a look; null for a burn. */
  readonly preregId: string | null;
  /** Burn reason; null for a look. */
  readonly reason: string | null;
  readonly at: string;
};

export type HeldoutRun = {
  readonly runId: string;
  readonly scopeKey: string;
  readonly rubricHash: string;
  /** seq of the authorizing look entry. */
  readonly lookSeq: number;
  readonly status: RunStatus;
};

export type LockState = {
  /** Monotonic counter for log seq numbers and generated ids. */
  readonly seq: number;
  readonly scopes: Readonly<Record<string, Scope>>;
  readonly preregistrations: Readonly<Record<string, Preregistration>>;
  readonly log: readonly HeldoutLogEntry[];
  /** Keyed by runId. */
  readonly heldoutRuns: Readonly<Record<string, HeldoutRun>>;
};

export function createLockState(): LockState {
  return Object.freeze({ seq: 0, scopes: {}, preregistrations: {}, log: [], heldoutRuns: {} });
}

// ---------------------------------------------------------------------------
// Keys and small helpers
// ---------------------------------------------------------------------------

/** Scope key = sha256(canonical JSON {owner, contentHash, judgeConfigHash}). */
export function scopeKey(owner: string, contentHash: string, judgeConfigHash: string): string {
  return sha256Hex(canonicalJson({ owner, contentHash, judgeConfigHash }));
}

/** Hash of a scale (values + labels) used as a pin. */
export function scaleHash(scale: Scale): string {
  return sha256Hex(canonicalJson({ levels: scale.levels.map((l) => ({ value: l.value, label: l.label })) }));
}

function fail(reason: LockReasonCode, message: string, details?: unknown): Err<LockError> {
  return details === undefined ? err({ reason, message }) : err({ reason, message, details });
}

function nonEmpty(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0;
}

function scopeLog(state: LockState, key: string): HeldoutLogEntry[] {
  return state.log.filter((e) => e.scopeKey === key);
}

function lookedHashes(state: LockState, key: string): string[] {
  const out: string[] = [];
  for (const e of scopeLog(state, key)) if (e.kind === 'look' && e.rubricHash !== null && !out.includes(e.rubricHash)) out.push(e.rubricHash);
  return out;
}

function isBurned(state: LockState, key: string): boolean {
  return state.log.some((e) => e.scopeKey === key && e.kind === 'burn');
}

function runFor(state: LockState, key: string, rubricHash: string): HeldoutRun | undefined {
  return Object.values(state.heldoutRuns).find((r) => r.scopeKey === key && r.rubricHash === rubricHash);
}

// ---------------------------------------------------------------------------
// Preregistration
// ---------------------------------------------------------------------------

export type PreregisterInput = {
  readonly owner: string;
  /** Current stored frozen records of the set. */
  readonly set: FrozenSetRecord;
  readonly judgeConfigHash: string;
  readonly baselineRubricHash: string;
  readonly chosenRubricHash: string;
  /** Completed dev score run of the baseline rubric (needed for the PAV fit), or null. */
  readonly baselineDevRun: DevRunRecord | null;
  /** Fits computed server-side / by MemoryStore from dev rows (K5); null when not computed. */
  readonly fits: FitHashes | null;
  /** Must be byte-equal to s36-v1 (K6). */
  readonly policy: unknown;
  /**
   * K23: split hash recomputed by the server from stored items + seed + algoVersion with the
   * shared split code. When given and different from the stored split hash ⇒ prereg_mismatch.
   */
  readonly recomputedSplitHash?: string;
  readonly now: string;
};

export type PreregisterOutput = { state: LockState; prereg: Preregistration; scopeCreated: boolean };

export function preregister(state: LockState, input: PreregisterInput): Result<PreregisterOutput, LockError> {
  const pol = assertStandardPolicy(input.policy);
  if (!pol.ok) return fail('custom_policy_refused', pol.error.message);
  const policy = pol.value;

  const { set } = input;
  if (set.owner !== input.owner) return fail('forbidden', 'the set belongs to another owner');
  if (!nonEmpty(input.judgeConfigHash) || !nonEmpty(input.baselineRubricHash) || !nonEmpty(input.chosenRubricHash)) {
    return fail('bad_request', 'judge config hash and both rubric hashes are required');
  }
  if (input.baselineRubricHash === input.chosenRubricHash) {
    return fail('bad_request', 'baseline and chosen rubric hashes are identical; preregister one rubric edit');
  }
  if (!set.frozen || set.splitHash === null) {
    return fail('prerequisite_missing', 'the set must be frozen before preregistration', { missing: 'set_not_frozen' });
  }
  const run = input.baselineDevRun;
  if (
    run === null ||
    run.setId !== set.setId ||
    run.rubricHash !== input.baselineRubricHash ||
    run.judgeConfigHash !== input.judgeConfigHash ||
    run.kind !== 'score' ||
    run.split !== 'dev' ||
    run.status !== 'complete'
  ) {
    return fail('prerequisite_missing', 'a completed dev score run of the baseline rubric with this judge config is required', {
      missing: 'baseline_dev_run',
    });
  }
  const fits = input.fits;
  if (fits === null || !nonEmpty(fits.lexicalCutPoints) || !nonEmpty(fits.modalLevel) || !nonEmpty(fits.pavMap)) {
    return fail('prerequisite_missing', 'fit hashes (lexical cut points, modal level, PAV map) are required', { missing: 'fits' });
  }
  if (input.recomputedSplitHash !== undefined && input.recomputedSplitHash !== set.splitHash) {
    return fail('prereg_mismatch', 'recomputed split hash differs from the stored split hash', { fields: ['splitHash'] });
  }

  const key = scopeKey(input.owner, set.contentHash, input.judgeConfigHash);
  const existing = state.scopes[key];
  const scope: Scope = existing ?? Object.freeze({
    key,
    owner: input.owner,
    contentHash: set.contentHash,
    judgeConfigHash: input.judgeConfigHash,
    createdAt: input.now,
  });
  const seq = state.seq + 1;
  const pins: PreregPins = Object.freeze({
    owner: input.owner,
    setId: set.setId,
    contentHash: set.contentHash,
    splitHash: set.splitHash,
    annotationHash: set.annotationHash,
    scaleHash: scaleHash(set.scale),
    baselineRubricHash: input.baselineRubricHash,
    chosenRubricHash: input.chosenRubricHash,
    judgeConfigHash: input.judgeConfigHash,
    policyVersion: policy.version,
    policyHash,
    algorithmVersions: policy.algorithmVersions,
    bootstrap: Object.freeze({ seed: policy.bootstrap.seed, resamples: policy.bootstrap.resamples }),
    fitHashes: Object.freeze({ lexicalCutPoints: fits.lexicalCutPoints, modalLevel: fits.modalLevel, pavMap: fits.pavMap }),
    baselineDevRunId: run.runId,
  });
  const prereg: Preregistration = Object.freeze({ id: `prereg-${seq}`, scopeKey: key, pins, createdAt: input.now });
  const next: LockState = Object.freeze({
    ...state,
    seq,
    scopes: existing ? state.scopes : { ...state.scopes, [key]: scope },
    preregistrations: { ...state.preregistrations, [prereg.id]: prereg },
  });
  return ok({ state: next, prereg, scopeCreated: existing === undefined });
}

// ---------------------------------------------------------------------------
// Held-out look (K13)
// ---------------------------------------------------------------------------

export type LookContext = {
  readonly owner: string;
  /** Current stored frozen records of the preregistered set. */
  readonly set: FrozenSetRecord;
  readonly now: string;
};

export type LookAuthorization = {
  readonly role: 'baseline' | 'chosen';
  readonly rubricHash: string;
  readonly runId: string;
  readonly lookSeq: number;
  /** true when the hash was already looked in this scope: no new slot, existing run reused. */
  readonly reused: boolean;
};

export type LookGrant = {
  readonly scopeKey: string;
  readonly looks: readonly LookAuthorization[];
  /** Number of new distinct rubric hashes looked by this request (slots spent). */
  readonly newSlotsUsed: number;
  readonly distinctLooked: number;
  /** Free slots left; null when the scope is burned (no slot limit, contaminated). */
  readonly slotsRemaining: number | null;
  readonly burned: boolean;
};

/** Fields of the pins that no longer match the current stored frozen records. */
export function pinMismatches(pins: PreregPins, set: FrozenSetRecord): string[] {
  const out: string[] = [];
  if (pins.setId !== set.setId) out.push('setId');
  if (!set.frozen || set.splitHash === null) out.push('frozen');
  if (pins.contentHash !== set.contentHash) out.push('contentHash');
  if (pins.splitHash !== set.splitHash) out.push('splitHash');
  if (pins.annotationHash !== set.annotationHash) out.push('annotationHash');
  if (pins.scaleHash !== scaleHash(set.scale)) out.push('scaleHash');
  if (!assertStandardPolicyRef(pins.policyVersion, pins.policyHash).ok) out.push('policy');
  return out;
}

/**
 * Authorize the held-out look(s) for a preregistration, in one serialized step:
 *  1. preregistration must exist (`not_found`) and belong to the caller (`forbidden`);
 *  2. pins must still equal the current stored frozen records (`prereg_mismatch`);
 *  3. for each pinned rubric hash: already looked in the scope ⇒ reuse its held-out run, no slot;
 *     otherwise it needs a free slot (distinct looked hashes < maxDistinctLooks) unless the scope
 *     is burned. All-or-nothing: if any hash lacks a slot nothing is recorded (`heldout_exhausted`);
 *  4. new looks are appended and their held-out runs created (status `pending`). The look is
 *     spent here, at authorization, regardless of what happens to the run later.
 */
export function requestHeldoutLook(state: LockState, preregId: string, current: LookContext): Result<{ state: LockState; grant: LookGrant }, LockError> {
  const prereg = state.preregistrations[preregId];
  if (prereg === undefined) return fail('not_found', `no preregistration ${preregId}; a held-out look requires one`);
  if (prereg.pins.owner !== current.owner) return fail('forbidden', 'the preregistration belongs to another owner');
  const mismatches = pinMismatches(prereg.pins, current.set);
  if (mismatches.length > 0) {
    return fail('prereg_mismatch', `preregistration pins no longer match the stored records: ${mismatches.join(', ')}`, {
      fields: mismatches,
    });
  }
  const policy = assertStandardPolicyRef(prereg.pins.policyVersion, prereg.pins.policyHash);
  if (!policy.ok) return fail('prereg_mismatch', policy.error.message, { fields: ['policy'] });
  const max = policy.value.maxDistinctLooks;

  const key = prereg.scopeKey;
  const burned = isBurned(state, key);
  const looked = lookedHashes(state, key);
  const wanted: { role: 'baseline' | 'chosen'; hash: string }[] = [
    { role: 'baseline', hash: prereg.pins.baselineRubricHash },
    { role: 'chosen', hash: prereg.pins.chosenRubricHash },
  ];
  const needSlot = wanted.filter((w) => !looked.includes(w.hash)).map((w) => w.hash);
  const distinctNew = [...new Set(needSlot)];
  if (!burned && looked.length + distinctNew.length > max) {
    return fail(
      'heldout_exhausted',
      `scope already looked ${looked.length} distinct rubric version(s); this request needs ${distinctNew.length} more and the limit is ${max} unless the scope is burned`,
      { looked, needed: distinctNew, max },
    );
  }

  let seq = state.seq;
  const log = state.log.slice();
  const runs: Record<string, HeldoutRun> = { ...state.heldoutRuns };
  const looks: LookAuthorization[] = [];
  const created = new Map<string, HeldoutRun>();
  for (const w of wanted) {
    const existingRun = runFor(state, key, w.hash) ?? created.get(w.hash);
    if (existingRun !== undefined) {
      looks.push(Object.freeze({ role: w.role, rubricHash: w.hash, runId: existingRun.runId, lookSeq: existingRun.lookSeq, reused: !created.has(w.hash) }));
      continue;
    }
    seq += 1;
    const entry: HeldoutLogEntry = Object.freeze({ seq, scopeKey: key, kind: 'look', rubricHash: w.hash, preregId, reason: null, at: current.now });
    log.push(entry);
    const run: HeldoutRun = Object.freeze({ runId: `heldout-run-${seq}`, scopeKey: key, rubricHash: w.hash, lookSeq: seq, status: 'pending' });
    runs[run.runId] = run;
    created.set(w.hash, run);
    looks.push(Object.freeze({ role: w.role, rubricHash: w.hash, runId: run.runId, lookSeq: seq, reused: false }));
  }

  const distinctLooked = looked.length + distinctNew.length;
  const next: LockState = Object.freeze({ ...state, seq, log: Object.freeze(log), heldoutRuns: runs });
  return ok({
    state: next,
    grant: Object.freeze({
      scopeKey: key,
      looks: Object.freeze(looks),
      newSlotsUsed: distinctNew.length,
      distinctLooked,
      slotsRemaining: burned ? null : Math.max(0, max - distinctLooked),
      burned,
    }),
  });
}

/** Record a held-out run status change. A failed run does NOT refund its look. */
export function setHeldoutRunStatus(state: LockState, runId: string, status: RunStatus): Result<LockState, LockError> {
  const run = state.heldoutRuns[runId];
  if (run === undefined) return fail('not_found', `no held-out run ${runId}`);
  return ok(Object.freeze({ ...state, heldoutRuns: { ...state.heldoutRuns, [runId]: Object.freeze({ ...run, status }) } }));
}

/** The held-out run of (scope, rubricHash), if that hash was ever looked. */
export function heldoutRunFor(state: LockState, key: string, rubricHash: string): HeldoutRun | null {
  return runFor(state, key, rubricHash) ?? null;
}

// ---------------------------------------------------------------------------
// Burn
// ---------------------------------------------------------------------------

/** Text the owner must type to burn a scope. */
export function burnConfirmationText(key: string): string {
  return `burn ${key.slice(0, 8)}`;
}

export type BurnInput = {
  readonly owner: string;
  readonly scopeKey: string;
  readonly reason: string;
  /** Must equal burnConfirmationText(scopeKey) exactly. */
  readonly confirmation: string;
  readonly now: string;
};

/** Burn a scope: permanent; lifts the slot limit; every later report shows `contaminated`. */
export function burnScope(state: LockState, input: BurnInput): Result<{ state: LockState; entry: HeldoutLogEntry }, LockError> {
  const scope = state.scopes[input.scopeKey];
  if (scope === undefined) return fail('not_found', `no scope ${input.scopeKey}`);
  if (scope.owner !== input.owner) return fail('forbidden', 'the scope belongs to another owner');
  if (input.reason.trim().length === 0) return fail('bad_request', 'a burn needs a reason');
  if (input.confirmation !== burnConfirmationText(input.scopeKey)) {
    return fail('confirmation_mismatch', `type "${burnConfirmationText(input.scopeKey)}" to confirm the burn`);
  }
  if (isBurned(state, input.scopeKey)) return fail('already_burned', 'the scope is already burned');
  const seq = state.seq + 1;
  const entry: HeldoutLogEntry = Object.freeze({
    seq,
    scopeKey: input.scopeKey,
    kind: 'burn',
    rubricHash: null,
    preregId: null,
    reason: input.reason.trim(),
    at: input.now,
  });
  return ok({ state: Object.freeze({ ...state, seq, log: Object.freeze([...state.log, entry]) }), entry });
}

// ---------------------------------------------------------------------------
// Re-split and contamination
// ---------------------------------------------------------------------------

export type ResplitPermission = {
  /** true when the content has been looked under some (now burned) scope: the new split is contaminated. */
  readonly contaminated: boolean;
  readonly scopesWithLooks: readonly string[];
};

/**
 * May the owner re-split content `contentHash` (a new seed / new split)? Refused while any scope
 * on that content has a look, unless EVERY such scope is burned (the new split is then
 * contaminated). Content never looked may be re-split freely.
 */
export function canResplit(state: LockState, owner: string, contentHash: string): Result<ResplitPermission, LockError> {
  const scopes = Object.values(state.scopes).filter((s) => s.owner === owner && s.contentHash === contentHash);
  const withLooks = scopes.filter((s) => lookedHashes(state, s.key).length > 0).map((s) => s.key).sort();
  const unburned = withLooks.filter((k) => !isBurned(state, k));
  if (unburned.length > 0) {
    return fail('resplit_refused', 'this content has held-out looks in a scope that is not burned; burn every looked scope first', {
      unburnedScopes: unburned,
    });
  }
  return ok({ contaminated: withLooks.length > 0, scopesWithLooks: withLooks });
}

export type ContaminationStatus = {
  readonly scopeKey: string;
  readonly status: 'clean' | 'contaminated';
  readonly burned: boolean;
  readonly distinctLookedHashes: readonly string[];
  /** Look entries in the log (equals distinct hashes: one look per (scope, hash), ever). */
  readonly looksUsed: number;
  /** null when burned (no limit); otherwise maxDistinctLooks − distinct looked (≥ 0). */
  readonly slotsRemaining: number | null;
  readonly maxDistinctLooks: number;
};

/** Contamination status of a scope; an unknown scope is clean with no looks. */
export function contaminationStatus(state: LockState, key: string, maxDistinctLooks: number = S36_V1.maxDistinctLooks): ContaminationStatus {
  const burned = isBurned(state, key);
  const distinct = lookedHashes(state, key);
  return {
    scopeKey: key,
    status: burned ? 'contaminated' : 'clean',
    burned,
    distinctLookedHashes: distinct,
    looksUsed: scopeLog(state, key).filter((e) => e.kind === 'look').length,
    slotsRemaining: burned ? null : Math.max(0, maxDistinctLooks - distinct.length),
    maxDistinctLooks,
  };
}
