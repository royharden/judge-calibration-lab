import type { SupabaseClient } from '@supabase/supabase-js';
import type { Store, StoreResult, StoreSnapshot, DevRunArgs, DevDisplay, PublicRun, StoredSuggestion } from './Store.ts';
import { fail, ok } from '../core/result.ts';
import { canonicalHash } from '../core/canonical.ts';
import { importGoldSet } from '../core/goldset/import.ts';
import { buildGroups, computeSplit, resampleUnitsFromGroups } from '../core/goldset/split.ts';
import { importProbeSets as parseProbes, checkProbeBaseItems } from '../core/goldset/probesets.ts';
import { labelSheetCsv } from '../core/goldset/labelsheet.ts';
import { createRubric as makeRubric, createChild as makeChild } from '../core/rubric/rubric.ts';
import { buildRunPlan } from '../core/plan/runPlan.ts';
import type { PriceBookEntry } from '../core/plan/costBound.ts';
import { buildRequest } from '../shared/providers.ts';
import { utf8Bytes } from '../core/sha256.ts';
import { buildJobs, replayProbes, type RunnerInput, type RunnerState } from './runner.ts';
import { diagnose, makeDevResults } from '../core/diagnostics/findings.ts';
import { generateSuggestions as suggest } from '../core/diagnostics/suggestions.ts';
import { judgeAgreementWithInterval, referenceCeilingWithInterval } from '../core/judgestats/agreement.ts';
import { fitLexical, applyLexical } from '../core/judge/lexical.ts';
import { fitModal } from '../core/judge/modal.ts';
import { undef, undefinedInterval } from '../core/judgestats/undefined.ts';
import { policyBootstrapOptions } from '../core/heldoutlock/policyConst.ts';
import { scopeKey } from '../core/heldoutlock/policy.ts';
import type { JudgeConfig, Rubric, Verdict } from '../core/types.ts';
import type { JobVerdict, LiveJob } from '../../supabase/functions/judge-run/contracts.ts';

type DevBundle = { set: StoreSnapshot['sets'][number]; run: PublicRun; rubric: Rubric; config: JudgeConfig; verdicts: Verdict[]; jobs: LiveJob[]; jobVerdicts: JobVerdict[] };
function databaseError(error: { message: string; details?: string }): ReturnType<typeof fail> {
  const match = /^([a-z_]+):\s*(.*)$/s.exec(error.message);
  return fail(match?.[1] ?? 'database_error', match?.[2] ?? error.message, error.details);
}
/** Authenticated live persistence. Every consequential write uses a named RPC or judge-run. */
export class SupabaseStore implements Store {
  #client: SupabaseClient;
  #reports = new Map<string, import('../core/report/beforeAfter.ts').BeforeAfterReport>();
  constructor(client: SupabaseClient) { this.#client = client; }
  async #rpc<T>(name: string, args: unknown = {}): Promise<StoreResult<T>> {
    try {
      const result = await this.#client.rpc(name, { p_args: args });
      return result.error ? databaseError(result.error) : ok(structuredClone(result.data) as T);
    } catch (error) { return fail('connection_error', error instanceof Error ? error.message : String(error)); }
  }
  async #edge<T>(action: string, args: Record<string, unknown>): Promise<StoreResult<T>> {
    try {
      const { data, error } = await this.#client.functions.invoke('judge-run', { body: { action, ...args } });
      if (error) {
        const context = (error as { context?: { json?: () => Promise<unknown> } }).context;
        if (context?.json) { try { const body = await context.json() as { code?: string; message?: string }; return fail(body.code ?? 'function_error', body.message ?? error.message); } catch { /* retain transport error */ } }
        return fail('function_error', error.message);
      }
      if (data && typeof data === 'object' && 'code' in data) return fail(String(data.code), String(data.message ?? data.code));
      return ok(data as T);
    } catch (error) { return fail('connection_error', error instanceof Error ? error.message : String(error)); }
  }
  async getSnapshot(): ReturnType<Store['getSnapshot']> {
    const result = await this.#rpc<StoreSnapshot>('public_snapshot');
    if (!result.ok) return result;
    const reports = [...this.#reports.values()].filter((r) => r.pins.owner === result.value.owner).map((report) => {
      const status = result.value.contamination.find((s) => s.scopeKey === scopeKey(report.pins.owner, report.pins.contentHash, report.pins.judgeConfigHash));
      const set = result.value.sets.find((s) => s.id === report.pins.setId);
      const contaminated = status?.status === 'contaminated' || set?.inheritedContamination === true;
      return contaminated ? { ...report, contamination: { contaminated: true, reasons: [...new Set([...report.contamination.reasons, 'current scope or lineage is contaminated'])] } } : report;
    });
    return ok({ ...result.value, reports: [...result.value.reports.filter((r) => !this.#reports.has(r.preregId)), ...reports] });
  }
  loadDemo(): ReturnType<Store['loadDemo']> { return Promise.resolve(fail('offline_demo_required', 'Select Run offline demo explicitly to create a separate MemoryStore; live persistence never substitutes demo data')); }
  async importSet(args: Parameters<Store['importSet']>[0]): ReturnType<Store['importSet']> {
    const parsed = importGoldSet(args.files);
    if (!parsed.ok) return fail('import_invalid', 'import refused; no rows persisted', parsed.error);
    const itemGroups = Object.fromEntries(buildGroups(parsed.value.items).flatMap((g) => g.itemKeys.map((key) => [key, g.groupKey])));
    return this.#rpc('import_set', { staged: parsed.value, parentSetId: args.parentSetId, itemGroups });
  }
  async freezeSet(args: Parameters<Store['freezeSet']>[0]): ReturnType<Store['freezeSet']> {
    const input = await this.#rpc<{ items: import('../core/types.ts').Item[]; annotations: import('../core/types.ts').Annotation[]; seed: number; heldoutFraction: number }>('freeze_input', args);
    if (!input.ok) return input;
    const split = computeSplit({ items: input.value.items, annotations: input.value.annotations, seed: args.seed ?? input.value.seed, heldoutFraction: args.heldoutFraction ?? input.value.heldoutFraction, frozenAt: new Date().toISOString() });
    if (!split.ok) return split;
    return this.#rpc('freeze_set', { setId: args.setId, seed: split.value.manifest.seed, heldoutFraction: split.value.manifest.heldoutFraction, heldoutItemKeys: split.value.manifest.heldout, splitHash: split.value.manifest.splitHash, manifest: split.value.manifest });
  }
  async importProbeSets(args: Parameters<Store['importProbeSets']>[0]): ReturnType<Store['importProbeSets']> {
    const parsed = parseProbes(args.files);
    if (!parsed.ok) return fail('probe_import_invalid', 'probe import refused', parsed.error);
    return this.#rpc('import_probe_sets', { setId: args.setId, probeSets: { pairs: parsed.value.pairs, rejectedPairs: parsed.value.rejectedPairs, injections: parsed.value.injections }, report: parsed.value.report });
  }
  async createRubric(args: Parameters<Store['createRubric']>[0]): ReturnType<Store['createRubric']> {
    const snapshot = await this.getSnapshot(); if (!snapshot.ok) return snapshot;
    const set = snapshot.value.sets.find((s) => s.id === args.setId); if (!set) return fail('not_found', 'set not found');
    const rubric = makeRubric(args, set.scale); if (!rubric.ok) return rubric;
    return this.#rpc('create_rubric', { setId: args.setId, rubric: rubric.value });
  }
  async createChild(args: Parameters<Store['createChild']>[0]): ReturnType<Store['createChild']> {
    const snapshot = await this.getSnapshot(); if (!snapshot.ok) return snapshot;
    const parent = snapshot.value.rubrics.find((r) => r.id === args.rubricId); if (!parent) return fail('not_found', 'rubric not found');
    const child = makeChild(parent, args.edits, args.changeNote); if (!child.ok) return child;
    return this.#rpc('create_rubric', { setId: parent.setId, rubric: child.value });
  }
  createJudgeConfig(args: Parameters<Store['createJudgeConfig']>[0]): ReturnType<Store['createJudgeConfig']> { return this.#rpc('create_judge_config', { config: args, configHash: canonicalHash(args) }); }
  async #prepare(args: DevRunArgs) {
    const snapshot = await this.getSnapshot(); if (!snapshot.ok) return snapshot;
    const set = snapshot.value.sets.find((s) => s.id === args.setId);
    const rubric = snapshot.value.rubrics.find((r) => r.id === args.rubricId);
    const config = snapshot.value.judgeConfigs.find((c) => c.id === args.judgeConfigId);
    if (!set || !rubric || !config) return fail('not_found', 'set, rubric or judge not found');
    if (!set.split || !set.frozen) return fail('prerequisite_missing', 'freeze the set first');
    if (rubric.setId !== set.id) return fail('bad_request', 'rubric belongs to another set');
    const linked = checkProbeBaseItems(set.probeSets, set.split); if (!linked.ok) return fail('probe_base_invalid', 'probe links must identify dev items', linked.error);
    const prices = await this.#rpc<PriceBookEntry[]>('price_book_rows'); if (!prices.ok) return prices;
    const dev = new Set(set.split.dev);
    const input: RunnerInput = { runId: 'preview', items: set.items.filter((i) => dev.has(i.key)), probes: set.probeSets, rubric, config, split: 'dev', includeProbes: args.includeProbes ?? true, seed: 36 };
    const jobs = buildJobs(input);
    const bytes = new Map(jobs.map((j) => [j.id, config.provider === 'mock' ? j.promptBytes : utf8Bytes(JSON.stringify(buildRequest(j.item, rubric, config, j.context.presentation).body)).length]));
    const plan = buildRunPlan({ itemKeys: jobs.map((j) => j.id), replicates: 1, kinds: ['score'], promptBytes: (id) => bytes.get(id)!, config, priceBook: prices.value });
    if (!plan.ok) return plan;
    return ok({ input, plan: { ...plan.value, items: input.items.length, kinds: [...new Set(jobs.map((j) => j.kind))] } });
  }
  async planRun(args: DevRunArgs): ReturnType<Store['planRun']> { const p = await this.#prepare(args); return p.ok ? ok(p.value.plan) : p; }
  async createDevRun(args: Parameters<Store['createDevRun']>[0]): ReturnType<Store['createDevRun']> {
    if (args.confirmed !== true) return fail('confirmation_required', 'explicit confirmation is required');
    const p = await this.#prepare(args); if (!p.ok) return p;
    return this.#rpc('create_dev_run', { ...args, includeProbes: args.includeProbes ?? true, plan: p.value.plan });
  }
  async runChunk(args: Parameters<Store['runChunk']>[0]): ReturnType<Store['runChunk']> {
    const response = await this.#edge<{ run_id: string; status: import('../core/heldoutlock/policy.ts').RunStatus; processed: number; remaining: number; unusable_count: number; spent_usd: number; reserved_usd: number }>('score', { run_id: args.runId, max_items: args.maxItems ?? 10, request_id: crypto.randomUUID() });
    return response.ok ? ok({ runId: response.value.run_id, status: response.value.status, processed: response.value.processed, remaining: response.value.remaining, unusableCount: response.value.unusable_count, spentUsd: response.value.spent_usd, reservedUsd: response.value.reserved_usd }) : response;
  }
  async listVerdicts(args: Parameters<Store['listVerdicts']>[0]): ReturnType<Store['listVerdicts']> { return this.#rpc('list_verdicts', args); }
  async #dev(args: { runId: string }): Promise<StoreResult<{ display: DevDisplay; evidence: ReturnType<typeof makeDevResults>; bundle: DevBundle }>> {
    const result = await this.#rpc<DevBundle>('dev_run_rows', args); if (!result.ok) return result;
    const b = result.value; if (b.run.split !== 'dev' || b.run.status !== 'complete' || !b.set.split) return fail('prerequisite_missing', 'complete the dev run first');
    const keys = new Set(b.set.split.dev);
    const input: RunnerInput = { runId: b.run.id, items: b.set.items.filter((i) => keys.has(i.key)), probes: b.set.probeSets, rubric: b.rubric, config: b.config, split: 'dev', includeProbes: b.run.includeProbes, seed: 36 };
    const jobs = buildJobs(input);
    const results: RunnerState['results'] = new Map(b.jobVerdicts.map((v) => [v.jobId, v.score !== null ? { kind: 'score' as const, score: v.score, raw: v.raw } : { kind: 'unusable' as const, unusable: v.unusableReason!, raw: v.raw }]));
    const probes = await replayProbes({ jobs, results }, input);
    const evidence = makeDevResults({ split: 'dev', runId: b.run.id, devKeys: b.set.split.dev, items: input.items, annotations: b.set.devAnnotations, verdicts: b.verdicts, k: b.set.scale.levels.length, scale: b.set.scale, probes });
    const units = resampleUnitsFromGroups(buildGroups(b.set.items), keys);
    const lexical = fitLexical(input.items, b.set.split, b.set.scale.levels.length);
    const modal = fitModal(b.set.devAnnotations, b.set.split, b.set.scale.levels.length);
    const missing = (reason: string) => undefinedInterval(undef(reason), reason);
    const baselines = {
      lexical: lexical.ok ? judgeAgreementWithInterval(input.items.map((i) => ({ itemKey: i.key, score: applyLexical(lexical.value, i) })), b.set.devAnnotations, b.set.scale.levels.length, units, policyBootstrapOptions()).interval : missing(lexical.error.message),
      modal: modal.ok ? judgeAgreementWithInterval(input.items.map((i) => ({ itemKey: i.key, score: modal.value.level })), b.set.devAnnotations, b.set.scale.levels.length, units, policyBootstrapOptions()).interval : missing(modal.error.message),
    };
    const snapshot = await this.getSnapshot(); if (!snapshot.ok) return snapshot;
    return ok({ display: { diagnostics: diagnose(evidence), verdicts: b.verdicts, probes, baselines, suggestions: snapshot.value.suggestions.filter((s) => s.runId === args.runId) }, evidence, bundle: b });
  }
  async getDevResults(args: Parameters<Store['getDevResults']>[0]): ReturnType<Store['getDevResults']> { const d = await this.#dev(args); return d.ok ? ok(d.value.display) : d; }
  async getDevCeiling(args: Parameters<Store['getDevCeiling']>[0]): ReturnType<Store['getDevCeiling']> {
    const snapshot = await this.getSnapshot(); if (!snapshot.ok) return snapshot;
    const set = snapshot.value.sets.find((s) => s.id === args.setId); if (!set?.split) return fail('prerequisite_missing', 'freeze the set first');
    return ok(referenceCeilingWithInterval(set.devAnnotations, set.scale.levels.length, resampleUnitsFromGroups(buildGroups(set.items), new Set(set.split.dev)), policyBootstrapOptions()));
  }
  async generateSuggestions(args: Parameters<Store['generateSuggestions']>[0]): ReturnType<Store['generateSuggestions']> {
    const data = await this.#dev(args); if (!data.ok) return data;
    const { evidence, display, bundle } = data.value;
    const session = await this.#client.auth.getUser(); if (session.error || !session.data.user) return fail('unauthenticated', 'sign in first');
    const suggestions: StoredSuggestion[] = suggest(evidence, display.diagnostics).suggestions.map((s) => ({ ...s, owner: session.data.user.id, setId: bundle.set.id, rubricHash: bundle.rubric.contentHash, judgeConfigHash: bundle.config.configHash }));
    return this.#rpc('append_suggestions', { runId: args.runId, inputHash: evidence.inputHash, suggestions });
  }
  appendRuling(args: Parameters<Store['appendRuling']>[0]): ReturnType<Store['appendRuling']> { return this.#rpc('append_ruling', args); }
  async preregister(args: Parameters<Store['preregister']>[0]): ReturnType<Store['preregister']> {
    const result = await this.#edge<{ prereg_id: string }>('preregister', { set_id: args.setId, judge_config_id: args.judgeConfigId, baseline_rubric_id: args.baselineRubricId, chosen_rubric_id: args.chosenRubricId, request_id: crypto.randomUUID() });
    if (!result.ok) return result;
    const snapshot = await this.getSnapshot(); if (!snapshot.ok) return snapshot;
    const prereg = snapshot.value.preregistrations.find((p) => p.id === result.value.prereg_id);
    return prereg ? ok(prereg) : fail('not_found', 'preregistration receipt was not present in the refreshed snapshot');
  }
  requestHeldoutLook(args: Parameters<Store['requestHeldoutLook']>[0]): ReturnType<Store['requestHeldoutLook']> { return args.confirmed === true ? this.#rpc('request_heldout_look', args) : Promise.resolve(fail('confirmation_required', 'confirm explicitly to spend held-out looks')); }
  burnScope(args: Parameters<Store['burnScope']>[0]): ReturnType<Store['burnScope']> { return this.#rpc('burn_scope', args); }
  async report(args: Parameters<Store['report']>[0]): ReturnType<Store['report']> {
    const report = await this.#edge<import('../core/report/beforeAfter.ts').BeforeAfterReport>('report', { prereg_id: args.preregId });
    if (report.ok) this.#reports.set(args.preregId, structuredClone(report.value));
    return report;
  }
  async contaminationStatus(args: Parameters<Store['contaminationStatus']>[0]): ReturnType<Store['contaminationStatus']> {
    const snapshot = await this.getSnapshot(); if (!snapshot.ok) return snapshot;
    const set = snapshot.value.sets.find((s) => s.id === args.setId); const config = snapshot.value.judgeConfigs.find((c) => c.id === args.judgeConfigId);
    if (!set || !config) return fail('not_found', 'set or judge not found');
    const key = scopeKey(snapshot.value.owner, set.contentHash, config.configHash);
    return this.#rpc('scope_status', { scopeKey: key, setId: args.setId });
  }
  async labellingSheet(args: Parameters<Store['labellingSheet']>[0]): ReturnType<Store['labellingSheet']> {
    const snapshot = await this.getSnapshot(); if (!snapshot.ok) return snapshot;
    const set = snapshot.value.sets.find((s) => s.id === args.setId); if (!set) return fail('not_found', 'set not found');
    if (args.split && args.split !== 'all' && !set.split) return fail('prerequisite_missing', 'freeze the set first');
    const keys = args.split && args.split !== 'all' ? new Set(set.split![args.split]) : null;
    return ok(labelSheetCsv(set.items.filter((i) => keys === null || keys.has(i.key))));
  }
  setBudget(args: Parameters<Store['setBudget']>[0]): ReturnType<Store['setBudget']> { return this.#rpc('set_budget', args); }
  resolveAmbiguous(args: Parameters<Store['resolveAmbiguous']>[0]): ReturnType<Store['resolveAmbiguous']> { return this.#rpc('resolve_ambiguous', args); }
  reconcileLedger(): ReturnType<Store['reconcileLedger']> { return this.#rpc('reconcile_ledger'); }
}
