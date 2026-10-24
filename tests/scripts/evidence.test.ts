import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { evaluateReal, parseArgs, parseRealInput, prepareEvidenceDirectory, proposedPass, rate, runSelfTest, type RealJudgeInput } from '../../scripts/eval.ts';
import { downloadArgs, isPublicIPv4, LICENSE_ACK } from '../../scripts/fetch-real-set.ts';
import { fixtureArgs } from '../../scripts/gen-fixtures.ts';
import { canonicalHash } from '../../src/core/canonical.ts';
import { generateSyntheticSet, syntheticRubricV2Edits } from '../../src/core/fixtures/synthetic.ts';
import { importGoldSet } from '../../src/core/goldset/import.ts';
import { computeSplit } from '../../src/core/goldset/split.ts';
import { createChild, createRubric } from '../../src/core/rubric/rubric.ts';
import { mockScoreSync } from '../../src/core/judge/mock.ts';
import { toVerdict } from '../../src/core/judge/judge.ts';
import { computeDevFits } from '../../src/core/report/fits.ts';
import { policyHash, S36_V1 } from '../../src/core/heldoutlock/policyConst.ts';
import { unwrap } from '../../src/core/result.ts';

/** Synthetic test INPUT only; never saved as real evidence or a result artifact. */
function reportFixture(): RealJudgeInput {
  const set = generateSyntheticSet(36);
  const staged = unwrap(importGoldSet(set.files));
  const split = { seed: 36, heldoutFraction: 0.5 };
  const manifest = unwrap(computeSplit({ items: set.items, annotations: set.annotations, ...split })).manifest;
  const devKeys = new Set(manifest.dev);
  const devItems = set.items.filter((i) => devKeys.has(i.key));
  const heldoutItems = set.items.filter((i) => !devKeys.has(i.key));
  const devAnnotations = set.annotations.filter((a) => devKeys.has(a.itemKey));
  const rubric = unwrap(createRubric({ setId: 'script-test', ...set.rubricV1 }, set.scale));
  const chosen = unwrap(createChild(rubric, syntheticRubricV2Edits(), 'test fixture repair'));
  const score = (items: typeof set.items, r: typeof rubric, runId: string) => items.map((i) => toVerdict(runId, i.key, 0, mockScoreSync('merges-3-4', i, r, { runId, seed: 36, replicate: 0, presentation: 'ascending', split: devKeys.has(i.key) ? 'dev' : 'heldout', truth: set.truth })));
  const baselineDev = { split: 'dev' as const, runId: 'dev-test', devKeys: manifest.dev, items: devItems, annotations: devAnnotations, verdicts: score(devItems, rubric, 'dev-test'), scale: set.scale, k: 5 };
  const fits = unwrap(computeDevFits({ devItems, devKeys: manifest.dev, devAnnotations, baselineVerdicts: baselineDev.verdicts, k: 5 }));
  const current = { contentHash: staged.contentHash, annotationHash: staged.annotationHash, splitHash: manifest.splitHash, judgeConfigHash: 'script-test-config', baselineRubricHash: rubric.contentHash, chosenRubricHash: chosen.contentHash };
  const pins = { ...current, owner: 'operator-test', setId: 'script-test', scaleHash: canonicalHash(set.scale), policyVersion: S36_V1.version, policyHash, algorithmVersions: S36_V1.algorithmVersions, bootstrap: S36_V1.bootstrap, fitHashes: fits.hashes, baselineDevRunId: baselineDev.runId };
  const cost = { actualUsd: null, attemptedCalls: heldoutItems.length, attemptedItems: heldoutItems.length };
  return { id: 'test-small', role: 'generative-small', provider: 'anthropic', baselineDev, split, input: { confirmed: true, preregId: 'test-prereg', pins, current, judgeName: 'synthetic test input (not real evidence)', scale: set.scale, items: heldoutItems, annotations: set.annotations.filter((a) => !devKeys.has(a.itemKey)), baselineVerdicts: score(heldoutItems, rubric, 'heldout-before'), chosenVerdicts: score(heldoutItems, chosen, 'heldout-after'), fits, contamination: { contaminated: false, reasons: [] }, baselineCost: cost, chosenCost: cost } };
}

describe('evidence CLI boundaries (execution deferred)', () => {
  it('refuses undersized seed claims before any simulation', async () => {
    // what_bug_this_catches: a smaller smoke run presented as >=201 seeds per defect.
    expect(() => parseArgs(['--seeds', '200'])).toThrow('201');
    await expect(runSelfTest(200)).rejects.toThrow('201');
    expect(parseArgs([])).toMatchObject({ selfTest: true, seeds: 201 });
    expect(parseArgs(['--real-input', 'local.json'])).toMatchObject({ selfTest: false, realInput: 'local.json' });
    expect(parseArgs(['--self-test', '--real-input', 'local.json'])).toMatchObject({ selfTest: true });
  });
  it('keeps zero-denominator rates and unassessable proposals undefined', () => {
    // what_bug_this_catches: no observations reported as a perfect zero false-flag rate.
    expect(rate(0, 0).kind).toBe('undefined');
    expect(proposedPass(rate(0, 0), 0, 0.1)).toBeNull();
    expect(proposedPass(rate(18, 20), 0.9)).toBe(true);
    expect(proposedPass(rate(19, 20), 0.92, 0.98)).toBe(true);
    expect(proposedPass(rate(20, 20), 0.92, 0.98)).toBe(false);
  });
  it('requires confirmed row-level real input and dev provenance', () => {
    // what_bug_this_catches: precomputed/fabricated table metrics accepted as real evidence.
    expect(() => parseRealInput({ reports: [] })).toThrow('schemaVersion');
    expect(() => parseRealInput({ schemaVersion: 's36-real-eval/v1', reports: [{ id: 'j', role: 'jev', provider: 'typesafe', input: { confirmed: false }, baselineDev: {}, split: {} }] })).toThrow('confirmed');
    expect(() => parseRealInput({ schemaVersion: 's36-real-eval/v1', reports: [{ id: 'j', role: 'jev', provider: 'anthropic', input: {} }] })).toThrow('provider');
    expect(() => parseRealInput({ schemaVersion: 's36-real-eval/v1', reports: [{ id: 'j', role: 'jev', provider: 'typesafe', input: { confirmed: true } }] })).toThrow('baselineDev');
    expect(parseRealInput({ schemaVersion: 's36-real-eval/v1', reports: [] }).reports).toEqual([]);
  });
  it('accepts deterministic uint32 fixture seeds only', () => {
    expect(fixtureArgs([])).toEqual({ seed: 36, out: 'fixtures/synthetic' });
    expect(() => fixtureArgs(['--seed', '-1'])).toThrow('integer');
    expect(() => fixtureArgs(['--seed', '4294967296'])).toThrow('integer');
  });
});

describe('evidence output directory safeguards (authored; not executed)', () => {
  const temporary: string[] = [];
  async function root() { const path = await mkdtemp(join(tmpdir(), 's36-evidence-test-')); temporary.push(path); return path; }
  // Cleanup owns only directories created by this test's mkdtemp, never repository evidence.
  afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

  it('accepts an existing results directory containing only its tracked .gitkeep', async () => {
    // what_bug_this_catches: the documented default fails with EEXIST before any evaluation.
    const output = join(await root(), 'results');
    await mkdir(output);
    await writeFile(join(output, '.gitkeep'), 'tracked marker\n', { flag: 'wx' });
    expect(await prepareEvidenceDirectory(output)).toBe(resolve(output));
    expect(await readFile(join(output, '.gitkeep'), 'utf8')).toBe('tracked marker\n');
    expect(await readdir(output)).toEqual(['.gitkeep']);
  });

  it('refuses previous evidence and preserves both original files unchanged', async () => {
    const output = await root();
    await writeFile(join(output, 'results.jsonl'), '{"original":true}\n', { flag: 'wx' });
    await writeFile(join(output, 'results.md'), '# Original evidence\n', { flag: 'wx' });
    await expect(prepareEvidenceDirectory(output)).rejects.toThrow('existing evidence');
    expect(await readFile(join(output, 'results.jsonl'), 'utf8')).toBe('{"original":true}\n');
    expect(await readFile(join(output, 'results.md'), 'utf8')).toBe('# Original evidence\n');
    expect((await readdir(output)).sort()).toEqual(['results.jsonl', 'results.md']);
  });

  it('creates a fresh output path and accepts an already empty directory', async () => {
    const output = join(await root(), 'fresh-run');
    expect(await prepareEvidenceDirectory(output)).toBe(resolve(output));
    expect(await readdir(output)).toEqual([]);
    expect(await prepareEvidenceDirectory(output)).toBe(resolve(output));
  });
});

describe('row-level report recomputation (authored; not executed)', () => {
  it('keeps absent judge roles and Jev gate explicitly unmeasured', async () => {
    // what_bug_this_catches: eval fills an absent real judge with a synthetic/default score.
    const result = await evaluateReal({ schemaVersion: 's36-real-eval/v1', reports: [] });
    expect(result.rows.filter((r) => r.kind === 'not-measured').map((r) => r.role)).toEqual(['generative-small', 'generative-large', 'jev']);
    expect(result.rows.find((r) => r.kind === 'jev-gate')).toMatchObject({ status: 'not measured' });
    expect(result.rows.find((r) => r.kind === 'judge-table')).toMatchObject({ rows: [] });
  });
  it('recomputes from supplied rows, preserving undefined modal kappa and unmeasured cost', async () => {
    // what_bug_this_catches: the script prints canned baseline/cost numbers instead of shared reports.
    const result = await evaluateReal({ schemaVersion: 's36-real-eval/v1', reports: [reportFixture()] });
    const row = result.rows.find((r) => r.kind === 'real-report');
    expect(row).toMatchObject({ report: { confirmed: true, modal: { kappa: { point: { kind: 'undefined' } } }, chosen: { cost: { per100AttemptedUsd: { kind: 'undefined' } } } }, probes: { status: 'not measured' } });
    expect(result.markdown).toContain('Human reference level:');
    expect(result.markdown).toContain('PAV remap (dev fit)');
  });
  it('refuses heldout leakage, changed dev provenance and fabricated frozen population pins', async () => {
    // what_bug_this_catches: caller-supplied fits/confirmation bypass dev-only learning and frozen set checks.
    const wrongFit = reportFixture();
    wrongFit.input.fits.devInputHash = 'invented';
    await expect(evaluateReal({ schemaVersion: 's36-real-eval/v1', reports: [wrongFit] })).rejects.toThrow('fits differ');
    const changedHash = reportFixture();
    changedHash.input.pins.annotationHash = 'invented';
    changedHash.input.current.annotationHash = 'invented';
    await expect(evaluateReal({ schemaVersion: 's36-real-eval/v1', reports: [changedHash] })).rejects.toThrow('annotation hash');
    const leaked = reportFixture();
    leaked.input.items = [leaked.baselineDev.items[0]!, ...leaked.input.items.slice(1)];
    await expect(evaluateReal({ schemaVersion: 's36-real-eval/v1', reports: [leaked] })).rejects.toThrow('overlap');
  });
  it('refuses valid changed labels or displayed scales in optional chosen diagnostics', async () => {
    // what_bug_this_catches: chosen dev diagnostics contradict the frozen labels/scale beside a pinned report.
    const relabelled = reportFixture();
    relabelled.dev = structuredClone(relabelled.baselineDev);
    relabelled.dev.annotations[0]!.score = (relabelled.dev.annotations[0]!.score + 1) % relabelled.dev.k;
    await expect(evaluateReal({ schemaVersion: 's36-real-eval/v1', reports: [relabelled] })).rejects.toThrow('chosen dev annotations');
    const rescaled = reportFixture();
    rescaled.dev = structuredClone(rescaled.baselineDev);
    rescaled.dev.scale.levels = rescaled.dev.scale.levels.map((level) => ({ ...level, value: level.value + 10 }));
    await expect(evaluateReal({ schemaVersion: 's36-real-eval/v1', reports: [rescaled] })).rejects.toThrow('chosen dev scales');
    const levelCount = reportFixture();
    levelCount.dev = structuredClone(levelCount.baselineDev);
    levelCount.dev.k--;
    await expect(evaluateReal({ schemaVersion: 's36-real-eval/v1', reports: [levelCount] })).rejects.toThrow('chosen dev level counts');
  });
  it('requires the complete dev key population and unchanged groups', async () => {
    const regrouped = reportFixture();
    regrouped.dev = structuredClone(regrouped.baselineDev);
    regrouped.dev.items[0]!.groupId = 'changed-group';
    await expect(evaluateReal({ schemaVersion: 's36-real-eval/v1', reports: [regrouped] })).rejects.toThrow('items/content/groups');
    const subset = reportFixture();
    subset.dev = structuredClone(subset.baselineDev);
    const removed = subset.dev.devKeys[0]!;
    subset.dev.devKeys = subset.dev.devKeys.filter((key) => key !== removed);
    subset.dev.items = subset.dev.items.filter((item) => item.key !== removed);
    subset.dev.annotations = subset.dev.annotations.filter((a) => a.itemKey !== removed);
    subset.dev.verdicts = subset.dev.verdicts.filter((v) => v.itemKey !== removed);
    await expect(evaluateReal({ schemaVersion: 's36-real-eval/v1', reports: [subset] })).rejects.toThrow('chosen dev key universes');
  });
  it('allows chosen verdicts and run identity to differ while reordered frozen gold stays identical', async () => {
    const entry = reportFixture();
    entry.dev = structuredClone(entry.baselineDev);
    entry.dev.runId = 'chosen-dev-test';
    entry.dev.verdicts = entry.dev.verdicts.map((v) => ({ ...v, runId: entry.dev!.runId, score: Math.min((v.score ?? 0) + 1, entry.dev!.k - 1) })).reverse();
    entry.dev.devKeys = [...entry.dev.devKeys].reverse();
    entry.dev.items = [...entry.dev.items].reverse();
    entry.dev.annotations = [...entry.dev.annotations].reverse();
    const result = await evaluateReal({ schemaVersion: 's36-real-eval/v1', reports: [entry] });
    expect(result.rows.find((row) => row.kind === 'real-report')).toMatchObject({ diagnostics: { runId: 'chosen-dev-test', split: 'dev' } });
  });
});

describe('download-only destination safeguards (no network in these cases)', () => {
  it('refuses private, metadata, mapped, reserved and documentation IP addresses', () => {
    // what_bug_this_catches: explicit URL/download source becomes an SSRF path into host services.
    for (const address of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.0.1', '100.100.100.200', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1']) expect(isPublicIPv4(address)).toBe(false);
    expect(isPublicIPv4('8.8.8.8')).toBe(true);
    expect(isPublicIPv4('1.1.1.1')).toBe(true);
  });
  it('requires explicit licensing acknowledgement and safe HTTPS URL', () => {
    const args = (url: string) => ['--url', url, '--dest', 'download.jsonl', '--license-ack', LICENSE_ACK];
    for (const url of ['http://example.com/file', 'https://localhost/file', 'https://169.254.169.254/latest', 'https://user:pass@example.com/file', 'https://example.com:8443/file', 'https://[::1]/file', 'https://example.com/file#fragment']) expect(() => downloadArgs(args(url))).toThrow();
    expect(() => downloadArgs(['--url', 'https://example.com/file', '--dest', 'x'])).toThrow('acknowledgement');
    expect(downloadArgs(args('https://example.com/file')).url.protocol).toBe('https:');
  });
});
