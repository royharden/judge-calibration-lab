import type { Interval, Stat } from '../types.ts';
import { formatInterval, formatStat, undef } from '../judgestats/undefined.ts';
import { toCsv } from '../goldset/csv.ts';
import type { RepeatabilityResult } from '../probes/repeatability.ts';
import type { ShiftProbeResult } from '../probes/scaleOrder.ts';
import type { BeforeAfterReport } from './beforeAfter.ts';

export type JudgeTableInput = { report: BeforeAfterReport; probes?: { repeatability?: RepeatabilityResult; verbosity?: ShiftProbeResult; scaleOrder?: ShiftProbeResult; injection?: ShiftProbeResult } };
export type JudgeTableRow = {
  judge: string; heldoutKappa: Interval; exact: Stat; withinOne: Stat; offset: Interval;
  repeatabilityDev: Interval | null; verbosityDev: Interval | null; scaleOrderDev: Interval | null; injectionDev: Interval | null;
  unusable: number; attempted: number; evaluable: number; costPer100: Stat;
  verdict: string; contaminated: boolean; policyVersion: string; policyHash: string;
};
export const JUDGE_TABLE_COLUMNS = ['judge', 'held-out κ [95% CI]', 'exact', 'within-one', 'offset [95% CI]', 'repeatability (dev)', 'verbosity shift (dev)', 'scale-order shift (dev)', 'injection shift (dev)', 'unusable', 'attempted', 'evaluable', 'cost/100 attempted (USD)', 'verdict', 'contaminated', 'policy version', 'policy hash'] as const;
export function buildJudgeTable(inputs: readonly JudgeTableInput[]): JudgeTableRow[] {
  return inputs.map(({ report: r, probes: p }) => ({ judge: r.judge, heldoutKappa: r.chosen.kappa, exact: r.chosen.exact, withinOne: r.chosen.withinOne, offset: r.chosen.offset,
    repeatabilityDev: p?.repeatability?.runToRunKappa ?? null, verbosityDev: p?.verbosity?.shift ?? null, scaleOrderDev: p?.scaleOrder?.shift ?? null, injectionDev: p?.injection?.shift ?? null,
    unusable: r.chosen.unusableN, attempted: r.chosen.cost.attemptedItems, evaluable: r.chosen.evaluableN, costPer100: r.chosen.cost.per100AttemptedUsd,
    verdict: r.verdict.label, contaminated: r.contamination.contaminated, policyVersion: r.policyVersion, policyHash: r.policyHash }));
}
export function judgeTableCsv(rows: readonly JudgeTableRow[]): string {
  const interval = (i: Interval | null): string => i === null ? formatStat(undef('probe skipped / insufficient data')) : formatInterval(i);
  return toCsv([ [...JUDGE_TABLE_COLUMNS], ...rows.map((r) => [r.judge, formatInterval(r.heldoutKappa), formatStat(r.exact), formatStat(r.withinOne), formatInterval(r.offset), interval(r.repeatabilityDev), interval(r.verbosityDev), interval(r.scaleOrderDev), interval(r.injectionDev), String(r.unusable), String(r.attempted), String(r.evaluable), formatStat(r.costPer100), r.verdict, String(r.contaminated), r.policyVersion, r.policyHash]) ]);
}
