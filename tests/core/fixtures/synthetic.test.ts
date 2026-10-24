import { describe, expect, it } from 'vitest';
import {
  ANNOTATOR_NOISE,
  generateSyntheticSet,
  SYNTHETIC_COUNTS,
  SYNTHETIC_RUBRIC_V1,
  syntheticRubricV2Edits,
  TRAP_PAIR_ID,
} from '../../../src/core/fixtures/synthetic.ts';
import { pairCheck } from '../../../src/core/probes/pairCheck.ts';
import { importGoldSet } from '../../../src/core/goldset/import.ts';
import { fingerprintItem } from '../../../src/core/goldset/fingerprint.ts';
import { injectionItemKeys, pairItemKeys } from '../../../src/core/goldset/probesets.ts';
import { INJECTION_MARKER, MERGE_FIX_MARKER } from '../../../src/core/judge/mock.ts';
import { referenceCeiling } from '../../../src/core/judgestats/index.ts';

const syn = generateSyntheticSet();

describe('generateSyntheticSet', () => {
  it('defaults to seed 36 and is deterministic', () => {
    expect(syn.seed).toBe(36);
    expect(generateSyntheticSet(36)).toEqual(syn);
  });

  it('a different seed gives a different set', () => {
    const other = generateSyntheticSet(37);
    expect(other.items.map((i) => i.answer)).not.toEqual(syn.items.map((i) => i.answer));
    expect(other.annotations).not.toEqual(syn.annotations);
  });

  it('has 120 distinct items, 24 per planted level, on a 1-5 scale', () => {
    expect(syn.items).toHaveLength(SYNTHETIC_COUNTS.items);
    expect(new Set(syn.items.map((i) => i.key)).size).toBe(120);
    expect(new Set(syn.items.map((i) => fingerprintItem(i))).size).toBe(120);
    expect(syn.scale.levels.map((l) => l.value)).toEqual([1, 2, 3, 4, 5]);
    for (let t = 0; t < 5; t++) expect(syn.items.filter((i) => syn.truth[i.key] === t)).toHaveLength(24);
    for (const it of syn.items) expect(it.source && it.source.length > 0).toBe(true);
  });

  it('has 5 annotators labelling every item with controlled noise', () => {
    expect(syn.annotatorIds).toEqual(['ann-1', 'ann-2', 'ann-3', 'ann-4', 'ann-5']);
    expect(syn.annotations).toHaveLength(600);
    syn.annotatorIds.forEach((id, a) => {
      const mine = syn.annotations.filter((x) => x.annotatorId === id);
      expect(mine).toHaveLength(120);
      for (const x of mine) expect(Math.abs(x.score - syn.truth[x.itemKey]!)).toBeLessThanOrEqual(1);
      const agree = mine.filter((x) => x.score === syn.truth[x.itemKey]).length / 120;
      const expected = 1 - ANNOTATOR_NOISE[a]!;
      expect(Math.abs(agree - expected)).toBeLessThan(0.15);
    });
    const ceiling = referenceCeiling(syn.annotations, 5);
    expect(ceiling.value.kind).toBe('value');
    expect(ceiling.value.kind === 'value' && ceiling.value.value).toBeGreaterThan(0.7);
  });

  it('has 24 passing content-equivalent pairs plus the padded-filler trap pair', () => {
    expect(syn.pairs).toHaveLength(SYNTHETIC_COUNTS.pairs + 1);
    const real = syn.pairs.filter((p) => !p.trap);
    expect(real).toHaveLength(24);
    for (const p of real) {
      const c = pairCheck({ short: p.shortText, long: p.longText, facts: p.facts });
      expect(c.reasons).toEqual([]);
      expect(c.pass).toBe(true);
      expect(p.longText.includes(p.shortText)).toBe(false);
    }
    const trap = syn.pairs.find((p) => p.id === TRAP_PAIR_ID)!;
    expect(trap.trap).toBe(true);
    expect(trap.longText.startsWith(trap.shortText)).toBe(true);
    expect(pairCheck({ short: trap.shortText, long: trap.longText, facts: trap.facts }).reasons).toEqual(['short_in_long']);
    expect(new Set(real.map((p) => p.shortText)).size).toBe(24);
  });

  it('has 12 injection items whose injected answers carry the marker', () => {
    expect(syn.injections).toHaveLength(SYNTHETIC_COUNTS.injections);
    for (const x of syn.injections) {
      expect(x.answer).toContain(INJECTION_MARKER);
      expect(x.baseAnswer).not.toContain(INJECTION_MARKER);
      expect(x.answer.startsWith(x.baseAnswer)).toBe(true);
    }
    expect(new Set(syn.injections.map((x) => x.instructionKind)).size).toBe(3);
  });

  it('the truth map covers items, probe-pair items and injection items', () => {
    for (const it of syn.items) expect(syn.truth[it.key]).toBeTypeOf('number');
    for (const p of syn.pairs) {
      const k = pairItemKeys(p.id);
      expect(syn.truth[k.short]).toBe(p.truth);
      expect(syn.truth[k.long]).toBe(p.truth);
    }
    for (const x of syn.injections) {
      const k = injectionItemKeys(x.id);
      expect(syn.truth[k.base]).toBe(x.truth);
      expect(syn.truth[k.injected]).toBe(x.truth);
    }
  });

  it('answers state as many source facts as the planted level (lexical signal)', () => {
    for (const it of syn.items.slice(0, 40)) {
      const t = syn.truth[it.key]!;
      const factSentences = it.source!.split(/(?<=\.)\s+/).slice(1, 5);
      const stated = factSentences.filter((f) => it.answer.includes(f)).length;
      expect(stated).toBe(t);
    }
  });

  it('ships import files that the real importer accepts', () => {
    const r = importGoldSet(syn.files);
    expect(r.ok).toBe(true);
    expect(syn.files.annotatorCsvs).toHaveLength(5);
    expect(syn.files.itemsJsonl.trim().split('\n')).toHaveLength(120);
    expect(JSON.parse(syn.files.manifestJson)).toMatchObject({ split_seed: 36, heldout_fraction: 0.5 });
  });

  it('rubric v1 has concrete levels 1..5 without the marker; the v2 edit adds it to level 4 only', () => {
    expect(syn.rubricV1).toEqual(SYNTHETIC_RUBRIC_V1);
    expect(SYNTHETIC_RUBRIC_V1.levels.map((l) => l.value)).toEqual([1, 2, 3, 4, 5]);
    for (const l of SYNTHETIC_RUBRIC_V1.levels) expect(l.description).not.toContain(MERGE_FIX_MARKER);
    const edits = syntheticRubricV2Edits();
    expect(Object.keys(edits.levels ?? {})).toEqual(['4']);
    expect(edits.levels![4]).toContain(MERGE_FIX_MARKER);
    expect(edits.instructions).toBeUndefined();
  });
});
