import { describe, expect, it } from 'vitest';
import { bigrams, tokenize, unigrams, wordCount } from '../../src/core/tokenize.ts';

describe('tokenize', () => {
  it('lowercases, strips punctuation and splits on whitespace', () => {
    expect(tokenize('Hello, World!  It   works.')).toEqual(['hello', 'world', 'it', 'works']);
  });

  it('deletes punctuation inside words (apostrophes, hyphens)', () => {
    expect(tokenize("Don't over-think")).toEqual(['dont', 'overthink']);
  });

  it('is Unicode-aware (accents kept, em dash and guillemets stripped)', () => {
    expect(tokenize('Café — «naïve»')).toEqual(['café', 'naïve']);
  });

  it('treats newlines, tabs and non-breaking spaces as separators', () => {
    expect(tokenize('a\r\nb\tc d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('empty / punctuation-only text has no tokens', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(' ... !! ')).toEqual([]);
    expect(wordCount('')).toBe(0);
  });

  it('wordCount counts tokens', () => {
    expect(wordCount('One two, three.')).toBe(3);
  });
});

describe('n-grams', () => {
  it('unigrams copy the tokens', () => {
    const t = ['a', 'b'];
    const u = unigrams(t);
    expect(u).toEqual(t);
    expect(u).not.toBe(t);
  });

  it('bigrams join adjacent tokens', () => {
    expect(bigrams(['a', 'b', 'c'])).toEqual(['a b', 'b c']);
    expect(bigrams(['a'])).toEqual([]);
    expect(bigrams([])).toEqual([]);
  });
});
