import { describe, expect, it } from 'vitest';
import { canonicalHash, canonicalJson, normalizeDeep, normalizeText } from '../../src/core/canonical.ts';

describe('normalizeText', () => {
  it('CRLF and CR become LF', () => {
    expect(normalizeText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('applies NFC (decomposed e + combining acute == precomposed é)', () => {
    expect(normalizeText('café')).toBe('café');
  });

  it('trims trailing whitespace on every line, keeps leading whitespace', () => {
    expect(normalizeText('  a  \t\n b \r\n\tc ')).toBe('  a\n b\n\tc');
  });

  it('is idempotent', () => {
    const s = 'x \r\n ý  ';
    expect(normalizeText(normalizeText(s))).toBe(normalizeText(s));
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every depth and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 2], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,2]},"b":1}');
  });

  it('is invariant to key insertion order', () => {
    const a = { task: 't', answer: 'a', source: 's', facts: ['f1', 'f2'] };
    const b = { facts: ['f1', 'f2'], source: 's', answer: 'a', task: 't' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('keeps array order (arrays are ordered data)', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('omits undefined object members, encodes undefined array slots as null', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson([1, undefined])).toBe('[1,null]');
  });

  it('serialises -0 as 0', () => {
    expect(canonicalJson({ x: -0 })).toBe('{"x":0}');
  });

  it('rejects non-finite numbers, non-plain objects, functions and cycles', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson({ x: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError);
    expect(() => canonicalJson(new Map())).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalJson(cyc)).toThrow(TypeError);
  });

  it('allows the same object twice when it is not a cycle', () => {
    const shared = { v: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"v":1},"b":{"v":1}}');
  });
});

describe('canonicalHash invariance', () => {
  it('same content hashes the same regardless of newline style, NFC form, trailing spaces and key order', () => {
    const a = { task: 'Summarise:\r\nline two  ', answer: 'café', facts: ['x'] };
    const b = { facts: ['x'], answer: 'café', task: 'Summarise:\nline two' };
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it('different content hashes differently', () => {
    expect(canonicalHash({ answer: 'a' })).not.toBe(canonicalHash({ answer: 'b' }));
  });

  it('normalizeDeep does not mutate its input', () => {
    const input = { t: 'a\r\n' };
    normalizeDeep(input);
    expect(input.t).toBe('a\r\n');
  });
});
