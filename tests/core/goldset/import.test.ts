import { describe, expect, it } from 'vitest';
import { importGoldSet } from '../../../src/core/goldset/import.ts';
import { annotationHashOf, contentHashOf, fingerprintItem, fingerprintMap } from '../../../src/core/goldset/fingerprint.ts';
import { IMPORT_LIMITS, PUBLIC_DATA_BANNER, type ImportFiles, type ImportReport } from '../../../src/core/goldset/types.ts';
import { generateSyntheticSet } from '../../../src/core/fixtures/synthetic.ts';
import { IMPORT_TRAP_EXPECTED, IMPORT_TRAP_FILES } from '../../../src/core/fixtures/traps.ts';

const SCALE_1_5 = { levels: [1, 2, 3, 4, 5].map((v) => ({ value: v, label: String(v) })) };

type Row = { id: string; task: string; answer: string; source?: string };

function makeFiles(rows: Row[], labels: [string, string, number][], opts: { eol?: string; manifest?: unknown } = {}): ImportFiles {
  const eol = opts.eol ?? '\n';
  const itemsJsonl = rows
    .map((r) => JSON.stringify({ id: r.id, task_text: r.task, answer: r.answer, ...(r.source === undefined ? {} : { source: r.source }) }))
    .join(eol);
  const annotators = [...new Set(labels.map((l) => l[1]))];
  return {
    itemsJsonl,
    manifestJson: JSON.stringify(opts.manifest ?? { name: 'Small', scale: SCALE_1_5, split_seed: 7 }),
    annotatorCsvs: annotators.map((a) => ({
      name: `${a}.csv`,
      text: ['item_id,annotator_id,score', ...labels.filter((l) => l[1] === a).map((l) => `${l[0]},${l[1]},${l[2]}`)].join(eol) + eol,
    })),
  };
}

const ROWS: Row[] = [
  { id: 'a', task: 'Task one', answer: 'First answer\nwith two lines', source: 'Source one' },
  { id: 'b', task: 'Task two', answer: 'Second answer' },
  { id: 'c', task: 'Task three', answer: 'Third answer', source: 'Source three' },
];
const LABELS: [string, string, number][] = [
  ['a', 'x', 1],
  ['a', 'y', 2],
  ['b', 'x', 3],
  ['b', 'y', 3],
  ['c', 'x', 5],
  ['c', 'y', 4],
];

function codes(report: ImportReport): string[] {
  return report.issues.map((i) => i.code);
}

function expectErr(files: ImportFiles): ImportReport {
  const r = importGoldSet(files);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('expected Err');
  return r.error;
}

describe('importGoldSet: valid input', () => {
  it('stages the synthetic set with no blocking issue and no warning', () => {
    const syn = generateSyntheticSet(36);
    const r = importGoldSet(syn.files);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value;
    expect(s.report.blockingCount).toBe(0);
    expect(s.report.warningCount).toBe(0);
    expect(s.report.banner).toBe(PUBLIC_DATA_BANNER);
    expect(s.items).toHaveLength(120);
    expect(s.stagedAnnotations).toHaveLength(600);
    expect(s.report.counts).toMatchObject({ items: 120, annotators: 5, labels: 600, annotatorFiles: 5 });
    expect(s.report.pairOverlaps).toHaveLength(10);
    for (const p of s.report.pairOverlaps) expect(p.sharedItems).toBe(120);
    expect(s.splitSeed).toBe(36);
    expect(s.heldoutFraction).toBe(0.5);
    // Scores are converted from displayed values 1..5 to indices 0..4.
    expect(s.stagedAnnotations.every((a) => a.score >= 0 && a.score <= 4)).toBe(true);
    expect(s.stagedAnnotations).toEqual(syn.annotations);
  });

  it('converts displayed scores to level indices', () => {
    const r = importGoldSet(makeFiles(ROWS, LABELS));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.stagedAnnotations.filter((a) => a.itemKey === 'c').map((a) => a.score);
    expect(c.sort()).toEqual([3, 4]);
  });
});

describe('importGoldSet: hash invariance', () => {
  const base = importGoldSet(makeFiles(ROWS, LABELS));
  if (!base.ok) throw new Error('base import failed');

  it('contentHash and annotationHash ignore row order', () => {
    const r = importGoldSet(makeFiles([...ROWS].reverse(), [...LABELS].reverse()));
    expect(r.ok && r.value.contentHash).toBe(base.value.contentHash);
    expect(r.ok && r.value.annotationHash).toBe(base.value.annotationHash);
  });

  it('contentHash and annotationHash ignore item ids', () => {
    const rename = (id: string): string => `renamed-${id}-x`;
    const r = importGoldSet(
      makeFiles(
        ROWS.map((x) => ({ ...x, id: rename(x.id) })),
        LABELS.map(([i, a, s]) => [rename(i), a, s] as [string, string, number]),
      ),
    );
    expect(r.ok && r.value.contentHash).toBe(base.value.contentHash);
    expect(r.ok && r.value.annotationHash).toBe(base.value.annotationHash);
  });

  it('keeps both hashes invariant for __proto__, constructor and toString item ids', () => {
    const ids = ['__proto__', 'constructor', 'toString'];
    const aliases = new Map(ROWS.map((row, i) => [row.id, ids[i]!] as const));
    const r = importGoldSet(makeFiles(
      ROWS.map((row) => ({ ...row, id: aliases.get(row.id)! })),
      LABELS.map(([id, annotator, score]) => [aliases.get(id)!, annotator, score] as [string, string, number]),
    ));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.contentHash).toBe(base.value.contentHash);
    expect(r.value.annotationHash).toBe(base.value.annotationHash);
    const fingerprints = fingerprintMap(r.value.items);
    for (const map of [r.value.fingerprints, fingerprints]) {
      expect(Object.getPrototypeOf(map)).toBeNull();
      expect(Object.keys(map).sort()).toEqual([...ids].sort());
      for (const id of ids) expect(map[id]).toMatch(/^[0-9a-f]{64}$/);
      expect(contentHashOf(Object.values(map))).toBe(base.value.contentHash);
      expect(annotationHashOf(r.value.stagedAnnotations, map)).toBe(base.value.annotationHash);
    }
  });

  it('annotation hashing refuses inherited names that are not known item ids', () => {
    for (const itemKey of ['__proto__', 'constructor', 'toString']) {
      expect(() => annotationHashOf([{ itemKey, annotatorId: 'x', score: 1 }], {})).toThrow(/unknown item/);
    }
  });

  it('contentHash ignores newline style in files and inside text, and trailing spaces', () => {
    const crlfRows = ROWS.map((x) => ({ ...x, answer: x.answer.replace(/\n/g, '\r\n') + '   ' }));
    const r = importGoldSet(makeFiles(crlfRows, LABELS, { eol: '\r\n' }));
    expect(r.ok && r.value.contentHash).toBe(base.value.contentHash);
  });

  it('contentHash changes when content changes; annotationHash changes when a label changes', () => {
    const changed = importGoldSet(makeFiles(ROWS.map((x, i) => (i === 0 ? { ...x, answer: 'Different' } : x)), LABELS));
    expect(changed.ok && changed.value.contentHash).not.toBe(base.value.contentHash);
    const relabelled = importGoldSet(makeFiles(ROWS, LABELS.map((l, i) => (i === 0 ? ([l[0], l[1], 3] as [string, string, number]) : l))));
    expect(relabelled.ok && relabelled.value.contentHash).toBe(base.value.contentHash);
    expect(relabelled.ok && relabelled.value.annotationHash).not.toBe(base.value.annotationHash);
  });

  it('fingerprints exclude the id and treat empty source as absent', () => {
    expect(fingerprintItem({ taskText: 't', answer: 'a', source: '' })).toBe(fingerprintItem({ taskText: 't', answer: 'a' }));
    expect(fingerprintItem({ taskText: 't', answer: 'a', facts: [] })).toBe(fingerprintItem({ taskText: 't', answer: 'a' }));
    expect(fingerprintItem({ taskText: 't', answer: 'a' })).not.toBe(fingerprintItem({ taskText: 't', answer: 'b' }));
  });
});

describe('importGoldSet: rejections (all collected, nothing staged)', () => {
  it('reports every planted problem of the trap set', () => {
    const rep = expectErr(IMPORT_TRAP_FILES);
    expect(rep.ok).toBe(false);
    expect(rep.blockingCount).toBeGreaterThanOrEqual(IMPORT_TRAP_EXPECTED.length - 1);
    for (const e of IMPORT_TRAP_EXPECTED) {
      expect(rep.issues.some((i) => i.code === e.code && (e.itemId === undefined || i.itemId === e.itemId))).toBe(true);
    }
    const dup = rep.issues.find((i) => i.code === 'duplicate_content');
    expect(dup?.severity).toBe('warning');
    expect(rep.banner).toBe(PUBLIC_DATA_BANNER);
  });

  it('rejects an oversize text field', () => {
    const big = 'a'.repeat(IMPORT_LIMITS.maxFieldBytes + 1);
    const rep = expectErr(makeFiles(ROWS.map((x, i) => (i === 1 ? { ...x, answer: big } : x)), LABELS));
    expect(codes(rep)).toContain('oversize_field');
  });

  it('counts multi-byte characters as UTF-8 bytes', () => {
    const big = 'é'.repeat(IMPORT_LIMITS.maxFieldBytes / 2 + 1); // 2 bytes each
    const rep = expectErr(makeFiles(ROWS.map((x, i) => (i === 1 ? { ...x, task: big } : x)), LABELS));
    expect(codes(rep)).toContain('oversize_field');
  });

  it('rejects more than 500 items', () => {
    const rows: Row[] = Array.from({ length: 501 }, (_, i) => ({ id: `i${i}`, task: 't', answer: `answer ${i}` }));
    const labels: [string, string, number][] = rows.flatMap((r) => [
      [r.id, 'x', 1] as [string, string, number],
      [r.id, 'y', 2] as [string, string, number],
    ]);
    expect(codes(expectErr(makeFiles(rows, labels)))).toContain('too_many_items');
  });

  it('rejects an upload above 25 MB before parsing', () => {
    const files = makeFiles(ROWS, LABELS);
    const rep = expectErr({ ...files, itemsJsonl: files.itemsJsonl + ' '.repeat(IMPORT_LIMITS.maxUploadBytes) });
    expect(codes(rep)).toEqual(['upload_too_large']);
  });

  it('rejects malformed manifests and scales', () => {
    const bad = (manifest: unknown): string[] => codes(expectErr(makeFiles(ROWS, LABELS, { manifest })));
    expect(codes(expectErr({ ...makeFiles(ROWS, LABELS), manifestJson: '{not json' }))).toContain('manifest_malformed');
    expect(bad({ scale: SCALE_1_5, split_seed: 1 })).toContain('manifest_malformed');
    expect(bad({ name: 'n', scale: { levels: [{ value: 1, label: '1' }] }, split_seed: 1 })).toContain('scale_invalid');
    expect(
      bad({ name: 'n', scale: { levels: [1, 2, 3, 4, 5, 6, 7, 8].map((v) => ({ value: v, label: String(v) })) }, split_seed: 1 }),
    ).toContain('scale_invalid');
    expect(
      bad({ name: 'n', scale: { levels: [{ value: 2, label: 'a' }, { value: 1, label: 'b' }] }, split_seed: 1 }),
    ).toContain('scale_invalid');
    expect(bad({ name: 'n', scale: { levels: [{ value: 1.5, label: 'a' }, { value: 2, label: 'b' }] }, split_seed: 1 })).toContain(
      'scale_invalid',
    );
    expect(bad({ name: 'n', scale: SCALE_1_5, split_seed: -1 })).toContain('split_seed_invalid');
    expect(bad({ name: 'n', scale: SCALE_1_5, split_seed: 1, heldout_fraction: 1 })).toContain('heldout_fraction_invalid');
  });

  it('rejects malformed item rows, duplicate ids and a bad CSV header', () => {
    const files = makeFiles(ROWS, LABELS);
    const rep = expectErr({
      ...files,
      itemsJsonl: `${files.itemsJsonl}\nnot json\n{"id":"d","answer":"no task"}\n{"id":"a","task_text":"dup","answer":"dup"}\n[1,2]`,
      annotatorCsvs: [...files.annotatorCsvs, { name: 'bad.csv', text: 'item,annotator,score\na,z,3\n' }],
    });
    expect(codes(rep)).toEqual(expect.arrayContaining(['malformed_row', 'duplicate_item_id', 'csv_header_invalid']));
    expect(rep.issues.filter((i) => i.code === 'malformed_row').length).toBeGreaterThanOrEqual(3);
  });

  it('rejects empty scores, wrong cell counts and labels for items with fewer than 2 distinct annotators', () => {
    const files = makeFiles(ROWS, LABELS.filter((l) => !(l[0] === 'b' && l[1] === 'y')));
    const rep = expectErr({
      ...files,
      annotatorCsvs: [...files.annotatorCsvs, { name: 'z.csv', text: 'item_id,annotator_id,score\nc,z,\nc,z\n' }],
    });
    expect(rep.issues.some((i) => i.code === 'too_few_annotators' && i.itemId === 'b')).toBe(true);
    expect(rep.issues.filter((i) => i.code === 'malformed_row' && i.file === 'z.csv')).toHaveLength(2);
  });

  it('a label from the same annotator twice does not count as two annotators', () => {
    const labels: [string, string, number][] = [
      ['a', 'x', 1],
      ['a', 'x', 2],
      ['b', 'x', 3],
      ['b', 'y', 3],
      ['c', 'x', 5],
      ['c', 'y', 4],
    ];
    const rep = expectErr(makeFiles(ROWS, labels));
    expect(codes(rep)).toEqual(expect.arrayContaining(['duplicate_annotation', 'too_few_annotators']));
  });

  it('requires at least one annotator file and one item', () => {
    expect(codes(expectErr({ ...makeFiles(ROWS, LABELS), annotatorCsvs: [] }))).toContain('no_annotator_files');
    expect(codes(expectErr({ ...makeFiles(ROWS, LABELS), itemsJsonl: '\n\n' }))).toContain('no_items');
  });
});
