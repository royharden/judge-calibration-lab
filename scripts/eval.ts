/** Offline evidence authoring entrypoint. Nothing here runs on import.
 * Future owner execution writes results; no stored success numbers or API calls.
 * CLI: npm run eval -- --self-test [--seeds 201] [--out results]
 *      npm run eval -- --real-input local.json --out results/real-run-001
 * Both mode flags may be combined. No flags means --self-test.
 *
 * Real input JSON is exactly RealEvaluationInput below. ReportInput is the app's
 * confirmed report contract (beforeAfter.ts), not a precomputed metric object.
 * Scores/annotations use INTERNAL indices 0..K-1; raw probe JSON uses displayed
 * scale values. Local confirmation is an operator assertion, not authentication.
 */
import { lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MockDefect, Presentation, Rubric, Stat } from '../src/core/types.ts';
import { canonicalHash } from '../src/core/canonical.ts';
import { deriveStream } from '../src/core/prng.ts';
import { unwrap } from '../src/core/result.ts';
import { generateSyntheticSet, syntheticRubricV2Edits } from '../src/core/fixtures/synthetic.ts';
import { annotatorTiesVariant, IMPORT_TRAP_EXPECTED, IMPORT_TRAP_FILES, MALFORMED_JUDGE_OUTPUTS, n12Subset, randomAnnotatorVariant } from '../src/core/fixtures/traps.ts';
import { importGoldSet } from '../src/core/goldset/import.ts';
import { importProbeSets } from '../src/core/goldset/probesets.ts';
import { annotationHashOf, contentHashOf, fingerprintItem, fingerprintMap } from '../src/core/goldset/fingerprint.ts';
import { buildGroups, computeSplit, sameHeldout } from '../src/core/goldset/split.ts';
import { createMockJudge, medianWordCount, MOCK_DEFECTS } from '../src/core/judge/mock.ts';
import { scoreAll, type Judge, type JudgeResult } from '../src/core/judge/judge.ts';
import { parseJudgeOutput } from '../src/core/judge/parse.ts';
import { createChild, createRubric, verifyRubricHash } from '../src/core/rubric/rubric.ts';
import { diagnose, makeDevResults, type DevInput, type SuggestionTemplate } from '../src/core/diagnostics/findings.ts';
import { runRepeatability, type ExploratoryItem } from '../src/core/probes/repeatability.ts';
import { runVerbosity, type ExploratoryPair } from '../src/core/probes/verbosity.ts';
import { runScaleOrder } from '../src/core/probes/scaleOrder.ts';
import { runInjection, type ExploratoryInjection } from '../src/core/probes/injection.ts';
import { pairCheck } from '../src/core/probes/pairCheck.ts';
import { judgeAgreementWithInterval, referenceCeiling } from '../src/core/judgestats/agreement.ts';
import { consensusByItem } from '../src/core/judgestats/consensus.ts';
import { unitsFromItems } from '../src/core/judgestats/bootstrap.ts';
import { formatInterval, formatStat, undef, value } from '../src/core/judgestats/undefined.ts';
import { wilsonInterval } from '../src/core/judgestats/wilson.ts';
import { LOCK_SCENARIOS, runLockScenario } from '../src/core/heldoutlock/scenarios.ts';
import { jevGate, type JevGateJudge } from '../src/core/heldoutlock/jevGate.ts';
import { assembleBeforeAfter, type BeforeAfterReport, type ReportInput, type VersionReport } from '../src/core/report/beforeAfter.ts';
import { computeDevFits } from '../src/core/report/fits.ts';
import { buildJudgeTable, judgeTableCsv, type JudgeTableInput } from '../src/core/report/judgeTable.ts';

export const MIN_SEEDS = 201;
// Use app default 2,000 draws for detection and coverage; no reduced headline run.
export const DETECTION_RESAMPLES = 2000;
export const COVERAGE_RESAMPLES = 2000;
export const PROPOSED_LINES = { detectionAtLeast: 0.9, cleanFalseFlagAtMost: 0.1, coverageLow: 0.92, coverageHigh: 0.98 } as const;
export type RecordedProbes = {
  rubric: Rubric;
  items: ExploratoryItem[];
  pairs: ExploratoryPair[];
  injections: ExploratoryInjection[];
  responses: { kind: 'repeatability' | 'verbosity' | 'scaleOrder' | 'injection'; itemKey: string; replicate: number; presentation: Presentation; raw: string }[];
};
export type RealJudgeInput = {
  id: string;
  role: 'generative-small' | 'generative-large' | 'jev';
  provider: 'anthropic' | 'openai_compatible' | 'typesafe';
  input: ReportInput;
  /** Complete BASELINE dev pass: recomputes lexical/modal/PAV without heldout leakage. */
  baselineDev: Omit<DevInput, 'probes'>;
  split: { seed: number; heldoutFraction: number };
  /** Chosen verdicts/run ID may differ; the full frozen dev gold universe must match baselineDev. */
  dev?: Omit<DevInput, 'probes'>;
  recordedProbes?: RecordedProbes;
};
export type RealEvaluationInput = {
  schemaVersion: 's36-real-eval/v1';
  reports: RealJudgeInput[];
  gatePair?: { jevId: string; generativeId: string };
};
type EvidenceRow = { kind: string; [key: string]: unknown };
type CaseResult = { seed: number; defect: MockDefect; detected: boolean; anyFlag: boolean; relevantUndefined: boolean; evidence: unknown };

const DETECTORS: Partial<Record<MockDefect, SuggestionTemplate>> = {
  lenient: 'leniency', verbosity: 'verbosity', 'merges-3-4': 'adjacent_confusion',
  'flip-flop': 'instability', 'order-sensitive': 'scale_order', injection: 'injection',
};
export function rate(numerator: number, denominator: number): Stat {
  return denominator === 0 ? undef('no cases in denominator') : value(numerator / denominator);
}
export function proposedPass(stat: Stat, low: number, high = Infinity): boolean | null {
  return stat.kind === 'undefined' ? null : stat.value >= low && stat.value <= high;
}

/** Real fixture, strict mock parser, shared probes and diagnostics; no bespoke detector thresholds. */
export async function evaluateDefect(seed: number, defect: MockDefect): Promise<CaseResult> {
  const set = generateSyntheticSet(seed);
  const rubric = unwrap(createRubric({ setId: 'self-test', ...set.rubricV1 }, set.scale));
  const items = set.items.map((i) => ({ ...i, split: 'dev' as const }));
  const judge = createMockJudge(defect);
  const probeSets = unwrap(importProbeSets(set.probeFiles));
  const opts = { split: 'dev' as const, runId: `self-${seed}-${defect}`, seed, truth: set.truth, bootstrap: { resamples: DETECTION_RESAMPLES } };
  const verdicts = await scoreAll(judge, items, rubric, { ...opts, replicate: 0, presentation: 'ascending', lengthReference: { kind: 'dev_median', words: medianWordCount(items) } });
  const probes = {
    repeatability: await runRepeatability(judge, items, rubric, opts),
    verbosity: await runVerbosity(judge, probeSets.pairs.map((p) => ({ ...p, split: 'probe' as const })), rubric, opts),
    scaleOrder: await runScaleOrder(judge, items, rubric, opts),
    injection: await runInjection(judge, probeSets.injections.map((p) => ({ ...p, split: 'probe' as const })), rubric, opts),
  };
  const diagnostics = diagnose(makeDevResults({ split: 'dev', runId: opts.runId, devKeys: items.map((i) => i.key), items, annotations: set.annotations, verdicts, k: 5, scale: set.scale, probes }), { seed, resamples: DETECTION_RESAMPLES });
  const expected = DETECTORS[defect];
  // Constant judges are detected by undefined QWK, not a manufactured zero or
  // a coincidental adjacent-confusion finding. Undefined is expected only here.
  const constant = diagnostics.judgeHumanKappa.point.kind === 'undefined';
  const anyFlag = diagnostics.findings.length > 0 || constant;
  const relevant = defect === 'verbosity' ? probes.verbosity.shift : defect === 'order-sensitive' ? probes.scaleOrder.shift
    : defect === 'injection' ? probes.injection.shift : defect === 'flip-flop' ? probes.repeatability.runToRunKappa
    : defect === 'lenient' ? diagnostics.offset : diagnostics.judgeHumanKappa;
  const relevantUndefined = [relevant.point, relevant.lo, relevant.hi].some((s) => s.kind === 'undefined');
  const detected = defect === 'clean' ? !anyFlag : defect === 'constant' ? constant : diagnostics.findings.some((f) => f.template === expected);
  // Retain all case counts, intervals, rejection reasons and diagnostic findings,
  // without holding millions of reproducible mock raw verdict objects in RAM.
  const { verdicts: _repeatVerdicts, ...repeatability } = probes.repeatability;
  const { verdicts: _verbosityVerdicts, pairs: _verbosityPairs, ...verbosity } = probes.verbosity;
  const { verdicts: _orderVerdicts, pairs: _orderPairs, ...scaleOrder } = probes.scaleOrder;
  const { verdicts: _injectionVerdicts, pairs: _injectionPairs, ...injection } = probes.injection;
  return { seed, defect, detected, anyFlag, relevantUndefined, evidence: { diagnostics, probes: { repeatability, verbosity, scaleOrder, injection } } };
}

/** IID singleton groups: H~Uniform{0..4}; J=H with p=.8, else independent
 * Uniform{0..4}. Marginals are identical uniform and E[(J-H)^2]=.2*4;
 * independent-marginal expected disagreement=4, hence population QWK=1-.2=.8.
 * Uses the SAME frozen-basis group-bootstrap implementation as app reports.
 */
export function coverageCase(seed: number) {
  const rng = deriveStream(seed, 'eval/known-population-qwk/v1');
  const items = Array.from({ length: 400 }, (_, i) => ({ key: `population-${i}` }));
  const annotations = items.map((i) => ({ itemKey: i.key, annotatorId: 'population-human', score: rng.int(5) }));
  const verdicts = annotations.map((a) => ({ itemKey: a.itemKey, score: rng.nextFloat() < 0.8 ? a.score : rng.int(5) }));
  const interval = judgeAgreementWithInterval(verdicts, annotations, 5, unitsFromItems(items), { seed, resamples: COVERAGE_RESAMPLES }).interval;
  const defined = interval.lo.kind === 'value' && interval.hi.kind === 'value';
  const covered = interval.lo.kind === 'value' && interval.hi.kind === 'value' && interval.lo.value <= 0.8 && interval.hi.value >= 0.8;
  return { seed, populationQwk: 0.8, n: items.length, defined, covered, interval };
}

export async function trapChecks(seed: number) {
  const set = generateSyntheticSet(seed);
  const imported = importGoldSet(IMPORT_TRAP_FILES);
  const n12 = n12Subset(set);
  const smallSplit = computeSplit({ ...n12, seed, heldoutFraction: 0.5 });
  const malformed = MALFORMED_JUDGE_OUTPUTS.map((c) => {
    const got = parseJudgeOutput(c.raw, set.scale.levels.map((l) => l.value));
    return { raw: c.raw, got, passed: 'unusable' in c.expect ? got.kind === 'unusable' && got.reason === c.expect.unusable : got.kind === 'score' && got.index === c.expect.index };
  });
  const ties = annotatorTiesVariant(set);
  const consensus = consensusByItem(ties.annotations);
  const normal = referenceCeiling(set.annotations, 5).value;
  const noisy = referenceCeiling(randomAnnotatorVariant(set, 'ann-5', seed), 5).value;
  const padded = set.pairs.find((p) => p.trap)!;
  const locks = LOCK_SCENARIOS.map(runLockScenario);
  const rubric = unwrap(createRubric({ setId: 'repair-trap', ...set.rubricV1 }, set.scale));
  const repaired = unwrap(createChild(rubric, syntheticRubricV2Edits(), 'Mechanical fixture marker repair; plumbing only'));
  const context = { seed, runId: 'repair', replicate: 0, split: 'dev' as const, presentation: 'ascending' as const, truth: set.truth };
  const judge = createMockJudge('merges-3-4');
  const before = await scoreAll(judge, set.items, rubric, context);
  const after = await scoreAll(judge, set.items, repaired, context);
  const repairWorks = after.every((v) => v.score === set.truth[v.itemKey]) && before.some((v) => v.score !== after.find((a) => a.itemKey === v.itemKey)?.score);
  const checks = {
    importTrap: !imported.ok && IMPORT_TRAP_EXPECTED.every((e) => imported.error.issues.some((i) => i.code === e.code && (e.itemId === undefined || i.itemId === e.itemId))),
    paddedPair: !pairCheck({ short: padded.shortText, long: padded.longText, facts: padded.facts }).pass,
    n12Refused: !smallSplit.ok,
    malformed: malformed.every((c) => c.passed),
    consensusTies: ties.tieKeys.every((key) => consensus.ties.includes(key)),
    randomAnnotator: normal.kind === 'value' && noisy.kind === 'value' && noisy.value < normal.value,
    lockScenarios: locks.every((s) => s.passed),
    markerRepairPlumbingOnly: repairWorks,
  };
  // Injection and constant traps are also exercised in every defect case, with
  // interval denominators and undefined-QWK evidence retained in JSONL.
  return { seed, checks, passed: Object.values(checks).every(Boolean), malformed, locks: locks.map((s) => ({ name: s.name, passed: s.passed, outcomes: s.outcomes })), normalReference: normal, randomReference: noisy };
}

export async function runSelfTest(seeds: number): Promise<{ rows: EvidenceRow[]; markdown: string }> {
  if (!Number.isInteger(seeds) || seeds < MIN_SEEDS) throw new RangeError(`--seeds must be an integer >= ${MIN_SEEDS}; every defect including clean receives that many seeds`);
  const rows: EvidenceRow[] = [];
  const lines = ['## Synthetic self-test (measured by this invocation only)', '', 'Proposed acceptance lines: detection ≥ 0.90; clean false flags ≤ 0.10; unconditional coverage 0.92–0.98. These are proposals, not validated standards.', '', '| case | successes / all seeds | rate | relevant undefined | proposed line met |', '| --- | --- | --- | --- | --- |'];
  for (const defect of MOCK_DEFECTS) {
    let successes = 0;
    let undefinedCases = 0;
    for (let seed = 0; seed < seeds; seed++) {
      const result = await evaluateDefect(seed, defect);
      rows.push({ kind: 'defect-case', ...result });
      if (defect === 'clean' ? result.anyFlag : result.detected) successes++;
      if (result.relevantUndefined) undefinedCases++;
    }
    const measuredRate = rate(successes, seeds);
    const meetsProposal = defect === 'clean' ? proposedPass(measuredRate, 0, PROPOSED_LINES.cleanFalseFlagAtMost) : proposedPass(measuredRate, PROPOSED_LINES.detectionAtLeast);
    rows.push({ kind: 'defect-summary', defect, seeds, successes, undefinedCases, denominatorIncludesUndefined: true, rate: measuredRate, uncertainty: wilsonInterval(successes, seeds), meetsProposal });
    lines.push(`| ${defect === 'clean' ? 'clean false flags' : defect} | ${successes} / ${seeds} | ${formatStat(measuredRate)} | ${undefinedCases} | ${String(meetsProposal)} |`);
  }
  let covered = 0;
  let defined = 0;
  let passedTraps = 0;
  for (let seed = 0; seed < seeds; seed++) {
    const coverage = coverageCase(seed);
    rows.push({ kind: 'coverage-case', ...coverage });
    if (coverage.covered) covered++;
    if (coverage.defined) defined++;
    const traps = await trapChecks(seed);
    rows.push({ kind: 'trap-case', ...traps });
    if (traps.passed) passedTraps++;
  }
  const coverageRate = rate(covered, seeds);
  const coverage = { seeds, covered, defined, undefinedCases: seeds - defined, unconditionalCoverage: coverageRate, conditionalOnDefined: rate(covered, defined), uncertainty: wilsonInterval(covered, seeds), meetsProposal: proposedPass(coverageRate, PROPOSED_LINES.coverageLow, PROPOSED_LINES.coverageHigh) };
  rows.push({ kind: 'coverage-summary', ...coverage }, { kind: 'trap-summary', seeds, passed: passedTraps, failed: seeds - passedTraps });
  lines.push('', `Known-population QWK = 0.8; 400 IID singleton groups per seed; coverage bootstrap ${COVERAGE_RESAMPLES} draws. Covered ${covered}/${seeds}; defined ${defined}/${seeds}; unconditional coverage ${formatStat(coverageRate)}; conditional coverage ${formatStat(coverage.conditionalOnDefined)}; proposed line met: ${String(coverage.meetsProposal)}. Undefined intervals remain in the unconditional denominator.`, '', `Trap suites passed ${passedTraps}/${seeds}. Every case, diagnostic finding, probe denominator, undefined reason and draw count is in results.jsonl; seeded mock raw verdicts are reproducible from source rather than duplicated in that file.`, '', `Detection uses the shared app probes/diagnostics with ${DETECTION_RESAMPLES} exploratory bootstrap draws per seed. Constant detection requires undefined QWK; clean false flags include any finding or undefined judge-human QWK. The fixture marker repair demonstrates plumbing only; it is not measured real-judge improvement.`);
  return { rows, markdown: lines.join('\n') };
}

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}
export function parseRealInput(data: unknown): RealEvaluationInput {
  object(data, 'real input');
  if (data.schemaVersion !== 's36-real-eval/v1' || !Array.isArray(data.reports)) throw new TypeError('real input requires schemaVersion s36-real-eval/v1 and reports[] (see RealEvaluationInput in scripts/eval.ts)');
  const ids = new Set<string>();
  for (const [index, unknownEntry] of data.reports.entries()) {
    object(unknownEntry, `reports[${index}]`);
    const e = unknownEntry;
    if (typeof e.id !== 'string' || !e.id || ids.has(e.id)) throw new TypeError(`reports[${index}].id must be nonempty and unique`);
    ids.add(e.id);
    if (!['generative-small', 'generative-large', 'jev'].includes(String(e.role))) throw new TypeError(`reports[${index}].role is invalid`);
    if (!['anthropic', 'openai_compatible', 'typesafe'].includes(String(e.provider)) || (e.role === 'jev') !== (e.provider === 'typesafe')) throw new TypeError(`reports[${index}] role/provider mismatch`);
    object(e.input, `reports[${index}].input`);
    object(e.baselineDev, `reports[${index}].baselineDev (complete baseline dev pass required to recompute fits)`);
    object(e.split, `reports[${index}].split (seed and heldoutFraction required to recompute frozen split)`);
    if (e.input.confirmed !== true) throw new TypeError(`reports[${index}].input must be a confirmed complete ReportInput`);
    for (const field of ['items', 'annotations', 'baselineVerdicts', 'chosenVerdicts']) if (!Array.isArray(e.input[field])) throw new TypeError(`reports[${index}].input.${field} must be an array`);
  }
  // Core assembly performs the consequential policy/hash/fit/universe checks.
  return data as unknown as RealEvaluationInput;
}

/** Recorded responses are keyed by actual request presentation and replicate.
 * Missing response stays unusable; it never becomes a score or a fresh API call.
 */
async function replayProbes(input: RecordedProbes) {
  const responses = new Map<string, string>();
  const key = (kind: string, itemKey: string, replicate: number, presentation: Presentation): string => JSON.stringify([kind, itemKey, replicate, presentation]);
  for (const row of input.responses) {
    if (!['repeatability', 'verbosity', 'scaleOrder', 'injection'].includes(row.kind) || !Number.isInteger(row.replicate) || row.replicate < 0 || !['ascending', 'reversed'].includes(row.presentation) || typeof row.raw !== 'string') throw new TypeError('invalid recorded probe response (kind, itemKey, replicate, presentation and raw required)');
    const id = key(row.kind, row.itemKey, row.replicate, row.presentation);
    if (responses.has(id)) throw new RangeError(`duplicate recorded probe response ${id}`);
    responses.set(id, row.raw);
  }
  const judge = (kind: RecordedProbes['responses'][number]['kind']): Judge => ({ id: `local-recording-${kind}`, score(item, rubric, ctx) {
    const raw = responses.get(key(kind, item.key, ctx.replicate, ctx.presentation));
    if (raw === undefined) return Promise.resolve({ kind: 'unusable', unusable: 'provider_error', raw: 'missing local recorded response' });
    const parsed = parseJudgeOutput(raw, rubric.levels.map((l) => l.value));
    const result: JudgeResult = parsed.kind === 'score' ? { kind: 'score', score: parsed.index, raw } : { kind: 'unusable', unusable: parsed.reason, raw };
    return Promise.resolve(result);
  } });
  const opts = { split: 'dev' as const, runId: 'recorded-probes', seed: 36 };
  return {
    repeatability: await runRepeatability(judge('repeatability'), input.items, input.rubric, opts),
    verbosity: await runVerbosity(judge('verbosity'), input.pairs, input.rubric, opts),
    scaleOrder: await runScaleOrder(judge('scaleOrder'), input.items, input.rubric, opts),
    injection: await runInjection(judge('injection'), input.injections, input.rubric, opts),
  };
}

function sameGatePopulation(a: ReportInput, b: ReportInput): boolean {
  return a.pins.annotationHash === b.pins.annotationHash && a.pins.scaleHash === b.pins.scaleHash
    && canonicalHash([...a.items].sort((x, y) => x.key.localeCompare(y.key))) === canonicalHash([...b.items].sort((x, y) => x.key.localeCompare(y.key)))
    && canonicalHash([...a.annotations].sort((x, y) => x.itemKey.localeCompare(y.itemKey) || x.annotatorId.localeCompare(y.annotatorId))) === canonicalHash([...b.annotations].sort((x, y) => x.itemKey.localeCompare(y.itemKey) || x.annotatorId.localeCompare(y.annotatorId)));
}
function gateJudge(e: RealJudgeInput, report: BeforeAfterReport): JevGateJudge {
  const cost = report.chosen.cost.per100AttemptedUsd;
  return { judgeConfigHash: e.input.pins.judgeConfigHash, provider: e.provider, preregId: e.input.preregId,
    chosenRubricHash: e.input.pins.chosenRubricHash, splitHash: e.input.pins.splitHash, contentHash: e.input.pins.contentHash,
    confirmed: e.input.confirmed, heldoutVerdicts: e.input.chosenVerdicts, lexicalKappa: report.lexical.kappa.point, costPer100Usd: cost.kind === 'value' ? cost.value : null };
}
function versionLine(label: string, v: VersionReport): string {
  return `| ${label} | ${formatInterval(v.kappa)} | ${formatStat(v.exact)} | ${formatStat(v.withinOne)} | ${formatInterval(v.offset)} | ${v.unusableN}/${v.plannedN} | ${formatStat(v.cost.per100AttemptedUsd)} |`;
}

function assertSameDevGold(baseline: Omit<DevInput, 'probes'>, chosen: Omit<DevInput, 'probes'>, reportId: string): void {
  const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
  const refuse = (field: string): never => { throw new RangeError(`report ${reportId}: chosen dev ${field} differ from frozen baseline dev`); };
  if (chosen.k !== baseline.k) refuse('level counts');
  if (canonicalHash(chosen.scale) !== canonicalHash(baseline.scale)) refuse('scales');
  if (canonicalHash([...chosen.devKeys].sort()) !== canonicalHash([...baseline.devKeys].sort())) refuse('key universes');
  const items = (input: Omit<DevInput, 'probes'>) => input.items.map((item) => ({ key: item.key, fingerprint: fingerprintItem(item), groupId: item.groupId ?? null }))
    .sort((a, b) => compare(a.key, b.key));
  if (canonicalHash(items(chosen)) !== canonicalHash(items(baseline))) refuse('items/content/groups');
  const annotations = (input: Omit<DevInput, 'probes'>) => input.annotations.map((a) => ({ itemKey: a.itemKey, annotatorId: a.annotatorId, score: a.score }))
    .sort((a, b) => compare(a.itemKey, b.itemKey) || compare(a.annotatorId, b.annotatorId) || a.score - b.score);
  if (canonicalHash(annotations(chosen)) !== canonicalHash(annotations(baseline))) refuse('annotations');
}

export async function evaluateReal(input: RealEvaluationInput): Promise<{ rows: EvidenceRow[]; markdown: string }> {
  const rows: EvidenceRow[] = [];
  const table: JudgeTableInput[] = [];
  const reports = new Map<string, { entry: RealJudgeInput; report: BeforeAfterReport }>();
  const lines = ['## Real data (local supplied evidence)', '', 'Numbers are recomputed from the supplied rows. Confirmed status and provenance are operator assertions; this offline script cannot authenticate a server ledger.'];
  for (const entry of input.reports) {
    let report: BeforeAfterReport;
    try {
      // makeDevResults checks scale, universe, verdict identities and dev branding.
      const dev = makeDevResults(entry.baselineDev);
      if (dev.runId !== entry.input.pins.baselineDevRunId) throw new RangeError('baseline dev run id differs from preregistration pin');
      if (canonicalHash(dev.scale) !== canonicalHash(entry.input.scale)) throw new RangeError('baseline dev scale differs from heldout scale');
      const devKeys = new Set(dev.devKeys);
      const heldoutKeys = new Set(entry.input.items.map((i) => i.key));
      if (entry.input.items.some((i) => devKeys.has(i.key))) throw new RangeError('dev/heldout item overlap');
      for (const group of buildGroups([...dev.items, ...entry.input.items])) {
        if (group.itemKeys.some((key) => devKeys.has(key)) && group.itemKeys.some((key) => heldoutKeys.has(key))) throw new RangeError('dev/heldout group or duplicate-fingerprint overlap');
      }
      const allItems = [...dev.items, ...entry.input.items];
      const allAnnotations = [...dev.annotations, ...entry.input.annotations];
      const fingerprints = fingerprintMap(allItems);
      if (contentHashOf(Object.values(fingerprints)) !== entry.input.pins.contentHash || annotationHashOf(allAnnotations, fingerprints) !== entry.input.pins.annotationHash) throw new RangeError('content or annotation hash differs from supplied full frozen population');
      const split = unwrap(computeSplit({ items: allItems, annotations: allAnnotations, seed: entry.split.seed, heldoutFraction: entry.split.heldoutFraction }));
      if (split.manifest.splitHash !== entry.input.pins.splitHash || !sameHeldout(split.manifest, [...heldoutKeys])) throw new RangeError('frozen split differs from recomputed split');
      const fits = unwrap(computeDevFits({ devItems: dev.items, devKeys: dev.devKeys, devAnnotations: dev.annotations, baselineVerdicts: dev.verdicts, k: dev.k }));
      if (canonicalHash(fits) !== canonicalHash(entry.input.fits)) throw new RangeError('supplied fits differ from recomputed baseline dev fits (including devInputHash)');
      report = assembleBeforeAfter({ ...entry.input, fits });
    }
    catch (error) { throw new Error(`report ${entry.id} cannot be recomputed: ${error instanceof Error ? error.message : String(error)}; supply the complete matching ReportInput, not precomputed report metrics`); }
    const devKeys = new Set(entry.baselineDev.devKeys);
    const devFingerprint = fingerprintMap(entry.baselineDev.items);
    if (entry.dev !== undefined) assertSameDevGold(entry.baselineDev, entry.dev, entry.id);
    if (entry.recordedProbes !== undefined) {
      const p = entry.recordedProbes;
      if (!verifyRubricHash(p.rubric) || p.rubric.contentHash !== entry.input.pins.chosenRubricHash) throw new RangeError(`report ${entry.id}: probe rubric does not match chosen rubric`);
      if (p.items.some((i) => !devKeys.has(i.key) || fingerprintItem(i) !== devFingerprint[i.key])) throw new RangeError(`report ${entry.id}: ordinary probe items must match frozen dev split`);
      const heldout = new Set(entry.input.items.map((i) => i.key));
      if ([...p.pairs, ...p.injections].some((i) => i.baseItemId !== undefined && heldout.has(i.baseItemId))) throw new RangeError(`report ${entry.id}: heldout base item cannot enter exploratory probes`);
    }
    const probes = entry.recordedProbes === undefined ? undefined : await replayProbes(entry.recordedProbes);
    const diagnostics = entry.dev === undefined ? null : diagnose(makeDevResults({ ...entry.dev, probes }));
    reports.set(entry.id, { entry, report });
    table.push({ report, probes });
    rows.push({ kind: 'real-report', id: entry.id, role: entry.role, provider: entry.provider, report, probes: probes ?? { status: 'not measured' }, diagnostics: diagnostics ?? { status: 'not measured' } });
    lines.push('', `### ${entry.id} (${entry.role})`, '', '| row | held-out κ [95% CI] | exact | within-one | offset [95% CI] | unusable/planned | USD/100 attempted |', '| --- | --- | --- | --- | --- | --- | --- |', versionLine('chosen', report.chosen), versionLine('baseline rubric', report.baseline), versionLine('lexical (dev fit)', report.lexical), versionLine('modal (dev fit)', report.modal), versionLine('PAV remap (dev fit)', report.remap.baseline), '', `Human reference level: ${formatInterval(report.ceiling.interval)} (pair basis ${report.ceiling.basis.length}; excluded below overlap floor ${report.ceiling.excluded.length}). Paired chosen−baseline Δκ: ${formatInterval(report.delta)}; chosen−remap Δκ: ${formatInterval(report.remap.pairedVsChosen.delta)}. Verdict: ${report.verdict.label}.`, '', `Probes: ${probes === undefined ? 'not measured' : 'replayed from local raw responses (dev); see judge table and JSONL for intervals and denominators'}. Dev diagnostics: ${diagnostics === null ? 'not measured' : `${diagnostics.findings.length} findings; ${diagnostics.notices.length} notices`}.`);
  }
  for (const role of ['generative-small', 'generative-large', 'jev'] as const) {
    if (!input.reports.some((e) => e.role === role)) {
      rows.push({ kind: 'not-measured', role, reason: 'no confirmed ReportInput supplied' });
      lines.push('', `${role}: not measured (no confirmed ReportInput supplied).`);
    }
  }
  rows.push({ kind: 'judge-table', rows: buildJudgeTable(table) });
  lines.push('', 'Judge comparison CSV (including probe intervals, unusable counts, denominators and cost):', '', '```csv', judgeTableCsv(buildJudgeTable(table)).trimEnd(), '```');
  const pair = input.gatePair;
  const j = pair === undefined ? undefined : reports.get(pair.jevId);
  const g = pair === undefined ? undefined : reports.get(pair.generativeId);
  if (pair === undefined || j === undefined || g === undefined || j.entry.role !== 'jev' || g.entry.role === 'jev' || !sameGatePopulation(j.entry.input, g.entry.input) || !j.report.missingness.ok || !g.report.missingness.ok || j.report.contamination.contaminated || g.report.contamination.contaminated || j.report.fits.mismatchFields.length > 0 || g.report.fits.mismatchFields.length > 0 || j.report.chosen.cost.per100AttemptedUsd.kind === 'undefined' || g.report.chosen.cost.per100AttemptedUsd.kind === 'undefined') {
    const reason = 'not measured: explicit matching confirmed, uncontaminated Jev/generative inputs with equal annotations, scale and held-out population, recomputed valid dev fits and measured costs required';
    rows.push({ kind: 'jev-gate', status: 'not measured', reason });
    lines.push('', `Jev promotion gate: ${reason}.`);
  } else {
    const gate = jevGate({ jev: gateJudge(j.entry, j.report), generative: gateJudge(g.entry, g.report), heldoutAnnotations: j.entry.input.annotations, k: j.entry.input.scale.levels.length, units: j.report.units });
    rows.push({ kind: 'jev-gate', result: gate });
    lines.push('', `Jev promotion gate: ${gate.outcome}; ${gate.messages.join('; ')}. Paired Δκ(Jev−generative): ${formatInterval(gate.delta)}. Margin ±${gate.margin} remains a proposal.`);
  }
  return { rows, markdown: lines.join('\n') };
}

export function parseArgs(args: readonly string[]) {
  let selfTest = false;
  let realInput: string | undefined;
  let seeds = MIN_SEEDS;
  let out = 'results';
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--self-test') selfTest = true;
    else if (flag === '--seeds' || flag === '--out' || flag === '--real-input') {
      const next = args[++i];
      if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`);
      if (flag === '--seeds') seeds = Number(next);
      else if (flag === '--out') out = next;
      else realInput = next;
    } else throw new Error(`unknown option ${String(flag)}; use --self-test [--seeds 201] [--real-input local.json] [--out <directory>] (new, empty or .gitkeep-only)`);
  }
  if (!Number.isInteger(seeds) || seeds < MIN_SEEDS || seeds > 10000) throw new RangeError('--seeds must be an integer from 201 to 10000');
  return { selfTest: selfTest || realInput === undefined, realInput, seeds, out };
}

/** Accept the tracked results/.gitkeep without ever overwriting or removing earlier output. */
export async function prepareEvidenceDirectory(directory: string): Promise<string> {
  const out = resolve(directory);
  try { await mkdir(out, { recursive: false }); return out; }
  catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
  const info = await lstat(out);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('output must be a real directory; choose a new --out directory; existing files are preserved');
  const entries = await readdir(out, { withFileTypes: true });
  if (entries.some((entry) => entry.name !== '.gitkeep' || !entry.isFile())) {
    throw new Error('output directory contains existing evidence or other entries; choose a new --out directory; existing files are preserved');
  }
  return out;
}

export async function main(args: readonly string[]) {
  const opts = parseArgs(args);
  // Refuse prior evidence BEFORE costly evaluation. Final exclusive writes also
  // refuse files created concurrently after the directory check.
  const out = await prepareEvidenceDirectory(opts.out);
  const rows: EvidenceRow[] = [{ kind: 'invocation', schemaVersion: 's36-evidence/v1', generatedAt: new Date().toISOString(), modes: opts, proposedLines: PROPOSED_LINES, implementation: 'shared app core', network: false }];
  const markdown = ['# Judge calibration evidence', '', 'These results were produced by an explicit local script invocation. Synthetic self-test metrics do not establish real-judge quality.'];
  if (opts.selfTest) { const result = await runSelfTest(opts.seeds); rows.push(...result.rows); markdown.push(result.markdown); }
  if (opts.realInput !== undefined) {
    if ((await stat(resolve(opts.realInput))).size > 100 * 1024 * 1024) throw new RangeError('real input exceeds 100 MiB; provide a bounded local export');
    const text = await readFile(resolve(opts.realInput), 'utf8');
    if (Buffer.byteLength(text) > 100 * 1024 * 1024) throw new RangeError('real input exceeds 100 MiB; provide a bounded local export');
    const input = parseRealInput(JSON.parse(text));
    rows.push({ kind: 'real-input-lineage', path: resolve(opts.realInput), hash: canonicalHash(input) });
    const result = await evaluateReal(input); rows.push(...result.rows); markdown.push(result.markdown);
  } else {
    rows.push({ kind: 'not-measured', scope: 'real judges', reason: 'no --real-input supplied' });
    markdown.push('## Real data', '', 'Lexical, modal, human reference, generative-small, generative-large and Jev on real data: not measured. Jev promotion gate: not measured. Supply --real-input with matching confirmed report inputs.');
  }
  await writeFile(resolve(out, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { flag: 'wx' });
  await writeFile(resolve(out, 'results.md'), markdown.join('\n\n') + '\n', { flag: 'wx' });
  console.log(`Wrote ${out}/results.md and results.jsonl. Acceptance lines are proposals; inspect failures and undefined denominators.`);
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`eval: ${error instanceof Error ? error.message : String(error)}. Use a separate --out directory for another invocation; existing evidence is preserved.`);
    process.exitCode = 1;
  });
}
