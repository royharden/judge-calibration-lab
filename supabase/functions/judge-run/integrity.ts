import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.47.10';
import type { JudgeConfig, Verdict } from './_core/core/types.ts';
import { canonicalHash } from './_core/core/canonical.ts';
import { annotationHashOf, contentHashOf, fingerprintMap } from './_core/core/goldset/fingerprint.ts';
import { computeSplit } from './_core/core/goldset/split.ts';
import { rubricContentHash } from './_core/core/rubric/rubric.ts';
import { devResultHash } from './_core/core/diagnostics/findings.ts';
import { computeDevFits } from './_core/core/report/fits.ts';
import { scaleHash } from './_core/core/heldoutlock/policy.ts';
import { policyHash, S36_V1 } from './_core/core/heldoutlock/policyConst.ts';
import { assembleBeforeAfter } from './_core/core/report/beforeAfter.ts';
import type { ReportBundle, SetBundle } from './contracts.ts';
import { ApiFault, rpc } from './runtime.ts';

export function verifyFrozen(bundle: SetBundle) {
  const set = bundle.set;
  if (!set.frozen || !set.split) throw new ApiFault('prerequisite_missing', 'set must be frozen');
  const fingerprints = fingerprintMap(set.items);
  const contentHash = contentHashOf(set.items.map((i) => fingerprints[i.key]!));
  const annotationHash = annotationHashOf(bundle.annotations, fingerprints);
  if (contentHash !== set.contentHash || annotationHash !== set.annotationHash) throw new ApiFault('prereg_mismatch', 'stored content/annotation hashes do not match recomputed rows');
  const split = computeSplit({ items: set.items, annotations: bundle.annotations, seed: set.split.seed, heldoutFraction: set.split.heldoutFraction });
  if (!split.ok) throw new ApiFault('prereg_mismatch', split.error.message);
  // Verify manifest membership as well as its hash, including renamed/reordered imports.
  const heldoutFingerprintHash = canonicalHash(set.items.filter((i) => set.split!.heldout.includes(i.key)).map((i) => fingerprints[i.key]!).sort());
  const expectedHeldoutHash = canonicalHash(split.value.manifest.heldout.map((key) => fingerprints[key]!).sort());
  const all = new Set([...set.split.dev, ...set.split.heldout]);
  if (all.size !== set.items.length || set.split.dev.some((key) => set.split!.heldout.includes(key)) || set.items.some((i) => !all.has(i.key)) || heldoutFingerprintHash !== expectedHeldoutHash || split.value.manifest.splitHash !== set.split.splitHash) throw new ApiFault('prereg_mismatch', 'frozen split membership is invalid');
  for (const rubric of bundle.rubrics) if (rubricContentHash(rubric) !== rubric.contentHash) throw new ApiFault('prereg_mismatch', 'rubric hash does not match stored content');
  for (const config of bundle.judgeConfigs) if (configHash(config) !== config.configHash) throw new ApiFault('prereg_mismatch', 'judge config hash does not match stored content');
  return { contentHash, annotationHash, splitHash: split.value.manifest.splitHash, scaleHash: scaleHash(set.scale) };
}
export function configHash(config: JudgeConfig): string {
  return canonicalHash({ provider: config.provider, model: config.model, params: config.params, promptTemplateVersion: config.promptTemplateVersion, outputSchemaVersion: config.outputSchemaVersion, scoreReadout: config.scoreReadout, levelMapVersion: config.levelMapVersion });
}
function fit(set: SetBundle['set'], rows: Verdict[]) {
  const dev = new Set(set.split!.dev);
  const result = computeDevFits({ devItems: set.items.filter((i) => dev.has(i.key)), devKeys: set.split!.dev, devAnnotations: set.devAnnotations, baselineVerdicts: rows, k: set.scale.levels.length });
  if (!result.ok) throw new ApiFault('prerequisite_missing', result.error.message);
  return result.value;
}
export async function preregisterAction(client: SupabaseClient, owner: string, body: Record<string, unknown>) {
  const bundle = await rpc<SetBundle>(client, 'server_set_bundle', { setId: body.set_id });
  const hashes = verifyFrozen(bundle);
  const baseline = bundle.rubrics.find((r) => r.id === body.baseline_rubric_id);
  const chosen = bundle.rubrics.find((r) => r.id === body.chosen_rubric_id);
  const config = bundle.judgeConfigs.find((c) => c.id === body.judge_config_id);
  if (!baseline || !chosen || !config || baseline.setId !== bundle.set.id || chosen.setId !== bundle.set.id) throw new ApiFault('forbidden', 'rubrics and judge must belong to the owned set/run scope');
  const dev = bundle.runs.filter((r) => r.split === 'dev' && r.status === 'complete' && r.rubricHash === baseline.contentHash && r.judgeConfigHash === config.configHash).sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '') || b.id.localeCompare(a.id))[0];
  if (!dev) throw new ApiFault('prerequisite_missing', 'complete the baseline dev run first');
  const rows = bundle.verdicts.filter((v) => v.runId === dev.id);
  if (devResultHash(rows) !== dev.resultHash) throw new ApiFault('prereg_mismatch', 'baseline dev result hash differs from its stored rows');
  const fits = fit(bundle.set, rows);
  const pins = { owner, setId: bundle.set.id, ...hashes, baselineRubricHash: baseline.contentHash, chosenRubricHash: chosen.contentHash, judgeConfigHash: config.configHash,
    policyVersion: S36_V1.version, policyHash, algorithmVersions: S36_V1.algorithmVersions, bootstrap: { seed: 36, resamples: 2000 }, fitHashes: fits.hashes, baselineDevRunId: dev.id };
  const prereg = await rpc<ReportBundle['prereg']>(client, 'preregister', { owner, setId: bundle.set.id, judgeConfigId: config.id, baselineRubricId: baseline.id, chosenRubricId: chosen.id, baselineDevRunId: dev.id, pins, requestId: body.request_id });
  return { prereg_id: prereg.id, scope_hash: prereg.scopeKey, fit_hashes: pins.fitHashes, policy_version: pins.policyVersion };
}
async function reportRows(client: SupabaseClient, source: ReportBundle['baseline'], target: ReportBundle['set']): Promise<Verdict[]> {
  if (source.run.setId === target.id) return source.verdicts;
  const original = await rpc<SetBundle>(client, 'server_set_bundle', { setId: source.run.setId });
  const originals = new Map(original.set.items.map((i) => [i.key, i]));
  const fingerprints = fingerprintMap(target.items);
  const buckets = new Map<string, string[]>();
  for (const key of [...target.split!.heldout].sort()) { const list = buckets.get(fingerprints[key]!) ?? []; list.push(key); buckets.set(fingerprints[key]!, list); }
  return [...source.verdicts].sort((a, b) => a.itemKey.localeCompare(b.itemKey)).map((v) => {
    const item = originals.get(v.itemKey); if (!item) throw new ApiFault('prereg_mismatch', 'reused verdict item missing');
    const fp = fingerprintMap([item])[item.key]!;
    const key = buckets.get(fp)?.shift(); if (!key) throw new ApiFault('prereg_mismatch', 'reused run differs from frozen split');
    return { ...v, itemKey: key };
  });
}
export async function reportAction(client: SupabaseClient, preregId: string) {
  const b = await rpc<ReportBundle>(client, 'heldout_report_rows', { preregId });
  if (b.baseline.run.status !== 'complete' || b.chosen.run.status !== 'complete') throw new ApiFault('prerequisite_missing', 'both held-out runs must be complete');
  const hashes = verifyFrozen({ set: b.set, annotations: [...b.set.devAnnotations, ...b.annotations], rubrics: b.rubrics, judgeConfigs: b.judgeConfigs, runs: [], verdicts: [] });
  const config = b.judgeConfigs.find((c) => c.configHash === b.prereg.pins.judgeConfigHash);
  if (!config) throw new ApiFault('prereg_mismatch', 'pinned judge config missing');
  const fits = fit(b.set, b.baselineDev.verdicts);
  const heldout = new Set(b.set.split!.heldout);
  return assembleBeforeAfter({ confirmed: true, preregId, pins: b.prereg.pins, current: { contentHash: hashes.contentHash, annotationHash: hashes.annotationHash, splitHash: hashes.splitHash,
    judgeConfigHash: configHash(config), baselineRubricHash: b.baseline.run.rubricHash, chosenRubricHash: b.chosen.run.rubricHash }, judgeName: config.model, scale: b.set.scale,
    items: b.set.items.filter((i) => heldout.has(i.key)), annotations: b.annotations, baselineVerdicts: await reportRows(client, b.baseline, b.set), chosenVerdicts: await reportRows(client, b.chosen, b.set),
    fits, contamination: b.contamination, lineage: b.lineage, baselineCost: b.baselineCost, chosenCost: b.chosenCost });
}
