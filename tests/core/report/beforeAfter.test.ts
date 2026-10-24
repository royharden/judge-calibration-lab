import { describe, expect, it } from 'vitest';
import { canonicalHash } from '../../../src/core/canonical.ts';
import { generateSyntheticSet } from '../../../src/core/fixtures/synthetic.ts';
import { createRubric, createChild } from '../../../src/core/rubric/rubric.ts';
import { syntheticRubricV2Edits } from '../../../src/core/fixtures/synthetic.ts';
import { mockScoreSync } from '../../../src/core/judge/mock.ts';
import { toVerdict } from '../../../src/core/judge/judge.ts';
import { unwrap } from '../../../src/core/result.ts';
import { S36_V1, policyHash } from '../../../src/core/heldoutlock/policyConst.ts';
import type { PreregPins } from '../../../src/core/heldoutlock/policy.ts';
import { computeDevFits } from '../../../src/core/report/fits.ts';
import { assembleBeforeAfter, summarizeCost, type ReportInput } from '../../../src/core/report/beforeAfter.ts';
import { buildJudgeTable, judgeTableCsv } from '../../../src/core/report/judgeTable.ts';

const syn = generateSyntheticSet(36);
const rubric = unwrap(createRubric({ setId: 's', ...syn.rubricV1 }, syn.scale));
const chosenRubric = unwrap(createChild(rubric, syntheticRubricV2Edits(), 'mechanical fixture repair'));
const dev = syn.items.slice(0, 60);
const heldout = syn.items.slice(60);
function score(items: typeof syn.items, r = rubric, runId = 'heldout-baseline') {
  return items.map((i) => toVerdict(runId, i.key, 0, mockScoreSync('merges-3-4', i, r, { runId, replicate: 0, presentation: 'ascending', seed: 36, split: 'heldout', truth: syn.truth })));
}
const fits = unwrap(computeDevFits({ devItems: dev, devKeys: dev.map((i) => i.key), devAnnotations: syn.annotations.filter((a) => dev.some((i) => i.key === a.itemKey)), baselineVerdicts: score(dev, rubric, 'dev'), k: 5 }));
const pins: PreregPins = {
  owner: 'u', setId: 's', contentHash: 'content', annotationHash: 'annotations', splitHash: 'split', scaleHash: canonicalHash(syn.scale), baselineRubricHash: rubric.contentHash, chosenRubricHash: chosenRubric.contentHash,
  judgeConfigHash: 'judge', policyVersion: S36_V1.version, policyHash, algorithmVersions: S36_V1.algorithmVersions, bootstrap: S36_V1.bootstrap, fitHashes: fits.hashes, baselineDevRunId: 'dev',
};
function input(): ReportInput {
  return { confirmed: true, preregId: 'p', pins, current: { contentHash: 'content', annotationHash: 'annotations', splitHash: 'split', judgeConfigHash: 'judge', baselineRubricHash: rubric.contentHash, chosenRubricHash: chosenRubric.contentHash }, judgeName: 'mock',
    scale: syn.scale, items: heldout, annotations: syn.annotations.filter((a) => heldout.some((i) => i.key === a.itemKey)), baselineVerdicts: score(heldout), chosenVerdicts: score(heldout, chosenRubric, 'heldout-chosen'), fits,
    contamination: { contaminated: false, reasons: [] }, lineage: ['original'], baselineCost: { actualUsd: 0, attemptedCalls: 60, attemptedItems: 60 }, chosenCost: { actualUsd: 0, attemptedCalls: 60, attemptedItems: 60 } };
}

describe('complete deterministic report assembly', () => {
  it('carries every report family, paired denominators, policy and exact undefined modal κ', () => {
    const report = assembleBeforeAfter(input());
    expect(report.denominators).toMatchObject({ planned: 60, baselineEvaluable: 60, chosenEvaluable: 60, commonEvaluable: 60 });
    expect(report.delta.draws).toBe(2000);
    expect(report.policyHash).toBe(policyHash);
    expect(report.modal.kappa.point.kind).toBe('undefined');
    expect(report.ceiling.pairs).toHaveLength(10);
    expect(report.halfWidthText).toContain('not a power analysis');
    expect(report.remap.pairedVsChosen.commonItemKeys).toEqual(report.paired.commonItemKeys);
    expect(report.chosen.cost.per100AttemptedUsd).toEqual({ kind: 'value', value: 0 });
    expect(report.lineage).toEqual(['original']);
    expect(assembleBeforeAfter(input())).toEqual(report);
  });
  it('n=12 cannot support, and fit mismatch cannot support', () => {
    const i = input();
    const subset = new Set(heldout.slice(0, 12).map((i) => i.key));
    const small = assembleBeforeAfter({ ...i, items: i.items.filter((it) => subset.has(it.key)), annotations: i.annotations.filter((a) => subset.has(a.itemKey)), baselineVerdicts: i.baselineVerdicts.filter((v) => subset.has(v.itemKey)), chosenVerdicts: i.chosenVerdicts.filter((v) => subset.has(v.itemKey)) });
    expect(small.verdict.outcome).toBe('cannot_support');
    expect(small.missingness.reasons).toContain('common_n_below_floor');
    const mismatch = assembleBeforeAfter({ ...i, pins: { ...pins, fitHashes: { ...pins.fitHashes, pavMap: 'stale' } } });
    expect(mismatch.verdict.outcome).toBe('cannot_support');
    expect(mismatch.fits.mismatchFields).toEqual(['pavMap']);
  });
  it('unusable counts and common exclusions include missing and failed rows', () => {
    const i = input();
    const failed = { ...i.chosenVerdicts[0]!, score: null, unusableReason: 'timeout' as const };
    const out = assembleBeforeAfter({ ...i, chosenVerdicts: [failed, ...i.chosenVerdicts.slice(2)] });
    expect(out.chosen.unusableN).toBe(2);
    expect(out.chosen.unusableReasons).toEqual({ timeout: 1, missing_verdict: 1 });
    expect(out.denominators.commonEvaluable).toBe(58);
    expect(out.excludedItemKeys.common).toHaveLength(2);
    expect(out.chosen.cost.evaluableItems).toBe(58);
  });
  it('refuses unconfirmed reports, pin drift and custom policy', () => {
    expect(() => assembleBeforeAfter({ ...input(), confirmed: false } as unknown as ReportInput)).toThrow('confirmed');
    expect(() => assembleBeforeAfter({ ...input(), current: { ...input().current, splitHash: 'other' } })).toThrow('prereg_mismatch');
    expect(() => assembleBeforeAfter({ ...input(), pins: { ...pins, policyVersion: 'custom' } })).toThrow('only policy');
  });
  it('contamination is preserved and CSV output escapes spreadsheet formulas', () => {
    const report = assembleBeforeAfter({ ...input(), judgeName: '  =EXEC()', contamination: { contaminated: true, reasons: ['burned'] } });
    const table = buildJudgeTable([{ report }]);
    expect(table[0]!.contaminated).toBe(true);
    const csv = judgeTableCsv(table);
    expect(csv).toContain("'  =EXEC()");
    expect(csv).toContain('repeatability (dev)');
    expect(csv).toContain('undefined (probe skipped / insufficient data)');
  });
  it('unmeasured costs and empty denominators stay undefined', () => {
    expect(summarizeCost({ actualUsd: null, attemptedCalls: 1, attemptedItems: 1 }, 1).per100AttemptedUsd.kind).toBe('undefined');
    expect(summarizeCost({ actualUsd: 0, attemptedCalls: 0, attemptedItems: 0 }, 0).per100EvaluableUsd.kind).toBe('undefined');
    expect(summarizeCost({ actualUsd: 0.3, attemptedCalls: 15, attemptedItems: 10 }, 5).per100AttemptedUsd).toEqual({ kind: 'value', value: 3 });
  });
});
