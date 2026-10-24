// Strict judge-output parser (PLAN.md §3.7). Accept rule — ALL must hold:
//   the raw text (surrounding JSON whitespace allowed) is one JSON object; it has exactly one
//   key, "score" (a duplicated "score" key counts as extra keys); the value is a JSON number
//   that is an integer; the integer is one of the displayed level values.
// Then the displayed value is normalised ONCE to its semantic index 0..K-1.
// Otherwise the verdict is unusable with a reason code:
//   empty          raw is empty / whitespace only
//   malformed_json not JSON, or JSON that is not an object (code fences, prose, arrays ...)
//   missing_score  object without a "score" key
//   extra_keys     "score" plus any other key (or "score" twice)
//   non_integer    score is not an integer number (string, float, bool, null ...)
//   out_of_scale   integer not among the displayed values
// provider_error / timeout are assigned by adapters, never by this parser.
// The raw text is preserved by callers and never repaired.

import type { UnusableReason } from '../types.ts';

export type ParseOutcome =
  | { kind: 'score'; /** Semantic index 0..K-1. */ index: number; value: number }
  | { kind: 'unusable'; reason: UnusableReason };

/**
 * Keys of the top-level object of an already-valid JSON text (in order, duplicates kept).
 * Precondition: `json` parsed successfully with JSON.parse and its top level is an object.
 */
export function topLevelKeys(json: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let i = 0;
  const n = json.length;
  let expectKey = false;
  while (i < n) {
    const ch = json[i]!;
    if (ch === '"') {
      // Scan a string literal.
      let j = i + 1;
      while (j < n && json[j] !== '"') j += json[j] === '\\' ? 2 : 1;
      const literal = json.slice(i, j + 1);
      if (depth === 1 && expectKey) {
        keys.push(JSON.parse(literal) as string);
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
      if (depth === 1 && ch === '{') expectKey = true;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
    } else if (ch === ',' && depth === 1) {
      expectKey = true;
    }
    i += 1;
  }
  return keys;
}

/** Parse raw judge text against the displayed values (semantic ascending order). */
export function parseJudgeOutput(raw: string, displayedValues: readonly number[]): ParseOutcome {
  const text = raw.trim();
  if (text === '') return { kind: 'unusable', reason: 'empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unusable', reason: 'malformed_json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'unusable', reason: 'malformed_json' };
  }
  const keys = topLevelKeys(text);
  if (!keys.includes('score')) return { kind: 'unusable', reason: 'missing_score' };
  if (keys.length !== 1) return { kind: 'unusable', reason: 'extra_keys' };
  const v = (parsed as Record<string, unknown>).score;
  if (typeof v !== 'number' || !Number.isInteger(v)) return { kind: 'unusable', reason: 'non_integer' };
  const index = displayedValues.indexOf(v);
  if (index < 0) return { kind: 'unusable', reason: 'out_of_scale' };
  return { kind: 'score', index, value: v };
}

/** Exact output a well-behaved judge returns for a displayed value. */
export function formatScoreJson(value: number): string {
  return JSON.stringify({ score: value });
}
