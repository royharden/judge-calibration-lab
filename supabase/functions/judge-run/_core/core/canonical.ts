// Canonicalisation used for every content hash (PLAN.md §3.4):
//  - text: Unicode NFC, CRLF / CR -> LF, trailing whitespace trimmed on every line;
//  - JSON: object keys sorted (UTF-16 code-unit order), no insignificant whitespace,
//    undefined object members omitted, non-finite numbers / non-plain objects rejected.

import { sha256Hex } from './sha256.ts';

export const CANONICAL_VERSION = 'nfc-lf-trimeol+sortedjson/v1';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };

/** NFC, normalised newlines, trailing whitespace removed per line (leading whitespace kept). */
export function normalizeText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+$/gm, '');
}

function isPlainObject(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Deeply normalise every string value with normalizeText() and every object key with NFC.
 * Returns a fresh structure; the input is not mutated.
 */
export function normalizeDeep(value: unknown): unknown {
  if (typeof value === 'string') return normalizeText(value);
  if (Array.isArray(value)) return value.map((v) => normalizeDeep(v));
  if (typeof value === 'object' && value !== null && isPlainObject(value)) {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) out[k.normalize('NFC')] = normalizeDeep(v);
    return out;
  }
  return value;
}

/**
 * Canonical JSON text: sorted keys, no whitespace. Throws TypeError on values that have no
 * canonical JSON form (undefined at top level / in arrays is encoded as null like JSON.stringify
 * does for arrays; functions, symbols, bigint, NaN/Infinity, Map/Set/Date/class instances, cycles).
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>());
}

function encode(v: unknown, stack: Set<object>): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError(`canonicalJson: non-finite number ${String(v)}`);
      return JSON.stringify(v); // -0 serialises as "0"
    case 'string':
      return JSON.stringify(v);
    case 'object': {
      if (stack.has(v)) throw new TypeError('canonicalJson: cyclic structure');
      stack.add(v);
      try {
        if (Array.isArray(v)) {
          return '[' + v.map((x: unknown) => (x === undefined ? 'null' : encode(x, stack))).join(',') + ']';
        }
        if (!isPlainObject(v)) throw new TypeError('canonicalJson: only plain objects and arrays are allowed');
        const rec = v as Record<string, unknown>;
        const keys = Object.keys(rec)
          .filter((k) => rec[k] !== undefined)
          .sort();
        return '{' + keys.map((k) => JSON.stringify(k) + ':' + encode(rec[k], stack)).join(',') + '}';
      } finally {
        stack.delete(v);
      }
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof v}`);
  }
}

/** sha256 hex of the canonical JSON of the deeply normalised value. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(normalizeDeep(value)));
}
