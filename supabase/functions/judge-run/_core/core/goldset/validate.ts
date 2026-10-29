// Row-level validators for gold-set import (PLAN.md §3.4). Each parser collects every issue
// it finds (never stops at the first); import.ts combines them into one report.

import type { Item, Scale, ScaleLevel } from '../types.ts';
import { levelIndex } from '../types.ts';
import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import { normalizeText } from '../canonical.ts';
import { utf8Bytes } from '../sha256.ts';
import { parseCsv } from './csv.ts';
import type { ImportIssue, ImportIssueCode, Manifest } from './types.ts';
import { DEFAULT_HELDOUT_FRACTION, IMPORT_LIMITS, ISSUE_SEVERITY } from './types.ts';

export function issue(code: ImportIssueCode, message: string, extra: Omit<ImportIssue, 'code' | 'severity' | 'message'> = {}): ImportIssue {
  return { code, severity: ISSUE_SEVERITY[code], message, ...extra };
}

export function utf8Length(text: string): number {
  return utf8Bytes(text).length;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Scale and manifest
// ---------------------------------------------------------------------------

/** 2–7 levels, integer values strictly increasing, string labels. */
export function validateScale(raw: unknown): Result<Scale, string> {
  if (!isRecord(raw) || !Array.isArray(raw.levels)) return err('scale must be an object with a "levels" array');
  const levels = raw.levels as unknown[];
  if (levels.length < IMPORT_LIMITS.minLevels || levels.length > IMPORT_LIMITS.maxLevels) {
    return err(`scale must have ${IMPORT_LIMITS.minLevels}–${IMPORT_LIMITS.maxLevels} levels, got ${levels.length}`);
  }
  const out: ScaleLevel[] = [];
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i];
    if (!isRecord(l)) return err(`scale level ${i} must be an object`);
    if (typeof l.value !== 'number' || !Number.isInteger(l.value)) return err(`scale level ${i} value must be an integer`);
    if (typeof l.label !== 'string') return err(`scale level ${i} label must be a string`);
    const prev = out[out.length - 1];
    if (prev !== undefined && l.value <= prev.value) return err('scale values must be strictly increasing');
    out.push({ value: l.value, label: normalizeText(l.label) });
  }
  return ok({ levels: out });
}

export type ManifestParse = { manifest: Manifest | null; issues: ImportIssue[] };

/** Parse manifest.json: {name, scale:{levels:[{value,label}]}, split_seed, heldout_fraction?, freeze_date?}. */
export function parseManifest(text: string, file = 'manifest.json'): ManifestParse {
  const issues: ImportIssue[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { manifest: null, issues: [issue('manifest_malformed', 'manifest is not valid JSON', { file })] };
  }
  if (!isRecord(raw)) return { manifest: null, issues: [issue('manifest_malformed', 'manifest must be a JSON object', { file })] };

  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? normalizeText(raw.name).trim() : null;
  if (name === null) issues.push(issue('manifest_malformed', 'manifest "name" must be a non-empty string', { file }));

  const scaleR = validateScale(raw.scale);
  if (!scaleR.ok) issues.push(issue('scale_invalid', scaleR.error, { file }));

  const seed = raw.split_seed;
  const seedOk = typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff;
  if (!seedOk) issues.push(issue('split_seed_invalid', 'split_seed must be an unsigned 32-bit integer', { file }));

  let fraction: number = DEFAULT_HELDOUT_FRACTION;
  if (raw.heldout_fraction !== undefined) {
    const f = raw.heldout_fraction;
    if (typeof f !== 'number' || !(f > 0 && f < 1)) {
      issues.push(issue('heldout_fraction_invalid', 'heldout_fraction must be a number strictly between 0 and 1', { file }));
    } else fraction = f;
  }

  let freezeDate: string | null = null;
  if (raw.freeze_date !== undefined && raw.freeze_date !== null) {
    if (typeof raw.freeze_date !== 'string') issues.push(issue('manifest_malformed', 'freeze_date must be a string', { file }));
    else freezeDate = raw.freeze_date;
  }

  if (issues.length > 0 || name === null || !scaleR.ok || !seedOk) return { manifest: null, issues };
  return { manifest: { name, scale: scaleR.value, splitSeed: seed as number, heldoutFraction: fraction, freezeDate }, issues };
}

// ---------------------------------------------------------------------------
// Items JSONL
// ---------------------------------------------------------------------------

export type ItemsParse = {
  /** Valid rows (first occurrence of each id), text canonicalised. */
  items: Item[];
  /** Ids seen on any row that carried a usable id (valid or not) — for unknown-ref checks. */
  knownIds: Set<string>;
  rowCount: number;
  issues: ImportIssue[];
};

function readId(v: unknown): string | null {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  return null;
}

/** Parse items JSONL rows `{id, task_text, answer, source?, facts?, group_id?}`. Blank lines skipped. */
export function parseItemsJsonl(text: string, file = 'items.jsonl'): ItemsParse {
  const issues: ImportIssue[] = [];
  const items: Item[] = [];
  const knownIds = new Set<string>();
  const seen = new Set<string>();
  let rowCount = 0;

  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const lineText = lines[i]!;
    if (lineText.trim() === '') continue;
    rowCount += 1;
    let raw: unknown;
    try {
      raw = JSON.parse(lineText);
    } catch {
      issues.push(issue('malformed_row', 'row is not valid JSON', { file, line: lineNo }));
      continue;
    }
    if (!isRecord(raw)) {
      issues.push(issue('malformed_row', 'row must be a JSON object', { file, line: lineNo }));
      continue;
    }
    const id = readId(raw.id);
    if (id === null) {
      issues.push(issue('malformed_row', 'row needs a non-empty string (or integer) "id"', { file, line: lineNo }));
      continue;
    }
    knownIds.add(id);
    if (seen.has(id)) {
      issues.push(issue('duplicate_item_id', `duplicate item id "${id}"`, { file, line: lineNo, itemId: id }));
      continue;
    }
    seen.add(id);

    const rowIssues: ImportIssue[] = [];
    const at = { file, line: lineNo, itemId: id };
    if (typeof raw.task_text !== 'string') rowIssues.push(issue('malformed_row', '"task_text" must be a string', at));
    if (typeof raw.answer !== 'string') rowIssues.push(issue('malformed_row', '"answer" must be a string', at));
    if (raw.source !== undefined && raw.source !== null && typeof raw.source !== 'string') {
      rowIssues.push(issue('malformed_row', '"source" must be a string when present', at));
    }
    let facts: string[] | undefined;
    if (raw.facts !== undefined && raw.facts !== null) {
      if (!Array.isArray(raw.facts) || !raw.facts.every((f: unknown) => typeof f === 'string')) {
        rowIssues.push(issue('malformed_row', '"facts" must be an array of strings when present', at));
      } else facts = (raw.facts as string[]).map((f) => normalizeText(f));
    }
    let groupId: string | undefined;
    if (raw.group_id !== undefined && raw.group_id !== null && raw.group_id !== '') {
      const g = readId(raw.group_id);
      if (g === null) rowIssues.push(issue('malformed_row', '"group_id" must be a non-empty string (or integer) when present', at));
      else groupId = g;
    }

    const fields: [string, unknown][] = [
      ['task_text', raw.task_text],
      ['answer', raw.answer],
      ['source', raw.source],
    ];
    for (const [fname, v] of fields) {
      if (typeof v === 'string' && utf8Length(v) > IMPORT_LIMITS.maxFieldBytes) {
        rowIssues.push(issue('oversize_field', `"${fname}" exceeds ${IMPORT_LIMITS.maxFieldBytes} UTF-8 bytes`, at));
      }
    }
    if (facts) {
      for (const f of facts) {
        if (utf8Length(f) > IMPORT_LIMITS.maxFieldBytes) {
          rowIssues.push(issue('oversize_field', `a "facts" entry exceeds ${IMPORT_LIMITS.maxFieldBytes} UTF-8 bytes`, at));
        }
      }
    }

    issues.push(...rowIssues);
    if (rowIssues.some((x) => x.code === 'malformed_row')) continue;

    const item: Item = {
      key: id,
      taskText: normalizeText(raw.task_text as string),
      answer: normalizeText(raw.answer as string),
    };
    if (typeof raw.source === 'string' && raw.source !== '') item.source = normalizeText(raw.source);
    if (facts && facts.length > 0) item.facts = facts;
    if (groupId !== undefined) item.groupId = groupId;
    items.push(item);
  }

  return { items, knownIds, rowCount, issues };
}

// ---------------------------------------------------------------------------
// Annotator CSV
// ---------------------------------------------------------------------------

export type ParsedLabel = { itemId: string; annotatorId: string; value: number; index: number; file: string; line: number };

export type AnnotatorCsvParse = { labels: ParsedLabel[]; issues: ImportIssue[] };

const REQUIRED_COLUMNS = ['item_id', 'annotator_id', 'score'] as const;
const INTEGER_TEXT = /^[+-]?\d+$/;

/**
 * Parse one annotator CSV with header `item_id,annotator_id,score` (any column order,
 * case-insensitive). Scores are displayed values; they are converted to level indices.
 * Unknown-item and duplicate checks need the global view and live in import.ts.
 */
export function parseAnnotatorCsv(file: string, text: string, scale: Scale | null): AnnotatorCsvParse {
  const issues: ImportIssue[] = [];
  const labels: ParsedLabel[] = [];
  const parsed = parseCsv(text);
  for (const e of parsed.errors) issues.push(issue('malformed_row', `CSV: ${e.message}`, { file, line: e.line }));

  const header = parsed.rows[0];
  if (header === undefined) {
    issues.push(issue('csv_header_invalid', 'annotator CSV is empty (needs header item_id,annotator_id,score)', { file }));
    return { labels, issues };
  }
  const names = header.cells.map((c) => c.trim().toLowerCase());
  const col: Record<string, number> = {};
  for (const req of REQUIRED_COLUMNS) {
    const idx = names.indexOf(req);
    if (idx < 0 || names.indexOf(req, idx + 1) >= 0) {
      issues.push(issue('csv_header_invalid', `header must contain exactly one "${req}" column`, { file, line: header.line }));
      return { labels, issues };
    }
    col[req] = idx;
  }

  for (const row of parsed.rows.slice(1)) {
    const at = { file, line: row.line };
    if (row.cells.length !== header.cells.length) {
      issues.push(issue('malformed_row', `expected ${header.cells.length} cells, got ${row.cells.length}`, at));
      continue;
    }
    const itemId = row.cells[col.item_id!]!.trim();
    const annotatorId = row.cells[col.annotator_id!]!.trim();
    const scoreText = row.cells[col.score!]!.trim();
    if (itemId === '' || annotatorId === '') {
      issues.push(issue('malformed_row', 'item_id and annotator_id must be non-empty', at));
      continue;
    }
    const where = { ...at, itemId, annotatorId };
    if (scoreText === '') {
      issues.push(issue('malformed_row', 'score is empty', where));
      continue;
    }
    if (!INTEGER_TEXT.test(scoreText)) {
      issues.push(issue('non_integer_score', `score "${scoreText}" is not an integer`, where));
      continue;
    }
    const value = Number(scoreText);
    if (scale === null) continue; // scale invalid: reported by the manifest; cannot map scores
    const index = levelIndex(scale, value);
    if (index === null) {
      issues.push(issue('off_scale_score', `score ${value} is not on the scale`, where));
      continue;
    }
    labels.push({ itemId, annotatorId, value, index, file, line: row.line });
  }
  return { labels, issues };
}
