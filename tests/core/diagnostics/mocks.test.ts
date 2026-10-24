import { describe, expect, it } from 'vitest';
import type { MockDefect } from '../../../src/core/types.ts';
import { generateSyntheticSet } from '../../../src/core/fixtures/synthetic.ts';
import { createMockJudge, createReplayJudge } from '../../../src/core/judge/mock.ts';
import { scoreAll } from '../../../src/core/judge/judge.ts';
import { createRubric } from '../../../src/core/rubric/rubric.ts';
import { importProbeSets } from '../../../src/core/goldset/probesets.ts';
import { unwrap } from '../../../src/core/result.ts';
import { runRepeatability } from '../../../src/core/probes/repeatability.ts';
import { runVerbosity } from '../../../src/core/probes/verbosity.ts';
import { runScaleOrder } from '../../../src/core/probes/scaleOrder.ts';
import { runInjection } from '../../../src/core/probes/injection.ts';
import { diagnose, makeDevResults, type DevInput } from '../../../src/core/diagnostics/findings.ts';
import { generateSuggestions, SUGGESTION_TEMPLATES } from '../../../src/core/diagnostics/suggestions.ts';

const synthetic = generateSyntheticSet(36);
const rubric = unwrap(createRubric({ setId: 's', ...synthetic.rubricV1 }, synthetic.scale));
const items = synthetic.items.map((i) => ({ ...i, split: 'dev' as const }));
const annotations = synthetic.items.flatMap((i) => ['a', 'b'].map((annotatorId) => ({ itemKey: i.key, annotatorId, score: synthetic.truth[i.key]! })));
const probeSets = unwrap(importProbeSets(synthetic.probeFiles));
const options = { split: 'dev' as const, runId: 'dev', seed: 36, truth: synthetic.truth, bootstrap: { resamples: 99 } };
const context = { ...options, replicate: 0, presentation: 'ascending' as const, lengthReference: { kind: 'dev_median' as const, words: 10 } };

async function evidence(defect: MockDefect) {
  const judge = createMockJudge(defect);
  const verdicts = await scoreAll(judge, items, rubric, context);
  const probes = {
    repeatability: await runRepeatability(judge, items, rubric, options),
    verbosity: await runVerbosity(judge, probeSets.pairs.map((p) => ({ ...p, split: 'probe' as const })), rubric, options),
    scaleOrder: await runScaleOrder(judge, items, rubric, options),
    injection: await runInjection(judge, probeSets.injections.map((i) => ({ ...i, split: 'probe' as const })), rubric, options),
  };
  const input = makeDevResults({ split: 'dev', runId: 'dev', devKeys: items.map((i) => i.key), items, annotations, verdicts, k: 5, scale: synthetic.scale, probes });
  return { input, diagnostics: diagnose(input, { seed: 36, resamples: 99 }) };
}

describe('single-seed planted-defect detection (authored; execution deferred)', () => {
  const cases = [
    ['lenient', 'leniency'], ['verbosity', 'verbosity'], ['merges-3-4', 'adjacent_confusion'],
    ['flip-flop', 'instability'], ['order-sensitive', 'scale_order'], ['injection', 'injection'], ['constant', 'adjacent_confusion'],
  ] as const;
  for (const [defect, template] of cases) it(`${defect} is flagged by ${template}`, async () => {
    // what_bug_this_catches: mocks exist but their corresponding diagnostic has no detector.
    const { input, diagnostics } = await evidence(defect);
    const suggestions = generateSuggestions(input, diagnostics).suggestions;
    expect(suggestions.some((s) => s.template === template)).toBe(true);
    expect(suggestions.every((s) => s.itemKeys.length <= 5 && s.fields.length > 0 && s.inputHash === input.inputHash)).toBe(true);
  });
  it('clean is unflagged across every mock-defect detector', async () => {
    const { input, diagnostics } = await evidence('clean');
    expect(diagnostics.findings).toEqual([]);
    expect(generateSuggestions(input, diagnostics).suggestions).toEqual([]);
  });
  it('merge suggestion names displayed rubric values 3 and 4', async () => {
    const { input, diagnostics } = await evidence('merges-3-4');
    const s = generateSuggestions(input, diagnostics).suggestions.find((s) => s.template === 'adjacent_confusion')!;
    expect(s.fields).toEqual(['levels[3].description', 'levels[4].description']);
    expect(s.message).toContain('human-level-4');
  });
});

describe('dev boundary and suggestion identity', () => {
  it('has precisely the seven templates', () => expect(SUGGESTION_TEMPLATES).toHaveLength(7));
  it('rejects held-out top-level input, rows and unbranded evidence', async () => {
    const { input } = await evidence('clean');
    expect(() => makeDevResults({ ...input, split: 'heldout' } as unknown as DevInput)).toThrow('dev');
    expect(() => makeDevResults({ ...input, verdicts: [{ ...input.verdicts[0]!, itemKey: 'heldout-key' }] })).toThrow('non-dev');
    expect(() => makeDevResults({ ...input, items: [{ ...items[0]!, split: 'heldout' }, ...items.slice(1)] } as unknown as DevInput)).toThrow('held-out');
    expect(() => diagnose({ ...JSON.parse(JSON.stringify(input)) })).toThrow('unbranded');
  });
  it('notice replaces suggestion for undefined statistics', async () => {
    const { input } = await evidence('clean');
    const empty = makeDevResults({ split: 'dev', runId: 'empty', devKeys: [], items: [], annotations: [], verdicts: [], k: 5, scale: synthetic.scale });
    const out = generateSuggestions(empty);
    expect(out.suggestions).toEqual([]);
    expect(out.notices.join(' ')).toContain('insufficient data');
    const d = diagnose(input, { seed: 36, resamples: 99 });
    expect(() => generateSuggestions(input, { ...d, inputHash: 'stale' })).toThrow('not this dev run');
  });
  it('unusable output gets its own reason-coded template', async () => {
    const verdicts = await scoreAll(createReplayJudge(Object.fromEntries(items.map((i) => [i.key, '{bad']))), items, rubric, context);
    const input = makeDevResults({ split: 'dev', runId: 'dev', devKeys: items.map((i) => i.key), items, annotations, verdicts, k: 5, scale: synthetic.scale });
    const d = diagnose(input, { seed: 36, resamples: 99 });
    const a = generateSuggestions(input, d);
    expect(a.suggestions.map((s) => s.template)).toEqual(['unusable']);
    expect(d.unusableReasons.malformed_json).toBe(items.length);
    expect(generateSuggestions(input, d)).toEqual(a);
    expect(a.suggestions[0]!.fields).toEqual(['instructions']);
  });
  it('worst dev items are ranked by absolute judge-minus-mean-human error', async () => {
    const { input, diagnostics } = await evidence('lenient');
    const suggestion = generateSuggestions(input, diagnostics).suggestions.find((s) => s.template === 'leniency')!;
    expect(suggestion.itemKeys).toEqual(items.filter((i) => synthetic.truth[i.key]! < 4).map((i) => i.key).sort().slice(0, 5));
  });
});
