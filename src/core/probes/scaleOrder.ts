import type { Interval, Rubric, Verdict } from '../types.ts';
import type { Judge } from '../judge/judge.ts';
import { toVerdict } from '../judge/judge.ts';
import { buildGroups } from '../goldset/split.ts';
import { bootstrapInterval, unitsFromItems } from '../judgestats/bootstrap.ts';
import { bandFlag, type BandFlag } from '../judgestats/bands.ts';
import { meanStat } from '../judgestats/undefined.ts';
import { assertExploratory, probeContext, type ExploratoryItem, type ProbeOptions } from './repeatability.ts';

export type ShiftPair = { itemKey: string; groupId?: string; baseline: number | null; changed: number | null };
export type ShiftProbeResult = {
  kind: 'scale_order' | 'verbosity' | 'injection'; split: 'dev' | 'probe'; label: string; exploratory: true;
  shift: Interval; band: BandFlag; attemptedN: number; evaluableN: number;
  excludedItemKeys: string[]; pairs: ShiftPair[]; verdicts: Verdict[];
};
/** Shared paired shift estimator: only complete pairs, resampled together by group. */
export function summarizeShift(kind: ShiftProbeResult['kind'], pairs: readonly ShiftPair[], verdicts: Verdict[], k: number, options: ProbeOptions): ShiftProbeResult {
  assertExploratory(options.split, pairs);
  if (new Set(pairs.map((p) => p.itemKey)).size !== pairs.length) throw new RangeError('duplicate shift pair');
  const usable = pairs.filter((p) => p.baseline !== null && p.changed !== null);
  const byKey = new Map(usable.map((p) => [p.itemKey, p.changed! - p.baseline!]));
  const shift = bootstrapInterval(unitsFromItems(usable.map((p) => ({ key: p.itemKey, groupId: p.groupId }))),
    (keys) => meanStat(keys.map((key) => byKey.get(key)!), 'no complete probe pairs'), { seed: options.seed, ...options.bootstrap });
  return { kind, split: options.split, label: `${kind.replace('_', '-')} shift (dev)`, exploratory: true, shift, band: bandFlag(shift, { k }),
    attemptedN: pairs.length, evaluableN: usable.length, excludedItemKeys: pairs.filter((p) => p.baseline === null || p.changed === null).map((p) => p.itemKey).sort(),
    pairs: [...pairs], verdicts };
}
export async function runScaleOrder(judge: Judge, items: readonly ExploratoryItem[], rubric: Rubric, options: ProbeOptions): Promise<ShiftProbeResult> {
  assertExploratory(options.split, items);
  const pairs: ShiftPair[] = [];
  const verdicts: Verdict[] = [];
  const groups = new Map(buildGroups(items).flatMap((g) => g.itemKeys.map((key) => [key, g.groupKey] as const)));
  for (const item of items) {
    const baseline = await judge.score(item, rubric, probeContext(options, 0));
    const changed = await judge.score(item, rubric, probeContext(options, 1, 'reversed'));
    verdicts.push(toVerdict(options.runId, item.key, 0, baseline), toVerdict(options.runId, item.key, 1, changed));
    pairs.push({ itemKey: item.key, groupId: groups.get(item.key), baseline: baseline.kind === 'score' ? baseline.score : null, changed: changed.kind === 'score' ? changed.score : null });
  }
  return summarizeShift('scale_order', pairs, verdicts, rubric.levels.length, options);
}
