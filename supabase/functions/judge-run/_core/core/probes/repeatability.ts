import type { Interval, Item, Rubric, Stat, Verdict } from '../types.ts';
import type { Judge, JudgeContext, TruthMap } from '../judge/judge.ts';
import { toVerdict } from '../judge/judge.ts';
import { bootstrapInterval, type BootstrapOptions } from '../judgestats/bootstrap.ts';
import { buildGroups, resampleUnitsFromGroups } from '../goldset/split.ts';
import { quadraticWeightedKappa } from '../judgestats/kappa.ts';
import { meanStat, undef } from '../judgestats/undefined.ts';
import { wilsonInterval, type ProportionInterval } from '../judgestats/wilson.ts';

/** Both the split and every row are checked again at runtime. */
export type ExploratoryItem = Item & { split: 'dev' | 'probe' };
export type ProbeOptions = {
  split: 'dev' | 'probe'; runId: string; seed: number; truth?: TruthMap;
  bootstrap?: Omit<BootstrapOptions, 'seed'>;
};
export type ProbeJudgeContext = JudgeContext & { cacheBypass: true };
export function assertExploratory(split: unknown, rows: readonly object[]): void {
  if (split !== 'dev' && split !== 'probe') throw new RangeError('probes accept dev/probe inputs only');
  if (rows.some((r) => 'split' in r && r.split !== undefined && r.split !== 'dev' && r.split !== 'probe')) {
    throw new RangeError('held-out rows cannot enter probes');
  }
}
export function probeContext(options: ProbeOptions, replicate: number, presentation: 'ascending' | 'reversed' = 'ascending'): ProbeJudgeContext {
  return { runId: options.runId, seed: options.seed, split: options.split, truth: options.truth, replicate, presentation, cacheBypass: true };
}
export type RepeatabilityResult = {
  kind: 'repeatability'; split: 'dev' | 'probe'; label: 'repeatability (dev)'; exploratory: true;
  replicateIds: readonly [0, 1, 2]; cacheBypass: true;
  attemptedN: number; completeN: number; excludedItemKeys: string[];
  exactMatch: ProportionInterval; runToRunKappa: Interval; verdicts: Verdict[];
};

/** Three fresh calls per item; incomplete triplets never count as matches. */
export async function runRepeatability(judge: Judge, items: readonly ExploratoryItem[], rubric: Rubric, options: ProbeOptions): Promise<RepeatabilityResult> {
  assertExploratory(options.split, items);
  if (new Set(items.map((i) => i.key)).size !== items.length) throw new RangeError('duplicate probe item key');
  const verdicts: Verdict[] = [];
  const triples = new Map<string, number[]>();
  const excludedItemKeys: string[] = [];
  let matches = 0;
  for (const item of items) {
    const scores: number[] = [];
    for (const replicate of [0, 1, 2] as const) {
      const result = await judge.score(item, rubric, probeContext(options, replicate));
      verdicts.push(toVerdict(options.runId, item.key, replicate, result));
      if (result.kind === 'score') scores.push(result.score);
    }
    if (scores.length !== 3) excludedItemKeys.push(item.key);
    else {
      triples.set(item.key, scores);
      if (scores.every((s) => s === scores[0])) matches++;
    }
  }
  const units = resampleUnitsFromGroups(buildGroups(items), new Set(triples.keys()));
  const statistic = (keys: readonly string[]): Stat => {
    const kappas: number[] = [];
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
      const kappa = quadraticWeightedKappa(keys.map((key) => triples.get(key)![a!]!), keys.map((key) => triples.get(key)![b!]!), rubric.levels.length);
      if (kappa.kind === 'undefined') return undef(`replicate ${a}/${b}: ${kappa.reason}`);
      kappas.push(kappa.value);
    }
    return meanStat(kappas);
  };
  return {
    kind: 'repeatability', split: options.split, label: 'repeatability (dev)', exploratory: true, replicateIds: [0, 1, 2], cacheBypass: true,
    attemptedN: items.length, completeN: triples.size, excludedItemKeys: excludedItemKeys.sort(),
    exactMatch: wilsonInterval(matches, triples.size),
    runToRunKappa: bootstrapInterval(units, statistic, { seed: options.seed, ...options.bootstrap }), verdicts,
  };
}
