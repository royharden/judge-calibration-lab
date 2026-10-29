import { describe, expect, it } from 'vitest';
import { generateSyntheticSet } from '../../../src/core/fixtures/synthetic.ts';
import { createRubric } from '../../../src/core/rubric/rubric.ts';
import { mockScoreSync } from '../../../src/core/judge/mock.ts';
import { toVerdict } from '../../../src/core/judge/judge.ts';
import { unwrap } from '../../../src/core/result.ts';
import { computeDevFits, fitHashes, type FitInput } from '../../../src/core/report/fits.ts';
import { applyPav } from '../../../src/core/judgestats/pav.ts';

const syn = generateSyntheticSet(36);
const rubric = unwrap(createRubric({ setId: 's', ...syn.rubricV1 }, syn.scale));
const devItems = syn.items.slice(0, 60);
const devKeys = devItems.map((i) => i.key);
const annotations = syn.annotations.filter((a) => devKeys.includes(a.itemKey));
const verdicts = devItems.map((i) => toVerdict('dev', i.key, 0, mockScoreSync('merges-3-4', i, rubric, { runId: 'dev', replicate: 0, presentation: 'ascending', seed: 36, split: 'dev', truth: syn.truth })));
const input: FitInput = { devItems, devKeys, devAnnotations: annotations, baselineVerdicts: verdicts, k: 5 };

describe('server/store-owned dev fits', () => {
  it('computes all three fits and deterministic hashes independent of row order', () => {
    const a = unwrap(computeDevFits(input));
    const b = unwrap(computeDevFits({ ...input, devItems: [...devItems].reverse(), devKeys: [...devKeys].reverse(), devAnnotations: [...annotations].reverse(), baselineVerdicts: [...verdicts].reverse() }));
    expect(b).toEqual(a);
    expect(a.hashes).toEqual(fitHashes(a));
    expect(a.fittedOn).toBe('dev');
    expect(a.lexical.fittedOn).toBe('dev');
    expect(a.modal.fittedOn).toBe('dev');
    expect(Object.values(a.hashes).every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(a.pav.map).toHaveLength(5);
    expect(a.pav.map.every((v, i, all) => i === 0 || v >= all[i - 1]!)).toBe(true);
    expect(applyPav(a.pav, 4)).toBeGreaterThanOrEqual(0);
  });
  it('refuses held-out rows instead of fitting them silently', () => {
    expect(computeDevFits({ ...input, devAnnotations: [...annotations, { itemKey: 'heldout', annotatorId: 'a', score: 4 }] }).ok).toBe(false);
    expect(computeDevFits({ ...input, devItems: [{ ...devItems[0]!, split: 'heldout' }, ...devItems.slice(1)] } as unknown as FitInput).ok).toBe(false);
    expect(computeDevFits({ ...input, baselineVerdicts: verdicts.slice(1) }).ok).toBe(false);
  });
  it('a changed learned map cannot reuse its old hash', () => {
    const a = unwrap(computeDevFits(input));
    expect(fitHashes({ ...a, pav: { ...a.pav, map: a.pav.map.map(() => 0) } }).pavMap).not.toBe(a.hashes.pavMap);
  });
  it('undefined fitting data is a reason-coded refusal', () => {
    const none = computeDevFits({ devItems: [], devKeys: [], devAnnotations: [], baselineVerdicts: [], k: 5 });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.reason).toBe('no_dev_items');
  });
});
