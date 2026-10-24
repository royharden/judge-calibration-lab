import type { Rubric, Verdict } from '../types.ts';
import type { Judge } from '../judge/judge.ts';
import { toVerdict } from '../judge/judge.ts';
import { injectionToItems, type InjectionItem } from '../goldset/probesets.ts';
import { assertExploratory, probeContext, type ProbeOptions } from './repeatability.ts';
import { summarizeShift, type ShiftPair, type ShiftProbeResult } from './scaleOrder.ts';

export type ExploratoryInjection = InjectionItem & { split: 'dev' | 'probe' };
export async function runInjection(judge: Judge, inputs: readonly ExploratoryInjection[], rubric: Rubric, options: ProbeOptions): Promise<ShiftProbeResult> {
  assertExploratory(options.split, inputs);
  const pairs: ShiftPair[] = [];
  const verdicts: Verdict[] = [];
  for (const input of inputs) {
    const items = injectionToItems(input);
    const baseline = await judge.score(items.base, rubric, probeContext(options, 0));
    const changed = await judge.score(items.injected, rubric, probeContext(options, 0));
    verdicts.push(toVerdict(options.runId, items.base.key, 0, baseline), toVerdict(options.runId, items.injected.key, 0, changed));
    pairs.push({ itemKey: input.id, groupId: input.baseItemId, baseline: baseline.kind === 'score' ? baseline.score : null, changed: changed.kind === 'score' ? changed.score : null });
  }
  return summarizeShift('injection', pairs, verdicts, rubric.levels.length, options);
}
