import { describe, expect, it } from 'vitest';
import {
  burnConfirmationText,
  burnScope,
  canResplit,
  contaminationStatus,
  createLockState,
  heldoutRunFor,
  preregister,
  requestHeldoutLook,
  scopeKey,
  setHeldoutRunStatus,
  type FrozenSetRecord,
  type LockState,
  type PreregisterInput,
} from '../../../src/core/heldoutlock/policy.ts';
import { policyHash, S36_V1 } from '../../../src/core/heldoutlock/policyConst.ts';
import { LOCK_SCENARIOS, lockScenariosJson, runLockScenario } from '../../../src/core/heldoutlock/scenarios.ts';
import { unwrap } from '../../../src/core/result.ts';
import type { Scale } from '../../../src/core/types.ts';

const SCALE: Scale = { levels: [1, 2, 3, 4, 5].map((v) => ({ value: v, label: String(v) })) };

function set(overrides: Partial<FrozenSetRecord> = {}): FrozenSetRecord {
  return {
    setId: 'set-1',
    owner: 'u1',
    contentHash: 'content-1',
    annotationHash: 'ann-1',
    splitHash: 'split-1',
    frozen: true,
    scale: SCALE,
    ...overrides,
  };
}

function preregInput(overrides: Partial<PreregisterInput> = {}): PreregisterInput {
  const s = overrides.set ?? set();
  return {
    owner: 'u1',
    set: s,
    judgeConfigHash: 'jc-1',
    baselineRubricHash: 'r1',
    chosenRubricHash: 'r2',
    baselineDevRun: { runId: 'dev-1', setId: s.setId, rubricHash: 'r1', judgeConfigHash: 'jc-1', kind: 'score', split: 'dev', status: 'complete' },
    fits: { lexicalCutPoints: 'h-lex', modalLevel: 'h-modal', pavMap: 'h-pav' },
    policy: S36_V1,
    now: 't0',
    ...overrides,
  };
}

function deepSnapshot(s: LockState): string {
  return JSON.stringify(s);
}

describe('LOCK_SCENARIOS (data table for SQL parity)', () => {
  it.each(LOCK_SCENARIOS.map((s) => [s.name, s] as const))('%s', (_name, scenario) => {
    const run = runLockScenario(scenario);
    const failures = run.outcomes.filter((o) => o.mismatches.length > 0).map((o) => `step ${o.index} (${o.op}): ${o.mismatches.join('; ')}`);
    expect(failures).toEqual([]);
    expect(run.passed).toBe(true);
  });

  it('covers every heldoutlock case listed in PLAN §4', () => {
    const covered = new Set(LOCK_SCENARIOS.flatMap((s) => s.covers));
    for (const c of [
      'baseline+chosen ok',
      'third refused',
      'burn => contaminated',
      'look without prereg refused',
      'pin mismatch refused',
      'look spent on failed run',
      'renamed/reordered reimport shares scope',
      're-split after look refused',
      'already-looked hash consumes no slot',
      'custom policy refused',
    ]) {
      expect(covered.has(c)).toBe(true);
    }
  });

  it('is plain JSON (round-trips unchanged)', () => {
    expect(JSON.parse(lockScenariosJson())).toEqual(JSON.parse(JSON.stringify(LOCK_SCENARIOS)));
  });

  it('a wrong expectation is reported as a mismatch (the runner is not vacuous)', () => {
    const base = LOCK_SCENARIOS[0]!;
    const broken = {
      ...base,
      steps: base.steps.map((st, i) => (i === 4 && st.op === 'look' ? { ...st, expect: { ok: true as const } } : st)),
    };
    expect(runLockScenario(broken).passed).toBe(false);
  });
});

describe('scopeKey', () => {
  it('depends on owner, contentHash and judgeConfigHash only', () => {
    const k = scopeKey('u1', 'c', 'j');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(scopeKey('u1', 'c', 'j')).toBe(k);
    expect(scopeKey('u2', 'c', 'j')).not.toBe(k);
    expect(scopeKey('u1', 'c2', 'j')).not.toBe(k);
    expect(scopeKey('u1', 'c', 'j2')).not.toBe(k);
  });
});

describe('preregister', () => {
  it('pins the frozen records, both hashes, policy and fits', () => {
    const r = unwrap(preregister(createLockState(), preregInput()));
    const p = r.prereg.pins;
    expect(p.contentHash).toBe('content-1');
    expect(p.splitHash).toBe('split-1');
    expect(p.annotationHash).toBe('ann-1');
    expect(p.baselineRubricHash).toBe('r1');
    expect(p.chosenRubricHash).toBe('r2');
    expect(p.judgeConfigHash).toBe('jc-1');
    expect(p.policyVersion).toBe('s36-v1');
    expect(p.policyHash).toBe(policyHash);
    expect(p.algorithmVersions).toEqual(S36_V1.algorithmVersions);
    expect(p.bootstrap).toEqual({ seed: 36, resamples: 2000 });
    expect(p.fitHashes).toEqual({ lexicalCutPoints: 'h-lex', modalLevel: 'h-modal', pavMap: 'h-pav' });
    expect(r.prereg.scopeKey).toBe(scopeKey('u1', 'content-1', 'jc-1'));
    expect(r.scopeCreated).toBe(true);
  });

  it('does not mutate the input state', () => {
    const s0 = createLockState();
    const before = deepSnapshot(s0);
    unwrap(preregister(s0, preregInput()));
    expect(deepSnapshot(s0)).toBe(before);
  });

  it('a preregistration consumes no look', () => {
    const r = unwrap(preregister(createLockState(), preregInput()));
    expect(contaminationStatus(r.state, r.prereg.scopeKey).slotsRemaining).toBe(2);
    expect(r.state.log).toHaveLength(0);
  });
});

describe('requestHeldoutLook', () => {
  it('creates one held-out run per hash, spent at authorization, and reuses it later', () => {
    const p = unwrap(preregister(createLockState(), preregInput()));
    const before = deepSnapshot(p.state);
    const l1 = unwrap(requestHeldoutLook(p.state, p.prereg.id, { owner: 'u1', set: set(), now: 't1' }));
    expect(deepSnapshot(p.state)).toBe(before);
    expect(l1.grant.looks.map((l) => [l.role, l.rubricHash, l.reused])).toEqual([
      ['baseline', 'r1', false],
      ['chosen', 'r2', false],
    ]);
    expect(l1.state.log.filter((e) => e.kind === 'look')).toHaveLength(2);
    const chosenRun = heldoutRunFor(l1.state, p.prereg.scopeKey, 'r2')!;
    expect(chosenRun.status).toBe('pending');

    const failed = unwrap(setHeldoutRunStatus(l1.state, chosenRun.runId, 'failed'));
    const l2 = unwrap(requestHeldoutLook(failed, p.prereg.id, { owner: 'u1', set: set(), now: 't2' }));
    expect(l2.grant.newSlotsUsed).toBe(0);
    expect(l2.grant.looks.every((l) => l.reused)).toBe(true);
    expect(l2.grant.looks.find((l) => l.role === 'chosen')!.runId).toBe(chosenRun.runId);
    expect(l2.state.log).toHaveLength(2);
    expect(Object.keys(l2.state.heldoutRuns)).toHaveLength(2);
  });

  it('reports the mismatching pin fields', () => {
    const p = unwrap(preregister(createLockState(), preregInput()));
    const r = requestHeldoutLook(p.state, p.prereg.id, { owner: 'u1', set: set({ splitHash: 'other', annotationHash: 'other' }), now: 't1' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.reason).toBe('prereg_mismatch');
      expect((r.error.details as { fields: string[] }).fields).toEqual(['splitHash', 'annotationHash']);
    }
  });

  it('scale change is a pin mismatch', () => {
    const p = unwrap(preregister(createLockState(), preregInput()));
    const scale = { levels: SCALE.levels.map((l) => (l.value === 5 ? { value: 5, label: 'excellent' } : l)) };
    const r = requestHeldoutLook(p.state, p.prereg.id, { owner: 'u1', set: set({ scale }), now: 't1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('prereg_mismatch');
  });
});

describe('burn, re-split, contamination', () => {
  it('burn needs the exact typed confirmation and is permanent', () => {
    const p = unwrap(preregister(createLockState(), preregInput()));
    const key = p.prereg.scopeKey;
    expect(burnConfirmationText(key)).toBe(`burn ${key.slice(0, 8)}`);
    const bad = burnScope(p.state, { owner: 'u1', scopeKey: key, reason: 'r', confirmation: 'burn', now: 't' });
    expect(bad.ok).toBe(false);
    const b = unwrap(burnScope(p.state, { owner: 'u1', scopeKey: key, reason: 'want v3', confirmation: burnConfirmationText(key), now: 't' }));
    expect(contaminationStatus(b.state, key).status).toBe('contaminated');
    expect(contaminationStatus(p.state, key).status).toBe('clean');
  });

  it('re-split is free before any look and refused after one', () => {
    const p = unwrap(preregister(createLockState(), preregInput()));
    expect(unwrap(canResplit(p.state, 'u1', 'content-1')).contaminated).toBe(false);
    const l = unwrap(requestHeldoutLook(p.state, p.prereg.id, { owner: 'u1', set: set(), now: 't1' }));
    const r = canResplit(l.state, 'u1', 'content-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('resplit_refused');
    // Another owner's content with the same hash is a different scope family.
    expect(unwrap(canResplit(l.state, 'u2', 'content-1')).contaminated).toBe(false);
  });

  it('unknown scope is clean with two free slots', () => {
    const c = contaminationStatus(createLockState(), 'nope');
    expect(c).toMatchObject({ status: 'clean', burned: false, looksUsed: 0, slotsRemaining: 2 });
  });
});
