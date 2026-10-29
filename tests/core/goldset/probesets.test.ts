import { describe, expect, it } from 'vitest';
import {
  checkProbeBaseItems,
  importProbeSets,
  injectionItemKeys,
  injectionToItems,
  pairItemKeys,
  pairToItems,
} from '../../../src/core/goldset/probesets.ts';
import { generateSyntheticSet, TRAP_PAIR_ID } from '../../../src/core/fixtures/synthetic.ts';
import { PADDED_PAIR_JSONL } from '../../../src/core/fixtures/traps.ts';
import { IMPORT_LIMITS } from '../../../src/core/goldset/types.ts';

const syn = generateSyntheticSet(36);

describe('importProbeSets', () => {
  it('accepts the 24 synthetic pairs, rejects the padded trap pair and loads 12 injections', () => {
    const r = importProbeSets(syn.probeFiles);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.pairs).toHaveLength(24);
    expect(r.value.rejectedPairs.map((p) => p.id)).toEqual([TRAP_PAIR_ID]);
    expect(r.value.rejectedPairs[0]!.check.reasons).toContain('short_in_long');
    expect(r.value.injections).toHaveLength(12);
    expect(r.value.report.counts).toEqual({ pairRows: 25, acceptedPairs: 24, rejectedPairs: 1, injectionRows: 12 });
    expect(r.value.report.warningCount).toBe(1);
    expect(r.value.report.issues[0]!.code).toBe('pair_rejected');
  });

  it('rejects the hand-written padded-filler pair', () => {
    const r = importProbeSets({ pairsJsonl: PADDED_PAIR_JSONL });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.pairs).toHaveLength(0);
    expect(r.value.rejectedPairs[0]!.check.reasons).toEqual(['short_in_long']);
  });

  it('blocks malformed rows, missing fields, duplicate ids and bad facts', () => {
    const pairs = [
      '{"id":"p1","task_text":"t","short_text":"a b","long_text":"c d e f"}',
      'not json',
      '{"id":"p1","task_text":"t","short_text":"x","long_text":"y y y"}',
      '{"id":"p2","task_text":"t","short_text":"x"}',
      '{"id":"p3","task_text":"t","short_text":"x","long_text":"y y y","facts":[1]}',
    ].join('\n');
    const r = importProbeSets({ pairsJsonl: pairs, injectionJsonl: '{"id":"i1","task_text":"t","answer":"a"}' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const codes = r.error.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['malformed_row', 'duplicate_probe_id']));
    expect(r.error.issues.filter((i) => i.code === 'malformed_row').length).toBeGreaterThanOrEqual(4);
  });

  it('empty inputs give an empty, valid probe set', () => {
    const r = importProbeSets({});
    expect(r.ok && r.value.pairs.length + r.value.injections.length).toBe(0);
  });

  it('collects a blocking UTF-8 byte limit issue for each oversize fact before pairCheck', () => {
    const fact = 'é'.repeat(IMPORT_LIMITS.maxFieldBytes / 2 + 1);
    const r = importProbeSets({ pairsJsonl: JSON.stringify({
      id: 'oversize-facts', task_text: 't', short_text: 'a b', long_text: 'c d e f', facts: [fact, fact],
    }) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.issues.map((issue) => issue.code)).toEqual(['oversize_field', 'oversize_field']);
    expect(r.error.issues.every((issue) => issue.probeId === 'oversize-facts' && issue.severity === 'blocking')).toBe(true);
    expect(r.error.counts.acceptedPairs + r.error.counts.rejectedPairs).toBe(0);
  });

  it('bounds the combined pair and injection upload before parsing either file', () => {
    const part = 'x'.repeat(IMPORT_LIMITS.maxUploadBytes / 2 + 1);
    const r = importProbeSets({ pairsJsonl: part, injectionJsonl: part });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.issues.map((issue) => issue.code)).toEqual(['upload_too_large']);
    expect(r.error.counts).toEqual({ pairRows: 0, acceptedPairs: 0, rejectedPairs: 0, injectionRows: 0 });
  });
});

describe('checkProbeBaseItems (freeze / dev-run time)', () => {
  const r = importProbeSets({
    pairsJsonl:
      '{"id":"p1","task_text":"t","short_text":"cats sleep","long_text":"the household cats like to sleep for most of the day, which is normal","base_item_id":"d1"}\n',
    injectionJsonl:
      '{"id":"i1","task_text":"t","base_answer":"a","answer":"a b","base_item_id":"h1"}\n{"id":"i2","task_text":"t","base_answer":"a","answer":"a b","base_item_id":"zz"}\n{"id":"i3","task_text":"t","base_answer":"a","answer":"a b"}\n',
  });
  if (!r.ok) throw new Error('probe import failed');

  it('refuses held-out and unknown base items, accepts dev bases and rows without a base', () => {
    const c = checkProbeBaseItems(r.value, { dev: ['d1'], heldout: ['h1'] });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.error.map((i) => [i.code, i.probeId])).toEqual([
      ['heldout_base_item', 'i1'],
      ['unknown_base_item', 'i2'],
    ]);
  });

  it('passes when every base item is dev', () => {
    const c = checkProbeBaseItems(r.value, { dev: ['d1', 'h1', 'zz'], heldout: [] });
    expect(c.ok).toBe(true);
  });
});

describe('probe items', () => {
  it('pairToItems and injectionToItems build judgeable items with distinct keys', () => {
    const r = importProbeSets(syn.probeFiles);
    if (!r.ok) throw new Error('probe import failed');
    const pair = r.value.pairs[0]!;
    const { short, long } = pairToItems(pair);
    expect(short.key).toBe(pairItemKeys(pair.id).short);
    expect(long.key).toBe(pairItemKeys(pair.id).long);
    expect(short.answer).toBe(pair.shortText);
    expect(long.answer).toBe(pair.longText);
    expect(short.taskText).toBe(long.taskText);
    const inj = r.value.injections[0]!;
    const { base, injected } = injectionToItems(inj);
    expect(base.key).toBe(injectionItemKeys(inj.id).base);
    expect(injected.answer).toBe(inj.answer);
    expect(base.answer).toBe(inj.baseAnswer);
    expect(base.key).not.toBe(injected.key);
  });
});
