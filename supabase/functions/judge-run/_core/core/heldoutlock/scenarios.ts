// Held-out lock scenario table (PLAN.md §3.9 "scenario table exported as data", §4 heldoutlock list).
//
// LOCK_SCENARIOS is plain JSON-serialisable data: each scenario declares stored set records and a
// list of steps with expected outcomes. `runLockScenario` drives the pure TS policy; the later
// SQL parity check drives the same table against `request_heldout_look` / `burn_scope` / … and
// must observe the same outcomes (ok / reason code / slot counts / contamination).

import type { Scale } from '../types.ts';
import {
  burnConfirmationText,
  burnScope,
  canResplit,
  contaminationStatus,
  createLockState,
  preregister,
  requestHeldoutLook,
  scopeKey,
  setHeldoutRunStatus,
  type DevRunRecord,
  type FrozenSetRecord,
  type LockReasonCode,
  type LockState,
  type RunStatus,
} from './policy.ts';
import { S36_V1 } from './policyConst.ts';

export type ScenarioSetRecord = {
  setId: string;
  owner: string;
  contentHash: string;
  annotationHash: string;
  splitHash: string | null;
  frozen: boolean;
  scale: Scale;
};

export type StepExpect =
  | {
      ok: true;
      /** look: new slots spent. */
      newSlots?: number;
      /** look: number of reused (already-looked) hashes. */
      reused?: number;
      /** look / contamination: free slots after the step (null = burned, unlimited). */
      slotsRemaining?: number | null;
      /** resplit: new split contaminated. */
      contaminated?: boolean;
      /** contamination step. */
      status?: 'clean' | 'contaminated';
      distinctLooked?: number;
    }
  | { ok: false; reason: LockReasonCode };

export type LockScenarioStep =
  | {
      op: 'preregister';
      /** Label used by later steps to refer to this preregistration. */
      as: string;
      set: string;
      owner?: string;
      judgeConfigHash: string;
      baseline: string;
      chosen: string;
      /** Default 'complete'. */
      baselineDevRun?: 'complete' | 'missing' | 'running';
      /** Default 'present'. */
      fits?: 'present' | 'missing';
      /** Default 'standard'. */
      policy?: 'standard' | 'custom';
      recomputedSplitHash?: string;
      expect: StepExpect;
    }
  | { op: 'look'; prereg: string; owner?: string; expect: StepExpect }
  | { op: 'run_status'; prereg: string; role: 'baseline' | 'chosen'; status: RunStatus; expect: StepExpect }
  | {
      op: 'burn';
      set: string;
      judgeConfigHash: string;
      owner?: string;
      reason: string;
      /** 'correct' types the exact confirmation text; anything else is typed verbatim. */
      confirmation: string;
      expect: StepExpect;
    }
  | { op: 'resplit'; set: string; owner?: string; expect: StepExpect }
  | { op: 'contamination'; set: string; judgeConfigHash: string; owner?: string; expect: StepExpect }
  /** Overwrite fields of a stored set record (simulates a re-split or tampered records). */
  | { op: 'update_set'; set: string; patch: { splitHash?: string | null; annotationHash?: string; frozen?: boolean } };

export type LockScenario = {
  name: string;
  /** PLAN §4 case(s) this scenario covers. */
  covers: string[];
  sets: Record<string, ScenarioSetRecord>;
  steps: LockScenarioStep[];
};

const SCALE5: Scale = {
  levels: [
    { value: 1, label: '1' },
    { value: 2, label: '2' },
    { value: 3, label: '3' },
    { value: 4, label: '4' },
    { value: 5, label: '5' },
  ],
};

function frozenSet(setId: string, contentHash = 'content-A', splitHash = 'split-A', owner = 'u1'): ScenarioSetRecord {
  return { setId, owner, contentHash, annotationHash: `ann-${contentHash}`, splitHash, frozen: true, scale: SCALE5 };
}

const J = 'judgecfg-mock';

export const LOCK_SCENARIOS: readonly LockScenario[] = [
  {
    name: 'baseline + chosen ok, third version refused, burn allows it and contaminates',
    covers: ['baseline+chosen ok', 'third refused', 'burn => contaminated'],
    sets: { A: frozenSet('set-A') },
    steps: [
      { op: 'preregister', as: 'p12', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', expect: { ok: true } },
      { op: 'contamination', set: 'A', judgeConfigHash: J, expect: { ok: true, status: 'clean', distinctLooked: 0, slotsRemaining: 2 } },
      { op: 'look', prereg: 'p12', expect: { ok: true, newSlots: 2, reused: 0, slotsRemaining: 0 } },
      { op: 'preregister', as: 'p13', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r3', expect: { ok: true } },
      { op: 'look', prereg: 'p13', expect: { ok: false, reason: 'heldout_exhausted' } },
      { op: 'contamination', set: 'A', judgeConfigHash: J, expect: { ok: true, status: 'clean', distinctLooked: 2, slotsRemaining: 0 } },
      { op: 'burn', set: 'A', judgeConfigHash: J, reason: 'try v3', confirmation: 'yes', expect: { ok: false, reason: 'confirmation_mismatch' } },
      { op: 'burn', set: 'A', judgeConfigHash: J, reason: '   ', confirmation: 'correct', expect: { ok: false, reason: 'bad_request' } },
      { op: 'burn', set: 'A', judgeConfigHash: J, reason: 'try v3', confirmation: 'correct', expect: { ok: true } },
      { op: 'burn', set: 'A', judgeConfigHash: J, reason: 'again', confirmation: 'correct', expect: { ok: false, reason: 'already_burned' } },
      { op: 'look', prereg: 'p13', expect: { ok: true, newSlots: 1, reused: 1, slotsRemaining: null } },
      { op: 'contamination', set: 'A', judgeConfigHash: J, expect: { ok: true, status: 'contaminated', distinctLooked: 3, slotsRemaining: null } },
    ],
  },
  {
    name: 'look without a preregistration is refused',
    covers: ['look without prereg refused'],
    sets: { A: frozenSet('set-A') },
    steps: [
      { op: 'look', prereg: 'never-registered', expect: { ok: false, reason: 'not_found' } },
      { op: 'contamination', set: 'A', judgeConfigHash: J, expect: { ok: true, status: 'clean', distinctLooked: 0, slotsRemaining: 2 } },
    ],
  },
  {
    name: 'pin mismatch refused (records changed after preregistration; recomputed split hash differs)',
    covers: ['pin mismatch refused'],
    sets: { A: frozenSet('set-A') },
    steps: [
      { op: 'preregister', as: 'p', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', recomputedSplitHash: 'split-HANDPICKED', expect: { ok: false, reason: 'prereg_mismatch' } },
      { op: 'preregister', as: 'p', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', recomputedSplitHash: 'split-A', expect: { ok: true } },
      { op: 'update_set', set: 'A', patch: { annotationHash: 'ann-TAMPERED' } },
      { op: 'look', prereg: 'p', expect: { ok: false, reason: 'prereg_mismatch' } },
      { op: 'contamination', set: 'A', judgeConfigHash: J, expect: { ok: true, status: 'clean', distinctLooked: 0, slotsRemaining: 2 } },
      { op: 'update_set', set: 'A', patch: { annotationHash: 'ann-content-A', splitHash: 'split-B' } },
      { op: 'look', prereg: 'p', expect: { ok: false, reason: 'prereg_mismatch' } },
    ],
  },
  {
    name: 'look is spent at authorization even when the held-out run fails',
    covers: ['look spent on failed run', 'already-looked hash consumes no slot'],
    sets: { A: frozenSet('set-A') },
    steps: [
      { op: 'preregister', as: 'p12', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', expect: { ok: true } },
      { op: 'look', prereg: 'p12', expect: { ok: true, newSlots: 2, reused: 0, slotsRemaining: 0 } },
      { op: 'run_status', prereg: 'p12', role: 'chosen', status: 'failed', expect: { ok: true } },
      { op: 'contamination', set: 'A', judgeConfigHash: J, expect: { ok: true, status: 'clean', distinctLooked: 2, slotsRemaining: 0 } },
      // Re-requesting the same preregistration reuses both runs (the failed one is resumed, not re-looked).
      { op: 'look', prereg: 'p12', expect: { ok: true, newSlots: 0, reused: 2, slotsRemaining: 0 } },
      { op: 'preregister', as: 'p13', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r3', expect: { ok: true } },
      { op: 'look', prereg: 'p13', expect: { ok: false, reason: 'heldout_exhausted' } },
    ],
  },
  {
    name: 'already-looked hash reuses its run and consumes no slot',
    covers: ['already-looked hash consumes no slot'],
    sets: { A: frozenSet('set-A') },
    steps: [
      { op: 'preregister', as: 'p12', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', expect: { ok: true } },
      { op: 'look', prereg: 'p12', expect: { ok: true, newSlots: 2, reused: 0, slotsRemaining: 0 } },
      // Same two versions in the other order: both reused, no slot.
      { op: 'preregister', as: 'p21', set: 'A', judgeConfigHash: J, baseline: 'r2', chosen: 'r1', expect: { ok: true } },
      { op: 'look', prereg: 'p21', expect: { ok: true, newSlots: 0, reused: 2, slotsRemaining: 0 } },
      { op: 'contamination', set: 'A', judgeConfigHash: J, expect: { ok: true, status: 'clean', distinctLooked: 2, slotsRemaining: 0 } },
    ],
  },
  {
    name: 'two never-looked versions are refused once both slots are spent, and nothing is recorded (all-or-nothing)',
    covers: ['already-looked hash consumes no slot', 'third refused'],
    sets: { A: frozenSet('set-A') },
    steps: [
      { op: 'preregister', as: 'p12', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', expect: { ok: true } },
      { op: 'preregister', as: 'p34', set: 'A', judgeConfigHash: J, baseline: 'r3', chosen: 'r4', expect: { ok: true } },
      { op: 'look', prereg: 'p12', expect: { ok: true, newSlots: 2, reused: 0, slotsRemaining: 0 } },
      { op: 'look', prereg: 'p34', expect: { ok: false, reason: 'heldout_exhausted' } },
      { op: 'contamination', set: 'A', judgeConfigHash: J, expect: { ok: true, status: 'clean', distinctLooked: 2, slotsRemaining: 0 } },
    ],
  },
  {
    name: 'renamed / reordered re-import (same contentHash, new set id) shares the scope',
    covers: ['renamed/reordered reimport shares scope'],
    sets: { A: frozenSet('set-A'), A2: frozenSet('set-A-renamed') },
    steps: [
      { op: 'preregister', as: 'pA', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', expect: { ok: true } },
      { op: 'look', prereg: 'pA', expect: { ok: true, newSlots: 2, reused: 0, slotsRemaining: 0 } },
      { op: 'contamination', set: 'A2', judgeConfigHash: J, expect: { ok: true, status: 'clean', distinctLooked: 2, slotsRemaining: 0 } },
      { op: 'preregister', as: 'pB', set: 'A2', judgeConfigHash: J, baseline: 'r1', chosen: 'r3', expect: { ok: true } },
      { op: 'look', prereg: 'pB', expect: { ok: false, reason: 'heldout_exhausted' } },
      { op: 'preregister', as: 'pC', set: 'A2', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', expect: { ok: true } },
      { op: 'look', prereg: 'pC', expect: { ok: true, newSlots: 0, reused: 2, slotsRemaining: 0 } },
    ],
  },
  {
    name: 'changed content is a new scope; another judge config is its own scope',
    covers: ['renamed/reordered reimport shares scope'],
    sets: { A: frozenSet('set-A'), B: frozenSet('set-B', 'content-B', 'split-B') },
    steps: [
      { op: 'preregister', as: 'pA', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', expect: { ok: true } },
      { op: 'look', prereg: 'pA', expect: { ok: true, newSlots: 2, reused: 0, slotsRemaining: 0 } },
      { op: 'contamination', set: 'B', judgeConfigHash: J, expect: { ok: true, status: 'clean', distinctLooked: 0, slotsRemaining: 2 } },
      { op: 'contamination', set: 'A', judgeConfigHash: 'judgecfg-other', expect: { ok: true, status: 'clean', distinctLooked: 0, slotsRemaining: 2 } },
      { op: 'preregister', as: 'pJ', set: 'A', judgeConfigHash: 'judgecfg-other', baseline: 'r1', chosen: 'r3', expect: { ok: true } },
      { op: 'look', prereg: 'pJ', expect: { ok: true, newSlots: 2, reused: 0, slotsRemaining: 0 } },
    ],
  },
  {
    name: 're-split refused after a look until every looked scope is burned; the new split is contaminated',
    covers: ['re-split after look refused', 'burn => contaminated'],
    sets: { A: frozenSet('set-A'), B: frozenSet('set-B', 'content-B', 'split-B') },
    steps: [
      { op: 'resplit', set: 'B', expect: { ok: true, contaminated: false } },
      { op: 'preregister', as: 'p1', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', expect: { ok: true } },
      { op: 'resplit', set: 'A', expect: { ok: true, contaminated: false } },
      { op: 'look', prereg: 'p1', expect: { ok: true, newSlots: 2, reused: 0, slotsRemaining: 0 } },
      { op: 'resplit', set: 'A', expect: { ok: false, reason: 'resplit_refused' } },
      { op: 'preregister', as: 'p2', set: 'A', judgeConfigHash: 'judgecfg-other', baseline: 'r1', chosen: 'r2', expect: { ok: true } },
      { op: 'look', prereg: 'p2', expect: { ok: true, newSlots: 2, reused: 0, slotsRemaining: 0 } },
      { op: 'burn', set: 'A', judgeConfigHash: J, reason: 'need a new split', confirmation: 'correct', expect: { ok: true } },
      { op: 'resplit', set: 'A', expect: { ok: false, reason: 'resplit_refused' } },
      { op: 'burn', set: 'A', judgeConfigHash: 'judgecfg-other', reason: 'need a new split', confirmation: 'correct', expect: { ok: true } },
      { op: 'resplit', set: 'A', expect: { ok: true, contaminated: true } },
      // After the re-split, old preregistrations no longer match the stored split.
      { op: 'update_set', set: 'A', patch: { splitHash: 'split-A2' } },
      { op: 'look', prereg: 'p1', expect: { ok: false, reason: 'prereg_mismatch' } },
      { op: 'contamination', set: 'A', judgeConfigHash: J, expect: { ok: true, status: 'contaminated', slotsRemaining: null } },
    ],
  },
  {
    name: 'preregistration prerequisites and policy',
    covers: ['custom policy refused', 'look without prereg refused'],
    sets: {
      A: frozenSet('set-A'),
      U: { setId: 'set-U', owner: 'u1', contentHash: 'content-U', annotationHash: 'ann-U', splitHash: null, frozen: false, scale: SCALE5 },
    },
    steps: [
      { op: 'preregister', as: 'x', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', policy: 'custom', expect: { ok: false, reason: 'custom_policy_refused' } },
      { op: 'preregister', as: 'x', set: 'U', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', expect: { ok: false, reason: 'prerequisite_missing' } },
      { op: 'preregister', as: 'x', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', baselineDevRun: 'missing', expect: { ok: false, reason: 'prerequisite_missing' } },
      { op: 'preregister', as: 'x', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', baselineDevRun: 'running', expect: { ok: false, reason: 'prerequisite_missing' } },
      { op: 'preregister', as: 'x', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', fits: 'missing', expect: { ok: false, reason: 'prerequisite_missing' } },
      { op: 'preregister', as: 'x', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r1', expect: { ok: false, reason: 'bad_request' } },
      { op: 'preregister', as: 'x', set: 'A', owner: 'u2', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', expect: { ok: false, reason: 'forbidden' } },
      { op: 'look', prereg: 'x', expect: { ok: false, reason: 'not_found' } },
      { op: 'preregister', as: 'x', set: 'A', judgeConfigHash: J, baseline: 'r1', chosen: 'r2', expect: { ok: true } },
      { op: 'look', prereg: 'x', owner: 'u2', expect: { ok: false, reason: 'forbidden' } },
      { op: 'burn', set: 'A', judgeConfigHash: J, owner: 'u2', reason: 'x', confirmation: 'correct', expect: { ok: false, reason: 'not_found' } },
      { op: 'look', prereg: 'x', expect: { ok: true, newSlots: 2, reused: 0, slotsRemaining: 0 } },
    ],
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type StepOutcome = {
  index: number;
  op: LockScenarioStep['op'];
  ok: boolean;
  reason?: LockReasonCode;
  newSlots?: number;
  reused?: number;
  slotsRemaining?: number | null;
  contaminated?: boolean;
  status?: 'clean' | 'contaminated';
  distinctLooked?: number;
  /** Human-readable differences from the expectation (empty = matched). */
  mismatches: string[];
};

export type ScenarioRun = { name: string; passed: boolean; outcomes: StepOutcome[]; finalState: LockState };

export const SCENARIO_FITS = { lexicalCutPoints: 'fit-lexical', modalLevel: 'fit-modal', pavMap: 'fit-pav' } as const;

/** A non-standard policy used by the scenarios (n floor lowered to 12). */
export const SCENARIO_CUSTOM_POLICY = { ...S36_V1, nFloor: 12 };

function compare(expect: StepExpect | undefined, out: Omit<StepOutcome, 'mismatches' | 'index' | 'op'>): string[] {
  if (expect === undefined) return [];
  const m: string[] = [];
  if (expect.ok !== out.ok) {
    m.push(`expected ok=${String(expect.ok)}${expect.ok ? '' : ` (${expect.reason})`}, got ok=${String(out.ok)}${out.reason ? ` (${out.reason})` : ''}`);
    return m;
  }
  if (!expect.ok) {
    if (expect.reason !== out.reason) m.push(`expected reason ${expect.reason}, got ${String(out.reason)}`);
    return m;
  }
  const keys = ['newSlots', 'reused', 'slotsRemaining', 'contaminated', 'status', 'distinctLooked'] as const;
  for (const k of keys) {
    if (expect[k] !== undefined && expect[k] !== out[k]) m.push(`expected ${k}=${String(expect[k])}, got ${String(out[k])}`);
  }
  return m;
}

/** Drive one scenario through the pure policy. Never throws on a refused step. */
export function runLockScenario(scenario: LockScenario): ScenarioRun {
  let state = createLockState();
  const sets = new Map<string, ScenarioSetRecord>();
  for (const [name, rec] of Object.entries(scenario.sets)) sets.set(name, { ...rec });
  const preregIds = new Map<string, { id: string; set: string }>();
  const outcomes: StepOutcome[] = [];

  const setRecord = (name: string): FrozenSetRecord => {
    const rec = sets.get(name);
    if (rec === undefined) throw new Error(`scenario ${scenario.name}: unknown set ${name}`);
    return rec;
  };

  scenario.steps.forEach((step, index) => {
    const now = `scenario-step-${index}`;
    let out: Omit<StepOutcome, 'mismatches' | 'index' | 'op'> = { ok: true };
    let expect: StepExpect | undefined;
    switch (step.op) {
      case 'preregister': {
        expect = step.expect;
        const set = setRecord(step.set);
        const owner = step.owner ?? set.owner;
        const devRun: DevRunRecord | null =
          (step.baselineDevRun ?? 'complete') === 'missing'
            ? null
            : {
                runId: `dev-run-${step.as}-${index}`,
                setId: set.setId,
                rubricHash: step.baseline,
                judgeConfigHash: step.judgeConfigHash,
                kind: 'score',
                split: 'dev',
                status: step.baselineDevRun === 'running' ? 'running' : 'complete',
              };
        const r = preregister(state, {
          owner,
          set,
          judgeConfigHash: step.judgeConfigHash,
          baselineRubricHash: step.baseline,
          chosenRubricHash: step.chosen,
          baselineDevRun: devRun,
          fits: (step.fits ?? 'present') === 'present' ? SCENARIO_FITS : null,
          policy: (step.policy ?? 'standard') === 'standard' ? S36_V1 : SCENARIO_CUSTOM_POLICY,
          ...(step.recomputedSplitHash === undefined ? {} : { recomputedSplitHash: step.recomputedSplitHash }),
          now,
        });
        if (r.ok) {
          state = r.value.state;
          preregIds.set(step.as, { id: r.value.prereg.id, set: step.set });
        } else out = { ok: false, reason: r.error.reason };
        break;
      }
      case 'look': {
        expect = step.expect;
        const ref = preregIds.get(step.prereg);
        const setName = ref?.set ?? Object.keys(scenario.sets)[0]!;
        const set = setRecord(setName);
        const r = requestHeldoutLook(state, ref?.id ?? `unregistered:${step.prereg}`, { owner: step.owner ?? set.owner, set, now });
        if (r.ok) {
          state = r.value.state;
          out = {
            ok: true,
            newSlots: r.value.grant.newSlotsUsed,
            reused: r.value.grant.looks.filter((l) => l.reused).length,
            slotsRemaining: r.value.grant.slotsRemaining,
          };
        } else out = { ok: false, reason: r.error.reason };
        break;
      }
      case 'run_status': {
        expect = step.expect;
        const ref = preregIds.get(step.prereg);
        const prereg = ref === undefined ? undefined : state.preregistrations[ref.id];
        if (prereg === undefined) {
          out = { ok: false, reason: 'not_found' };
          break;
        }
        const hash = step.role === 'baseline' ? prereg.pins.baselineRubricHash : prereg.pins.chosenRubricHash;
        const run = Object.values(state.heldoutRuns).find((x) => x.scopeKey === prereg.scopeKey && x.rubricHash === hash);
        const r = setHeldoutRunStatus(state, run?.runId ?? 'missing-run', step.status);
        if (r.ok) state = r.value;
        else out = { ok: false, reason: r.error.reason };
        break;
      }
      case 'burn': {
        expect = step.expect;
        const set = setRecord(step.set);
        const owner = step.owner ?? set.owner;
        const key = scopeKey(owner, set.contentHash, step.judgeConfigHash);
        const r = burnScope(state, {
          owner,
          scopeKey: key,
          reason: step.reason,
          confirmation: step.confirmation === 'correct' ? burnConfirmationText(key) : step.confirmation,
          now,
        });
        if (r.ok) state = r.value.state;
        else out = { ok: false, reason: r.error.reason };
        break;
      }
      case 'resplit': {
        expect = step.expect;
        const set = setRecord(step.set);
        const r = canResplit(state, step.owner ?? set.owner, set.contentHash);
        out = r.ok ? { ok: true, contaminated: r.value.contaminated } : { ok: false, reason: r.error.reason };
        break;
      }
      case 'contamination': {
        expect = step.expect;
        const set = setRecord(step.set);
        const c = contaminationStatus(state, scopeKey(step.owner ?? set.owner, set.contentHash, step.judgeConfigHash));
        out = { ok: true, status: c.status, distinctLooked: c.distinctLookedHashes.length, slotsRemaining: c.slotsRemaining };
        break;
      }
      case 'update_set': {
        const rec = sets.get(step.set);
        if (rec === undefined) throw new Error(`scenario ${scenario.name}: unknown set ${step.set}`);
        sets.set(step.set, { ...rec, ...step.patch });
        break;
      }
    }
    outcomes.push({ index, op: step.op, ...out, mismatches: compare(expect, out) });
  });

  return { name: scenario.name, passed: outcomes.every((o) => o.mismatches.length === 0), outcomes, finalState: state };
}

/** JSON text of the scenario table (for the later SQL parity harness). */
export function lockScenariosJson(): string {
  return JSON.stringify(LOCK_SCENARIOS, null, 2);
}
