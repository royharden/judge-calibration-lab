import { describe, expect, it } from 'vitest';
import { consensusByItem, consensusLabel, meanHumanByItem } from '../../../src/core/judgestats/consensus.ts';
import type { Annotation } from '../../../src/core/types.ts';

describe('consensusLabel (median / tie rule)', () => {
  it('odd count -> median', () => {
    expect(consensusLabel([1, 2, 3])).toEqual({ kind: 'label', value: 2 });
    expect(consensusLabel([3, 1, 2, 2, 0])).toEqual({ kind: 'label', value: 2 });
    expect(consensusLabel([4])).toEqual({ kind: 'label', value: 4 });
  });

  it('even count with equal middle labels -> that label', () => {
    expect(consensusLabel([2, 2])).toEqual({ kind: 'label', value: 2 });
    expect(consensusLabel([3, 1, 2, 2])).toEqual({ kind: 'label', value: 2 });
  });

  it('even count with unequal middle labels -> tie (never a fractional average)', () => {
    expect(consensusLabel([1, 3, 3, 1])).toEqual({ kind: 'tie', middle: [1, 3] });
    expect(consensusLabel([2, 3])).toEqual({ kind: 'tie', middle: [2, 3] });
  });

  it('no labels -> empty', () => {
    expect(consensusLabel([])).toEqual({ kind: 'empty' });
  });
});

describe('consensusByItem', () => {
  const ann: Annotation[] = [
    { itemKey: 'b', annotatorId: 'x', score: 1 },
    { itemKey: 'b', annotatorId: 'y', score: 3 },
    { itemKey: 'a', annotatorId: 'x', score: 2 },
    { itemKey: 'a', annotatorId: 'y', score: 2 },
    { itemKey: 'a', annotatorId: 'z', score: 4 },
  ];

  it('flags ties, counts them and keeps item order deterministic', () => {
    const r = consensusByItem(ann);
    expect(r.items.map((i) => [i.itemKey, i.consensus, i.tie])).toEqual([
      ['a', 2, false],
      ['b', null, true],
    ]);
    expect(r.ties).toEqual(['b']);
    expect(r.tieCount).toBe(1);
  });

  it('meanHumanByItem gives fractional means', () => {
    const m = meanHumanByItem(ann);
    expect(m.get('a')).toBeCloseTo(8 / 3, 12);
    expect(m.get('b')).toBeCloseTo(2, 12);
  });
});
