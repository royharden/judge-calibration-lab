// Seeded PRNG: xoshiro128** whose 128-bit state is filled by splitmix32(seed).
// Every random step in the lab takes an explicit seed; separate concerns use
// separate streams via deriveStream(seed, label) so adding draws to one stream
// never shifts another (e.g. split vs bootstrap vs mock noise).

import { sha256Bytes, utf8Bytes } from './sha256.ts';

export const PRNG_ALGO_VERSION = 'xoshiro128starstar+splitmix32/v1';

export type Prng = {
  /** Uniform integer in [0, 2^32). */
  nextUint32(): number;
  /** Uniform float in [0, 1) with 32 bits of resolution. */
  nextFloat(): number;
  /** Unbiased uniform integer in [0, n), n an integer in [1, 2^32]. */
  int(n: number): number;
  /** Fisher–Yates shuffled COPY of `items` (input untouched). */
  shuffle<T>(items: readonly T[]): T[];
};

const TWO_32 = 0x100000000;

function assertSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed >= TWO_32) {
    throw new RangeError(`PRNG seed must be an unsigned 32-bit integer, got ${String(seed)}`);
  }
}

/** splitmix32 generator (Weyl increment 0x9e3779b9 + murmur3-style finaliser). */
export function splitmix32(seed: number): () => number {
  assertSeed(seed);
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/** Create a xoshiro128** generator seeded through splitmix32. */
export function createPrng(seed: number): Prng {
  const sm = splitmix32(seed);
  let s0 = sm();
  let s1 = sm();
  let s2 = sm();
  let s3 = sm();
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1; // all-zero state is a fixed point; practically unreachable

  function nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);
    return result;
  }

  function nextFloat(): number {
    return nextUint32() / TWO_32;
  }

  function int(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > TWO_32) throw new RangeError(`int(n) needs 1 <= n <= 2^32, got ${String(n)}`);
    // Rejection sampling removes modulo bias.
    const limit = TWO_32 - (TWO_32 % n);
    for (;;) {
      const r = nextUint32();
      if (r < limit) return r % n;
    }
  }

  function shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  }

  return { nextUint32, nextFloat, int, shuffle };
}

/** Deterministic 32-bit seed for a named sub-stream: first 4 bytes (big-endian) of sha256. */
export function deriveSeed(seed: number, label: string): number {
  assertSeed(seed);
  const d = sha256Bytes(utf8Bytes(`prng-stream/v1:${seed}:${label}`));
  return ((d[0]! << 24) | (d[1]! << 16) | (d[2]! << 8) | d[3]!) >>> 0;
}

/** Independent generator for `label` derived from `seed`. */
export function deriveStream(seed: number, label: string): Prng {
  return createPrng(deriveSeed(seed, label));
}
