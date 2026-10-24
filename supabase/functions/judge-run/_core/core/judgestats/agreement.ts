// Agreement statistics (PLAN.md §3.6).
//
// Item-level, aligned arrays (judge[i] and human[i] rate the same item):
//   exactAgreement, withinOneAgreement, meanSignedOffset (judge - human; positive = lenient).
//
// Rater-pair means over keyed data:
//   referenceCeiling — per annotator pair, QWK over items both rated; pairs with fewer than
//     `overlapFloor` (default 10) shared items are EXCLUDED and listed with their n; the
//     ceiling is the equal-weight mean of the DEFINED included pairs. It is an observed human
//     reference level, not an upper bound.
//   judgeAgreement — equal-weight mean over annotators of QWK(judge, annotator) over items the
//     annotator rated and the judge scored usably, with the same overlap floor.
//
// Bootstrap variants freeze the "basis" (included pairs with a defined point kappa) from the
// original data; in every draw the statistic is the mean over the same basis, and the draw is
// undefined if any basis member is undefined in it (so the mean never silently changes
// composition between draws).

import type { Annotation, Interval, JudgeScore, Stat } from '../types.ts';
import { bootstrapInterval, allItemKeys, type BootstrapOptions, type ResampleUnit } from './bootstrap.ts';
import { quadraticWeightedKappa } from './kappa.ts';
import { meanStat, undef, value } from './undefined.ts';

export const DEFAULT_OVERLAP_FLOOR = 10;

// ---------------------------------------------------------------------------
// Item-level agreement on aligned arrays
// ---------------------------------------------------------------------------

function assertAligned(judge: readonly number[], human: readonly number[]): void {
  if (judge.length !== human.length) {
    throw new RangeError(`agreement: length mismatch (${judge.length} vs ${human.length})`);
  }
}

/** Share of items where judge == human. Undefined when there are no items. */
export function exactAgreement(judge: readonly number[], human: readonly number[]): Stat {
  assertAligned(judge, human);
  if (judge.length === 0) return undef('no items');
  let hits = 0;
  for (let i = 0; i < judge.length; i++) if (judge[i] === human[i]) hits += 1;
  return value(hits / judge.length);
}

/** Share of items where |judge - human| <= 1. Undefined when there are no items. */
export function withinOneAgreement(judge: readonly number[], human: readonly number[]): Stat {
  assertAligned(judge, human);
  if (judge.length === 0) return undef('no items');
  let hits = 0;
  for (let i = 0; i < judge.length; i++) if (Math.abs(judge[i]! - human[i]!) <= 1) hits += 1;
  return value(hits / judge.length);
}

/** Mean of (judge - human) in level units; positive = lenient, negative = harsh. */
export function meanSignedOffset(judge: readonly number[], human: readonly number[]): Stat {
  assertAligned(judge, human);
  const diffs: number[] = [];
  for (let i = 0; i < judge.length; i++) diffs.push(judge[i]! - human[i]!);
  return meanStat(diffs, 'no items');
}

// ---------------------------------------------------------------------------
// Raters (itemKey -> level index)
// ---------------------------------------------------------------------------

export type Rater = ReadonlyMap<string, number>;

/** Judge rater from score rows; null scores (unusable) are skipped. Duplicate item keys throw. */
export function raterFromJudge(scores: readonly JudgeScore[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of scores) {
    if (s.score === null) continue;
    if (m.has(s.itemKey)) throw new RangeError(`duplicate judge score for item "${s.itemKey}"`);
    m.set(s.itemKey, s.score);
  }
  return m;
}

/** One rater per annotator. Duplicate (annotator, item) throws (the importer rejects them). */
export function ratersFromAnnotations(annotations: readonly Annotation[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const a of annotations) {
    let r = out.get(a.annotatorId);
    if (!r) {
      r = new Map<string, number>();
      out.set(a.annotatorId, r);
    }
    if (r.has(a.itemKey)) throw new RangeError(`duplicate annotation (${a.annotatorId}, ${a.itemKey})`);
    r.set(a.itemKey, a.score);
  }
  return out;
}

/** Aligned score arrays over the occurrences rated by both raters (repeats kept). */
export function alignRaters(a: Rater, b: Rater, occurrences: Iterable<string>): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const key of occurrences) {
    const x = a.get(key);
    const y = b.get(key);
    if (x !== undefined && y !== undefined) {
      xs.push(x);
      ys.push(y);
    }
  }
  return { xs, ys };
}

/** QWK of two raters over the given occurrences; n = number of aligned occurrences. */
export function pairKappa(a: Rater, b: Rater, occurrences: Iterable<string>, k: number): { n: number; kappa: Stat } {
  const { xs, ys } = alignRaters(a, b, occurrences);
  return { n: xs.length, kappa: quadraticWeightedKappa(xs, ys, k) };
}

// ---------------------------------------------------------------------------
// Mean over rater pairs (ceiling and judge agreement)
// ---------------------------------------------------------------------------

export type PairStat = {
  /** "A~B" for annotator pairs, "judge~A" for judge-annotator pairs. */
  id: string;
  raterA: string;
  raterB: string;
  /** Distinct shared items within the item set. */
  n: number;
  kappa: Stat;
  /** n >= overlap floor. */
  included: boolean;
};

export type MeanAgreement = {
  /** Equal-weight mean over `basis`; undefined when the basis is empty. */
  value: Stat;
  overlapFloor: number;
  /** Every candidate pair (sorted by id). */
  pairs: PairStat[];
  /** Included pairs whose point kappa is defined: the members of the mean. */
  basis: PairStat[];
  /** Pairs below the overlap floor (listed with n). */
  excluded: PairStat[];
};

export type AgreementOptions = {
  overlapFloor?: number;
  /** Restrict to these items (e.g. the dev split). Default: every item the raters share. */
  itemKeys?: readonly string[];
};

type Candidate = { id: string; raterA: string; raterB: string; a: Rater; b: Rater };
type BasisPair = { stat: PairStat; a: Rater; b: Rater };

function resolveFloor(floor: number | undefined): number {
  const f = floor ?? DEFAULT_OVERLAP_FLOOR;
  if (!Number.isInteger(f) || f < 0) throw new RangeError(`overlapFloor must be a non-negative integer`);
  return f;
}

function evaluateCandidates(
  candidates: readonly Candidate[],
  itemKeys: readonly string[] | undefined,
  k: number,
  overlapFloor: number,
  emptyReason: string,
): { result: MeanAgreement; basisPairs: BasisPair[] } {
  const universe = itemKeys === undefined ? undefined : [...new Set(itemKeys)];
  const pairs: PairStat[] = [];
  const basisPairs: BasisPair[] = [];
  for (const c of [...candidates].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    const occ = universe ?? [...c.a.keys()];
    const { n, kappa } = pairKappa(c.a, c.b, occ, k);
    const stat: PairStat = { id: c.id, raterA: c.raterA, raterB: c.raterB, n, kappa, included: n >= overlapFloor };
    pairs.push(stat);
    if (stat.included && kappa.kind === 'value') basisPairs.push({ stat, a: c.a, b: c.b });
  }
  const basis = basisPairs.map((p) => p.stat);
  const valueStat = basis.length === 0 ? undef(emptyReason) : meanStat(basis.map((p) => (p.kappa as { value: number }).value));
  return {
    result: { value: valueStat, overlapFloor, pairs, basis, excluded: pairs.filter((p) => !p.included) },
    basisPairs,
  };
}

/** Mean QWK over a frozen basis on one draw; undefined if the basis is empty or any member is undefined. */
export function meanKappaOverBasis(basis: readonly { id: string; a: Rater; b: Rater }[], occurrences: readonly string[], k: number): Stat {
  if (basis.length === 0) return undef('empty basis');
  const vals: number[] = [];
  for (const p of basis) {
    const { kappa } = pairKappa(p.a, p.b, occurrences, k);
    if (kappa.kind === 'undefined') return undef(`basis member ${p.id}: ${kappa.reason}`);
    vals.push(kappa.value);
  }
  return meanStat(vals);
}

function annotatorPairCandidates(annotations: readonly Annotation[]): Candidate[] {
  const raters = ratersFromAnnotations(annotations);
  const ids = [...raters.keys()].sort();
  const out: Candidate[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!;
      const b = ids[j]!;
      out.push({ id: `${a}~${b}`, raterA: a, raterB: b, a: raters.get(a)!, b: raters.get(b)! });
    }
  }
  return out;
}

function judgeCandidates(judge: readonly JudgeScore[], annotations: readonly Annotation[]): Candidate[] {
  const j = raterFromJudge(judge);
  const raters = ratersFromAnnotations(annotations);
  return [...raters.keys()].sort().map((id) => ({ id: `judge~${id}`, raterA: 'judge', raterB: id, a: j, b: raters.get(id)! }));
}

const NO_CEILING_PAIR = 'no annotator pair with a defined kappa meets the overlap floor';
const NO_JUDGE_PAIR = 'no annotator with a defined judge kappa meets the overlap floor';

/** Human reference level (observed, not an upper bound). */
export function referenceCeiling(annotations: readonly Annotation[], k: number, opts: AgreementOptions = {}): MeanAgreement {
  return evaluateCandidates(annotatorPairCandidates(annotations), opts.itemKeys, k, resolveFloor(opts.overlapFloor), NO_CEILING_PAIR)
    .result;
}

/** Judge-vs-human agreement: equal-weight mean of judge-vs-single-annotator QWK. */
export function judgeAgreement(
  judge: readonly JudgeScore[],
  annotations: readonly Annotation[],
  k: number,
  opts: AgreementOptions = {},
): MeanAgreement {
  return evaluateCandidates(judgeCandidates(judge, annotations), opts.itemKeys, k, resolveFloor(opts.overlapFloor), NO_JUDGE_PAIR)
    .result;
}

export type MeanAgreementWithInterval = MeanAgreement & { interval: Interval };

type IntervalOptions = BootstrapOptions & { overlapFloor?: number };

function withInterval(
  candidates: readonly Candidate[],
  k: number,
  units: readonly ResampleUnit[],
  opts: IntervalOptions,
  emptyReason: string,
): MeanAgreementWithInterval {
  const floor = resolveFloor(opts.overlapFloor);
  const { result, basisPairs } = evaluateCandidates(candidates, allItemKeys(units), k, floor, emptyReason);
  const basis = basisPairs.map((p) => ({ id: p.stat.id, a: p.a, b: p.b }));
  const interval =
    basis.length === 0
      ? bootstrapInterval(units, () => undef(emptyReason), opts)
      : bootstrapInterval(units, (occ) => meanKappaOverBasis(basis, occ, k), opts);
  return { ...result, interval };
}

/** Reference ceiling with a group-bootstrap interval; the item universe is the units' items. */
export function referenceCeilingWithInterval(
  annotations: readonly Annotation[],
  k: number,
  units: readonly ResampleUnit[],
  opts: IntervalOptions,
): MeanAgreementWithInterval {
  return withInterval(annotatorPairCandidates(annotations), k, units, opts, NO_CEILING_PAIR);
}

/** Judge agreement with a group-bootstrap interval; the item universe is the units' items. */
export function judgeAgreementWithInterval(
  judge: readonly JudgeScore[],
  annotations: readonly Annotation[],
  k: number,
  units: readonly ResampleUnit[],
  opts: IntervalOptions,
): MeanAgreementWithInterval {
  return withInterval(judgeCandidates(judge, annotations), k, units, opts, NO_JUDGE_PAIR);
}
