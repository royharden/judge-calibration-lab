// Preregistered verdict (PLAN.md §3.9, [C] §2.5 "where the verdict is computed").
//
//   improved             iff the paired 95% lower bound of Δκ (chosen − baseline) > 0
//   worse                iff the upper bound < 0
//   no detectable change otherwise
//   cannot support       when the missingness guard fails, the paired interval (or its point) is
//                        undefined, a recomputed fit hash differs from its pin (fit mismatch), or
//                        the interval was not computed with the policy's resample count.
//
// Inputs are the paired Interval from judgestats (`pairedJudgeDelta(...).delta`), the missingness
// guard result and the fit-mismatch flag. Deterministic: a stored report recomputes the same verdict.

import type { Interval, Stat } from '../types.ts';
import { formatStat, undef, value } from '../judgestats/undefined.ts';
import type { MissingnessResult } from './missingness.ts';
import type { FitHashes } from './policy.ts';
import type { HeldoutPolicy } from './policyConst.ts';
import { S36_V1 } from './policyConst.ts';

export type VerdictOutcome = 'improved' | 'no_detectable_change' | 'worse' | 'cannot_support';

/** Display labels (the words the report prints). */
export const VERDICT_LABELS: Readonly<Record<VerdictOutcome, string>> = Object.freeze({
  improved: 'improved',
  no_detectable_change: 'no detectable change',
  worse: 'worse',
  cannot_support: 'cannot support',
});

/** Exact half-width wording (PLAN.md §3.9). */
export const HALF_WIDTH_WORDING = 'observed precision: roughly the smallest change this set could resolve — not a power analysis';

export type VerdictReason =
  | 'lower_bound_above_zero'
  | 'upper_bound_below_zero'
  | 'interval_includes_zero'
  | 'missingness_guard'
  | 'interval_undefined'
  | 'fit_mismatch'
  | 'resamples_mismatch';

export type VerdictInput = {
  /** Paired Δκ interval (chosen − baseline). */
  delta: Interval;
  guard: MissingnessResult;
  /** true when any recomputed fit hash differs from the preregistered pin. */
  fitMismatch: boolean;
  /** Optional: names of the mismatching fit fields (for the reason text). */
  fitMismatchFields?: readonly string[];
};

export type VerdictResult = {
  outcome: VerdictOutcome;
  label: string;
  /** Machine reasons; for `cannot_support` every failing condition is listed. */
  reasons: VerdictReason[];
  /** Human-readable reason lines. */
  messages: string[];
  /** (hi − lo) / 2 of the paired interval; undefined when the interval is. */
  halfWidth: Stat;
  /** e.g. "half-width 0.083 — observed precision: … not a power analysis". */
  halfWidthText: string;
  delta: Interval;
  policyVersion: string;
};

/** Half-width of an interval as a Stat. */
export function intervalHalfWidth(i: Interval): Stat {
  if (i.lo.kind === 'undefined') return undef(i.lo.reason);
  if (i.hi.kind === 'undefined') return undef(i.hi.reason);
  return value((i.hi.value - i.lo.value) / 2);
}

export function halfWidthText(halfWidth: Stat, digits = 3): string {
  return `half-width ${formatStat(halfWidth, digits)} — ${HALF_WIDTH_WORDING}`;
}

/** Compare pinned fit hashes with recomputed ones. */
export function compareFitHashes(pinned: FitHashes, recomputed: FitHashes): { mismatch: boolean; fields: string[] } {
  const fields: string[] = [];
  if (pinned.lexicalCutPoints !== recomputed.lexicalCutPoints) fields.push('lexicalCutPoints');
  if (pinned.modalLevel !== recomputed.modalLevel) fields.push('modalLevel');
  if (pinned.pavMap !== recomputed.pavMap) fields.push('pavMap');
  return { mismatch: fields.length > 0, fields };
}

export function computeVerdict(input: VerdictInput, policy: HeldoutPolicy = S36_V1): VerdictResult {
  const { delta, guard } = input;
  const halfWidth = intervalHalfWidth(delta);
  const base = { halfWidth, halfWidthText: halfWidthText(halfWidth), delta, policyVersion: policy.version };

  const reasons: VerdictReason[] = [];
  const messages: string[] = [];
  if (input.fitMismatch) {
    reasons.push('fit_mismatch');
    const f = input.fitMismatchFields && input.fitMismatchFields.length > 0 ? ` (${input.fitMismatchFields.join(', ')})` : '';
    messages.push(`fit mismatch: a recomputed fit differs from its preregistered hash${f}`);
  }
  if (!guard.ok) {
    reasons.push('missingness_guard');
    messages.push(...guard.messages);
  }
  if (delta.point.kind === 'undefined' || delta.lo.kind === 'undefined' || delta.hi.kind === 'undefined') {
    reasons.push('interval_undefined');
    const why =
      delta.point.kind === 'undefined' ? delta.point.reason : delta.lo.kind === 'undefined' ? delta.lo.reason : delta.hi.kind === 'undefined' ? delta.hi.reason : '';
    messages.push(`paired interval undefined (${why}; ${delta.droppedDraws} of ${delta.draws} draws undefined)`);
  }
  if (delta.draws > 0 && delta.draws !== policy.bootstrap.resamples) {
    reasons.push('resamples_mismatch');
    messages.push(`interval used ${delta.draws} resamples; policy ${policy.version} requires ${policy.bootstrap.resamples}`);
  }
  if (reasons.length > 0) return { outcome: 'cannot_support', label: VERDICT_LABELS.cannot_support, reasons, messages, ...base };

  // Here lo, hi and point are defined.
  const lo = (delta.lo as { value: number }).value;
  const hi = (delta.hi as { value: number }).value;
  if (lo > 0) {
    return { outcome: 'improved', label: VERDICT_LABELS.improved, reasons: ['lower_bound_above_zero'], messages: [`95% lower bound ${lo.toFixed(3)} > 0`], ...base };
  }
  if (hi < 0) {
    return { outcome: 'worse', label: VERDICT_LABELS.worse, reasons: ['upper_bound_below_zero'], messages: [`95% upper bound ${hi.toFixed(3)} < 0`], ...base };
  }
  return {
    outcome: 'no_detectable_change',
    label: VERDICT_LABELS.no_detectable_change,
    reasons: ['interval_includes_zero'],
    messages: [`95% interval [${lo.toFixed(3)}, ${hi.toFixed(3)}] includes 0`],
    ...base,
  };
}
