import { describe, expect, it } from 'vitest';
import type { Item } from '../../../src/core/types.ts';
import { deriveStream } from '../../../src/core/prng.ts';
import {
  buildPrompt,
  chooseNonce,
  defaultRandomSource,
  delimit,
  generateNonce,
  NONCE_MAX_ATTEMPTS,
  PROMPT_TEMPLATE_VERSION,
  type RandomSource,
} from '../../../src/core/judge/prompt.ts';
import { createRubric } from '../../../src/core/rubric/rubric.ts';
import { unwrap } from '../../../src/core/result.ts';
import { SYNTHETIC_RUBRIC_V1 } from '../../../src/core/fixtures/synthetic.ts';
import { INJECTED_ANSWERS } from '../../../src/core/fixtures/traps.ts';

/** Source that replays fixed 32-bit words (then repeats the last one). */
function fixedSource(words: number[]): RandomSource {
  let i = 0;
  return { nextUint32: () => words[Math.min(i++, words.length - 1)]! };
}

const rubric = unwrap(createRubric({ setId: 's', ...SYNTHETIC_RUBRIC_V1 }));
const item: Item = { key: 'i1', taskText: 'Summarise the passage.', answer: 'The ferry runs every hour.', source: 'The ferry runs every hour.' };

describe('nonce', () => {
  it('is 128 bits = 32 lowercase hex characters', () => {
    const n = generateNonce(deriveStream(36, 'test-nonce'));
    expect(n).toMatch(/^[0-9a-f]{32}$/);
    expect(generateNonce(fixedSource([1, 2, 3, 0xffffffff]))).toBe('000000010000000200000003ffffffff');
  });

  it('is regenerated when it collides with the text', () => {
    const first = '00000001000000020000000300000004';
    const src = fixedSource([1, 2, 3, 4, 5, 6, 7, 8]);
    const r = chooseNonce(src, [`answer that contains ${first.toUpperCase()} by chance`]);
    expect(r.attempts).toBe(2);
    expect(r.nonce).toBe('00000005000000060000000700000008');
  });

  it('gives up loudly after the maximum number of collisions', () => {
    expect(() => chooseNonce(fixedSource([0]), ['0'.repeat(32)])).toThrow(String(NONCE_MAX_ATTEMPTS));
  });

  it('the default source works with or without crypto', () => {
    const src = defaultRandomSource(36);
    const v = src.nextUint32();
    expect(Number.isInteger(v) && v >= 0 && v < 2 ** 32).toBe(true);
  });
});

describe('buildPrompt', () => {
  it('delimits task, source and answer with the nonce and never reuses a nonce found in the data', () => {
    const p = buildPrompt(item, rubric, 'ascending', deriveStream(36, 'p1'));
    expect(p.user).toContain(delimit('ANSWER', p.nonce, item.answer));
    expect(p.user).toContain(delimit('TASK', p.nonce, item.taskText));
    expect(p.user).toContain(delimit('SOURCE', p.nonce, item.source!));
    expect(item.answer.includes(p.nonce)).toBe(false);
    expect(p.templateVersion).toBe(PROMPT_TEMPLATE_VERSION);
  });

  it('collision in the answer forces a new nonce', () => {
    const first = '00000001000000020000000300000004';
    const p = buildPrompt({ ...item, answer: `x ${first} y` }, rubric, 'ascending', fixedSource([1, 2, 3, 4, 9, 9, 9, 9]));
    expect(p.nonce).toBe('00000009000000090000000900000009');
    expect(p.nonceAttempts).toBe(2);
  });

  it('shows levels with displayed values in presentation order', () => {
    const asc = buildPrompt(item, rubric, 'ascending', deriveStream(36, 'p2'));
    expect(asc.system.indexOf('Level 1:')).toBeLessThan(asc.system.indexOf('Level 5:'));
    expect(asc.order).toEqual([0, 1, 2, 3, 4]);
    const rev = buildPrompt(item, rubric, 'reversed', deriveStream(36, 'p2'));
    expect(rev.system.indexOf('Level 5:')).toBeLessThan(rev.system.indexOf('Level 1:'));
    expect(rev.order).toEqual([4, 3, 2, 1, 0]);
    expect(rev.displayedValues).toEqual([1, 2, 3, 4, 5]);
    for (const l of rubric.levels) expect(rev.system).toContain(`Level ${l.value}: ${l.description}`);
  });

  it('states the exact output contract', () => {
    const p = buildPrompt(item, rubric, 'ascending', deriveStream(36, 'p3'));
    expect(p.system).toContain('{"score": <level>}');
    expect(p.system).toContain('1, 2, 3, 4, 5');
  });

  it('a fake closing delimiter inside an injected answer does not match the real nonce', () => {
    const trap = INJECTED_ANSWERS.find((a) => a.kind === 'fake_delimiter')!;
    const p = buildPrompt({ ...item, answer: trap.answer }, rubric, 'ascending', deriveStream(36, 'p4'));
    const closing = `<</ANSWER-${p.nonce}>>`;
    expect(p.user.split(closing)).toHaveLength(2);
    expect(p.nonce).not.toBe('0'.repeat(32));
  });

  it('omits the source block when there is no source', () => {
    const p = buildPrompt({ key: 'n', taskText: 't', answer: 'a' }, rubric, 'ascending', deriveStream(36, 'p5'));
    expect(p.user).not.toContain('<<SOURCE-');
  });
});
