import { describe, expect, it } from 'vitest';
import { bytesToHex, sha256Bytes, sha256Hex, utf8Bytes } from '../../src/core/sha256.ts';

// NIST FIPS 180-2 / CSRC example vectors.
describe('sha256 (NIST vectors)', () => {
  it('empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('"abc" (one block)', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('448-bit message (two blocks: padding spills into a second block)', () => {
    const msg = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    expect(msg.length * 8).toBe(448);
    expect(sha256Hex(msg)).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('896-bit message', () => {
    const msg =
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu';
    expect(sha256Hex(msg)).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
  });

  it('one million "a" (many blocks)', () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });
});

describe('sha256 helpers', () => {
  it('sha256Hex(s) equals hex of sha256Bytes(utf8(s)), including non-ASCII', () => {
    for (const s of ['', 'abc', 'café — naïve', '\u{1F600} emoji']) {
      expect(sha256Hex(s)).toBe(bytesToHex(sha256Bytes(utf8Bytes(s))));
    }
  });

  it('digest is 32 bytes and hex is 64 lowercase chars', () => {
    expect(sha256Bytes(new Uint8Array([1, 2, 3])).length).toBe(32);
    expect(sha256Hex('x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('block-boundary lengths (55, 56, 63, 64, 65 bytes) are distinct and well-formed', () => {
    const hashes = [55, 56, 63, 64, 65].map((n) => sha256Hex('a'.repeat(n)));
    expect(new Set(hashes).size).toBe(5);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not mutate the input bytes', () => {
    const data = new Uint8Array([9, 8, 7]);
    sha256Bytes(data);
    expect([...data]).toEqual([9, 8, 7]);
  });
});
