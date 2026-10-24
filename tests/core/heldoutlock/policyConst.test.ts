import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/core/canonical.ts';
import { SPLIT_ALGO_VERSION } from '../../../src/core/goldset/split.ts';
import {
  assertStandardPolicy,
  assertStandardPolicyRef,
  computePolicyHash,
  policyBootstrapOptions,
  policyHash,
  POLICY_VERSION,
  S36_V1,
} from '../../../src/core/heldoutlock/policyConst.ts';
import { PAV_ALGO_VERSION } from '../../../src/core/judgestats/pav.ts';
import { QUANTILE_ALGO_VERSION } from '../../../src/core/judgestats/quantile.ts';
import { PRNG_ALGO_VERSION } from '../../../src/core/prng.ts';
import { sha256Hex } from '../../../src/core/sha256.ts';
import { TOKENIZER_VERSION } from '../../../src/core/tokenize.ts';

describe('s36-v1 policy constant', () => {
  it('carries every §3.9 field with the frozen values', () => {
    expect(S36_V1.version).toBe('s36-v1');
    expect(POLICY_VERSION).toBe('s36-v1');
    expect(S36_V1.primaryMetric).toBe('mean_judge_annotator_qwk');
    expect(S36_V1.confidence).toBe(0.95);
    expect(S36_V1.nFloor).toBe(20);
    expect(S36_V1.overlapFloor).toBe(10);
    expect(S36_V1.missingness).toEqual({ rule: 'T=max(2,floor(0.05*N))', tMin: 2, tFraction: 0.05 });
    expect(S36_V1.bootstrap.seed).toBe(36);
    expect(S36_V1.bootstrap.resamples).toBe(2000);
    expect(S36_V1.bootstrap.quantile).toBe('type7');
    expect(S36_V1.bootstrap.maxUndefinedShare).toBe(0.1);
    expect(S36_V1.band).toBe(0.25);
    expect(S36_V1.jevMargin).toBe(0.05);
    expect(S36_V1.maxDistinctLooks).toBe(2);
  });

  it('pins the algorithm versions of the shared code', () => {
    expect(S36_V1.algorithmVersions.prng).toBe(PRNG_ALGO_VERSION);
    expect(S36_V1.algorithmVersions.quantile).toBe(QUANTILE_ALGO_VERSION);
    expect(S36_V1.algorithmVersions.pav).toBe(PAV_ALGO_VERSION);
    expect(S36_V1.algorithmVersions.tokenizer).toBe(TOKENIZER_VERSION);
  });

  it('pinned split algorithm version equals goldset/split.ts (drift guard)', () => {
    expect(S36_V1.algorithmVersions.split).toBe(SPLIT_ALGO_VERSION);
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(S36_V1)).toBe(true);
    expect(Object.isFrozen(S36_V1.bootstrap)).toBe(true);
    expect(Object.isFrozen(S36_V1.algorithmVersions)).toBe(true);
    expect(() => {
      (S36_V1 as { nFloor: number }).nFloor = 5;
    }).toThrow();
  });

  it('policyHash = sha256 of the canonical JSON', () => {
    expect(policyHash).toBe(sha256Hex(canonicalJson(S36_V1)));
    expect(computePolicyHash(S36_V1)).toBe(policyHash);
    expect(policyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('bootstrap options follow the policy', () => {
    expect(policyBootstrapOptions()).toEqual({ seed: 36, resamples: 2000, streamLabel: 'bootstrap', maxUndefinedShare: 0.1, confidence: 0.95, overlapFloor: 10 });
  });
});

describe('assertStandardPolicy (K6: custom policy refused)', () => {
  it('accepts s36-v1 and a byte-equal copy, returning the frozen constant', () => {
    const r1 = assertStandardPolicy(S36_V1);
    expect(r1.ok).toBe(true);
    const copy = JSON.parse(JSON.stringify(S36_V1)) as unknown;
    const r2 = assertStandardPolicy(copy);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toBe(S36_V1);
  });

  it.each([
    ['lower n floor', { ...S36_V1, nFloor: 12 }],
    ['three looks', { ...S36_V1, maxDistinctLooks: 3 }],
    ['other seed', { ...S36_V1, bootstrap: { ...S36_V1.bootstrap, seed: 37 } }],
    ['fewer resamples', { ...S36_V1, bootstrap: { ...S36_V1.bootstrap, resamples: 500 } }],
    ['wider band', { ...S36_V1, band: 0.5 }],
    ['renamed version', { ...S36_V1, version: 's36-v1-custom' }],
    ['extra field', { ...S36_V1, note: 'custom policy' }],
    ['other quantile', { ...S36_V1, bootstrap: { ...S36_V1.bootstrap, quantile: 'type6' } }],
    ['a string', 's36-v1'],
    ['null', null],
    ['a non-JSON value', { ...S36_V1, nFloor: Number.NaN }],
  ])('refuses %s', (_name, candidate) => {
    const r = assertStandardPolicy(candidate);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('custom_policy_refused');
  });

  it('assertStandardPolicyRef accepts only (s36-v1, policyHash)', () => {
    expect(assertStandardPolicyRef('s36-v1', policyHash).ok).toBe(true);
    expect(assertStandardPolicyRef('s36-v1', '0'.repeat(64)).ok).toBe(false);
    expect(assertStandardPolicyRef('s36-v2', policyHash).ok).toBe(false);
  });
});
