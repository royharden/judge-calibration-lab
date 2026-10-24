import { describe, expect, it } from 'vitest';
import { containsTokens, PAIR_MIN_RATIO, pairCheck } from '../../../src/core/probes/pairCheck.ts';

const SHORT = 'The ferry runs every hour until midnight.';
const LONG =
  'According to the timetable, boats leave the harbour every hour, and the last crossing of the day departs just before midnight, so evening travellers still have options.';

describe('pairCheck', () => {
  it('passes a separately written, longer, fact-preserving pair', () => {
    const r = pairCheck({ short: SHORT, long: LONG, facts: ['every hour', 'midnight'] });
    expect(r).toMatchObject({ pass: true, reasons: [], missingFacts: [] });
    expect(r.ratio).toBeGreaterThanOrEqual(PAIR_MIN_RATIO);
  });

  it('rejects padded filler: short contained in long after normalisation', () => {
    const r = pairCheck({ short: SHORT, long: `the FERRY runs, every hour until midnight!! ${'and so on '.repeat(5)}` });
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('short_in_long');
  });

  it('containment is on whole tokens, not substrings', () => {
    expect(containsTokens(['concatenate', 'things'], ['cat'])).toBe(false);
    expect(containsTokens(['a', 'cat', 'sat'], ['cat', 'sat'])).toBe(true);
    expect(containsTokens(['a'], [])).toBe(false);
  });

  it('rejects a fact missing from either text', () => {
    const r = pairCheck({ short: SHORT, long: LONG, facts: ['every hour', 'harbour'] });
    expect(r.reasons).toEqual(['missing_fact']);
    expect(r.missingFacts).toEqual(['harbour']);
  });

  it('rejects a long text under 1.5x the short in words', () => {
    const r = pairCheck({ short: 'one two three four', long: 'five six seven eight nine' });
    expect(r.reasons).toEqual(['length_ratio']);
    expect(pairCheck({ short: 'one two three four', long: 'five six seven eight nine ten' }).pass).toBe(true);
  });

  it('rejects a ratio hidden by punctuation-stripping normalized token counts', () => {
    expect(pairCheck({ short: 'alpha beta -- --', long: 'gamma delta epsilon' })).toMatchObject({
      pass: false, reasons: ['length_ratio'], shortWords: 4, longWords: 3, ratio: 0.75,
    });
  });

  it.each([
    { long: 'gamma delta epsilon -- --', longWords: 5, pass: false },
    { long: 'gamma delta epsilon -- -- --', longWords: 6, pass: true },
    { long: 'gamma delta epsilon -- -- -- --', longWords: 7, pass: true },
  ])('uses whitespace words at the 1.5x boundary: $longWords / 4', ({ long, longWords, pass }) => {
    const r = pairCheck({ short: ' \talpha beta -- --\u2003', long });
    expect(r).toMatchObject({ pass, shortWords: 4, longWords, ratio: longWords / 4 });
    expect(r.reasons).toEqual(pass ? [] : ['length_ratio']);
  });

  it('reports every failing rule together, and empty texts', () => {
    const r = pairCheck({ short: 'a b c d', long: 'a b c d e', facts: ['zzz'] });
    expect(r.reasons).toEqual(['short_in_long', 'missing_fact', 'length_ratio']);
    expect(pairCheck({ short: '...', long: 'some words here' }).reasons).toEqual(['empty_text']);
    expect(pairCheck({ short: ' \t\n ', long: 'x' }).ratio).toBeNull();
  });
});
