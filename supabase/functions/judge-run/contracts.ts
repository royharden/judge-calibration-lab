import type { Annotation, Item, JudgeConfig, Presentation, Rubric, RunKind, UnusableReason, Verdict } from './_core/core/types.ts';
import type { Preregistration } from './_core/core/heldoutlock/policy.ts';
import type { PriceBookEntry } from './_core/core/plan/costBound.ts';
import type { RunPlan } from './_core/core/plan/runPlan.ts';
import type { ProbeSets } from './_core/core/goldset/probesets.ts';
import type { GoldSet } from './_core/core/types.ts';
import type { MeasuredCost } from './_core/core/report/beforeAfter.ts';

export type LiveJob = { id: string; kind: RunKind; item: Item; replicate: number; ledgerReplicate: number; presentation: Presentation; cacheBypass: boolean; lengthReference?: { kind: 'pair_short' | 'dev_median'; words: number } };
export type JobVerdict = { jobId: string; score: number | null; unusableReason: UnusableReason | null; raw: string };
export type LiveSet = Omit<GoldSet, 'heldoutAnnotations'> & { frozen: boolean; probeSets: ProbeSets; inheritedContamination: boolean };
export type LiveRun = { id: string; setId: string; rubricId: string; rubricHash: string; judgeConfigId: string; judgeConfigHash: string; split: 'dev' | 'heldout'; status: 'pending' | 'running' | 'paused' | 'complete' | 'failed'; includeProbes: boolean; resultHash: string | null; completedAt: string | null; plan: RunPlan };
export type SetBundle = { set: LiveSet; annotations: Annotation[]; stagedAnnotations?: Annotation[]; rubrics: Rubric[]; judgeConfigs: JudgeConfig[]; runs: LiveRun[]; verdicts: Verdict[] };
export type RunBundle = { set: LiveSet; rubric: Rubric; config: JudgeConfig; run: LiveRun; jobs: LiveJob[]; jobVerdicts: JobVerdict[]; prices: PriceBookEntry[]; budget?: { spentUsd: number; reservedUsd: number } };
export type ReportBundle = { prereg: Preregistration; set: LiveSet; annotations: Annotation[]; rubrics: Rubric[]; judgeConfigs: JudgeConfig[]; baseline: { run: LiveRun; verdicts: Verdict[] }; chosen: { run: LiveRun; verdicts: Verdict[] }; baselineDev: { run: LiveRun; verdicts: Verdict[] }; contamination: { contaminated: boolean; reasons: string[] }; lineage: string[]; baselineCost: MeasuredCost; chosenCost: MeasuredCost };
export type RequestReceipt = { state: 'new' | 'busy' | 'complete'; response?: { ok: boolean; data?: unknown; error?: ApiError } };
export type ApiError = { code: string; message: string; retryable: boolean };
