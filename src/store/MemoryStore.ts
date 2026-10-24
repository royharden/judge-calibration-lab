import type { Annotation, JudgeConfig, Rubric } from '../core/types.ts';
import { canonicalHash } from '../core/canonical.ts';
import { fail, ok } from '../core/result.ts';
import { importGoldSet } from '../core/goldset/import.ts';
import type { ImportFiles, StagedSet } from '../core/goldset/types.ts';
import { importProbeSets as parseProbeSets, checkProbeBaseItems, type ProbeSets } from '../core/goldset/probesets.ts';
import { buildGroups, computeSplit, resampleUnitsFromGroups, verifySplit } from '../core/goldset/split.ts';
import { fingerprintItem } from '../core/goldset/fingerprint.ts';
import { labelSheetCsv } from '../core/goldset/labelsheet.ts';
import { createRubric as rootRubric, createChild as childRubric } from '../core/rubric/rubric.ts';
import { generateSyntheticSet } from '../core/fixtures/synthetic.ts';
import { medianWordCount, MOCK_DEFECTS } from '../core/judge/mock.ts';
import { fitLexical, applyLexical } from '../core/judge/lexical.ts';
import { fitModal } from '../core/judge/modal.ts';
import { PROMPT_TEMPLATE_VERSION, OUTPUT_SCHEMA_VERSION } from '../core/judge/prompt.ts';
import { LEVEL_MAP_VERSION } from '../core/judge/levelMap.ts';
import type { TruthMap } from '../core/judge/judge.ts';
import { devResultHash, diagnose, makeDevResults, type DevResults } from '../core/diagnostics/findings.ts';
import { generateSuggestions as suggest } from '../core/diagnostics/suggestions.ts';
import { judgeAgreementWithInterval, referenceCeilingWithInterval } from '../core/judgestats/agreement.ts';
import { undefinedInterval, undef } from '../core/judgestats/undefined.ts';
import { computeDevFits } from '../core/report/fits.ts';
import { assembleBeforeAfter, type BeforeAfterReport, type MeasuredCost } from '../core/report/beforeAfter.ts';
import { S36_V1, policyBootstrapOptions } from '../core/heldoutlock/policyConst.ts';
import { createLockState, preregister as registerPins, requestHeldoutLook as authorizeLook, burnScope as burnLockScope,
  canResplit, contaminationStatus as scopeStatus, scopeKey, setHeldoutRunStatus, heldoutRunFor,
  type FrozenSetRecord, type LockState, type Preregistration, type ContaminationStatus } from '../core/heldoutlock/policy.ts';
import { createCallLedger, type CallLedger } from '../shared/callledger.ts';
import { appendRuling as appendLogRuling, createRulingsLog, type RulingsLog } from '../shared/rulings.ts';
import { buildJobs, executeChunk, planJobs, replayProbes, runnerVerdicts, type RunnerInput, type RunnerState } from './runner.ts';
import type { DevDisplay, DevRunArgs, JudgeConfigDraft, PublicGoldSet, PublicRun, Store, StoreResult, StoreSnapshot, StoredSuggestion } from './Store.ts';

export const DEMO_BANNER = 'Offline demo — synthetic data — page memory only: reload or reset clears everything, including look counts';
type PrivateSet = { public: PublicGoldSet; staged: Annotation[]; heldout: Annotation[]; seed: number; fraction: number; truth?: TruthMap };
type PrivateRun = { public: PublicRun; input: RunnerInput; state: RunnerState; evidence?: DevResults; display?: DevDisplay; completionSeq: number };
export type MemoryStoreOptions = { owner?: string; now?: () => number; ledger?: CallLedger };
const emptyProbes = (): ProbeSets => ({ pairs: [], rejectedPairs: [], injections: [] });
const copy = <T>(value: T): T => structuredClone(value);

export class MemoryStore implements Store {
  #owner: string;
  #now: () => number;
  #ledger: CallLedger;
  #sets = new Map<string, PrivateSet>();
  #rubrics = new Map<string, Rubric>();
  #configs = new Map<string, JudgeConfig>();
  #runs = new Map<string, PrivateRun>();
  #suggestions = new Map<string, StoredSuggestion>();
  #reports = new Map<string, BeforeAfterReport>();
  #cache = new Map<string, import('../core/judge/judge.ts').JudgeResult>();
  #lock: LockState = createLockState();
  #rulings: RulingsLog = createRulingsLog();
  #serialTail: Promise<void> = Promise.resolve();
  #seq = 0;
  #completionSeq = 0;
  constructor(options: MemoryStoreOptions = {}) {
    this.#owner = options.owner ?? 'offline-demo-owner';
    this.#now = options.now ?? Date.now;
    this.#ledger = options.ledger ?? createCallLedger({ now: this.#now });
  }
  #time(): string { return new Date(this.#now()).toISOString(); }
  #id(prefix: string): string { this.#seq++; return `${prefix}-${this.#seq}`; }
  /** One queue covers reads and mutations; two concurrent look requests cannot race. */
  #serial<T>(work: () => StoreResult<T> | Promise<StoreResult<T>>): Promise<StoreResult<T>> {
    const result = this.#serialTail.then(async () => {
      try { const value = await work(); return copy(value); }
      catch (error) { return fail('store_error', error instanceof Error ? error.message : String(error)); }
    });
    this.#serialTail = result.then(() => undefined, () => undefined);
    return result;
  }
  #frozen(set: PrivateSet): FrozenSetRecord {
    return { setId: set.public.id, owner: this.#owner, contentHash: set.public.contentHash, annotationHash: set.public.annotationHash,
      splitHash: set.public.split?.splitHash ?? null, frozen: set.public.frozen, scale: set.public.scale };
  }
  #status(set: PrivateSet, judgeHash: string): ContaminationStatus {
    const status = scopeStatus(this.#lock, scopeKey(this.#owner, set.public.contentHash, judgeHash));
    return set.public.inheritedContamination ? { ...status, status: 'contaminated' } : status;
  }
  #currentReport(report: BeforeAfterReport): BeforeAfterReport {
    const set = this.#sets.get(report.pins.setId);
    const status = scopeStatus(this.#lock, scopeKey(this.#owner, report.pins.contentHash, report.pins.judgeConfigHash));
    const inherited = set?.public.inheritedContamination ?? false;
    const reasons = this.#lock.log.filter((e) => e.scopeKey === status.scopeKey && e.kind === 'burn').map((e) => e.reason ?? 'burned');
    if (inherited) reasons.push('inherited contamination from a prior split or parent');
    return { ...report, contamination: { contaminated: status.burned || inherited, reasons } };
  }
  getSnapshot(): ReturnType<Store['getSnapshot']> {
    return this.#serial(() => {
      const snapshot: StoreSnapshot = { mode: 'memory', banner: DEMO_BANNER, owner: this.#owner,
        sets: [...this.#sets.values()].map((s) => s.public), rubrics: [...this.#rubrics.values()], judgeConfigs: [...this.#configs.values()],
        runs: [...this.#runs.values()].map((r) => r.public), suggestions: [...this.#suggestions.values()], rulings: [...this.#rulings.entries],
        preregistrations: Object.values(this.#lock.preregistrations), reports: [...this.#reports.values()].map((r) => this.#currentReport(r)),
        contamination: Object.values(this.#lock.scopes).map((s) => {
          const set = [...this.#sets.values()].find((set) => set.public.contentHash === s.contentHash && set.public.inheritedContamination);
          const status = scopeStatus(this.#lock, s.key); return set ? { ...status, status: 'contaminated' as const } : status;
        }), budgets: this.#ledger.snapshot().budgets };
      return ok(snapshot);
    });
  }
  #import(files: ImportFiles, parentSetId?: string): StoreResult<{ set: PublicGoldSet; report: StagedSet['report'] }> {
    const parsed = importGoldSet(files);
    if (!parsed.ok) return fail('import_invalid', 'import refused; no rows persisted', parsed.error);
    const parent = parentSetId === undefined ? undefined : this.#sets.get(parentSetId);
    if (parentSetId !== undefined && !parent) return fail('not_found', 'parent set not found');
    const staged = parsed.value;
    const publicSet: PublicGoldSet = { id: this.#id('set'), name: staged.name, scale: staged.scale, items: staged.items, devAnnotations: [],
      contentHash: staged.contentHash, annotationHash: staged.annotationHash, parentSetId: parentSetId ?? null, frozen: false,
      importReport: staged.report, probeSets: emptyProbes(), inheritedContamination: parent?.public.inheritedContamination ?? false };
    if (parent && Object.values(this.#lock.scopes).some((s) => s.contentHash === parent.public.contentHash && scopeStatus(this.#lock, s.key).status === 'contaminated')) publicSet.inheritedContamination = true;
    // Re-imported fixture content can reuse planted truth by fingerprint, never by annotations.
    const known = [...this.#sets.values()].find((s) => s.public.contentHash === staged.contentHash && s.truth !== undefined);
    let truth: Record<string, number> | undefined;
    if (known?.truth) {
      const byFingerprint = new Map(known.public.items.map((i) => [fingerprintItem(i), known.truth![i.key]]));
      truth = Object.create(null) as Record<string, number>;
      for (const item of staged.items) { const level = byFingerprint.get(fingerprintItem(item)); if (level !== undefined) truth[item.key] = level; }
    }
    this.#sets.set(publicSet.id, { public: publicSet, staged: staged.stagedAnnotations, heldout: [], seed: staged.splitSeed, fraction: staged.heldoutFraction, truth });
    return ok({ set: publicSet, report: staged.report });
  }
  importSet(args: Parameters<Store['importSet']>[0]): ReturnType<Store['importSet']> { return this.#serial(() => this.#import(args.files, args.parentSetId)); }
  #makeRubric(args: Parameters<Store['createRubric']>[0]) {
    const set = this.#sets.get(args.setId);
    if (!set) return fail('not_found', 'set not found');
    const result = rootRubric(args, set.public.scale);
    if (result.ok) this.#rubrics.set(result.value.id, result.value);
    return result;
  }
  createRubric(args: Parameters<Store['createRubric']>[0]): ReturnType<Store['createRubric']> { return this.#serial(() => this.#makeRubric(args)); }
  createChild(args: Parameters<Store['createChild']>[0]): ReturnType<Store['createChild']> {
    return this.#serial(() => {
      const parent = this.#rubrics.get(args.rubricId);
      if (!parent) return fail('not_found', 'rubric not found');
      const result = childRubric(parent, args.edits, args.changeNote);
      if (result.ok) this.#rubrics.set(result.value.id, result.value);
      return result;
    });
  }
  #makeConfig(args: JudgeConfigDraft): StoreResult<JudgeConfig> {
    if (!['mock', 'anthropic', 'openai_compatible', 'typesafe'].includes(args.provider) || !args.model.trim() || !Number.isInteger(args.params.maxOutputTokens) || args.params.maxOutputTokens < 1) return fail('bad_request', 'valid provider, pinned model and positive maxOutputTokens required');
    if (!args.promptTemplateVersion || !args.outputSchemaVersion || !args.levelMapVersion) return fail('bad_request', 'judge versions must be pinned');
    if (args.params.temperature !== undefined && (!Number.isFinite(args.params.temperature) || args.params.temperature < 0)) return fail('bad_request', 'invalid temperature');
    if (args.provider === 'typesafe' && (args.model !== 'jev-1.13.0' || !['argmax_probabilities', 'rounded_score'].includes(args.scoreReadout))) return fail('bad_request', 'TypeSafe requires pinned Jev and positional readout');
    if (args.provider !== 'typesafe' && args.scoreReadout !== 'json_score') return fail('bad_request', 'generative and mock judges require json_score');
    if (args.params.mockDefect !== undefined && !MOCK_DEFECTS.includes(args.params.mockDefect)) return fail('bad_request', 'unknown mock defect');
    const configHash = canonicalHash(args);
    const existing = [...this.#configs.values()].find((c) => c.configHash === configHash);
    if (existing) return ok(existing);
    const config = { ...copy(args), id: `judge-${configHash}`, configHash };
    this.#configs.set(config.id, config);
    return ok(config);
  }
  createJudgeConfig(args: JudgeConfigDraft): ReturnType<Store['createJudgeConfig']> { return this.#serial(() => this.#makeConfig(args)); }
  loadDemo(args: { seed?: number } = {}): ReturnType<Store['loadDemo']> {
    return this.#serial(() => {
      const fixture = generateSyntheticSet(args.seed ?? 36);
      const imported = this.#import(fixture.files);
      if (!imported.ok) return imported;
      const set = this.#sets.get(imported.value.set.id)!;
      set.truth = copy(fixture.truth);
      const probes = parseProbeSets(fixture.probeFiles);
      if (!probes.ok) return fail('probe_import_invalid', 'fixture probe import failed', probes.error);
      set.public.probeSets = { pairs: probes.value.pairs, rejectedPairs: probes.value.rejectedPairs, injections: probes.value.injections };
      const rubric = this.#makeRubric({ setId: set.public.id, ...fixture.rubricV1 });
      if (!rubric.ok) return rubric;
      const config = this.#makeConfig({ provider: 'mock', model: 'mock-merges-3-4', params: { maxOutputTokens: 64, temperature: 0, mockDefect: 'merges-3-4' }, promptTemplateVersion: PROMPT_TEMPLATE_VERSION, outputSchemaVersion: OUTPUT_SCHEMA_VERSION, levelMapVersion: LEVEL_MAP_VERSION, scoreReadout: 'json_score' });
      return config.ok ? ok({ setId: set.public.id, rubricId: rubric.value.id, judgeConfigId: config.value.id }) : config;
    });
  }
  freezeSet(args: Parameters<Store['freezeSet']>[0]): ReturnType<Store['freezeSet']> {
    return this.#serial(() => {
      const set = this.#sets.get(args.setId);
      if (!set) return fail('not_found', 'set not found');
      const seed = args.seed ?? set.seed;
      const fraction = args.heldoutFraction ?? set.fraction;
      if (set.public.frozen) return seed === set.seed && fraction === set.fraction ? ok(set.public) : fail('already_frozen', 'frozen records are immutable; import a new set to request another split');
      const split = computeSplit({ items: set.public.items, annotations: set.staged, seed, heldoutFraction: fraction, frozenAt: this.#time() });
      if (!split.ok) return split;
      const priorPins = Object.values(this.#lock.preregistrations).filter((p) => p.pins.contentHash === set.public.contentHash);
      const differentPriorSplit = priorPins.some((p) => p.pins.splitHash !== split.value.manifest.splitHash);
      let inheritedContamination = set.public.inheritedContamination;
      if (differentPriorSplit) {
        const permission = canResplit(this.#lock, this.#owner, set.public.contentHash);
        if (!permission.ok) return permission;
        inheritedContamination ||= permission.value.contaminated;
      }
      const linked = checkProbeBaseItems(set.public.probeSets, split.value.manifest);
      if (!linked.ok) return fail('probe_base_invalid', 'probe links must identify dev items', linked.error);
      set.public.inheritedContamination = inheritedContamination;
      const dev = new Set(split.value.manifest.dev);
      set.public.devAnnotations = set.staged.filter((a) => dev.has(a.itemKey));
      set.heldout = set.staged.filter((a) => !dev.has(a.itemKey));
      set.staged = [];
      set.public.split = split.value.manifest;
      set.public.frozen = true;
      set.seed = seed; set.fraction = fraction;
      return ok(set.public);
    });
  }
  importProbeSets(args: Parameters<Store['importProbeSets']>[0]): ReturnType<Store['importProbeSets']> {
    return this.#serial(() => {
      const set = this.#sets.get(args.setId);
      if (!set) return fail('not_found', 'set not found');
      const parsed = parseProbeSets(args.files);
      if (!parsed.ok) return fail('probe_import_invalid', 'probe import refused', parsed.error);
      if (set.public.split) { const linked = checkProbeBaseItems(parsed.value, set.public.split); if (!linked.ok) return fail('probe_base_invalid', 'probe links must identify dev items', linked.error); }
      if ([...this.#runs.values()].some((r) => r.public.setId === args.setId)) return fail('immutable_probes', 'probe sets cannot change after a run is planned; use a new imported set');
      set.public.probeSets = { pairs: parsed.value.pairs, rejectedPairs: parsed.value.rejectedPairs, injections: parsed.value.injections };
      return ok(parsed.value.report);
    });
  }
  #prepare(args: DevRunArgs, runId: string, split: 'dev' | 'heldout' = 'dev'): StoreResult<{ input: RunnerInput; state: RunnerState; plan: PublicRun['plan'] }> {
    const set = this.#sets.get(args.setId);
    const rubric = this.#rubrics.get(args.rubricId);
    const config = this.#configs.get(args.judgeConfigId);
    if (!set || !rubric || !config) return fail('not_found', 'set, rubric or judge configuration not found');
    if (rubric.setId !== set.public.id) return fail('bad_request', 'rubric belongs to another set');
    if (!set.public.frozen || !set.public.split) return fail('prerequisite_missing', 'freeze the set before planning a run');
    if (config.provider !== 'mock') return fail('live_unavailable', 'MemoryStore cannot call live providers; connect a live Store explicitly');
    if (!set.truth) return fail('mock_truth_missing', 'mock judges require planted fixture truth; imported human annotations are never used as mock truth');
    const linked = checkProbeBaseItems(set.public.probeSets, set.public.split);
    if (!linked.ok) return fail('probe_base_invalid', 'probe links must identify dev items', linked.error);
    const keys = new Set(set.public.split[split]);
    const input: RunnerInput = { runId, items: set.public.items.filter((i) => keys.has(i.key)), probes: copy(set.public.probeSets), rubric: copy(rubric), config: copy(config),
      split, includeProbes: split === 'dev' && (args.includeProbes ?? true), seed: 36, truth: set.truth,
      devMedianWords: medianWordCount(set.public.items.filter((i) => set.public.split!.dev.includes(i.key))) };
    const jobs = buildJobs(input);
    const plan = planJobs(jobs, config, keys.size);
    return plan.ok ? ok({ input, state: { jobs, results: new Map() }, plan: plan.value }) : plan;
  }
  planRun(args: DevRunArgs): ReturnType<Store['planRun']> {
    return this.#serial(() => { const prepared = this.#prepare(args, 'preview'); return prepared.ok ? ok(prepared.value.plan) : prepared; });
  }
  #registerRun(args: DevRunArgs, id: string, split: 'dev' | 'heldout', preregId: string | null = null, lookSeq: number | null = null): StoreResult<PublicRun> {
    const prepared = this.#prepare(args, id, split);
    if (!prepared.ok) return prepared;
    const { input, state, plan } = prepared.value;
    const registered = this.#ledger.registerRun({ runId: id, owner: this.#owner, judgeConfigId: input.config.id, provider: input.config.provider, model: input.config.model, maxOutputTokens: input.config.params.maxOutputTokens });
    if (!registered.ok) return registered;
    const publicRun: PublicRun = { id, setId: args.setId, rubricId: args.rubricId, rubricHash: input.rubric.contentHash, judgeConfigId: args.judgeConfigId, judgeConfigHash: input.config.configHash,
      split, kind: 'score', status: 'pending', plan, plannedCalls: state.jobs.length, completedCalls: 0, scoreItems: input.items.length, completedScoreItems: 0,
      resultHash: null, includeProbes: input.includeProbes, createdAt: this.#time(), completedAt: null, preregId, lookSeq, error: null };
    this.#runs.set(id, { public: publicRun, input, state, completionSeq: 0 });
    return ok(publicRun);
  }
  createDevRun(args: Parameters<Store['createDevRun']>[0]): ReturnType<Store['createDevRun']> {
    return this.#serial(() => args.confirmed === true ? this.#registerRun(args, this.#id('dev-run'), 'dev') : fail('confirmation_required', 'run plan is a dry run; confirm explicitly before creating a run'));
  }
  async #complete(run: PrivateRun): Promise<void> {
    const rows = runnerVerdicts(run.public.id, run.state);
    if (rows.length !== run.input.items.length) throw new RangeError('run completed without every planned score verdict');
    if (run.public.split === 'dev') {
      const set = this.#sets.get(run.public.setId)!;
      const probes = await replayProbes(run.state, run.input);
      run.evidence = makeDevResults({ split: 'dev', runId: run.public.id, devKeys: run.input.items.map((i) => i.key), items: run.input.items,
        annotations: set.public.devAnnotations, verdicts: rows, k: set.public.scale.levels.length, scale: set.public.scale, probes });
      const units = resampleUnitsFromGroups(buildGroups(set.public.items), new Set(set.public.split!.dev));
      const lexical = fitLexical(run.input.items, { dev: set.public.split!.dev }, set.public.scale.levels.length);
      const modal = fitModal(set.public.devAnnotations, { dev: set.public.split!.dev }, set.public.scale.levels.length);
      const missing = (reason: string) => undefinedInterval(undef(reason), reason);
      const lexicalKappa = lexical.ok ? judgeAgreementWithInterval(run.input.items.map((i) => ({ itemKey: i.key, score: applyLexical(lexical.value, i) })), set.public.devAnnotations, set.public.scale.levels.length, units, policyBootstrapOptions()).interval : missing(lexical.error.message);
      const modalKappa = modal.ok ? judgeAgreementWithInterval(run.input.items.map((i) => ({ itemKey: i.key, score: modal.value.level })), set.public.devAnnotations, set.public.scale.levels.length, units, policyBootstrapOptions()).interval : missing(modal.error.message);
      run.display = { diagnostics: diagnose(run.evidence), suggestions: [], verdicts: rows, probes, baselines: { lexical: lexicalKappa, modal: modalKappa } };
    }
    run.public.resultHash = devResultHash(rows);
    run.public.status = 'complete'; run.public.completedAt = this.#time(); run.public.error = null;
    run.completionSeq = ++this.#completionSeq;
    if (run.public.split === 'heldout') { const next = setHeldoutRunStatus(this.#lock, run.public.id, 'complete'); if (next.ok) this.#lock = next.value; }
  }
  runChunk(args: Parameters<Store['runChunk']>[0]): ReturnType<Store['runChunk']> {
    return this.#serial(async () => {
      const run = this.#runs.get(args.runId);
      if (!run) return fail('not_found', 'run not found');
      if (run.public.status === 'complete') return ok(this.#progress(run, 0));
      run.public.status = 'running'; run.public.error = null;
      const execution = await executeChunk({ runId: run.public.id, owner: this.#owner, state: run.state, config: run.input.config, rubric: run.input.rubric,
        ledger: this.#ledger, cache: this.#cache, now: this.#now, maxItems: args.maxItems });
      run.public.completedCalls = run.state.results.size;
      run.public.completedScoreItems = runnerVerdicts(run.public.id, run.state).length;
      if (!execution.ok) {
        run.public.status = 'paused'; run.public.error = execution.error;
        if (run.public.split === 'heldout') { const next = setHeldoutRunStatus(this.#lock, run.public.id, 'paused'); if (next.ok) this.#lock = next.value; }
        return execution;
      }
      if (execution.value.remaining === 0) {
        try { await this.#complete(run); }
        catch (error) { run.public.status = 'paused'; run.public.error = { reason: 'analysis_failed', message: error instanceof Error ? error.message : String(error) }; return fail('analysis_failed', run.public.error.message); }
      }
      else run.public.status = 'paused';
      if (execution.value.processed === 0 && execution.value.remaining > 0) {
        run.public.error = { reason: 'chunk_yielded', message: 'chunk has insufficient time to start an attempt; resume explicitly' };
        return fail('chunk_yielded', run.public.error.message);
      }
      return ok(this.#progress(run, execution.value.processed));
    });
  }
  #progress(run: PrivateRun, processed: number) {
    const budget = this.#ledger.getBudget(this.#owner, run.public.judgeConfigId);
    return { runId: run.public.id, status: run.public.status, processed, remaining: run.state.jobs.length - run.state.results.size,
      unusableCount: runnerVerdicts(run.public.id, run.state).filter((v) => v.score === null).length, spentUsd: budget.spentUsd, reservedUsd: budget.reservedUsd };
  }
  listVerdicts(args: Parameters<Store['listVerdicts']>[0]): ReturnType<Store['listVerdicts']> {
    return this.#serial(() => {
      const run = this.#runs.get(args.runId);
      if (!run) return fail('not_found', 'run not found');
      if (run.public.split === 'heldout' && run.public.status !== 'complete') return fail('prerequisite_missing', 'held-out rows are released only after the authorized run completes');
      return ok(runnerVerdicts(run.public.id, run.state));
    });
  }
  getDevResults(args: Parameters<Store['getDevResults']>[0]): ReturnType<Store['getDevResults']> {
    return this.#serial(() => {
      const run = this.#runs.get(args.runId);
      if (!run) return fail('not_found', 'run not found');
      if (run.public.split !== 'dev') return fail('not_dev', 'diagnostics admit dev runs only');
      if (run.public.status !== 'complete' || !run.display) return fail('prerequisite_missing', 'complete the dev score and probes first');
      return ok({ ...run.display, suggestions: [...this.#suggestions.values()].filter((s) => s.runId === args.runId) });
    });
  }
  getDevCeiling(args: Parameters<Store['getDevCeiling']>[0]): ReturnType<Store['getDevCeiling']> {
    return this.#serial(() => {
      const set = this.#sets.get(args.setId);
      if (!set) return fail('not_found', 'set not found');
      if (!set.public.split) return fail('prerequisite_missing', 'freeze the set before computing the dev ceiling');
      const dev = new Set(set.public.split.dev);
      const units = resampleUnitsFromGroups(buildGroups(set.public.items), dev);
      return ok(referenceCeilingWithInterval(set.public.devAnnotations, set.public.scale.levels.length, units, policyBootstrapOptions()));
    });
  }
  generateSuggestions(args: Parameters<Store['generateSuggestions']>[0]): ReturnType<Store['generateSuggestions']> {
    return this.#serial(() => {
      const run = this.#runs.get(args.runId);
      if (!run) return fail('not_found', 'run not found');
      if (run.public.split !== 'dev') return fail('not_dev', 'suggestions admit dev runs only');
      if (!run.evidence || !run.display || run.public.status !== 'complete') return fail('prerequisite_missing', 'complete the dev run first');
      const generated = suggest(run.evidence, run.display.diagnostics).suggestions;
      const stored: StoredSuggestion[] = generated.map((s) => ({ ...s, owner: this.#owner, setId: run.public.setId, rubricHash: run.public.rubricHash, judgeConfigHash: run.public.judgeConfigHash }));
      for (const s of stored) this.#suggestions.set(s.suggestionId, s);
      return ok(stored);
    });
  }
  #latestDev(setId: string, rubricHash: string, judgeConfigHash: string): PrivateRun | undefined {
    return [...this.#runs.values()].filter((r) => r.public.setId === setId && r.public.rubricHash === rubricHash && r.public.judgeConfigHash === judgeConfigHash && r.public.split === 'dev' && r.public.status === 'complete').sort((a, b) => b.completionSeq - a.completionSeq)[0];
  }
  appendRuling(args: Parameters<Store['appendRuling']>[0]): ReturnType<Store['appendRuling']> {
    return this.#serial(() => {
      const suggestion = this.#suggestions.get(args.suggestionId);
      if (!suggestion) return fail('not_found', 'suggestion not found');
      const result = appendLogRuling(this.#rulings, { owner: this.#owner, suggestion, decision: args.decision, note: args.note, now: this.#time() }, (key) => {
        const run = this.#latestDev(key.setId, key.rubricHash, key.judgeConfigHash);
        return run?.public.resultHash ? { runId: run.public.id, resultHash: run.public.resultHash } : null;
      });
      if (!result.ok) return result;
      this.#rulings = result.value.log;
      return ok(result.value.ruling);
    });
  }
  #fitFor(set: PrivateSet, baseline: PrivateRun) {
    return computeDevFits({ devItems: baseline.input.items, devKeys: set.public.split!.dev, devAnnotations: set.public.devAnnotations,
      baselineVerdicts: runnerVerdicts(baseline.public.id, baseline.state), k: set.public.scale.levels.length });
  }
  preregister(args: Parameters<Store['preregister']>[0]): ReturnType<Store['preregister']> {
    return this.#serial(() => {
      const set = this.#sets.get(args.setId);
      const config = this.#configs.get(args.judgeConfigId);
      const baseline = this.#rubrics.get(args.baselineRubricId);
      const chosen = this.#rubrics.get(args.chosenRubricId);
      if (!set || !config || !baseline || !chosen) return fail('not_found', 'set, rubrics or judge not found');
      if (baseline.setId !== set.public.id || chosen.setId !== set.public.id) return fail('bad_request', 'both rubrics must belong to this set');
      if (!set.public.split) return fail('prerequisite_missing', 'freeze set first');
      const dev = this.#latestDev(args.setId, baseline.contentHash, config.configHash);
      if (!dev) return fail('prerequisite_missing', 'a completed baseline dev score run is required');
      const fits = this.#fitFor(set, dev);
      if (!fits.ok) return fits;
      const recomputedSplit = verifySplit({ items: set.public.items, annotations: [...set.public.devAnnotations, ...set.heldout], seed: set.seed, heldoutFraction: set.fraction }, set.public.split.splitHash);
      if (!recomputedSplit.ok) return fail('prereg_mismatch', 'recomputed split differs from frozen split', recomputedSplit.error);
      const registration = registerPins(this.#lock, { owner: this.#owner, set: this.#frozen(set), judgeConfigHash: config.configHash,
        baselineRubricHash: baseline.contentHash, chosenRubricHash: chosen.contentHash, baselineDevRun: { runId: dev.public.id, setId: set.public.id, rubricHash: baseline.contentHash, judgeConfigHash: config.configHash, kind: 'score', split: 'dev', status: 'complete' },
        fits: fits.value.hashes, policy: S36_V1, recomputedSplitHash: recomputedSplit.value, now: this.#time() });
      if (!registration.ok) return registration;
      this.#lock = registration.value.state;
      return ok(registration.value.prereg);
    });
  }
  requestHeldoutLook(args: Parameters<Store['requestHeldoutLook']>[0]): ReturnType<Store['requestHeldoutLook']> {
    return this.#serial(() => {
      if (args.confirmed !== true) return fail('confirmation_required', 'confirm explicitly to spend the held-out look slots');
      const prereg = this.#lock.preregistrations[args.preregId];
      if (!prereg) return fail('not_found', 'preregistration not found');
      const set = this.#sets.get(prereg.pins.setId);
      const config = [...this.#configs.values()].find((c) => c.configHash === prereg.pins.judgeConfigHash);
      if (!set || !config) return fail('not_found', 'preregistered set or judge not found');
      if (config.provider !== 'mock') return fail('live_unavailable', 'MemoryStore cannot make live calls; no fallback is performed');
      const rubrics = [prereg.pins.baselineRubricHash, prereg.pins.chosenRubricHash].map((hash) => [...this.#rubrics.values()].find((r) => r.setId === set.public.id && r.contentHash === hash));
      if (rubrics.some((r) => r === undefined)) return fail('prereg_mismatch', 'pinned rubrics not found in this set');
      // Prepare first; failed validation must not partially authorize a look.
      for (const rubric of rubrics) {
        const prepared = this.#prepare({ setId: set.public.id, rubricId: rubric!.id, judgeConfigId: config.id, includeProbes: false }, 'preview', 'heldout');
        if (!prepared.ok) return prepared;
      }
      const authorization = authorizeLook(this.#lock, args.preregId, { owner: this.#owner, set: this.#frozen(set), now: this.#time() });
      if (!authorization.ok) return authorization;
      // Slots are spent now, before scoring, and are not refunded by any subsequent failure.
      this.#lock = authorization.value.state;
      for (const look of authorization.value.grant.looks) {
        if (this.#runs.has(look.runId)) continue;
        const rubric = rubrics.find((r) => r!.contentHash === look.rubricHash)!;
        const registered = this.#registerRun({ setId: set.public.id, rubricId: rubric!.id, judgeConfigId: config.id, includeProbes: false }, look.runId, 'heldout', args.preregId, look.lookSeq);
        if (!registered.ok) { const status = setHeldoutRunStatus(this.#lock, look.runId, 'failed'); if (status.ok) this.#lock = status.value; return registered; }
      }
      return ok(authorization.value.grant);
    });
  }
  burnScope(args: Parameters<Store['burnScope']>[0]): ReturnType<Store['burnScope']> {
    return this.#serial(() => {
      const result = burnLockScope(this.#lock, { ...args, owner: this.#owner, now: this.#time() });
      if (!result.ok) return result;
      this.#lock = result.value.state;
      return ok(scopeStatus(this.#lock, args.scopeKey));
    });
  }
  contaminationStatus(args: Parameters<Store['contaminationStatus']>[0]): ReturnType<Store['contaminationStatus']> {
    return this.#serial(() => {
      const set = this.#sets.get(args.setId); const config = this.#configs.get(args.judgeConfigId);
      if (!set || !config) return fail('not_found', 'set or judge not found');
      return ok(this.#status(set, config.configHash));
    });
  }
  #cost(run: PrivateRun): MeasuredCost {
    const calls = this.#ledger.snapshot().attempts.filter((a) => a.runId === run.public.id && a.sentAt !== null);
    return { actualUsd: calls.reduce((sum, a) => sum + (a.actualUsd ?? (a.resolution === 'charge_reserved' ? a.reservedUsd : 0)), 0), attemptedCalls: calls.length, attemptedItems: new Set(calls.map((a) => a.itemKey)).size };
  }
  /** Reuse across renamed/reordered imports pairs original rows to current keys by content. */
  #rowsFor(run: PrivateRun, target: PrivateSet) {
    const rows = runnerVerdicts(run.public.id, run.state);
    if (run.public.setId === target.public.id) return rows;
    const original = this.#sets.get(run.public.setId)!;
    const targetKeys = new Set(target.public.split!.heldout);
    const buckets = new Map<string, string[]>();
    for (const item of target.public.items.filter((i) => targetKeys.has(i.key)).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) {
      const fp = fingerprintItem(item); const list = buckets.get(fp) ?? []; list.push(item.key); buckets.set(fp, list);
    }
    return [...rows].sort((a, b) => a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0).map((row) => {
      const item = original.public.items.find((i) => i.key === row.itemKey)!;
      const key = buckets.get(fingerprintItem(item))?.shift();
      if (key === undefined) throw new RangeError('prereg_mismatch: reused run content differs from this frozen split');
      return { ...row, itemKey: key };
    });
  }
  report(args: Parameters<Store['report']>[0]): ReturnType<Store['report']> {
    return this.#serial(() => {
      const prereg: Preregistration | undefined = this.#lock.preregistrations[args.preregId];
      if (!prereg) return fail('not_found', 'preregistration not found');
      const set = this.#sets.get(prereg.pins.setId);
      const baselineRef = heldoutRunFor(this.#lock, prereg.scopeKey, prereg.pins.baselineRubricHash);
      const chosenRef = heldoutRunFor(this.#lock, prereg.scopeKey, prereg.pins.chosenRubricHash);
      const baseline = baselineRef ? this.#runs.get(baselineRef.runId) : undefined;
      const chosen = chosenRef ? this.#runs.get(chosenRef.runId) : undefined;
      if (!set || !set.public.split || !baseline || !chosen || baseline.public.status !== 'complete' || chosen.public.status !== 'complete') return fail('prerequisite_missing', 'authorize and complete both pinned held-out runs before reporting');
      const dev = this.#runs.get(prereg.pins.baselineDevRunId);
      if (!dev || dev.public.status !== 'complete' || dev.public.split !== 'dev') return fail('prerequisite_missing', 'pinned baseline dev evidence is unavailable');
      const fits = this.#fitFor(set, dev);
      if (!fits.ok) return fits;
      const heldout = new Set(set.public.split.heldout);
      const report = assembleBeforeAfter({ confirmed: true, preregId: prereg.id, pins: prereg.pins,
        current: { contentHash: set.public.contentHash, annotationHash: set.public.annotationHash, splitHash: set.public.split.splitHash, judgeConfigHash: chosen.public.judgeConfigHash, baselineRubricHash: baseline.public.rubricHash, chosenRubricHash: chosen.public.rubricHash },
        judgeName: chosen.input.config.model, scale: set.public.scale, items: set.public.items.filter((i) => heldout.has(i.key)), annotations: set.heldout,
        baselineVerdicts: this.#rowsFor(baseline, set), chosenVerdicts: this.#rowsFor(chosen, set), fits: fits.value,
        contamination: { contaminated: false, reasons: [] }, lineage: set.public.parentSetId ? [set.public.parentSetId] : [], baselineCost: this.#cost(baseline), chosenCost: this.#cost(chosen) });
      const current = this.#currentReport(report);
      this.#reports.set(prereg.id, current);
      return ok(current);
    });
  }
  labellingSheet(args: Parameters<Store['labellingSheet']>[0]): ReturnType<Store['labellingSheet']> {
    return this.#serial(() => {
      const set = this.#sets.get(args.setId);
      if (!set) return fail('not_found', 'set not found');
      if (args.split !== undefined && args.split !== 'all' && !set.public.split) return fail('prerequisite_missing', 'freeze before exporting a split sheet');
      const keys = args.split && args.split !== 'all' ? new Set(set.public.split![args.split]) : null;
      return ok(labelSheetCsv(set.public.items.filter((i) => keys === null || keys.has(i.key))));
    });
  }
  setBudget(args: Parameters<Store['setBudget']>[0]): ReturnType<Store['setBudget']> {
    return this.#serial(() => this.#configs.has(args.judgeConfigId) ? this.#ledger.setBudget({ ...args, owner: this.#owner }) : fail('not_found', 'judge configuration not found'));
  }
  resolveAmbiguous(args: Parameters<Store['resolveAmbiguous']>[0]): ReturnType<Store['resolveAmbiguous']> {
    return this.#serial(() => this.#ledger.resolveAmbiguous({ ...args, owner: this.#owner }));
  }
  reconcileLedger(): ReturnType<Store['reconcileLedger']> { return this.#serial(() => ok(this.#ledger.reconcile())); }
}
