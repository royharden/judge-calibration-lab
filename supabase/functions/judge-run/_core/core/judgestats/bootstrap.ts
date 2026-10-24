// Percentile bootstrap over resampling UNITS (PLAN.md §3.6).
//  - unit = split group (explicit group id or duplicate-fingerprint group); a singleton
//    group is one item. Correlated variants are therefore resampled together.
//  - 2,000 resamples by default, seeded PRNG stream (deriveStream(seed, streamLabel)).
//  - type-7 quantiles for the percentile bounds.
//  - draws where the statistic is undefined are DROPPED and COUNTED; the interval is
//    undefined when the dropped share exceeds 10% (10% exactly is still defined) or when
//    the point statistic itself is undefined.
//
// A statistic receives the list of item keys of one draw (with repeats when a unit is
// drawn more than once) and returns a Stat. The point estimate is the statistic over all
// units' item keys, in unit order.

import type { Interval, Stat } from '../types.ts';
import { deriveStream } from '../prng.ts';
import { quantile7Sorted } from './quantile.ts';
import { undefinedInterval, value } from './undefined.ts';

export type ResampleUnit = { id: string; itemKeys: readonly string[] };

export type BootstrapOptions = {
  /** Seed of the bootstrap stream (policy s36-v1 uses 36). Required: no hidden default seed. */
  seed: number;
  /** Number of resamples (default 2000). */
  resamples?: number;
  /** PRNG sub-stream label (default 'bootstrap'). Same seed + label + unit count => same draws. */
  streamLabel?: string;
  /** Max share of undefined draws before the interval becomes undefined (default 0.10). */
  maxUndefinedShare?: number;
  /** Two-sided confidence level (default 0.95). */
  confidence?: number;
};

export const BOOTSTRAP_DEFAULTS = {
  resamples: 2000,
  streamLabel: 'bootstrap',
  maxUndefinedShare: 0.1,
  confidence: 0.95,
} as const;

export const BOOTSTRAP_ALGO_VERSION = 'percentile-group-bootstrap/v1';

export type Statistic = (itemKeys: readonly string[]) => Stat;

type ResolvedOptions = Required<BootstrapOptions>;

function resolve(opts: BootstrapOptions): ResolvedOptions {
  const r: ResolvedOptions = {
    seed: opts.seed,
    resamples: opts.resamples ?? BOOTSTRAP_DEFAULTS.resamples,
    streamLabel: opts.streamLabel ?? BOOTSTRAP_DEFAULTS.streamLabel,
    maxUndefinedShare: opts.maxUndefinedShare ?? BOOTSTRAP_DEFAULTS.maxUndefinedShare,
    confidence: opts.confidence ?? BOOTSTRAP_DEFAULTS.confidence,
  };
  if (!Number.isInteger(r.resamples) || r.resamples < 1) throw new RangeError(`resamples must be a positive integer`);
  if (!(r.maxUndefinedShare >= 0 && r.maxUndefinedShare < 1)) throw new RangeError(`maxUndefinedShare must be in [0, 1)`);
  if (!(r.confidence > 0 && r.confidence < 1)) throw new RangeError(`confidence must be in (0, 1)`);
  return r;
}

/**
 * Build resampling units from items: items sharing a groupId form one unit, every other
 * item is a singleton unit. Units are sorted by id and item keys within a unit are sorted,
 * so the unit list (and hence the draws) does not depend on input row order.
 */
export function unitsFromItems(items: readonly { key: string; groupId?: string | null }[]): ResampleUnit[] {
  const groups = new Map<string, string[]>();
  for (const it of items) {
    const id = it.groupId !== undefined && it.groupId !== null && it.groupId !== '' ? `group:${it.groupId}` : `item:${it.key}`;
    const list = groups.get(id);
    if (list) list.push(it.key);
    else groups.set(id, [it.key]);
  }
  return [...groups.keys()].sort().map((id) => ({ id, itemKeys: groups.get(id)!.slice().sort() }));
}

/** All item keys of the units, in unit order. */
export function allItemKeys(units: readonly ResampleUnit[]): string[] {
  const out: string[] = [];
  for (const u of units) for (const k of u.itemKeys) out.push(k);
  return out;
}

/** Keep only the given item keys inside each unit; drop units that become empty. */
export function restrictUnits(units: readonly ResampleUnit[], keep: ReadonlySet<string>): ResampleUnit[] {
  const out: ResampleUnit[] = [];
  for (const u of units) {
    const itemKeys = u.itemKeys.filter((k) => keep.has(k));
    if (itemKeys.length > 0) out.push({ id: u.id, itemKeys });
  }
  return out;
}

/**
 * The unit indices of every draw (resamples x nUnits), fully determined by
 * (seed, streamLabel, nUnits, resamples). Exposed so paired comparisons and tests can
 * prove that two statistics were evaluated on identical draws.
 */
export function drawUnitIndices(nUnits: number, opts: BootstrapOptions): number[][] {
  const r = resolve(opts);
  if (!Number.isInteger(nUnits) || nUnits < 1) throw new RangeError('drawUnitIndices: need at least one unit');
  const prng = deriveStream(r.seed, r.streamLabel);
  const draws: number[][] = [];
  for (let d = 0; d < r.resamples; d++) {
    const idx = new Array<number>(nUnits);
    for (let i = 0; i < nUnits; i++) idx[i] = prng.int(nUnits);
    draws.push(idx);
  }
  return draws;
}

/** Item keys of one draw (units concatenated in draw order, repeats kept). */
export function drawItemKeys(units: readonly ResampleUnit[], draw: readonly number[]): string[] {
  const keys: string[] = [];
  for (const i of draw) for (const k of units[i]!.itemKeys) keys.push(k);
  return keys;
}

/** Percentile bootstrap interval of `statistic` over `units`. */
export function bootstrapInterval(units: readonly ResampleUnit[], statistic: Statistic, opts: BootstrapOptions): Interval {
  const r = resolve(opts);
  const point = statistic(allItemKeys(units));
  if (point.kind === 'undefined') return undefinedInterval(point, 'point statistic undefined');
  if (units.length === 0) return undefinedInterval(point, 'no resampling units');

  const values: number[] = [];
  let dropped = 0;
  for (const draw of drawUnitIndices(units.length, r)) {
    const s = statistic(drawItemKeys(units, draw));
    if (s.kind === 'value') values.push(s.value);
    else dropped += 1;
  }

  if (dropped / r.resamples > r.maxUndefinedShare || values.length === 0) {
    const pct = Math.round(r.maxUndefinedShare * 1000) / 10;
    return undefinedInterval(point, `${dropped} of ${r.resamples} resamples undefined (> ${pct}%)`, r.resamples, dropped);
  }

  values.sort((a, b) => a - b);
  const alpha = (1 - r.confidence) / 2;
  return {
    point,
    lo: value(quantile7Sorted(values, alpha)),
    hi: value(quantile7Sorted(values, 1 - alpha)),
    draws: r.resamples,
    droppedDraws: dropped,
  };
}
