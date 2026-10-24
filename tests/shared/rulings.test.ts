import { describe, expect, it } from 'vitest';
import { unwrap } from '../../src/core/result.ts';
import {
  appendRuling,
  createRulingsLog,
  latestRulings,
  rulingStaleness,
  type LatestDevRunLookup,
  type SuggestionRef,
} from '../../src/shared/rulings.ts';

const suggestion: SuggestionRef = {
  suggestionId: 'sg-1',
  owner: 'u1',
  runId: 'dev-run-1',
  split: 'dev',
  setId: 'set-1',
  rubricHash: 'r1',
  judgeConfigHash: 'jc-1',
  inputHash: 'result-hash-1',
};

const current: LatestDevRunLookup = () => ({ runId: 'dev-run-1', resultHash: 'result-hash-1' });
const newer: LatestDevRunLookup = () => ({ runId: 'dev-run-2', resultHash: 'result-hash-2' });

describe('rulings log', () => {
  it('appends a ruling citing the input hash; the old log is untouched (append-only, immutable)', () => {
    const log0 = createRulingsLog();
    const r = unwrap(appendRuling(log0, { owner: 'u1', suggestion, decision: 'accept', note: 'agree', now: 't1' }, current));
    expect(log0.entries).toHaveLength(0);
    expect(r.log.entries).toHaveLength(1);
    expect(r.ruling).toMatchObject({ seq: 1, suggestionId: 'sg-1', decision: 'accept', inputHash: 'result-hash-1', runId: 'dev-run-1', note: 'agree' });
    expect(Object.isFrozen(r.log.entries)).toBe(true);
    expect(Object.isFrozen(r.ruling)).toBe(true);
  });

  it('exposes no update or delete: a change of mind is a new entry and the latest one wins', () => {
    const a = unwrap(appendRuling(createRulingsLog(), { owner: 'u1', suggestion, decision: 'accept', now: 't1' }, current));
    const b = unwrap(appendRuling(a.log, { owner: 'u1', suggestion, decision: 'reject', now: 't2' }, current));
    expect(b.log.entries.map((e) => [e.seq, e.decision])).toEqual([
      [1, 'accept'],
      [2, 'reject'],
    ]);
    expect(latestRulings(b.log).get('sg-1')!.decision).toBe('reject');
  });

  it('rejects a stale ruling when a newer completed dev score run exists', () => {
    const r = appendRuling(createRulingsLog(), { owner: 'u1', suggestion, decision: 'accept', now: 't1' }, newer);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('stale');
    expect(rulingStaleness(suggestion, newer).stale).toBe(true);
  });

  it('rejects a ruling whose input hash differs from the run result hash', () => {
    const lookup: LatestDevRunLookup = () => ({ runId: 'dev-run-1', resultHash: 'something-else' });
    const r = appendRuling(createRulingsLog(), { owner: 'u1', suggestion, decision: 'accept', now: 't1' }, lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('stale');
  });

  it('rejects when no completed dev score run exists', () => {
    const r = appendRuling(createRulingsLog(), { owner: 'u1', suggestion, decision: 'accept', now: 't1' }, () => null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('stale');
  });

  it('passes the (set, rubric, judge config) key to the lookup', () => {
    const seen: unknown[] = [];
    const lookup: LatestDevRunLookup = (key) => {
      seen.push(key);
      return { runId: 'dev-run-1', resultHash: 'result-hash-1' };
    };
    unwrap(appendRuling(createRulingsLog(), { owner: 'u1', suggestion, decision: 'reject', now: 't1' }, lookup));
    expect(seen).toEqual([{ setId: 'set-1', rubricHash: 'r1', judgeConfigHash: 'jc-1' }]);
  });

  it('refuses suggestions from non-dev runs and other owners', () => {
    const heldout = appendRuling(createRulingsLog(), { owner: 'u1', suggestion: { ...suggestion, split: 'heldout' }, decision: 'accept', now: 't1' }, current);
    expect(heldout.ok).toBe(false);
    if (!heldout.ok) expect(heldout.error.reason).toBe('not_dev');
    const other = appendRuling(createRulingsLog(), { owner: 'u2', suggestion, decision: 'accept', now: 't1' }, current);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.reason).toBe('forbidden');
  });
});
