// Blank labelling sheet (PLAN.md §3.4): `item_id,task_text,answer,source,score` with an empty
// score column. Every cell (header included) goes through the formula escape in csv.ts, so a
// task or answer starting with = + - @ (also after leading whitespace) or a tab / CR cannot
// execute as a spreadsheet formula.

import type { Item } from '../types.ts';
import { toCsv } from './csv.ts';

export const LABEL_SHEET_HEADER = ['item_id', 'task_text', 'answer', 'source', 'score'] as const;

/** CSV text (CRLF rows). Items are written in the given order. */
export function labelSheetCsv(items: readonly Item[]): string {
  const rows: string[][] = [[...LABEL_SHEET_HEADER]];
  for (const it of items) rows.push([it.key, it.taskText, it.answer, it.source ?? '', '']);
  return toCsv(rows);
}
