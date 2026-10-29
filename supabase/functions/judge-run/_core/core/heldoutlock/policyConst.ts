// Held-out policy constant `s36-v1` (PLAN.md §3.9, K6, K16).
//
// This is the ONLY policy the lab accepts (K6): a preregistration pins this constant's version
// and hash, and anything that is not byte-equal (canonical JSON) to it is refused. There is no
// "custom policy" path. The numeric constants are proposals (PLAN.md §6.4) until results exist,
// but they are frozen for this version: changing any of them requires a new version string.
//
// The same constant is mirrored server-side (SQL / judge-run) and checked by hash.

import { canonicalJson, CANONICAL_VERSION } from '../canonical.ts';
import { PRNG_ALGO_VERSION } from '../prng.ts';
import { err, ok, type Reason, type Result } from '../result.ts';
import { sha256Hex } from '../sha256.ts';
import { TOKENIZER_VERSION } from '../tokenize.ts';
import { BOOTSTRAP_ALGO_VERSION } from '../judgestats/bootstrap.ts';
import { PAV_ALGO_VERSION } from '../judgestats/pav.ts';
import { QUANTILE_ALGO_VERSION } from '../judgestats/quantile.ts';

export const POLICY_VERSION = 's36-v1';

/**
 * Split algorithm version pinned by s36-v1. Written as a literal (not imported) because
 * `goldset/split.ts` belongs to another milestone; tests assert it equals
 * `SPLIT_ALGO_VERSION` from `src/core/goldset/split.ts` so drift is caught.
 */
export const PINNED_SPLIT_ALGO_VERSION = 'stratified-group-greedy/v1';

export type AlgorithmVersions = {
  readonly split: string;
  readonly prng: string;
  readonly quantile: string;
  readonly pav: string;
  readonly tokenizer: string;
  readonly bootstrap: string;
  readonly canonical: string;
};

export type HeldoutPolicy = {
  readonly version: string;
  /** Equal-weight mean of judge-vs-single-annotator QWK over the frozen annotator basis. */
  readonly primaryMetric: 'mean_judge_annotator_qwk';
  /** improved iff paired 95% lower bound > 0; worse iff upper bound < 0; else no detectable change. */
  readonly verdictRule: 'paired_ci95_lo_gt_0_improved__hi_lt_0_worse__else_no_detectable_change';
  readonly confidence: number;
  /** Minimum common evaluable held-out n (and per-split n at freeze). */
  readonly nFloor: number;
  /** Minimum shared items for a rater pair to enter a kappa mean. */
  readonly overlapFloor: number;
  /** Missingness tolerance T = max(tMin, floor(tFraction * N_planned)). */
  readonly missingness: { readonly rule: 'T=max(2,floor(0.05*N))'; readonly tMin: number; readonly tFraction: number };
  readonly bootstrap: {
    readonly method: 'paired_percentile_group';
    readonly seed: number;
    readonly resamples: number;
    readonly quantile: 'type7';
    readonly streamLabel: string;
    readonly maxUndefinedShare: number;
  };
  /** Innocent band, level units. */
  readonly band: number;
  /** Jev promotion equivalence margin on paired delta-kappa (proposal, K15). */
  readonly jevMargin: number;
  /** Max distinct rubric hashes looked per scope unless burned. */
  readonly maxDistinctLooks: number;
  readonly algorithmVersions: AlgorithmVersions;
};

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** The frozen `s36-v1` policy constant. */
export const S36_V1: HeldoutPolicy = deepFreeze({
  version: POLICY_VERSION,
  primaryMetric: 'mean_judge_annotator_qwk',
  verdictRule: 'paired_ci95_lo_gt_0_improved__hi_lt_0_worse__else_no_detectable_change',
  confidence: 0.95,
  nFloor: 20,
  overlapFloor: 10,
  missingness: { rule: 'T=max(2,floor(0.05*N))', tMin: 2, tFraction: 0.05 },
  bootstrap: {
    method: 'paired_percentile_group',
    seed: 36,
    resamples: 2000,
    quantile: 'type7',
    streamLabel: 'bootstrap',
    maxUndefinedShare: 0.1,
  },
  band: 0.25,
  jevMargin: 0.05,
  maxDistinctLooks: 2,
  algorithmVersions: {
    split: PINNED_SPLIT_ALGO_VERSION,
    prng: PRNG_ALGO_VERSION,
    quantile: QUANTILE_ALGO_VERSION,
    pav: PAV_ALGO_VERSION,
    tokenizer: TOKENIZER_VERSION,
    bootstrap: BOOTSTRAP_ALGO_VERSION,
    canonical: CANONICAL_VERSION,
  },
} satisfies HeldoutPolicy);

/** Canonical JSON text of a policy (sorted keys, no whitespace). */
export function policyCanonicalJson(policy: HeldoutPolicy): string {
  return canonicalJson(policy);
}

/** sha256 hex of the canonical JSON of a policy. */
export function computePolicyHash(policy: HeldoutPolicy): string {
  return sha256Hex(policyCanonicalJson(policy));
}

/** policyHash of `s36-v1`. */
export const policyHash: string = computePolicyHash(S36_V1);

const STANDARD_JSON = policyCanonicalJson(S36_V1);

export type PolicyRefusal = Reason<'custom_policy_refused'>;

/**
 * Accept only a policy byte-equal (canonical JSON) to `s36-v1`. Any other value — a changed
 * constant, an extra field, a different version string, a non-JSON value — is refused.
 * Returns the frozen standard constant on success (never the caller's object).
 */
export function assertStandardPolicy(p: unknown): Result<HeldoutPolicy, PolicyRefusal> {
  let text: string;
  try {
    text = canonicalJson(p);
  } catch {
    return err({ reason: 'custom_policy_refused', message: 'policy is not a canonical JSON value; only s36-v1 is accepted' });
  }
  if (text !== STANDARD_JSON) {
    return err({ reason: 'custom_policy_refused', message: `only policy ${POLICY_VERSION} (hash ${policyHash}) is accepted` });
  }
  return ok(S36_V1);
}

/** Accept a pinned (version, hash) reference only when it names `s36-v1` exactly. */
export function assertStandardPolicyRef(version: string, hash: string): Result<HeldoutPolicy, PolicyRefusal> {
  if (version !== POLICY_VERSION || hash !== policyHash) {
    return err({ reason: 'custom_policy_refused', message: `pinned policy ${version}/${hash} is not ${POLICY_VERSION}/${policyHash}` });
  }
  return ok(S36_V1);
}

/** Bootstrap options (judgestats) implied by a policy. */
export function policyBootstrapOptions(policy: HeldoutPolicy = S36_V1): {
  seed: number;
  resamples: number;
  streamLabel: string;
  maxUndefinedShare: number;
  confidence: number;
  overlapFloor: number;
} {
  return {
    seed: policy.bootstrap.seed,
    resamples: policy.bootstrap.resamples,
    streamLabel: policy.bootstrap.streamLabel,
    maxUndefinedShare: policy.bootstrap.maxUndefinedShare,
    confidence: policy.confidence,
    overlapFloor: policy.overlapFloor,
  };
}
