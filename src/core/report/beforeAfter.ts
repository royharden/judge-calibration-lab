import type { Annotation, Interval, Item, JudgeScore, Scale, Stat, Verdict } from '../types.ts';
import { canonicalHash } from '../canonical.ts';
import { buildGroups, resampleUnitsFromGroups } from '../goldset/split.ts';
import { applyLexical } from '../judge/lexical.ts';
import { applyPav } from '../judgestats/pav.ts';
import { consensusByItem, meanHumanByItem } from '../judgestats/consensus.ts';
import { exactAgreement, withinOneAgreement, judgeAgreementWithInterval, referenceCeilingWithInterval, type MeanAgreementWithInterval } from '../judgestats/agreement.ts';
import { bootstrapInterval, type ResampleUnit } from '../judgestats/bootstrap.ts';
import { pairedJudgeDelta, type PairedJudgeResult } from '../judgestats/paired.ts';
import { wilsonInterval, type ProportionInterval } from '../judgestats/wilson.ts';
import { meanStat, undef, value } from '../judgestats/undefined.ts';
import { missingnessGuard, type MissingnessResult } from '../heldoutlock/missingness.ts';
import { computeVerdict, compareFitHashes, type VerdictResult } from '../heldoutlock/verdict.ts';
import { assertStandardPolicyRef, policyBootstrapOptions, policyHash, POLICY_VERSION } from '../heldoutlock/policyConst.ts';
import type { PreregPins } from '../heldoutlock/policy.ts';
import { fitHashes, type DevFits } from './fits.ts';

export type MeasuredCost = { actualUsd: number | null; attemptedCalls: number; attemptedItems: number };
export type ReportCost = MeasuredCost & { evaluableItems: number; per100AttemptedUsd: Stat; per100EvaluableUsd: Stat };
export type VersionReport = {
  kappa: Interval; agreement: MeanAgreementWithInterval; exact: Stat; exactInterval: ProportionInterval; withinOne: Stat; offset: Interval;
  plannedN: number; attemptedN: number; evaluableN: number; consensusN: number;
  unusableN: number; unusableRate: ProportionInterval; excludedItemKeys: string[]; unusableReasons: Record<string, number>;
  consensusTieKeys: string[]; missingHumanKeys: string[]; cost: ReportCost;
};
export type ReportInput = {
  confirmed: true; preregId: string; pins: PreregPins;
  current: { contentHash: string; annotationHash: string; splitHash: string; judgeConfigHash: string; baselineRubricHash: string; chosenRubricHash: string };
  judgeName: string; scale: Scale; items: readonly Item[]; annotations: readonly Annotation[];
  baselineVerdicts: readonly Verdict[]; chosenVerdicts: readonly Verdict[]; fits: DevFits;
  contamination: { contaminated: boolean; reasons: readonly string[] }; lineage?: readonly string[];
  baselineCost: MeasuredCost; chosenCost: MeasuredCost;
};
export type BeforeAfterReport = {
  confirmed: true; preregId: string; judge: string; inputHash: string; pins: PreregPins;
  baseline: VersionReport; chosen: VersionReport; paired: PairedJudgeResult; delta: Interval;
  verdict: VerdictResult; missingness: MissingnessResult; halfWidthText: string;
  ceiling: MeanAgreementWithInterval; lexical: VersionReport; modal: VersionReport;
  remap: { baseline: VersionReport; pairedVsChosen: PairedJudgeResult };
  denominators: { planned: number; baselineEvaluable: number; chosenEvaluable: number; commonEvaluable: number; commonItemKeys: string[] };
  excludedItemKeys: { baseline: string[]; chosen: string[]; common: string[] };
  contamination: ReportInput['contamination']; lineage: readonly string[]; policyVersion: string; policyHash: string;
  fits: { pinned: PreregPins['fitHashes']; recomputed: PreregPins['fitHashes']; mismatchFields: string[] };
  units: ResampleUnit[];
};
export function summarizeCost(cost: MeasuredCost, evaluableItems: number): ReportCost {
  if (cost.actualUsd !== null && (!Number.isFinite(cost.actualUsd) || cost.actualUsd < 0)) throw new RangeError('invalid measured cost');
  for (const n of [cost.attemptedCalls, cost.attemptedItems, evaluableItems]) if (!Number.isInteger(n) || n < 0) throw new RangeError('invalid cost denominator');
  return { ...cost, evaluableItems,
    per100AttemptedUsd: cost.actualUsd === null ? undef('cost not measured') : cost.attemptedItems === 0 ? undef('no attempted items') : value(100 * cost.actualUsd / cost.attemptedItems),
    per100EvaluableUsd: cost.actualUsd === null ? undef('cost not measured') : evaluableItems === 0 ? undef('no evaluable items') : value(100 * cost.actualUsd / evaluableItems) };
}

/** Descriptive per-version metrics use all usable rows; the paired delta uses common rows. */
function versionReport(rows: readonly JudgeScore[], annotations: readonly Annotation[], k: number, units: readonly ResampleUnit[], cost: MeasuredCost, rawVerdicts?: readonly Verdict[]): VersionReport {
  const universe = units.flatMap((u) => [...u.itemKeys]);
  const keys = new Set(universe);
  const scores = new Map(rows.filter((r) => keys.has(r.itemKey)).map((r) => [r.itemKey, r.score]));
  const consensus = consensusByItem(annotations);
  const usable = universe.filter((key) => scores.get(key) !== null && scores.has(key));
  const excludedItemKeys = universe.filter((key) => !usable.includes(key)).sort();
  const complete = consensus.items.filter((c) => c.consensus !== null && scores.get(c.itemKey) !== null && scores.has(c.itemKey));
  const judge = complete.map((c) => scores.get(c.itemKey)!);
  const human = complete.map((c) => c.consensus!);
  const means = meanHumanByItem(annotations);
  const offset = bootstrapInterval(units, (occ) => meanStat(occ.filter((key) => scores.get(key) !== null && scores.has(key) && means.has(key)).map((key) => scores.get(key)! - means.get(key)!), 'no judge-human pairs'), policyBootstrapOptions());
  const agreement = judgeAgreementWithInterval(rows, annotations, k, units, policyBootstrapOptions());
  const unusableReasons: Record<string, number> = {};
  for (const key of excludedItemKeys) { const reason = rawVerdicts?.find((v) => v.itemKey === key)?.unusableReason ?? 'missing_verdict'; unusableReasons[reason] = (unusableReasons[reason] ?? 0) + 1; }
  const exact = exactAgreement(judge, human);
  return { kappa: agreement.interval, agreement, exact, exactInterval: wilsonInterval(judge.filter((s, i) => s === human[i]).length, complete.length), withinOne: withinOneAgreement(judge, human), offset,
    plannedN: universe.length, attemptedN: rows.length, evaluableN: usable.length, consensusN: complete.length, unusableN: excludedItemKeys.length,
    unusableRate: wilsonInterval(excludedItemKeys.length, universe.length), excludedItemKeys, unusableReasons, consensusTieKeys: consensus.ties,
    missingHumanKeys: universe.filter((key) => !means.has(key)).sort(), cost: summarizeCost(cost, usable.length) };
}

/** Store/edge calls this only after both authorized held-out runs complete. */
export function assembleBeforeAfter(input: ReportInput): BeforeAfterReport {
  if (input.confirmed !== true) throw new RangeError('held-out report requires confirmed complete runs');
  const policy = assertStandardPolicyRef(input.pins.policyVersion, input.pins.policyHash);
  if (!policy.ok) throw new RangeError(policy.error.message);
  for (const field of ['contentHash', 'annotationHash', 'splitHash', 'judgeConfigHash', 'baselineRubricHash', 'chosenRubricHash'] as const) {
    if (input.current[field] !== input.pins[field]) throw new RangeError(`prereg_mismatch: ${field}`);
  }
  if (canonicalHash(input.scale) !== input.pins.scaleHash) throw new RangeError('prereg_mismatch: scaleHash');
  const k = input.fits.lexical.k;
  if (input.scale.levels.length !== k || input.fits.modal.k !== k || input.fits.pav.k !== k || input.fits.fittedOn !== 'dev') throw new RangeError('invalid dev fits');
  const keys = new Set(input.items.map((i) => i.key));
  if (keys.size !== input.items.length) throw new RangeError('duplicate held-out item');
  for (const rows of [input.baselineVerdicts, input.chosenVerdicts]) {
    if (new Set(rows.map((v) => v.itemKey)).size !== rows.length || rows.some((v) => !keys.has(v.itemKey))) throw new RangeError('held-out verdict universe mismatch');
    for (const row of rows) if (row.score !== null && (!Number.isInteger(row.score) || row.score < 0 || row.score >= k)) throw new RangeError('invalid held-out score');
  }
  if (input.annotations.some((a) => !keys.has(a.itemKey))) throw new RangeError('annotation outside held-out split');
  const units = resampleUnitsFromGroups(buildGroups(input.items));
  const baseline = versionReport(input.baselineVerdicts, input.annotations, k, units, input.baselineCost, input.baselineVerdicts);
  const chosen = versionReport(input.chosenVerdicts, input.annotations, k, units, input.chosenCost, input.chosenVerdicts);
  const paired = pairedJudgeDelta(input.baselineVerdicts, input.chosenVerdicts, input.annotations, k, units, policyBootstrapOptions());
  const missingness = missingnessGuard({ plannedN: keys.size, unusableBaseline: baseline.unusableN, unusableChosen: chosen.unusableN, commonEvaluableN: paired.commonItemKeys.length });
  const recomputed = fitHashes(input.fits);
  const mismatch = compareFitHashes(input.pins.fitHashes, recomputed);
  const verdict = computeVerdict({ delta: paired.delta, guard: missingness, fitMismatch: mismatch.mismatch, fitMismatchFields: mismatch.fields });
  const noCost: MeasuredCost = { actualUsd: 0, attemptedCalls: 0, attemptedItems: keys.size };
  const lexicalRows = input.items.map((i) => ({ itemKey: i.key, score: applyLexical(input.fits.lexical, i) }));
  const modalRows = input.items.map((i) => ({ itemKey: i.key, score: input.fits.modal.level }));
  const remapped = input.baselineVerdicts.map((v) => ({ itemKey: v.itemKey, score: v.score === null ? null : applyPav(input.fits.pav, v.score) }));
  const remap = { baseline: versionReport(remapped, input.annotations, k, units, input.baselineCost), pairedVsChosen: pairedJudgeDelta(remapped, input.chosenVerdicts, input.annotations, k, units, policyBootstrapOptions()) };
  const common = new Set(paired.commonItemKeys);
  return { confirmed: true, preregId: input.preregId, judge: input.judgeName, inputHash: canonicalHash(input), pins: input.pins,
    baseline, chosen, paired, delta: paired.delta, verdict, missingness, halfWidthText: verdict.halfWidthText,
    ceiling: referenceCeilingWithInterval(input.annotations, k, units, policyBootstrapOptions()), lexical: versionReport(lexicalRows, input.annotations, k, units, noCost), modal: versionReport(modalRows, input.annotations, k, units, noCost), remap,
    denominators: { planned: keys.size, baselineEvaluable: baseline.evaluableN, chosenEvaluable: chosen.evaluableN, commonEvaluable: common.size, commonItemKeys: [...common].sort() },
    excludedItemKeys: { baseline: baseline.excludedItemKeys, chosen: chosen.excludedItemKeys, common: [...keys].filter((key) => !common.has(key)).sort() },
    contamination: structuredClone(input.contamination), lineage: [...(input.lineage ?? [])], policyVersion: POLICY_VERSION, policyHash,
    fits: { pinned: input.pins.fitHashes, recomputed, mismatchFields: mismatch.fields }, units };
}
