import type { Rubric, Verdict } from '../types.ts';
import type { Judge } from '../judge/judge.ts';
import { toVerdict } from '../judge/judge.ts';
import { pairToItems, type ProbePair } from '../goldset/probesets.ts';
import { pairCheck, type PairCheckResult } from './pairCheck.ts';
import { assertExploratory, probeContext, type ProbeOptions } from './repeatability.ts';
import { summarizeShift, type ShiftPair, type ShiftProbeResult } from './scaleOrder.ts';

export type ExploratoryPair = ProbePair & { split: 'dev' | 'probe' };
export type VerbosityResult = ShiftProbeResult & { rejectedPairs: { id: string; check: PairCheckResult }[] };
export async function runVerbosity(judge: Judge, inputs: readonly ExploratoryPair[], rubric: Rubric, options: ProbeOptions): Promise<VerbosityResult> {
  assertExploratory(options.split, inputs);
  const rejectedPairs: VerbosityResult['rejectedPairs'] = [];
  const pairs: ShiftPair[] = [];
  const verdicts: Verdict[] = [];
  for (const pair of inputs) {
    // Never trust the stored importer check: recheck the actual texts about to be scored.
    const check = pairCheck({ short: pair.shortText, long: pair.longText, facts: pair.facts });
    if (!check.pass) { rejectedPairs.push({ id: pair.id, check }); continue; }
    const items = pairToItems(pair);
    const ctx = { ...probeContext(options, 0), lengthReference: { kind: 'pair_short' as const, words: check.shortWords } };
    const baseline = await judge.score(items.short, rubric, ctx);
    const changed = await judge.score(items.long, rubric, ctx);
    verdicts.push(toVerdict(options.runId, items.short.key, 0, baseline), toVerdict(options.runId, items.long.key, 0, changed));
    pairs.push({ itemKey: pair.id, groupId: pair.baseItemId, baseline: baseline.kind === 'score' ? baseline.score : null, changed: changed.kind === 'score' ? changed.score : null });
  }
  return { ...summarizeShift('verbosity', pairs, verdicts, rubric.levels.length, options), rejectedPairs };
}
