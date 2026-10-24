import { describe, expect, it } from 'vitest';
import {
  actualCostUsd,
  findPrice,
  projectedAttemptUsd,
  projectedInputTokens,
  projectedOutputTokens,
  resolvePrice,
  usdFor,
  utf8ByteLength,
  worstCaseAttemptUsd,
  worstCaseInputTokens,
  type PriceBook,
} from '../../../src/core/plan/costBound.ts';
import { unwrap } from '../../../src/core/result.ts';

const book: PriceBook = [
  { provider: 'anthropic', model: 'claude-small', usdPerInputMTok: 1, usdPerOutputMTok: 5, effectiveDate: '2026-01-01' },
  { provider: 'anthropic', model: 'claude-small', usdPerInputMTok: 0.8, usdPerOutputMTok: 4, effectiveDate: '2026-06-01' },
  { provider: 'anthropic', model: 'claude-small', usdPerInputMTok: 0.5, usdPerOutputMTok: 2, effectiveDate: '2027-01-01' },
  { provider: 'typesafe', model: 'jev-1.13.0', usdPerInputMTok: 0.2, usdPerOutputMTok: 0, effectiveDate: '2026-01-01' },
];

describe('token bounds', () => {
  it('projected input ≈ ceil(bytes / 4); worst case = bytes', () => {
    expect(projectedInputTokens(0)).toBe(0);
    expect(projectedInputTokens(1)).toBe(1);
    expect(projectedInputTokens(4)).toBe(1);
    expect(projectedInputTokens(5)).toBe(2);
    expect(worstCaseInputTokens(5)).toBe(5);
    for (let b = 0; b < 200; b++) expect(worstCaseInputTokens(b)).toBeGreaterThanOrEqual(projectedInputTokens(b));
  });

  it('projected output is capped by maxOutputTokens', () => {
    expect(projectedOutputTokens(64)).toBe(8);
    expect(projectedOutputTokens(4)).toBe(4);
  });

  it('rejects non-integer byte counts', () => {
    expect(() => projectedInputTokens(1.5)).toThrow(RangeError);
    expect(() => worstCaseInputTokens(-1)).toThrow(RangeError);
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
  });
});

describe('pricing', () => {
  it('input and output are priced separately', () => {
    const p = unwrap(resolvePrice(book, 'anthropic', 'claude-small', '2026-03-01'));
    expect(p.usdPerInputMTok).toBe(1);
    expect(usdFor(1_000_000, 0, p)).toBeCloseTo(1, 12);
    expect(usdFor(0, 1_000_000, p)).toBeCloseTo(5, 12);
    expect(usdFor(2000, 100, p)).toBeCloseTo((2000 * 1 + 100 * 5) / 1e6, 15);
  });

  it('uses the latest entry effective on the date', () => {
    expect(findPrice(book, 'anthropic', 'claude-small', '2025-12-31')).toBeNull();
    expect(findPrice(book, 'anthropic', 'claude-small', '2026-06-01')!.usdPerInputMTok).toBe(0.8);
    expect(findPrice(book, 'anthropic', 'claude-small')!.usdPerInputMTok).toBe(0.5);
  });

  it('missing price for a live provider => missing_price; mock => $0', () => {
    const r = resolvePrice(book, 'openai_compatible', 'some-model');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('missing_price');
    const m = unwrap(resolvePrice([], 'mock', 'merges-3-4'));
    expect(m.kind).toBe('mock_free');
    expect(worstCaseAttemptUsd(10_000, 64, m)).toBe(0);
  });

  it('worst-case attempt cost ≥ projected ≥ 0, and ≥ any settled cost whose usage respects the bounds', () => {
    const p = unwrap(resolvePrice(book, 'anthropic', 'claude-small', '2026-03-01'));
    const bytes = 3_217;
    const maxOut = 64;
    const worst = worstCaseAttemptUsd(bytes, maxOut, p);
    expect(worst).toBeGreaterThanOrEqual(projectedAttemptUsd(bytes, maxOut, p));
    // Realistic usage: ~4 bytes/token in, a short JSON answer out.
    expect(actualCostUsd({ inputTokens: 820, outputTokens: 6 }, p)).toBeLessThanOrEqual(worst);
    // Extreme usage at the bound itself.
    expect(actualCostUsd({ inputTokens: bytes, outputTokens: maxOut }, p)).toBeCloseTo(worst, 15);
  });
});
