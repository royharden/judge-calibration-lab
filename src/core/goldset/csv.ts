// RFC-4180-ish CSV parsing and formula-safe CSV writing (PLAN.md §3.4).
//
// Parser: comma separator, double-quoted fields with "" escapes, quoted fields may contain
// commas and newlines, CRLF / LF / CR row ends, optional UTF-8 BOM, a final row without a
// newline. A quote inside an unquoted field, text after a closing quote, or an unterminated
// quoted field is reported as an error (with the 1-based physical line), never repaired.
//
// Writer: every cell is formula-escaped (prefix "'" when the cell, after leading whitespace,
// starts with = + - @, or when it starts with a tab or CR), then quoted when it contains a
// comma, quote, CR or LF, or has leading/trailing spaces. Rows end with CRLF.

export type CsvError = { line: number; message: string };

export type CsvParseResult = {
  /** Parsed rows (cells as raw strings). Rows that produced an error are omitted. */
  rows: CsvRow[];
  errors: CsvError[];
};

export type CsvRow = {
  /** 1-based physical line on which the row starts. */
  line: number;
  cells: string[];
};

/** Parse CSV text. Blank lines (a row with one empty unquoted cell) are skipped. */
export function parseCsv(text: string): CsvParseResult {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: CsvRow[] = [];
  const errors: CsvError[] = [];

  let i = 0;
  let line = 1;
  const n = src.length;

  while (i < n) {
    const rowLine = line;
    const cells: string[] = [];
    let rowError: string | null = null;
    let cell = '';
    let quotedRow = false;
    let endOfRow = false;

    while (!endOfRow) {
      // Start of a cell.
      cell = '';
      if (i < n && src[i] === '"') {
        quotedRow = true;
        i += 1;
        let closed = false;
        while (i < n) {
          const ch = src[i]!;
          if (ch === '"') {
            if (src[i + 1] === '"') {
              cell += '"';
              i += 2;
              continue;
            }
            i += 1;
            closed = true;
            break;
          }
          if (ch === '\r') {
            // CR or CRLF inside a quoted field is kept verbatim (callers normalise text later).
            cell += src[i + 1] === '\n' ? '\r\n' : '\r';
            i += src[i + 1] === '\n' ? 2 : 1;
            line += 1;
            continue;
          }
          if (ch === '\n') line += 1;
          cell += ch;
          i += 1;
        }
        if (!closed) {
          rowError = 'unterminated quoted field';
          i = n;
          endOfRow = true;
          break;
        }
        // After a closing quote only a separator or row end may follow.
        if (i < n && src[i] !== ',' && src[i] !== '\n' && src[i] !== '\r') {
          rowError ??= 'unexpected text after closing quote';
          while (i < n && src[i] !== ',' && src[i] !== '\n' && src[i] !== '\r') i += 1;
        }
      } else {
        while (i < n) {
          const ch = src[i]!;
          if (ch === ',' || ch === '\n' || ch === '\r') break;
          if (ch === '"') rowError ??= 'quote inside unquoted field';
          cell += ch;
          i += 1;
        }
      }
      cells.push(cell);

      if (i >= n) {
        endOfRow = true;
      } else if (src[i] === ',') {
        i += 1;
        if (i >= n) {
          cells.push('');
          endOfRow = true;
        }
      } else {
        // Row end: CRLF, LF or CR.
        if (src[i] === '\r' && src[i + 1] === '\n') i += 2;
        else i += 1;
        line += 1;
        endOfRow = true;
      }
    }

    if (rowError !== null) {
      errors.push({ line: rowLine, message: rowError });
      continue;
    }
    const blank = cells.length === 1 && cells[0] === '' && !quotedRow;
    if (!blank) rows.push({ line: rowLine, cells });
  }

  return { rows, errors };
}

const FORMULA_START = /^[=+\-@]/;

/** True when a spreadsheet could interpret the cell as a formula. */
export function needsFormulaEscape(value: string): boolean {
  if (value.length === 0) return false;
  const first = value[0]!;
  if (first === '\t' || first === '\r') return true;
  return FORMULA_START.test(value.replace(/^\s+/u, ''));
}

/** Prefix "'" when the cell could be read as a formula (see needsFormulaEscape). */
export function formulaEscape(value: string): string {
  return needsFormulaEscape(value) ? `'${value}` : value;
}

/** RFC-4180 quoting (no formula escaping). */
export function quoteCsvField(value: string): string {
  if (/[",\r\n]/.test(value) || /^\s|\s$/u.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** One formula-escaped, quoted cell. */
export function escapeCell(value: string): string {
  return quoteCsvField(formulaEscape(value));
}

/** One CSV row (no line terminator); every cell formula-escaped and quoted as needed. */
export function formatCsvRow(cells: readonly string[]): string {
  return cells.map((c) => escapeCell(c)).join(',');
}

/** Full CSV document with CRLF row ends (including after the last row). */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => formatCsvRow(r) + '\r\n').join('');
}
