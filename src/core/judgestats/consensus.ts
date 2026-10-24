// Consensus label per item (PLAN.md §3.6, K7) — always an integer level index:
//   odd label count  -> the median label;
//   even label count -> the two middle labels if they are equal, else the item is a TIE
//                       (flagged, excluded from consensus-only metrics, count shown).

import type { Annotation } from '../types.ts';

export type ConsensusOutcome =
  | { kind: 'label'; value: number }
  | { kind: 'tie'; middle: [number, number] }
  | { kind: 'empty' };

export type ConsensusItem = {
  itemKey: string;
  /** Labels sorted ascending. */
  labels: number[];
  consensus: number | null;
  tie: boolean;
};

export type ConsensusResult = {
  /** Sorted by itemKey. */
  items: ConsensusItem[];
  /** Item keys flagged as ties (sorted). */
  ties: string[];
  tieCount: number;
};

export function consensusLabel(labels: readonly number[]): ConsensusOutcome {
  const n = labels.length;
  if (n === 0) return { kind: 'empty' };
  const sorted = labels.slice().sort((a, b) => a - b);
  if (n % 2 === 1) return { kind: 'label', value: sorted[(n - 1) / 2]! };
  const a = sorted[n / 2 - 1]!;
  const b = sorted[n / 2]!;
  return a === b ? { kind: 'label', value: a } : { kind: 'tie', middle: [a, b] };
}

/** Group annotations by item (deterministic order). */
export function labelsByItem(annotations: readonly Annotation[]): Map<string, number[]> {
  const byItem = new Map<string, number[]>();
  for (const a of annotations) {
    const list = byItem.get(a.itemKey);
    if (list) list.push(a.score);
    else byItem.set(a.itemKey, [a.score]);
  }
  return byItem;
}

export function consensusByItem(annotations: readonly Annotation[]): ConsensusResult {
  const byItem = labelsByItem(annotations);
  const keys = [...byItem.keys()].sort();
  const items: ConsensusItem[] = [];
  const ties: string[] = [];
  for (const key of keys) {
    const labels = byItem.get(key)!.slice().sort((a, b) => a - b);
    const c = consensusLabel(labels);
    const tie = c.kind === 'tie';
    if (tie) ties.push(key);
    items.push({ itemKey: key, labels, consensus: c.kind === 'label' ? c.value : null, tie });
  }
  return { items, ties, tieCount: ties.length };
}

/** Mean human level index per item (fractional) — used by PAV fits and "worst items" ranking. */
export function meanHumanByItem(annotations: readonly Annotation[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, labels] of labelsByItem(annotations)) {
    let sum = 0;
    for (const l of labels) sum += l;
    out.set(key, sum / labels.length);
  }
  return out;
}
