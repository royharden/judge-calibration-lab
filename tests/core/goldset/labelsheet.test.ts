import { describe, expect, it } from 'vitest';
import type { Item } from '../../../src/core/types.ts';
import { LABEL_SHEET_HEADER, labelSheetCsv } from '../../../src/core/goldset/labelsheet.ts';
import { needsFormulaEscape, parseCsv } from '../../../src/core/goldset/csv.ts';

const ITEMS: Item[] = [
  { key: 'i1', taskText: 'Summarise, briefly.', answer: '=HYPERLINK("http://evil.example","click")', source: 'A "quoted" source' },
  { key: 'i2', taskText: '  +cmd|" /C calc"!A0', answer: '@SUM(A1:A9)' },
  { key: '-i3', taskText: '\t=1+1', answer: '\r-2', source: '   @x' },
  { key: 'i4', taskText: 'plain', answer: 'multi\nline answer' },
];

describe('labelSheetCsv', () => {
  const text = labelSheetCsv(ITEMS);
  const parsed = parseCsv(text);

  it('has the fixed header, one row per item and a blank score column', () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]!.cells).toEqual([...LABEL_SHEET_HEADER]);
    expect(parsed.rows).toHaveLength(ITEMS.length + 1);
    for (const r of parsed.rows.slice(1)) {
      expect(r.cells).toHaveLength(5);
      expect(r.cells[4]).toBe('');
    }
  });

  it('formula-escapes every dangerous cell, including whitespace-prefixed ones', () => {
    const cells = parsed.rows.slice(1).flatMap((r) => r.cells);
    expect(cells).toContain(`'=HYPERLINK("http://evil.example","click")`);
    expect(cells).toContain(`'  +cmd|" /C calc"!A0`);
    expect(cells).toContain("'@SUM(A1:A9)");
    expect(cells).toContain("'-i3");
    expect(cells).toContain("'\t=1+1");
    expect(cells).toContain("'\r-2");
    expect(cells).toContain("'   @x");
    for (const c of cells) expect(needsFormulaEscape(c)).toBe(false);
  });

  it('keeps ordinary text intact (quoting only)', () => {
    const row1 = parsed.rows[1]!.cells;
    expect(row1[1]).toBe('Summarise, briefly.');
    expect(row1[3]).toBe('A "quoted" source');
    expect(parsed.rows[4]!.cells[2]).toBe('multi\nline answer');
  });

  it('uses CRLF row ends', () => {
    expect(text.startsWith('item_id,task_text,answer,source,score\r\n')).toBe(true);
  });
});
