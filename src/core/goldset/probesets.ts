// Probe-set import (PLAN.md §3.4, K12): verbosity probe pairs JSONL and injection items JSONL.
//
// Pair row:      {id, task_text, short_text, long_text, source?, facts?, base_item_id?}
// Injection row: {id, task_text, base_answer, answer, source?, instruction_kind?, base_item_id?}
//
// Pairs failing pairCheck are REJECTED (listed as warnings, excluded from the accepted set);
// malformed rows, duplicate ids and oversize fields are blocking. Probe rows belong to
// neither dev nor held-out and never enter agreement denominators. The optional
// base_item_id link to a gold item is checked at freeze / dev-run time, not at import
// (the split is unknown then): see checkProbeBaseItems().

import type { Item, SplitManifest } from '../types.ts';
import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import { normalizeText } from '../canonical.ts';
import type { PairCheckResult } from '../probes/pairCheck.ts';
import { pairCheck } from '../probes/pairCheck.ts';
import { IMPORT_LIMITS } from './types.ts';
import { utf8Length } from './validate.ts';

export type ProbePair = {
  id: string;
  taskText: string;
  shortText: string;
  longText: string;
  source?: string;
  facts?: string[];
  baseItemId?: string;
  check: PairCheckResult;
};

export type InjectionItem = {
  id: string;
  taskText: string;
  /** The un-injected answer the shift is measured against. */
  baseAnswer: string;
  /** The answer containing judge-targeted instructions. */
  answer: string;
  source?: string;
  instructionKind: string;
  baseItemId?: string;
};

export type ProbeSets = {
  /** Pairs that passed pairCheck. */
  pairs: ProbePair[];
  /** Pairs that failed pairCheck (kept for the report; never run). */
  rejectedPairs: ProbePair[];
  injections: InjectionItem[];
};

export type ProbeIssueCode =
  | 'upload_too_large'
  | 'malformed_row'
  | 'duplicate_probe_id'
  | 'oversize_field'
  | 'pair_rejected'
  | 'unknown_base_item'
  | 'heldout_base_item';

export type ProbeIssue = {
  code: ProbeIssueCode;
  severity: 'blocking' | 'warning';
  message: string;
  file?: string;
  line?: number;
  probeId?: string;
};

export type ProbeImportReport = {
  ok: boolean;
  blockingCount: number;
  warningCount: number;
  issues: ProbeIssue[];
  counts: { pairRows: number; acceptedPairs: number; rejectedPairs: number; injectionRows: number };
};

export type ProbeImportFiles = { pairsJsonl?: string; injectionJsonl?: string };

const PAIR_FILE = 'probe-pairs.jsonl';
const INJECTION_FILE = 'injections.jsonl';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function blocking(code: ProbeIssueCode, message: string, extra: Omit<ProbeIssue, 'code' | 'severity' | 'message'>): ProbeIssue {
  return { code, severity: 'blocking', message, ...extra };
}

function readId(v: unknown): string | null {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  return null;
}

type RowVisitor = (raw: Record<string, unknown>, id: string, line: number, issues: ProbeIssue[]) => void;

function visitJsonl(text: string, file: string, issues: ProbeIssue[], visit: RowVisitor): number {
  const seen = new Set<string>();
  let rows = 0;
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  lines.forEach((lineText, i) => {
    const line = i + 1;
    if (lineText.trim() === '') return;
    rows += 1;
    let raw: unknown;
    try {
      raw = JSON.parse(lineText);
    } catch {
      issues.push(blocking('malformed_row', 'row is not valid JSON', { file, line }));
      return;
    }
    if (!isRecord(raw)) {
      issues.push(blocking('malformed_row', 'row must be a JSON object', { file, line }));
      return;
    }
    const id = readId(raw.id);
    if (id === null) {
      issues.push(blocking('malformed_row', 'row needs a non-empty "id"', { file, line }));
      return;
    }
    if (seen.has(id)) {
      issues.push(blocking('duplicate_probe_id', `duplicate id "${id}"`, { file, line, probeId: id }));
      return;
    }
    seen.add(id);
    visit(raw, id, line, issues);
  });
  return rows;
}

/** Validate string fields; returns false (and records issues) when any is missing or oversize. */
function checkStrings(
  raw: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  at: { file: string; line: number; probeId: string },
  issues: ProbeIssue[],
): boolean {
  let good = true;
  for (const f of required) {
    if (typeof raw[f] !== 'string' || (raw[f] as string).trim() === '') {
      issues.push(blocking('malformed_row', `"${f}" must be a non-empty string`, at));
      good = false;
    }
  }
  for (const f of optional) {
    const v = raw[f];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      issues.push(blocking('malformed_row', `"${f}" must be a string when present`, at));
      good = false;
    }
  }
  for (const f of [...required, ...optional]) {
    const v = raw[f];
    if (typeof v === 'string' && utf8Length(v) > IMPORT_LIMITS.maxFieldBytes) {
      issues.push(blocking('oversize_field', `"${f}" exceeds ${IMPORT_LIMITS.maxFieldBytes} UTF-8 bytes`, at));
      good = false;
    }
  }
  return good;
}

function optText(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? normalizeText(v) : undefined;
}

/** Import probe pairs and injection items. Err(report) on any blocking issue. */
export function importProbeSets(files: ProbeImportFiles): Result<ProbeSets & { report: ProbeImportReport }, ProbeImportReport> {
  const total = utf8Length(files.pairsJsonl ?? '') + utf8Length(files.injectionJsonl ?? '');
  if (total > IMPORT_LIMITS.maxUploadBytes) {
    return err({
      ok: false,
      blockingCount: 1,
      warningCount: 0,
      issues: [blocking('upload_too_large', `upload is ${total} bytes; the limit is ${IMPORT_LIMITS.maxUploadBytes}`, {})],
      counts: { pairRows: 0, acceptedPairs: 0, rejectedPairs: 0, injectionRows: 0 },
    });
  }
  const issues: ProbeIssue[] = [];
  const pairs: ProbePair[] = [];
  const rejectedPairs: ProbePair[] = [];
  const injections: InjectionItem[] = [];

  const pairRows = visitJsonl(files.pairsJsonl ?? '', PAIR_FILE, issues, (raw, id, line, iss) => {
    const at = { file: PAIR_FILE, line, probeId: id };
    let good = checkStrings(raw, ['task_text', 'short_text', 'long_text'], ['source', 'base_item_id'], at, iss);
    let facts: string[] | undefined;
    if (raw.facts !== undefined && raw.facts !== null) {
      if (!Array.isArray(raw.facts) || !raw.facts.every((f: unknown) => typeof f === 'string')) {
        iss.push(blocking('malformed_row', '"facts" must be an array of strings when present', at));
        good = false;
      } else {
        for (const f of raw.facts as string[]) {
          if (utf8Length(f) > IMPORT_LIMITS.maxFieldBytes) {
            iss.push(blocking('oversize_field', `a "facts" entry exceeds ${IMPORT_LIMITS.maxFieldBytes} UTF-8 bytes`, at));
            good = false;
          }
        }
        facts = (raw.facts as string[]).map((f) => normalizeText(f));
      }
    }
    if (!good) return;
    const shortText = normalizeText(raw.short_text as string);
    const longText = normalizeText(raw.long_text as string);
    const check = pairCheck({ short: shortText, long: longText, facts: facts ?? [] });
    const pair: ProbePair = { id, taskText: normalizeText(raw.task_text as string), shortText, longText, check };
    const source = optText(raw.source);
    if (source !== undefined) pair.source = source;
    if (facts && facts.length > 0) pair.facts = facts;
    const base = optText(raw.base_item_id);
    if (base !== undefined) pair.baseItemId = base.trim();
    if (check.pass) pairs.push(pair);
    else {
      rejectedPairs.push(pair);
      iss.push({
        code: 'pair_rejected',
        severity: 'warning',
        message: `pair "${id}" rejected by the equivalence check: ${check.reasons.join(', ')}`,
        ...at,
      });
    }
  });

  const injectionRows = visitJsonl(files.injectionJsonl ?? '', INJECTION_FILE, issues, (raw, id, line, iss) => {
    const at = { file: INJECTION_FILE, line, probeId: id };
    const good = checkStrings(raw, ['task_text', 'base_answer', 'answer'], ['source', 'instruction_kind', 'base_item_id'], at, iss);
    if (!good) return;
    const inj: InjectionItem = {
      id,
      taskText: normalizeText(raw.task_text as string),
      baseAnswer: normalizeText(raw.base_answer as string),
      answer: normalizeText(raw.answer as string),
      instructionKind: optText(raw.instruction_kind) ?? 'unspecified',
    };
    const source = optText(raw.source);
    if (source !== undefined) inj.source = source;
    const base = optText(raw.base_item_id);
    if (base !== undefined) inj.baseItemId = base.trim();
    injections.push(inj);
  });

  const blockingCount = issues.filter((i) => i.severity === 'blocking').length;
  const report: ProbeImportReport = {
    ok: blockingCount === 0,
    blockingCount,
    warningCount: issues.length - blockingCount,
    issues,
    counts: { pairRows, acceptedPairs: pairs.length, rejectedPairs: rejectedPairs.length, injectionRows },
  };
  if (!report.ok) return err(report);
  return ok({ pairs, rejectedPairs, injections, report });
}

/**
 * Freeze-time / dev-run-time rule (K12): a probe row's base_item_id must name a known gold
 * item that is NOT held-out. Ok(undefined) when every link is fine, else Err(issues).
 */
export function checkProbeBaseItems(
  probeSets: Pick<ProbeSets, 'pairs' | 'injections'> & { rejectedPairs?: ProbePair[] },
  split: Pick<SplitManifest, 'dev' | 'heldout'>,
): Result<undefined, ProbeIssue[]> {
  const dev = new Set(split.dev);
  const heldout = new Set(split.heldout);
  const issues: ProbeIssue[] = [];
  const rows: { id: string; baseItemId?: string; file: string }[] = [
    ...probeSets.pairs.map((p) => ({ id: p.id, baseItemId: p.baseItemId, file: PAIR_FILE })),
    ...probeSets.injections.map((i) => ({ id: i.id, baseItemId: i.baseItemId, file: INJECTION_FILE })),
  ];
  for (const r of rows) {
    if (r.baseItemId === undefined) continue;
    if (heldout.has(r.baseItemId)) {
      issues.push(blocking('heldout_base_item', `probe "${r.id}" uses held-out item "${r.baseItemId}" as its base`, { file: r.file, probeId: r.id }));
    } else if (!dev.has(r.baseItemId)) {
      issues.push(blocking('unknown_base_item', `probe "${r.id}" refers to unknown item "${r.baseItemId}"`, { file: r.file, probeId: r.id }));
    }
  }
  return issues.length === 0 ? ok(undefined) : err(issues);
}

/** Item keys used when a pair is judged (never collide with each other). */
export function pairItemKeys(pairId: string): { short: string; long: string } {
  return { short: `probe:${pairId}:short`, long: `probe:${pairId}:long` };
}

export function injectionItemKeys(injectionId: string): { base: string; injected: string } {
  return { base: `inj:${injectionId}:base`, injected: `inj:${injectionId}:injected` };
}

/** The two judgeable items of a pair (same task/source/facts, short vs long answer). */
export function pairToItems(pair: ProbePair): { short: Item; long: Item } {
  const keys = pairItemKeys(pair.id);
  const common = (key: string, answer: string): Item => {
    const it: Item = { key, taskText: pair.taskText, answer };
    if (pair.source !== undefined) it.source = pair.source;
    if (pair.facts !== undefined) it.facts = pair.facts;
    return it;
  };
  return { short: common(keys.short, pair.shortText), long: common(keys.long, pair.longText) };
}

/** The two judgeable items of an injection row (base answer vs injected answer). */
export function injectionToItems(inj: InjectionItem): { base: Item; injected: Item } {
  const keys = injectionItemKeys(inj.id);
  const common = (key: string, answer: string): Item => {
    const it: Item = { key, taskText: inj.taskText, answer };
    if (inj.source !== undefined) it.source = inj.source;
    return it;
  };
  return { base: common(keys.base, inj.baseAnswer), injected: common(keys.injected, inj.answer) };
}
