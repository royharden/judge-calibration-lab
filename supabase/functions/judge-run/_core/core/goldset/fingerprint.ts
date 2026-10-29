// Content fingerprints and set hashes (PLAN.md §3.4).
//  - item fingerprint = sha256(canonical JSON of {task, answer, source, facts}) after text
//    canonicalisation (NFC, LF, trailing whitespace per line); ids are NOT part of it;
//  - contentHash      = sha256(canonical JSON of the SORTED fingerprint list) — independent of
//    row order, item ids, newline style and user;
//  - annotationHash   = sha256(canonical JSON of the sorted (fingerprint, annotator, score
//    index) triples) — separate from contentHash.

import type { Annotation, Item } from '../types.ts';
import { canonicalHash, canonicalJson } from '../canonical.ts';

export const FINGERPRINT_VERSION = 'item-fp/v1';

type ItemContent = Pick<Item, 'taskText' | 'answer' | 'source' | 'facts'>;

/** Content fingerprint of one item (empty source / empty facts count as absent). */
export function fingerprintItem(item: ItemContent): string {
  const source = item.source === undefined || item.source === '' ? undefined : item.source;
  const facts = item.facts === undefined || item.facts.length === 0 ? undefined : item.facts;
  return canonicalHash({ task: item.taskText, answer: item.answer, source, facts });
}

/** itemKey -> fingerprint for every item. */
export function fingerprintMap(items: readonly Item[]): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const it of items) out[it.key] = fingerprintItem(it);
  return out;
}

/** Hash of the sorted fingerprint multiset. */
export function contentHashOf(fingerprints: readonly string[]): string {
  return canonicalHash([...fingerprints].sort());
}

/** Hash of sorted (fingerprint, annotatorId, score) triples. Unknown item keys throw. */
export function annotationHashOf(annotations: readonly Annotation[], fingerprints: Readonly<Record<string, string>>): string {
  const triples = annotations.map((a) => {
    const fp = Object.hasOwn(fingerprints, a.itemKey) ? fingerprints[a.itemKey] : undefined;
    if (fp === undefined) throw new RangeError(`annotationHashOf: unknown item "${a.itemKey}"`);
    return [fp, a.annotatorId.normalize('NFC'), a.score] as const;
  });
  const sorted = triples.map((t) => ({ t, key: canonicalJson(t) })).sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return canonicalHash(sorted.map((s) => [...s.t]));
}
