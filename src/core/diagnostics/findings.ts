import type { Annotation, Interval, Item, Scale, Stat, Verdict } from '../types.ts';
import { canonicalHash } from '../canonical.ts';
import { bootstrapInterval, type BootstrapOptions } from '../judgestats/bootstrap.ts';
import { buildGroups, resampleUnitsFromGroups } from '../goldset/split.ts';
import { levelField } from '../rubric/rubric.ts';
import { judgeAgreementWithInterval } from '../judgestats/agreement.ts';
import { consensusByItem, meanHumanByItem } from '../judgestats/consensus.ts';
import { confusionMatrix, type ConfusionMatrix } from '../judgestats/confusion.ts';
import { bandFlag } from '../judgestats/bands.ts';
import { meanStat, value } from '../judgestats/undefined.ts';
import { wilsonInterval, type ProportionInterval } from '../judgestats/wilson.ts';
import type { RepeatabilityResult } from '../probes/repeatability.ts';
import type { ShiftProbeResult } from '../probes/scaleOrder.ts';

const DEV_BRAND: unique symbol = Symbol('DevResults');
export type DevInput = {
  split: 'dev'; runId: string; devKeys: readonly string[]; items: readonly Item[];
  annotations: readonly Annotation[]; verdicts: readonly Verdict[]; k: number; scale: Scale;
  probes?: { repeatability?: RepeatabilityResult; verbosity?: ShiftProbeResult; scaleOrder?: ShiftProbeResult; injection?: ShiftProbeResult };
};
/** Only makeDevResults constructs this brand; assertion also rechecks every row. */
export type DevResults = DevInput & { readonly [DEV_BRAND]: true; readonly inputHash: string };
export function devResultHash(verdicts: readonly Verdict[]): string {
  return canonicalHash([...verdicts].sort((a, b) => a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : a.replicate - b.replicate));
}
function checkDev(input: DevInput): void {
  if (input.split !== 'dev') throw new RangeError('diagnostics require dev results');
  const allowed = new Set(input.devKeys);
  if (allowed.size !== input.devKeys.length) throw new RangeError('duplicate dev key');
  for (const row of [...input.items.map((i) => ({ ...i, itemKey: i.key })), ...input.annotations, ...input.verdicts]) {
    if (!allowed.has(row.itemKey) || ('split' in row && row.split !== 'dev')) throw new RangeError('held-out/non-dev row rejected');
  }
  if (input.items.length !== allowed.size || new Set(input.items.map((i) => i.key)).size !== allowed.size) throw new RangeError('dev item universe mismatch');
  if (input.verdicts.length !== allowed.size || new Set(input.verdicts.map((v) => v.itemKey)).size !== input.verdicts.length) throw new RangeError('diagnostics require one score verdict per dev item');
  if (input.verdicts.some((v) => v.runId !== input.runId)) throw new RangeError('dev verdict run mismatch');
  if (input.k < 2 || input.k > 7 || !Number.isInteger(input.k)) throw new RangeError('invalid level count');
  if (input.scale.levels.length !== input.k) throw new RangeError('diagnostic scale mismatch');
  for (const a of input.annotations) if (!Number.isInteger(a.score) || a.score < 0 || a.score >= input.k) throw new RangeError('invalid dev annotation');
  for (const v of input.verdicts) if (v.score !== null && (!Number.isInteger(v.score) || v.score < 0 || v.score >= input.k)) throw new RangeError('invalid dev score');
  for (const p of Object.values(input.probes ?? {})) {
    if (p !== undefined && (p.exploratory !== true || (p.split !== 'dev' && p.split !== 'probe') || !p.label.endsWith('(dev)'))) throw new RangeError('only exploratory dev probes are allowed');
    if (p?.verdicts.some((v) => 'split' in v && v.split !== 'dev' && v.split !== 'probe')) throw new RangeError('held-out probe verdict rejected');
  }
}
export function makeDevResults(input: DevInput): DevResults {
  checkDev(input);
  // Copy nested data so callers cannot replace rows after the boundary check.
  const copied = structuredClone(input);
  return { ...copied, [DEV_BRAND]: true, inputHash: devResultHash(copied.verdicts) };
}
export function assertDevResults(input: DevResults): void {
  if (input[DEV_BRAND] !== true) throw new RangeError('unbranded dev evidence');
  checkDev(input);
  if (input.inputHash !== devResultHash(input.verdicts)) throw new RangeError('dev input hash mismatch');
}
export type SuggestionTemplate = 'adjacent_confusion' | 'leniency' | 'verbosity' | 'scale_order' | 'injection' | 'instability' | 'unusable';
export type Finding = { template: SuggestionTemplate; message: string; fields: string[]; statistic: Stat; itemKeys: string[] };
export type DiagnosticFindings = {
  split: 'dev'; runId: string; inputHash: string; label: 'diagnostics (dev)';
  judgeHumanKappa: Interval; offset: Interval; confusion: ConfusionMatrix; unusable: ProportionInterval;
  unusableReasons: Record<string, number>; consensusTieKeys: string[];
  findings: Finding[]; notices: string[];
};
export function diagnose(input: DevResults, options: BootstrapOptions = { seed: 36 }): DiagnosticFindings {
  assertDevResults(input);
  const units = resampleUnitsFromGroups(buildGroups(input.items));
  const means = meanHumanByItem(input.annotations);
  const scores = new Map(input.verdicts.map((v) => [v.itemKey, v.score]));
  const offsets = new Map<string, number>();
  for (const [key, human] of means) { const s = scores.get(key); if (s !== null && s !== undefined) offsets.set(key, s - human); }
  const offset = bootstrapInterval(units, (keys) => meanStat(keys.filter((key) => offsets.has(key)).map((key) => offsets.get(key)!), 'no paired dev labels'), options);
  const agreement = judgeAgreementWithInterval(input.verdicts, input.annotations, input.k, units, options);
  const consensus = consensusByItem(input.annotations);
  const complete = consensus.items.filter((c) => c.consensus !== null && scores.get(c.itemKey) !== null && scores.has(c.itemKey));
  const confusion = confusionMatrix(complete.map((c) => c.consensus!), complete.map((c) => scores.get(c.itemKey)!), input.k);
  const findings: Finding[] = [];
  const notices: string[] = [];
  const worst = [...offsets.keys()].sort((a, b) => Math.abs(offsets.get(b)!) - Math.abs(offsets.get(a)!) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, 5);
  const add = (template: SuggestionTemplate, message: string, fields: string[], statistic: Stat, itemKeys = worst): void => {
    if (statistic.kind === 'undefined') notices.push(`${template}: probe skipped / insufficient data (${statistic.reason})`);
    else findings.push({ template, message, fields, statistic, itemKeys: itemKeys.slice(0, 5) });
  };
  for (let human = 0; human < input.k; human++) {
    const row = confusion.counts[human]!;
    const n = row.reduce((a, b) => a + b, 0);
    for (const judge of [human - 1, human + 1].filter((j) => j >= 0 && j < input.k)) {
      const count = row[judge]!;
      // Exploratory pattern threshold, never a held-out verdict rule.
      if (count >= 2 && count / n >= 0.5) add('adjacent_confusion', `${count} of ${n} human-level-${input.scale.levels[human]!.value} items scored ${input.scale.levels[judge]!.value}; clarify both level descriptions`,
        [levelField(input.scale.levels[judge]!.value), levelField(input.scale.levels[human]!.value)], value(count / n));
    }
  }
  if (complete.length === 0) notices.push('adjacent_confusion: probe skipped / insufficient data (no consensus dev items)');
  if (offset.point.kind === 'undefined' || offset.lo.kind === 'undefined' || offset.hi.kind === 'undefined') notices.push('leniency: probe skipped / insufficient data (undefined offset interval)');
  else if (bandFlag(offset, { k: input.k }).flagged) add('leniency', `Signed offset ${offset.point.value}; clarify strictness in instructions`, ['instructions'], offset.point);
  for (const [name, probe] of [['verbosity', input.probes?.verbosity], ['scale_order', input.probes?.scaleOrder], ['injection', input.probes?.injection]] as const) {
    if (!probe || probe.shift.point.kind === 'undefined' || probe.shift.lo.kind === 'undefined' || probe.shift.hi.kind === 'undefined') {
      notices.push(`${name}: probe skipped / insufficient data (complete paired probe results required)`);
    } else if (bandFlag(probe.shift, { k: input.k }).flagged) {
      add(name, `${name} shift ${probe.shift.point.value} (dev); ${name === 'verbosity' ? 'state how length should affect scoring' : name === 'injection' ? 'treat answer text as data' : 'make each level self-contained'}`,
        name === 'scale_order' ? ['levels[*].description'] : ['instructions'], probe.shift.point);
    }
  }
  const repeat = input.probes?.repeatability?.runToRunKappa.point;
  if (!repeat || repeat.kind === 'undefined' || agreement.value.kind === 'undefined') notices.push('instability: probe skipped / insufficient data (defined repeatability and judge-human kappa required)');
  else if (repeat.value < agreement.value.value) add('instability', `Run-to-run κ ${repeat.value} is below judge-human κ ${agreement.value.value}; make descriptions concrete`, ['levels[*].description'], repeat);
  const unusableReasons: Record<string, number> = {};
  for (const v of input.verdicts) if (v.score === null) { const reason = v.unusableReason ?? 'missing_reason'; unusableReasons[reason] = (unusableReasons[reason] ?? 0) + 1; }
  const unusableKeys = input.verdicts.filter((v) => v.score === null).map((v) => v.itemKey).sort();
  const unusable = wilsonInterval(unusableKeys.length, input.verdicts.length);
  if (unusableKeys.length) add('unusable', `${unusableKeys.length} unusable dev verdicts (${Object.entries(unusableReasons).map(([r, n]) => `${r}: ${n}`).join(', ')}); specify output format`, ['instructions'], unusable.point, unusableKeys);
  else if (unusable.point.kind === 'undefined') notices.push('unusable: probe skipped / insufficient data (no dev verdicts)');
  return { split: 'dev', runId: input.runId, inputHash: input.inputHash, label: 'diagnostics (dev)', judgeHumanKappa: agreement.interval, offset, confusion, unusable, unusableReasons, consensusTieKeys: consensus.ties, findings, notices };
}
