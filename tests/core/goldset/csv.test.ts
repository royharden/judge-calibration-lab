import { describe, expect, it } from 'vitest';
import { escapeCell, formatCsvRow, formulaEscape, needsFormulaEscape, parseCsv, quoteCsvField, toCsv } from '../../../src/core/goldset/csv.ts';

describe('parseCsv', () => {
  it('parses quoted commas, escaped quotes, embedded newlines and mixed row ends', () => {
    const r = parseCsv('a,b\r\n"x, y","say ""hi"""\n"multi\nline",z');
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.cells)).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', 'z'],
    ]);
    expect(r.rows.map((x) => x.line)).toEqual([1, 2, 3]);
  });

  it('handles a lone CR row end, a BOM and a missing final newline', () => {
    const r = parseCsv('﻿h1,h2\rv1,v2');
    expect(r.rows.map((x) => x.cells)).toEqual([
      ['h1', 'h2'],
      ['v1', 'v2'],
    ]);
  });

  it('skips blank lines but keeps their line numbers counted', () => {
    const r = parseCsv('a\n\nb\n');
    expect(r.rows).toEqual([
      { line: 1, cells: ['a'] },
      { line: 3, cells: ['b'] },
    ]);
  });

  it('keeps trailing empty cells', () => {
    expect(parseCsv('a,\n').rows[0]!.cells).toEqual(['a', '']);
    expect(parseCsv('a,').rows[0]!.cells).toEqual(['a', '']);
  });

  it('keeps a row made of one quoted empty cell', () => {
    expect(parseCsv('""\n').rows[0]!.cells).toEqual(['']);
  });

  it('reports an unterminated quoted field with the row start line', () => {
    const r = parseCsv('ok,1\na,"b\nc');
    expect(r.rows.map((x) => x.cells)).toEqual([['ok', '1']]);
    expect(r.errors).toEqual([{ line: 2, message: 'unterminated quoted field' }]);
  });

  it('reports a quote inside an unquoted field and text after a closing quote', () => {
    const r = parseCsv('a"b,c\n"x"y,z\nfine,row\n');
    expect(r.errors.map((e) => e.line)).toEqual([1, 2]);
    expect(r.rows.map((x) => x.cells)).toEqual([['fine', 'row']]);
  });
});

describe('formula escaping', () => {
  it('flags = + - @ at the start, also after leading whitespace, and a leading tab or CR', () => {
    for (const v of ['=1+2', '+cmd', '-2', '@SUM(A1)', '  =x', ' \t@x', '\t=x', '\tplain', '\rabc', '\n=x']) {
      expect(needsFormulaEscape(v)).toBe(true);
    }
    for (const v of ['', 'abc', 'a=b', '1-2', "'=x", 'x@y']) expect(needsFormulaEscape(v)).toBe(false);
  });

  it('prefixes a single quote', () => {
    expect(formulaEscape('=1+2')).toBe("'=1+2");
    expect(formulaEscape('  -x')).toBe("'  -x");
    expect(formulaEscape('safe')).toBe('safe');
  });

  it('quotes fields with comma, quote, CR/LF or edge whitespace', () => {
    expect(quoteCsvField('a,b')).toBe('"a,b"');
    expect(quoteCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(quoteCsvField('l1\nl2')).toBe('"l1\nl2"');
    expect(quoteCsvField(' padded ')).toBe('" padded "');
    expect(quoteCsvField('plain')).toBe('plain');
  });

  it('escapeCell = formula escape then quoting', () => {
    expect(escapeCell('=a,b')).toBe(`"'=a,b"`);
    expect(escapeCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(escapeCell('  +1')).toBe("'  +1");
  });

  it('round-trips through parseCsv with the escape prefix kept and no cell left executable', () => {
    const rows = [
      ['id', '=cmd|calc', ' @x', 'ok'],
      ['x,y', 'l1\r\nl2', '-5', '\t=1'],
    ];
    const text = toCsv(rows);
    expect(text.endsWith('\r\n')).toBe(true);
    const back = parseCsv(text);
    expect(back.errors).toEqual([]);
    expect(back.rows.map((r) => r.cells)).toEqual(rows.map((r) => r.map((c) => formulaEscape(c))));
    for (const r of back.rows) for (const c of r.cells) expect(needsFormulaEscape(c)).toBe(false);
  });

  it('formatCsvRow joins escaped cells', () => {
    expect(formatCsvRow(['a', '=b', 'c,d'])).toBe(`a,'=b,"c,d"`);
  });
});
