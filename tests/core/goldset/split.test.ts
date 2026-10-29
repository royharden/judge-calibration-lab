import { describe, expect, it } from 'vitest';
import type { Annotation, Item } from '../../../src/core/types.ts';
import {
  buildGroups,
  computeSplit,
  resampleUnitsFromGroups,
  sameHeldout,
  SPLIT_ALGO_VERSION,
  splitHashOf,
  verifySplit,
} from '../../../src/core/goldset/split.ts';
import { fingerprintItem } from '../../../src/core/goldset/fingerprint.ts';
import { importGoldSet } from '../../../src/core/goldset/import.ts';
import { generateSyntheticSet } from '../../../src/core/fixtures/synthetic.ts';
import { n12Subset } from '../../../src/core/fixtures/traps.ts';

const syn = generateSyntheticSet(36);

function twoLabels(items: readonly Item[], level: (i: number) => number): Annotation[] {
  return items.flatMap((it, i) => [
    { itemKey: it.key, annotatorId: 'x', score: level(i) },
    { itemKey: it.key, annotatorId: 'y', score: level(i) },
  ]);
}

function plainItems(n: number, prefix = 'it'): Item[] {
  return Array.from({ length: n }, (_, i) => ({ key: `${prefix}-${i}`, taskText: `task ${i}`, answer: `answer ${i}` }));
}

describe('computeSplit on the synthetic set', () => {
  const r = computeSplit({ items: syn.items, annotations: syn.annotations, seed: 36, heldoutFraction: 0.5, frozenAt: '2026-10-24T00:00:00Z' });

  it('freezes 60/60 with disjoint, complete membership and achieved counts', () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.value.manifest;
    expect(m.dev).toHaveLength(60);
    expect(m.heldout).toHaveLength(60);
    expect(new Set([...m.dev, ...m.heldout]).size).toBe(120);
    expect(m.achieved.dev.total).toBe(60);
    expect(m.achieved.heldout.total).toBe(60);
    const sum = (xs: { count: number }[]): number => xs.reduce((a, b) => a + b.count, 0);
    expect(sum(m.achieved.dev.byStratum)).toBe(60);
    expect(sum(m.achieved.heldout.byStratum)).toBe(60);
    expect(m.algoVersion).toBe(SPLIT_ALGO_VERSION);
    expect(m.seed).toBe(36);
    expect(m.frozenAt).toBe('2026-10-24T00:00:00Z');
    expect(r.value.targets).toEqual({ dev: 60, heldout: 60 });
  });

  it('stratifies: every stratum is split within one item of half', () => {
    if (!r.ok) throw new Error('split failed');
    const m = r.value.manifest;
    for (const d of m.achieved.dev.byStratum) {
      const h = m.achieved.heldout.byStratum.find((x) => x.stratum === d.stratum)!;
      expect(Math.abs(d.count - h.count)).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic for a seed and changes with the seed', () => {
    const again = computeSplit({ items: syn.items, annotations: syn.annotations, seed: 36, heldoutFraction: 0.5, frozenAt: '2026-10-24T00:00:00Z' });
    expect(again).toEqual(r);
    const other = computeSplit({ items: syn.items, annotations: syn.annotations, seed: 37, heldoutFraction: 0.5 });
    expect(other.ok && r.ok && other.value.manifest.splitHash !== r.value.manifest.splitHash).toBe(true);
  });

  it('splitHash = sha256 over sorted held-out fingerprints + seed + algoVersion', () => {
    if (!r.ok) throw new Error('split failed');
    const byKey = new Map(syn.items.map((i) => [i.key, i] as const));
    const fps = r.value.manifest.heldout.map((k) => fingerprintItem(byKey.get(k)!));
    expect(r.value.manifest.splitHash).toBe(splitHashOf(fps, 36, SPLIT_ALGO_VERSION));
  });

  it('renamed and reordered items give the same split hash (content-based)', () => {
    if (!r.ok) throw new Error('split failed');
    const rename = (k: string): string => `zz-${k.split('').reverse().join('')}`;
    const items = [...syn.items].reverse().map((i) => ({ ...i, key: rename(i.key) }));
    const annotations = [...syn.annotations].reverse().map((a) => ({ ...a, itemKey: rename(a.itemKey), annotatorId: `A${a.annotatorId}` }));
    const r2 = computeSplit({ items, annotations, seed: 36, heldoutFraction: 0.5 });
    expect(r2.ok && r2.value.manifest.splitHash).toBe(r.value.manifest.splitHash);
    expect(r2.ok && [...r2.value.manifest.heldout].sort()).toEqual(r.value.manifest.heldout.map(rename).sort());
  });

  it('preserves hash, split membership and group lookup for prototype-named item ids', () => {
    if (!r.ok) throw new Error('split failed');
    const aliases = new Map(syn.items.slice(0, 3).map((item, i) => [item.key, ['__proto__', 'constructor', 'toString'][i]!] as const));
    const rename = (key: string): string => aliases.get(key) ?? key;
    const items = syn.items.map((item) => ({ ...item, key: rename(item.key) }));
    const annotations = syn.annotations.map((annotation) => ({ ...annotation, itemKey: rename(annotation.itemKey) }));
    const changed = computeSplit({ items, annotations, seed: 36, heldoutFraction: 0.5 });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.value.manifest.splitHash).toBe(r.value.manifest.splitHash);
    expect([...changed.value.manifest.heldout].sort()).toEqual(r.value.manifest.heldout.map(rename).sort());
    expect(Object.getPrototypeOf(changed.value.itemGroup)).toBeNull();
    expect(Object.keys(changed.value.itemGroup)).toHaveLength(items.length);
    for (const [original, renamed] of aliases) {
      expect(changed.value.itemGroup[renamed]).toBe(r.value.itemGroup[original]);
    }
  });

  it('verifySplit recomputes the same hash and refuses a different one', () => {
    if (!r.ok) throw new Error('split failed');
    const input = { items: syn.items, annotations: syn.annotations, seed: 36, heldoutFraction: 0.5 };
    expect(verifySplit(input)).toEqual({ ok: true, value: r.value.manifest.splitHash });
    expect(verifySplit(input, r.value.manifest.splitHash).ok).toBe(true);
    const bad = verifySplit(input, 'f'.repeat(64));
    expect(!bad.ok && bad.error.reason).toBe('split_mismatch');
  });

  it('sameHeldout compares membership regardless of order', () => {
    if (!r.ok) throw new Error('split failed');
    expect(sameHeldout(r.value.manifest, [...r.value.manifest.heldout].reverse())).toBe(true);
    expect(sameHeldout(r.value.manifest, r.value.manifest.dev)).toBe(false);
  });

  it('works on the imported staged set', () => {
    const staged = importGoldSet(syn.files);
    if (!staged.ok) throw new Error('import failed');
    const s = computeSplit({ items: staged.value.items, annotations: staged.value.stagedAnnotations, seed: staged.value.splitSeed, heldoutFraction: 0.5 });
    expect(s.ok && r.ok && s.value.manifest.splitHash).toBe(r.ok && r.value.manifest.splitHash);
  });
});

describe('grouping', () => {
  it('keeps explicit group_id groups and duplicate-content items together', () => {
    const items: Item[] = plainItems(60);
    for (let g = 0; g < 5; g++) for (let j = 0; j < 4; j++) items[g * 4 + j]!.groupId = `G${g}`;
    // Two duplicate-content pairs (identical task + answer, different ids).
    items[30] = { key: 'dup-a1', taskText: 'same', answer: 'same answer' };
    items[31] = { key: 'dup-a2', taskText: 'same', answer: 'same answer' };
    items[32] = { key: 'dup-b1', taskText: 'other', answer: 'other answer' };
    items[33] = { key: 'dup-b2', taskText: 'other', answer: 'other answer' };
    const ann = twoLabels(items, (i) => i % 5);
    const r = computeSplit({ items, annotations: ann, seed: 36, heldoutFraction: 0.5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const side = (k: string): string => (r.value.manifest.heldout.includes(k) ? 'heldout' : 'dev');
    for (let g = 0; g < 5; g++) {
      const sides = new Set([0, 1, 2, 3].map((j) => side(items[g * 4 + j]!.key)));
      expect(sides.size).toBe(1);
    }
    expect(side('dup-a1')).toBe(side('dup-a2'));
    expect(side('dup-b1')).toBe(side('dup-b2'));
    expect(r.value.itemGroup['dup-a1']).toBe(r.value.itemGroup['dup-a2']);
    expect(buildGroups(items)).toHaveLength(60 - 5 * 3 - 2);
  });

  it('does NOT collapse a single-instruction set (same task text, distinct answers)', () => {
    const items: Item[] = Array.from({ length: 60 }, (_, i) => ({ key: `s${i}`, taskText: 'Rate this summary.', answer: `distinct answer ${i}` }));
    expect(buildGroups(items)).toHaveLength(60);
    const r = computeSplit({ items, annotations: twoLabels(items, (i) => i % 3), seed: 36, heldoutFraction: 0.5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.manifest.heldout).toHaveLength(30);
    expect(r.value.manifest.dev).toHaveLength(30);
  });

  it('group keys do not depend on ids or row order', () => {
    const a = plainItems(10);
    const b = [...a].reverse().map((i) => ({ ...i, key: `other-${i.key}` }));
    expect(buildGroups(a).map((g) => g.groupKey)).toEqual(buildGroups(b).map((g) => g.groupKey));
  });

  it('resampleUnitsFromGroups yields one unit per group, optionally restricted', () => {
    const items = plainItems(6);
    items[0]!.groupId = 'G';
    items[1]!.groupId = 'G';
    const groups = buildGroups(items);
    expect(resampleUnitsFromGroups(groups)).toHaveLength(5);
    const keep = new Set(['it-0', 'it-2']);
    const units = resampleUnitsFromGroups(groups, keep);
    expect(units.flatMap((u) => u.itemKeys).sort()).toEqual(['it-0', 'it-2']);
  });
});

describe('refusals', () => {
  it('refuses when the largest group exceeds the held-out target', () => {
    const items = plainItems(40);
    for (let i = 0; i < 21; i++) items[i]!.groupId = 'BIG';
    const r = computeSplit({ items, annotations: twoLabels(items, (i) => i % 5), seed: 36, heldoutFraction: 0.5 });
    expect(!r.ok && r.error.reason).toBe('group_too_large');
  });

  it('refuses when a split target is below the n floor of 20', () => {
    const items = plainItems(30);
    const r = computeSplit({ items, annotations: twoLabels(items, (i) => i % 5), seed: 36, heldoutFraction: 0.5 });
    expect(!r.ok && r.error.reason).toBe('split_too_small');
  });

  it('refuses the n = 12 trap subset', () => {
    const sub = n12Subset(syn);
    const r = computeSplit({ items: sub.items, annotations: sub.annotations, seed: 36, heldoutFraction: 0.5 });
    expect(!r.ok && r.error.reason).toBe('split_too_small');
  });

  it('refuses unlabelled items, bad fractions, bad seeds and duplicate keys', () => {
    const items = plainItems(50);
    const ann = twoLabels(items.slice(1), (i) => i % 5);
    const r = computeSplit({ items, annotations: ann, seed: 1, heldoutFraction: 0.5 });
    expect(!r.ok && r.error.reason).toBe('unlabelled_item');
    const full = twoLabels(items, (i) => i % 5);
    expect(computeSplit({ items, annotations: full, seed: 1, heldoutFraction: 1 }).ok).toBe(false);
    expect(computeSplit({ items, annotations: full, seed: -1, heldoutFraction: 0.5 }).ok).toBe(false);
    expect(computeSplit({ items: [...items, items[0]!], annotations: full, seed: 1, heldoutFraction: 0.5 }).ok).toBe(false);
  });

  it('a lower n floor option is honoured', () => {
    const items = plainItems(30);
    const r = computeSplit({ items, annotations: twoLabels(items, (i) => i % 5), seed: 36, heldoutFraction: 0.5, nFloor: 10 });
    expect(r.ok).toBe(true);
  });
});
