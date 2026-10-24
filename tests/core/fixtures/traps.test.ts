import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  annotatorTiesVariant,
  CONSTANT_JUDGE_TRAP,
  IMPORT_TRAP_ANNOTATOR_A_CSV,
  IMPORT_TRAP_ANNOTATOR_B_CSV,
  IMPORT_TRAP_ITEMS_JSONL,
  IMPORT_TRAP_MANIFEST_JSON,
  INJECTED_ANSWERS,
  INJECTED_ANSWERS_JSONL,
  MALFORMED_JUDGE_OUTPUTS,
  n12Subset,
  PADDED_PAIR_JSONL,
  randomAnnotatorVariant,
  THIRD_VERSION_SCENARIO,
} from '../../../src/core/fixtures/traps.ts';
import { generateSyntheticSet, SYNTHETIC_RUBRIC_V1 } from '../../../src/core/fixtures/synthetic.ts';
import { consensusByItem, qwk, referenceCeiling } from '../../../src/core/judgestats/index.ts';
import { mockScoreSync } from '../../../src/core/judge/mock.ts';
import { createRubric } from '../../../src/core/rubric/rubric.ts';
import { unwrap } from '../../../src/core/result.ts';

const ROOT = new URL('../../../fixtures/traps/', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, ROOT), 'utf8').replace(/\r\n/g, '\n');

const syn = generateSyntheticSet(36);

describe('hand-written trap files equal the runtime constants', () => {
  it('import trap set', () => {
    expect(read('import-trap/items.jsonl')).toBe(IMPORT_TRAP_ITEMS_JSONL);
    expect(read('import-trap/manifest.json')).toBe(IMPORT_TRAP_MANIFEST_JSON);
    expect(read('import-trap/annotator-a.csv')).toBe(IMPORT_TRAP_ANNOTATOR_A_CSV);
    expect(read('import-trap/annotator-b.csv')).toBe(IMPORT_TRAP_ANNOTATOR_B_CSV);
  });

  it('padded pair, injected answers, malformed outputs, third-version scenario', () => {
    expect(read('padded-pair.jsonl')).toBe(PADDED_PAIR_JSONL);
    expect(read('injected-answers.jsonl')).toBe(INJECTED_ANSWERS_JSONL);
    expect(JSON.parse(read('malformed-judge-outputs.json'))).toEqual(MALFORMED_JUDGE_OUTPUTS);
    expect(JSON.parse(read('third-version-scenario.json'))).toEqual(THIRD_VERSION_SCENARIO);
  });
});

describe('derived traps', () => {
  it('n = 12 subset has 12 items, their labels and truth', () => {
    const s = n12Subset(syn);
    expect(s.items).toHaveLength(12);
    expect(new Set(s.annotations.map((a) => a.itemKey)).size).toBe(12);
    expect(s.annotations).toHaveLength(60);
    expect(Object.keys(s.truth)).toHaveLength(12);
  });

  it('truth maps preserve prototype-named item ids through a derived subset', () => {
    expect(Object.getPrototypeOf(syn.truth)).toBeNull();
    const ids = ['__proto__', 'constructor', 'toString'];
    const items = syn.items.slice(0, 3).map((item, i) => ({ ...item, key: ids[i]! }));
    const truth = Object.fromEntries(ids.map((id, i) => [id, i]));
    const subset = n12Subset({ ...syn, items, annotations: [], truth });
    expect(Object.getPrototypeOf(subset.truth)).toBeNull();
    expect(Object.keys(subset.truth).sort()).toEqual([...ids].sort());
    for (const [i, id] of ids.entries()) expect(subset.truth[id]).toBe(i);
  });

  it('one random annotator lowers the human reference level', () => {
    const base = referenceCeiling(syn.annotations, 5).value;
    const noisy = referenceCeiling(randomAnnotatorVariant(syn), 5).value;
    expect(base.kind === 'value' && noisy.kind === 'value' && noisy.value < base.value).toBe(true);
    expect(randomAnnotatorVariant(syn)).toEqual(randomAnnotatorVariant(syn));
  });

  it('annotator ties variant plants consensus ties on the chosen items', () => {
    const { annotations, tieKeys } = annotatorTiesVariant(syn, 10);
    expect(tieKeys).toHaveLength(10);
    expect(new Set(annotations.map((a) => a.annotatorId))).toEqual(new Set(['ann-1', 'ann-2', 'ann-3', 'ann-4']));
    const c = consensusByItem(annotations);
    for (const k of tieKeys) expect(c.ties).toContain(k);
  });

  it('constant judge trap: kappa is undefined, never 0', () => {
    const rubric = unwrap(createRubric({ setId: 's', ...SYNTHETIC_RUBRIC_V1 }, syn.scale));
    const ctx = { runId: 'r', replicate: 0, presentation: 'ascending' as const, seed: 36, split: 'dev' as const, truth: syn.truth };
    const judge = syn.items.map((it) => {
      const r = mockScoreSync(CONSTANT_JUDGE_TRAP.defect, it, rubric, ctx);
      return r.kind === 'score' ? r.score : -1;
    });
    const ann1 = syn.items.map((it) => syn.annotations.find((a) => a.annotatorId === 'ann-1' && a.itemKey === it.key)!.score);
    const k = qwk(judge, ann1, 5);
    expect(k.kind).toBe(CONSTANT_JUDGE_TRAP.expectKappa);
  });

  it('injected answers all carry the marker; malformed table covers every parser reason code', () => {
    for (const a of INJECTED_ANSWERS) expect(a.answer).toContain('[[fixture:inject-top-score]]');
    const reasons = new Set(MALFORMED_JUDGE_OUTPUTS.flatMap((c) => ('unusable' in c.expect ? [c.expect.unusable] : [])));
    expect([...reasons].sort()).toEqual(['empty', 'extra_keys', 'malformed_json', 'missing_score', 'non_integer', 'out_of_scale']);
  });

  it('third-version scenario: refused look on v3, burn, then contaminated', () => {
    const steps = THIRD_VERSION_SCENARIO.steps;
    expect(steps.some((s) => s.op === 'request_look' && s.expect === 'refused' && s.reason === 'heldout_exhausted')).toBe(true);
    const burnAt = steps.findIndex((s) => s.op === 'burn');
    expect(burnAt).toBeGreaterThan(0);
    expect(steps[steps.length - 1]).toEqual({ op: 'report_status', expect: 'contaminated' });
  });
});
