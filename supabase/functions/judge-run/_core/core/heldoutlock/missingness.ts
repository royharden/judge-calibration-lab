// Missingness guard (PLAN.md §3.9, [C] §2.5), preregistered in s36-v1.
//
// With N planned held-out items, T = max(2, floor(0.05 · N)). The comparison `cannot support`s when
//   max(U_baseline, U_chosen) > T, or |U_chosen − U_baseline| > T, or common evaluable n < 20,
// where U_v = held-out items unusable under version v and the common evaluable n = items usable
// under both versions (the paired denominator). The descriptive Δ is still shown by the report.

import type { HeldoutPolicy } from './policyConst.ts';
import { S36_V1 } from './policyConst.ts';

export type MissingnessReason = 'unusable_over_threshold' | 'unusable_gap_over_threshold' | 'common_n_below_floor';

export type MissingnessInput = {
  /** N: planned held-out items. */
  plannedN: number;
  /** U_baseline: held-out items unusable under the baseline rubric. */
  unusableBaseline: number;
  /** U_chosen: held-out items unusable under the chosen rubric. */
  unusableChosen: number;
  /** Items usable under both versions. */
  commonEvaluableN: number;
};

export type MissingnessResult = {
  /** true = guard passes (the verdict may be decided by the interval). */
  ok: boolean;
  /** T for this N. */
  threshold: number;
  nFloor: number;
  reasons: MissingnessReason[];
  messages: string[];
  input: MissingnessInput;
};

/** T = max(tMin, floor(tFraction · N)) — s36-v1: max(2, floor(0.05·N)). */
export function missingnessThreshold(plannedN: number, policy: HeldoutPolicy = S36_V1): number {
  if (!Number.isInteger(plannedN) || plannedN < 0) throw new RangeError(`plannedN must be a non-negative integer, got ${String(plannedN)}`);
  // Integer arithmetic for the floor so that e.g. 0.05·60 is exactly 3 (avoids 2.9999… drift).
  const pct = Math.round(policy.missingness.tFraction * 10000);
  return Math.max(policy.missingness.tMin, Math.floor((plannedN * pct) / 10000));
}

function assertCount(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer, got ${String(v)}`);
}

export function missingnessGuard(input: MissingnessInput, policy: HeldoutPolicy = S36_V1): MissingnessResult {
  assertCount('unusableBaseline', input.unusableBaseline);
  assertCount('unusableChosen', input.unusableChosen);
  assertCount('commonEvaluableN', input.commonEvaluableN);
  const t = missingnessThreshold(input.plannedN, policy);
  const reasons: MissingnessReason[] = [];
  const messages: string[] = [];
  const maxU = Math.max(input.unusableBaseline, input.unusableChosen);
  if (maxU > t) {
    reasons.push('unusable_over_threshold');
    messages.push(`unusable verdicts ${maxU} exceed T = ${t} (N = ${input.plannedN})`);
  }
  const gap = Math.abs(input.unusableChosen - input.unusableBaseline);
  if (gap > t) {
    reasons.push('unusable_gap_over_threshold');
    messages.push(`unusable difference between versions ${gap} exceeds T = ${t}`);
  }
  if (input.commonEvaluableN < policy.nFloor) {
    reasons.push('common_n_below_floor');
    messages.push(`common evaluable n = ${input.commonEvaluableN} is below the floor of ${policy.nFloor}`);
  }
  return { ok: reasons.length === 0, threshold: t, nFloor: policy.nFloor, reasons, messages, input: { ...input } };
}
