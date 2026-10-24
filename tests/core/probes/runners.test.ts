import { describe, expect, it } from 'vitest';
import { generateSyntheticSet } from '../../../src/core/fixtures/synthetic.ts';
import { importProbeSets, pairToItems } from '../../../src/core/goldset/probesets.ts';
import { createRubric } from '../../../src/core/rubric/rubric.ts';
import { createMockJudge, createReplayJudge } from '../../../src/core/judge/mock.ts';
import type { Judge } from '../../../src/core/judge/judge.ts';
import { unwrap } from '../../../src/core/result.ts';
import { runRepeatability, type ProbeOptions, type ProbeJudgeContext } from '../../../src/core/probes/repeatability.ts';
import { runVerbosity } from '../../../src/core/probes/verbosity.ts';
import { runScaleOrder, summarizeShift } from '../../../src/core/probes/scaleOrder.ts';
import { runInjection } from '../../../src/core/probes/injection.ts';

const syn = generateSyntheticSet(36);
const rubric = unwrap(createRubric({ setId: 's', ...syn.rubricV1 }, syn.scale));
const items = syn.items.map((i) => ({ ...i, split: 'dev' as const }));
const probes = unwrap(importProbeSets(syn.probeFiles));
const options: ProbeOptions = { split: 'dev', runId: 'repeat', seed: 36, truth: syn.truth, bootstrap: { resamples: 99 } };

describe('exploratory probe runners', () => {
  it('uses three distinct replicate ids and bypasses cache on each call', async () => {
    const seen: ProbeJudgeContext[] = [];
    const clean = createMockJudge('clean');
    const recording: Judge = { id: 'recording', score: (item, r, ctx) => { seen.push(ctx as ProbeJudgeContext); return clean.score(item, r, ctx); } };
    const out = await runRepeatability(recording, items, rubric, options);
    expect(seen).toHaveLength(items.length * 3);
    for (let i = 0; i < seen.length; i += 3) expect(seen.slice(i, i + 3).map((c) => c.replicate)).toEqual([0, 1, 2]);
    expect(seen.every((c) => c.cacheBypass)).toBe(true);
    expect(out.exactMatch.point).toEqual({ kind: 'value', value: 1 });
    expect(out.runToRunKappa.point).toEqual({ kind: 'value', value: 1 });
    expect(out.label).toContain('(dev)');
  });
  it('excludes incomplete triplets and incomplete shift pairs', async () => {
    const bad = createReplayJudge({});
    const out = await runRepeatability(bad, items.slice(0, 2), rubric, options);
    expect(out.completeN).toBe(0);
    expect(out.exactMatch.point.kind).toBe('undefined');
    expect(out.excludedItemKeys).toHaveLength(2);
    const shift = summarizeShift('injection', [{ itemKey: 'x', baseline: 0, changed: null }], [], 5, options);
    expect(shift.evaluableN).toBe(0);
    expect(shift.band.flagged).toBe(false);
    expect(shift.shift.point.kind).toBe('undefined');
  });
  it('rechecks pairCheck and never sends the padded-filler trap to the judge', async () => {
    const pairInputs = [...probes.pairs, ...probes.rejectedPairs].map((p) => ({ ...p, split: 'probe' as const, check: { ...p.check, pass: true } }));
    const out = await runVerbosity(createMockJudge('verbosity'), pairInputs, rubric, options);
    expect(out.rejectedPairs).toHaveLength(1);
    expect(out.rejectedPairs[0]!.check.reasons).toContain('short_in_long');
    expect(out.attemptedN).toBe(24);
    expect(out.verdicts).toHaveLength(48);
    expect(out.band.flagged).toBe(true);
  });
  it('rejects the punctuation ratio trap and forwards whitespace counts to the verbosity mock', async () => {
    const common = { ...probes.pairs[0]!, shortText: 'alpha beta -- --', facts: [], split: 'probe' as const };
    const rejected = { ...common, id: 'punctuation-ratio-trap', longText: 'gamma delta epsilon' };
    const accepted = { ...common, id: 'punctuation-threshold', longText: 'gamma delta epsilon -- -- --' };
    const acceptedItems = pairToItems(accepted);
    const truth = { [acceptedItems.short.key]: 1, [acceptedItems.long.key]: 1 };
    const seen: ProbeJudgeContext[] = [];
    const verbosity = createMockJudge('verbosity');
    const recording: Judge = { id: 'recording', score: (item, r, ctx) => { seen.push(ctx as ProbeJudgeContext); return verbosity.score(item, r, ctx); } };
    const out = await runVerbosity(recording, [rejected, accepted], rubric, { ...options, truth });
    expect(out.rejectedPairs).toHaveLength(1);
    expect(out.rejectedPairs[0]).toMatchObject({ id: rejected.id, check: { reasons: ['length_ratio'], shortWords: 4, longWords: 3, ratio: 0.75 } });
    expect(seen.map((c) => c.lengthReference)).toEqual([{ kind: 'pair_short', words: 4 }, { kind: 'pair_short', words: 4 }]);
    expect(out.attemptedN).toBe(1);
    expect(out.verdicts.map((v) => v.score)).toEqual([1, 2]);
  });
  it('rejects held-out input at every public runner', async () => {
    const judge = createMockJudge('clean');
    const heldout = { ...options, split: 'heldout' } as unknown as ProbeOptions;
    await expect(runRepeatability(judge, [], rubric, heldout)).rejects.toThrow('dev/probe');
    await expect(runScaleOrder(judge, [], rubric, heldout)).rejects.toThrow('dev/probe');
    await expect(runVerbosity(judge, [], rubric, heldout)).rejects.toThrow('dev/probe');
    await expect(runInjection(judge, [], rubric, heldout)).rejects.toThrow('dev/probe');
  });
  it('constant repeats preserve undefined κ rather than inventing perfection', async () => {
    const out = await runRepeatability(createMockJudge('constant'), items, rubric, options);
    expect(out.exactMatch.point).toEqual({ kind: 'value', value: 1 });
    expect(out.runToRunKappa.point.kind).toBe('undefined');
  });
});
