import type { Annotation, GoldSet, Interval, JudgeConfig, Rubric, RunKind, Verdict } from '../core/types.ts';
import type { ImportFiles, ImportReport } from '../core/goldset/types.ts';
import type { ProbeImportFiles, ProbeImportReport, ProbeSets } from '../core/goldset/probesets.ts';
import type { RubricContent, RubricEdits } from '../core/rubric/rubric.ts';
import type { RunPlan } from '../core/plan/runPlan.ts';
import type { DevInput, DiagnosticFindings } from '../core/diagnostics/findings.ts';
import type { Suggestion } from '../core/diagnostics/suggestions.ts';
import type { MeanAgreementWithInterval } from '../core/judgestats/agreement.ts';
import type { ContaminationStatus, LookGrant, Preregistration, RunStatus } from '../core/heldoutlock/policy.ts';
import type { BeforeAfterReport } from '../core/report/beforeAfter.ts';
import type { Ruling, RulingDecision, SuggestionRef } from '../shared/rulings.ts';
import type { Budget, ReconcileReport } from '../shared/callledger.ts';
import type { Reason, Result } from '../core/result.ts';

export type StoreError = Reason<string, unknown>;
export type StoreResult<T> = Result<T, StoreError>;
/** No staged or held-out annotation property exists in the public set contract. */
export type PublicGoldSet = Omit<GoldSet, 'heldoutAnnotations'> & {
  frozen: boolean; importReport: ImportReport; probeSets: ProbeSets;
  inheritedContamination: boolean;
};
export type PublicRun = {
  id: string; setId: string; rubricId: string; rubricHash: string; judgeConfigId: string;
  judgeConfigHash: string; split: 'dev' | 'heldout'; kind: RunKind;
  status: RunStatus; plan: RunPlan; plannedCalls: number; completedCalls: number;
  scoreItems: number; completedScoreItems: number; resultHash: string | null;
  includeProbes: boolean; createdAt: string; completedAt: string | null;
  preregId: string | null; lookSeq: number | null; error: StoreError | null;
};
export type StoredSuggestion = Suggestion & SuggestionRef;
export type StoreSnapshot = {
  mode: 'memory' | 'live'; banner: string; owner: string;
  sets: PublicGoldSet[]; rubrics: Rubric[]; judgeConfigs: JudgeConfig[];
  runs: PublicRun[]; suggestions: StoredSuggestion[]; rulings: Ruling[];
  preregistrations: Preregistration[]; reports: BeforeAfterReport[];
  contamination: ContaminationStatus[]; budgets: Budget[];
};
export type DevRunArgs = { setId: string; rubricId: string; judgeConfigId: string; includeProbes?: boolean };
export type ChunkProgress = {
  runId: string; status: RunStatus; processed: number; remaining: number;
  unusableCount: number; spentUsd: number; reservedUsd: number;
};
export type DevDisplay = { diagnostics: DiagnosticFindings; suggestions: StoredSuggestion[]; verdicts: Verdict[]; probes: DevInput['probes']; baselines: { lexical: Interval; modal: Interval } };
export type JudgeConfigDraft = Omit<JudgeConfig, 'id' | 'configHash'>;

/** All methods are asynchronous Results so live RPC storage can implement the same contract. */
export interface Store {
  getSnapshot(): Promise<StoreResult<StoreSnapshot>>;
  loadDemo(args?: { seed?: number }): Promise<StoreResult<{ setId: string; rubricId: string; judgeConfigId: string }>>;
  importSet(args: { files: ImportFiles; parentSetId?: string }): Promise<StoreResult<{ set: PublicGoldSet; report: ImportReport }>>;
  freezeSet(args: { setId: string; seed?: number; heldoutFraction?: number }): Promise<StoreResult<PublicGoldSet>>;
  importProbeSets(args: { setId: string; files: ProbeImportFiles }): Promise<StoreResult<ProbeImportReport>>;
  createRubric(args: RubricContent & { setId: string; changeNote?: string }): Promise<StoreResult<Rubric>>;
  createChild(args: { rubricId: string; edits: RubricEdits; changeNote: string }): Promise<StoreResult<Rubric>>;
  createJudgeConfig(args: JudgeConfigDraft): Promise<StoreResult<JudgeConfig>>;
  planRun(args: DevRunArgs): Promise<StoreResult<RunPlan>>;
  createDevRun(args: DevRunArgs & { confirmed?: boolean }): Promise<StoreResult<PublicRun>>;
  runChunk(args: { runId: string; maxItems?: number }): Promise<StoreResult<ChunkProgress>>;
  listVerdicts(args: { runId: string }): Promise<StoreResult<Verdict[]>>;
  getDevResults(args: { runId: string }): Promise<StoreResult<DevDisplay>>;
  getDevCeiling(args: { setId: string }): Promise<StoreResult<MeanAgreementWithInterval>>;
  generateSuggestions(args: { runId: string }): Promise<StoreResult<StoredSuggestion[]>>;
  appendRuling(args: { suggestionId: string; decision: RulingDecision; note?: string }): Promise<StoreResult<Ruling>>;
  preregister(args: { setId: string; judgeConfigId: string; baselineRubricId: string; chosenRubricId: string }): Promise<StoreResult<Preregistration>>;
  requestHeldoutLook(args: { preregId: string; confirmed?: boolean }): Promise<StoreResult<LookGrant>>;
  burnScope(args: { scopeKey: string; confirmation: string; reason: string }): Promise<StoreResult<ContaminationStatus>>;
  report(args: { preregId: string }): Promise<StoreResult<BeforeAfterReport>>;
  contaminationStatus(args: { setId: string; judgeConfigId: string }): Promise<StoreResult<ContaminationStatus>>;
  labellingSheet(args: { setId: string; split?: 'all' | 'dev' | 'heldout' }): Promise<StoreResult<string>>;
  setBudget(args: { judgeConfigId: string; capUsd: number; reason: string }): Promise<StoreResult<Budget>>;
  resolveAmbiguous(args: { attemptId: string; resolution: 'charge_reserved' | 'release' }): Promise<StoreResult<void>>;
  reconcileLedger(): Promise<StoreResult<ReconcileReport>>;
}

/** For integrations needing explicitly public label rows without a GoldSet. */
export type PublicAnnotations = readonly Annotation[];
