// Append-only rulings log (PLAN.md §3.8, §3.13 item 2, K18).
//
// A ruling is a human accept/reject decision on a dev-only suggestion. The log is append-only:
// there is no update or delete; a later ruling on the same suggestion is a new entry and the
// latest one is the effective decision.
//
// Staleness (K18): a suggestion carries the `input_hash` of the dev result it was generated
// from (= that run's `result_hash`). A ruling is rejected as `stale` when
//   - a newer completed dev score run exists for the same (set, rubric, judge config), or
//   - the suggestion's input hash differs from its run's stored result hash,
// so every ruling cites the latest dev evidence. The latest-run lookup is injected (MemoryStore
// reads page memory; the SQL `append_ruling` RPC reads `runs`).

import { err, ok, type Err, type Reason, type Result } from '../core/result.ts';
import type { Split } from '../core/types.ts';

export type RulingDecision = 'accept' | 'reject';

/** The suggestion being ruled on (stored when the suggestion was generated). */
export type SuggestionRef = {
  readonly suggestionId: string;
  readonly owner: string;
  readonly runId: string;
  /** Split of the run the suggestion came from; must be 'dev'. */
  readonly split: Split;
  readonly setId: string;
  readonly rubricHash: string;
  readonly judgeConfigHash: string;
  /** Result hash of the dev run the suggestion was computed from. */
  readonly inputHash: string;
};

/** Latest COMPLETED dev score run for (set, rubric, judge config), or null when none exists. */
export type LatestDevRunLookup = (key: { setId: string; rubricHash: string; judgeConfigHash: string }) => {
  runId: string;
  resultHash: string;
} | null;

export type Ruling = {
  readonly seq: number;
  readonly suggestionId: string;
  readonly owner: string;
  readonly decision: RulingDecision;
  readonly note: string;
  readonly inputHash: string;
  readonly runId: string;
  readonly at: string;
};

export type RulingsLog = { readonly entries: readonly Ruling[] };

export type RulingErrorCode = 'forbidden' | 'not_dev' | 'stale' | 'bad_request';
export type RulingError = Reason<RulingErrorCode>;

export type AppendRulingInput = {
  readonly owner: string;
  readonly suggestion: SuggestionRef;
  readonly decision: RulingDecision;
  readonly note?: string;
  readonly now: string;
};

export function createRulingsLog(): RulingsLog {
  return Object.freeze({ entries: Object.freeze([]) as readonly Ruling[] });
}

function fail(reason: RulingErrorCode, message: string): Err<RulingError> {
  return err({ reason, message });
}

/** Staleness check alone (also used to grey out stale suggestions in the UI). */
export function rulingStaleness(suggestion: SuggestionRef, latestDevRun: LatestDevRunLookup): { stale: boolean; message: string } {
  const latest = latestDevRun({ setId: suggestion.setId, rubricHash: suggestion.rubricHash, judgeConfigHash: suggestion.judgeConfigHash });
  if (latest === null) return { stale: true, message: 'no completed dev score run exists for this set, rubric and judge config' };
  if (latest.runId !== suggestion.runId) return { stale: true, message: `a newer completed dev score run (${latest.runId}) exists; regenerate suggestions` };
  if (latest.resultHash !== suggestion.inputHash) return { stale: true, message: 'the suggestion input hash differs from its run result hash' };
  return { stale: false, message: 'current' };
}

/** Append a ruling. Returns a NEW log; the input log is never mutated. */
export function appendRuling(log: RulingsLog, input: AppendRulingInput, latestDevRun: LatestDevRunLookup): Result<{ log: RulingsLog; ruling: Ruling }, RulingError> {
  const s = input.suggestion;
  if (s.owner !== input.owner) return fail('forbidden', 'the suggestion belongs to another owner');
  if (s.split !== 'dev') return fail('not_dev', 'rulings apply only to suggestions computed from dev results');
  if (input.decision !== 'accept' && input.decision !== 'reject') return fail('bad_request', 'decision must be accept or reject');
  const staleness = rulingStaleness(s, latestDevRun);
  if (staleness.stale) return fail('stale', staleness.message);
  const last = log.entries[log.entries.length - 1];
  const ruling: Ruling = Object.freeze({
    seq: (last?.seq ?? 0) + 1,
    suggestionId: s.suggestionId,
    owner: input.owner,
    decision: input.decision,
    note: input.note ?? '',
    inputHash: s.inputHash,
    runId: s.runId,
    at: input.now,
  });
  return ok({ log: Object.freeze({ entries: Object.freeze([...log.entries, ruling]) }), ruling });
}

/** Effective (latest) ruling per suggestion id. */
export function latestRulings(log: RulingsLog): Map<string, Ruling> {
  const out = new Map<string, Ruling>();
  for (const r of log.entries) out.set(r.suggestionId, r);
  return out;
}
