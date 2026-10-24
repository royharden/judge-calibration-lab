import { describe, expect, it } from 'vitest';
import { formatScoreJson, parseJudgeOutput, topLevelKeys } from '../../../src/core/judge/parse.ts';
import { MALFORMED_JUDGE_OUTPUTS } from '../../../src/core/fixtures/traps.ts';

const VALUES_1_5 = [1, 2, 3, 4, 5];

describe('parseJudgeOutput accept / reject table (1-5 scale)', () => {
  for (const c of MALFORMED_JUDGE_OUTPUTS) {
    it(`${JSON.stringify(c.raw)} -> ${JSON.stringify(c.expect)}`, () => {
      const r = parseJudgeOutput(c.raw, VALUES_1_5);
      if ('index' in c.expect) {
        expect(r).toEqual({ kind: 'score', index: c.expect.index, value: VALUES_1_5[c.expect.index] });
      } else {
        expect(r).toEqual({ kind: 'unusable', reason: c.expect.unusable });
      }
    });
  }

  it('5 on a 1-5 scale normalises to index 4; 1 to index 0', () => {
    expect(parseJudgeOutput('{"score": 5}', VALUES_1_5)).toEqual({ kind: 'score', index: 4, value: 5 });
    expect(parseJudgeOutput('{"score":1}', VALUES_1_5)).toEqual({ kind: 'score', index: 0, value: 1 });
  });

  it('uses the displayed values of the scale, not 1..K', () => {
    expect(parseJudgeOutput('{"score": 0}', [0, 1, 2])).toEqual({ kind: 'score', index: 0, value: 0 });
    expect(parseJudgeOutput('{"score": 3}', [0, 1, 2])).toEqual({ kind: 'unusable', reason: 'out_of_scale' });
    expect(parseJudgeOutput('{"score": 10}', [0, 5, 10])).toEqual({ kind: 'score', index: 2, value: 10 });
  });

  it('nested keys do not count as top-level keys', () => {
    expect(parseJudgeOutput('{"meta": {"score": 2}}', VALUES_1_5)).toEqual({ kind: 'unusable', reason: 'missing_score' });
    expect(parseJudgeOutput('{"score": 2, "meta": {"score": 3}}', VALUES_1_5)).toEqual({ kind: 'unusable', reason: 'extra_keys' });
  });

  it('never repairs: surrounding prose or fences stay unusable', () => {
    expect(parseJudgeOutput('Sure! {"score": 3}', VALUES_1_5).kind).toBe('unusable');
    expect(parseJudgeOutput('{"score": 3}\n{"score": 4}', VALUES_1_5).kind).toBe('unusable');
  });

  it('formatScoreJson round-trips', () => {
    for (const v of VALUES_1_5) expect(parseJudgeOutput(formatScoreJson(v), VALUES_1_5)).toEqual({ kind: 'score', index: v - 1, value: v });
  });
});

describe('topLevelKeys', () => {
  it('lists keys in order, keeps duplicates, ignores nested keys and braces inside strings', () => {
    expect(topLevelKeys('{"a": 1, "b": {"c": [1, {"d": 2}]}, "e": "}{,\\"x"}')).toEqual(['a', 'b', 'e']);
    expect(topLevelKeys('{"score": 1, "score": 2}')).toEqual(['score', 'score']);
    expect(topLevelKeys('{}')).toEqual([]);
    expect(topLevelKeys('{"s\\u0063ore": 1}')).toEqual(['score']);
  });
});
