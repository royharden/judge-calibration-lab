// Paired bootstrap (PLAN.md §3.6, K8).
//
// Delta = stat(chosen) - stat(baseline), with BOTH statistics evaluated inside the same
// statistic call on the same draw, so the draws are identical by construction (not merely
// by sharing a seed). The draws themselves depend only on (seed, streamLabel, unit count,
// resamples), so a later comparison over the same units (the PAV remap comparator, the Jev
// gate's cross-judge pairing) reuses exactly the same draws.
//
// Judge kappa delta (pairedJudgeDelta):
//  - items = those usable under BOTH versions (common usable originals) within the units;
//  - annotator basis frozen once from those originals: annotators whose overlap with the
//    common items meets the floor in both versions (the common item set is shared, so the
//    two overlaps are equal; both are checked explicitly);
//  - per draw: kappa_v = equal-weight mean over the basis of QWK(judge_v, annotator); if ANY
//    basis member is undefined in EITHER version, the whole draw is undefined (dropped and
//    counted by the bootstrap). The same rule applies to the point estimate.

import type { Annotation, Interval, JudgeScore, Stat } from '../types.ts';
import { bootstrapInterval, allItemKeys, restrictUnits, type BootstrapOptions, type ResampleUnit, type Statistic } from './bootstrap.ts';
import { DEFAULT_OVERLAP_FLOOR, meanKappaOverBasis, raterFromJudge, ratersFromAnnotations, type Rater } from './agreement.ts';
import { undef, value } from './undefined.ts';

export type PairedDelta = {
  /** Interval of chosen - baseline. */
  delta: Interval;
  /** Point statistics over all units. */
  baseline: Stat;
  chosen: Stat;
};

/** Generic paired bootstrap of statChosen - statBaseline on identical draws. */
export function pairedBootstrapInterval(
  units: readonly ResampleUnit[],
  statBaseline: Statistic,
  statChosen: Statistic,
  opts: BootstrapOptions,
): PairedDelta {
  const diff: Statistic = (occ) => {
    const b = statBaseline(occ);
    if (b.kind === 'undefined') return undef(`baseline: ${b.reason}`);
    const c = statChosen(occ);
    if (c.kind === 'undefined') return undef(`chosen: ${c.reason}`);
    return value(c.value - b.value);
  };
  const all = allItemKeys(units);
  return {
    delta: bootstrapInterval(units, diff, opts),
    baseline: statBaseline(all),
    chosen: statChosen(all),
  };
}

export type BasisMember = { annotatorId: string; nBaseline: number; nChosen: number };

export type PairedJudgeResult = {
  delta: Interval;
  /** Point kappa over the frozen basis (undefined if any member is undefined). */
  baselineKappa: Stat;
  chosenKappa: Stat;
  /** Items usable under both versions (sorted). */
  commonItemKeys: string[];
  /** Frozen annotator basis. */
  basis: BasisMember[];
  /** Annotators below the overlap floor in either version. */
  excludedAnnotators: BasisMember[];
  /** Units remaining after restricting to common items (the resampling units actually used). */
  unitsUsed: number;
  overlapFloor: number;
};

export type PairedJudgeOptions = BootstrapOptions & { overlapFloor?: number };

/**
 * Paired kappa delta between two judge versions (or a judge and its PAV-remapped baseline,
 * or two judges sharing a rubric hash) on the same items and annotators.
 */
export function pairedJudgeDelta(
  baseline: readonly JudgeScore[],
  chosen: readonly JudgeScore[],
  annotations: readonly Annotation[],
  k: number,
  units: readonly ResampleUnit[],
  opts: PairedJudgeOptions,
): PairedJudgeResult {
  const floor = opts.overlapFloor ?? DEFAULT_OVERLAP_FLOOR;
  if (!Number.isInteger(floor) || floor < 0) throw new RangeError('overlapFloor must be a non-negative integer');

  const rb = raterFromJudge(baseline);
  const rc = raterFromJudge(chosen);

  // Common usable originals within the units.
  const common = new Set<string>();
  for (const key of allItemKeys(units)) if (rb.has(key) && rc.has(key)) common.add(key);
  const usedUnits = restrictUnits(units, common);
  const commonItemKeys = [...common].sort();

  // Freeze the annotator basis from the originals.
  const raters = ratersFromAnnotations(annotations);
  const basis: BasisMember[] = [];
  const excludedAnnotators: BasisMember[] = [];
  const basisRaters: { id: string; rater: Rater }[] = [];
  for (const id of [...raters.keys()].sort()) {
    const r = raters.get(id)!;
    let nBaseline = 0;
    let nChosen = 0;
    for (const key of commonItemKeys) {
      if (!r.has(key)) continue;
      if (rb.has(key)) nBaseline += 1;
      if (rc.has(key)) nChosen += 1;
    }
    const member: BasisMember = { annotatorId: id, nBaseline, nChosen };
    if (nBaseline >= floor && nChosen >= floor) {
      basis.push(member);
      basisRaters.push({ id, rater: r });
    } else {
      excludedAnnotators.push(member);
    }
  }

  const statFor =
    (judge: Rater): Statistic =>
    (occ) =>
      basisRaters.length === 0
        ? undef('no annotator meets the overlap floor on common items')
        : meanKappaOverBasis(
            basisRaters.map((b) => ({ id: `judge~${b.id}`, a: judge, b: b.rater })),
            occ,
            k,
          );

  const paired = pairedBootstrapInterval(usedUnits, statFor(rb), statFor(rc), opts);
  return {
    delta: paired.delta,
    baselineKappa: paired.baseline,
    chosenKappa: paired.chosen,
    commonItemKeys,
    basis,
    excludedAnnotators,
    unitsUsed: usedUnits.length,
    overlapFloor: floor,
  };
}
