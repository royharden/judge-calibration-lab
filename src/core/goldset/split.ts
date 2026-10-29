// Deterministic, stratified, group-preserving dev / held-out split (PLAN.md §3.4, K23).
//
//  1. Groups = explicit group_id  UNION  exact duplicate fingerprints (union-find). Items are
//     never grouped because they merely share task text (a single-instruction set is NOT
//     collapsed into one group).
//  2. Group key = sha256(canonical JSON of the group's sorted member fingerprints), so the
//     grouping and its order do not depend on item ids or row order.
//  3. Stratum = round-half-up of the group's mean human level (mean of its items' mean label
//     index).
//  4. Targets: heldout = round(N * fraction), dev = N - heldout.
//     Refuse when N = 0, either target < nFloor (20), or the largest group > heldout target.
//  5. Strata in ascending order; within a stratum the groups (sorted by group key) are
//     shuffled with PRNG stream deriveStream(seed, 'split/v1'); each group goes whole to the
//     split furthest below its per-stratum target (n_s * fraction); ties go to the split
//     furthest below its global target; remaining ties use the same PRNG stream.
//  6. Refuse when an achieved split is below nFloor.
//  7. splitHash = sha256(canonical JSON {algoVersion, heldout: sorted held-out fingerprints,
//     seed}).
//
// verifySplit() recomputes the hash from stored items + labels + seed (K23 integrity check).

import type { Annotation, Item, SplitManifest, StratumCount } from '../types.ts';
import type { Reason, Result } from '../result.ts';
import { fail, ok } from '../result.ts';
import { canonicalHash } from '../canonical.ts';
import { deriveStream } from '../prng.ts';
import { fingerprintItem } from './fingerprint.ts';

export const SPLIT_ALGO_VERSION = 'stratified-group-greedy/v1';
/** Policy n floor per split (s36-v1 n floor; M3 policyConst should consume or re-export). */
export const SPLIT_N_FLOOR = 20;

const EPS = 1e-9;

export type SplitSide = 'dev' | 'heldout';

export type SplitGroup = {
  groupKey: string;
  /** Sorted item keys. */
  itemKeys: string[];
  /** Sorted member fingerprints. */
  fingerprints: string[];
  stratum: number;
};

export type AssignedGroup = SplitGroup & { split: SplitSide };

export type SplitResult = {
  manifest: SplitManifest;
  /** Groups sorted by (stratum, groupKey). */
  groups: AssignedGroup[];
  /** itemKey -> groupKey. */
  itemGroup: Record<string, string>;
  targets: { dev: number; heldout: number };
};

export type SplitRefusalCode =
  | 'invalid_fraction'
  | 'invalid_seed'
  | 'no_items'
  | 'duplicate_item_key'
  | 'unlabelled_item'
  | 'group_too_large'
  | 'split_too_small'
  | 'split_mismatch';

export type SplitRefusal = Reason<SplitRefusalCode, Record<string, unknown>>;

export type SplitInput = {
  items: readonly Item[];
  /** Staged (unsplit) labels as level indices. */
  annotations: readonly Annotation[];
  seed: number;
  heldoutFraction: number;
  /** ISO timestamp recorded in the manifest (set by the store at freeze). Default ''. */
  frozenAt?: string;
  /** Minimum items per split (default SPLIT_N_FLOOR). */
  nFloor?: number;
};

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/** Union-find grouping by explicit groupId and identical fingerprint. Sorted by groupKey. */
export function buildGroups(items: readonly Item[]): Omit<SplitGroup, 'stratum'>[] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    let c = i;
    while (parent[c] !== r) {
      const next = parent[c]!;
      parent[c] = r;
      c = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const fps = items.map((it) => fingerprintItem(it));
  const firstByGroupId = new Map<string, number>();
  const firstByFp = new Map<string, number>();
  items.forEach((it, i) => {
    if (it.groupId !== undefined && it.groupId !== '') {
      const g = firstByGroupId.get(it.groupId);
      if (g === undefined) firstByGroupId.set(it.groupId, i);
      else union(g, i);
    }
    const f = firstByFp.get(fps[i]!);
    if (f === undefined) firstByFp.set(fps[i]!, i);
    else union(f, i);
  });

  const members = new Map<number, number[]>();
  items.forEach((_, i) => {
    const r = find(i);
    const list = members.get(r);
    if (list) list.push(i);
    else members.set(r, [i]);
  });

  const groups: Omit<SplitGroup, 'stratum'>[] = [];
  for (const idxs of members.values()) {
    const fingerprints = idxs.map((i) => fps[i]!).sort();
    const itemKeys = idxs.map((i) => items[i]!.key).sort();
    groups.push({ groupKey: canonicalHash(fingerprints), itemKeys, fingerprints });
  }
  return groups.sort((a, b) => cmp(a.groupKey, b.groupKey));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Bootstrap resampling units (one per group) restricted to `keep` item keys when given. */
export function resampleUnitsFromGroups(
  groups: readonly { groupKey: string; itemKeys: readonly string[] }[],
  keep?: ReadonlySet<string>,
): { id: string; itemKeys: string[] }[] {
  const out: { id: string; itemKeys: string[] }[] = [];
  for (const g of groups) {
    const itemKeys = keep ? g.itemKeys.filter((k) => keep.has(k)) : [...g.itemKeys];
    if (itemKeys.length > 0) out.push({ id: g.groupKey, itemKeys });
  }
  return out.sort((a, b) => cmp(a.id, b.id));
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

export function splitHashOf(heldoutFingerprints: readonly string[], seed: number, algoVersion: string = SPLIT_ALGO_VERSION): string {
  return canonicalHash({ algoVersion, heldout: [...heldoutFingerprints].sort(), seed });
}

function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5 + EPS);
}

export function computeSplit(input: SplitInput): Result<SplitResult, SplitRefusal> {
  const { items, annotations, seed, heldoutFraction } = input;
  const nFloor = input.nFloor ?? SPLIT_N_FLOOR;
  if (!(heldoutFraction > 0 && heldoutFraction < 1)) {
    return fail('invalid_fraction', 'heldout fraction must be strictly between 0 and 1', { heldoutFraction });
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    return fail('invalid_seed', 'split seed must be an unsigned 32-bit integer', { seed });
  }
  const n = items.length;
  if (n === 0) return fail('no_items', 'the set has no items', {});
  const keys = new Set(items.map((i) => i.key));
  if (keys.size !== n) return fail('duplicate_item_key', 'item keys must be unique', {});

  // Mean label per item.
  const sum = new Map<string, number>();
  const cnt = new Map<string, number>();
  for (const a of annotations) {
    if (!keys.has(a.itemKey)) continue;
    sum.set(a.itemKey, (sum.get(a.itemKey) ?? 0) + a.score);
    cnt.set(a.itemKey, (cnt.get(a.itemKey) ?? 0) + 1);
  }
  const unlabelled = items.filter((i) => !cnt.has(i.key)).map((i) => i.key);
  if (unlabelled.length > 0) {
    return fail('unlabelled_item', `${unlabelled.length} item(s) have no labels`, { itemKeys: unlabelled.sort() });
  }

  const raw = buildGroups(items);
  const groups: SplitGroup[] = raw.map((g) => {
    let s = 0;
    for (const k of g.itemKeys) s += sum.get(k)! / cnt.get(k)!;
    return { ...g, stratum: roundHalfUp(s / g.itemKeys.length) };
  });

  const heldoutTarget = Math.round(n * heldoutFraction);
  const devTarget = n - heldoutTarget;
  const targets = { dev: devTarget, heldout: heldoutTarget };
  if (heldoutTarget < nFloor || devTarget < nFloor) {
    return fail('split_too_small', `targets dev=${devTarget}, heldout=${heldoutTarget} are below the n floor ${nFloor}`, {
      targets,
      nFloor,
    });
  }
  const largest = groups.reduce((m, g) => Math.max(m, g.itemKeys.length), 0);
  if (largest > heldoutTarget) {
    return fail('group_too_large', `largest group has ${largest} items, above the held-out target ${heldoutTarget}`, {
      largest,
      heldoutTarget,
    });
  }

  // Greedy stratified assignment.
  const prng = deriveStream(seed, 'split/v1');
  const strata = [...new Set(groups.map((g) => g.stratum))].sort((a, b) => a - b);
  const assigned: AssignedGroup[] = [];
  let devCount = 0;
  let heldCount = 0;
  for (const s of strata) {
    const inStratum = groups.filter((g) => g.stratum === s); // already sorted by groupKey
    const nS = inStratum.reduce((m, g) => m + g.itemKeys.length, 0);
    const tH = nS * heldoutFraction;
    const tD = nS - tH;
    let cH = 0;
    let cD = 0;
    for (const g of prng.shuffle(inStratum)) {
      const dH = tH - cH;
      const dD = tD - cD;
      let side: SplitSide;
      if (dH > dD + EPS) side = 'heldout';
      else if (dD > dH + EPS) side = 'dev';
      else {
        const gH = heldoutTarget - heldCount;
        const gD = devTarget - devCount;
        if (gH > gD) side = 'heldout';
        else if (gD > gH) side = 'dev';
        else side = prng.nextFloat() < 0.5 ? 'heldout' : 'dev';
      }
      const size = g.itemKeys.length;
      if (side === 'heldout') {
        cH += size;
        heldCount += size;
      } else {
        cD += size;
        devCount += size;
      }
      assigned.push({ ...g, split: side });
    }
  }

  if (heldCount < nFloor || devCount < nFloor) {
    return fail('split_too_small', `achieved dev=${devCount}, heldout=${heldCount}; the n floor is ${nFloor}`, {
      achieved: { dev: devCount, heldout: heldCount },
      nFloor,
    });
  }

  assigned.sort((a, b) => a.stratum - b.stratum || cmp(a.groupKey, b.groupKey));
  const dev: string[] = [];
  const heldout: string[] = [];
  const heldoutFps: string[] = [];
  const itemGroup: Record<string, string> = Object.create(null) as Record<string, string>;
  const byStratum = (side: SplitSide): StratumCount[] =>
    strata.map((st) => ({
      stratum: st,
      count: assigned.filter((g) => g.split === side && g.stratum === st).reduce((m, g) => m + g.itemKeys.length, 0),
    }));
  for (const g of assigned) {
    for (const k of g.itemKeys) itemGroup[k] = g.groupKey;
    if (g.split === 'heldout') {
      heldout.push(...g.itemKeys);
      heldoutFps.push(...g.fingerprints);
    } else dev.push(...g.itemKeys);
  }
  dev.sort();
  heldout.sort();

  const manifest: SplitManifest = {
    seed,
    heldoutFraction,
    algoVersion: SPLIT_ALGO_VERSION,
    dev,
    heldout,
    splitHash: splitHashOf(heldoutFps, seed),
    frozenAt: input.frozenAt ?? '',
    achieved: {
      dev: { total: devCount, byStratum: byStratum('dev') },
      heldout: { total: heldCount, byStratum: byStratum('heldout') },
    },
  };
  return ok({ manifest, groups: assigned, itemGroup, targets });
}

/**
 * Recompute the split hash from stored items + labels + seed (K23). With `expectedHash`,
 * a different recomputed hash is Err('split_mismatch').
 */
export function verifySplit(input: SplitInput, expectedHash?: string): Result<string, SplitRefusal> {
  const r = computeSplit(input);
  if (!r.ok) return r;
  const h = r.value.manifest.splitHash;
  if (expectedHash !== undefined && expectedHash !== h) {
    return fail('split_mismatch', 'the stored split hash does not match the recomputed split', { expected: expectedHash, actual: h });
  }
  return ok(h);
}

/** Check that a proposed held-out key list is exactly the recomputed one (MemoryStore / freeze parity). */
export function sameHeldout(manifest: Pick<SplitManifest, 'heldout'>, heldoutKeys: readonly string[]): boolean {
  const a = [...manifest.heldout].sort();
  const b = [...new Set(heldoutKeys)].sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
