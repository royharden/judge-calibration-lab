import { describe, expect, it } from 'vitest';
import { fail, ok } from '../../src/core/result.ts';
import type { Store, StoreResult, StoredSuggestion } from '../../src/store/Store.ts';
import { diagnosticsForRun, loadDevDiagnostics } from '../../src/ui/actions.ts';

describe('diagnostics Load action', () => {
  it('awaits suggestion generation for the selected run before reading, and propagates read errors', async () => {
    // what_bug_this_catches: the button reads an empty suggestion list before generation finishes.
    const calls: string[] = [];
    let completeGeneration: (result: StoreResult<StoredSuggestion[]>) => void = () => { throw new Error('generation not started'); };
    const generation = new Promise<StoreResult<StoredSuggestion[]>>((resolve) => { completeGeneration = resolve; });
    const readError = fail('not_found', 'selected run disappeared before read');
    const store: Pick<Store, 'generateSuggestions' | 'getDevResults'> = {
      generateSuggestions: ({ runId }) => { calls.push(`generate:${runId}`); return generation; },
      getDevResults: async ({ runId }) => { calls.push(`read:${runId}`); return readError; },
    };
    const pending = loadDevDiagnostics(store, 'completed-run');
    expect(calls).toEqual(['generate:completed-run']);
    completeGeneration(ok([]));
    expect(await pending).toBe(readError);
    expect(calls).toEqual(['generate:completed-run', 'read:completed-run']);
  });

  it('propagates generation failure without reading existing diagnostics', async () => {
    // what_bug_this_catches: a refused generation is hidden behind stale or incomplete evidence.
    const calls: string[] = [];
    const generationError = fail('prerequisite_missing', 'complete the dev run first');
    const store: Pick<Store, 'generateSuggestions' | 'getDevResults'> = {
      generateSuggestions: async ({ runId }) => { calls.push(`generate:${runId}`); return generationError; },
      getDevResults: async ({ runId }) => { calls.push(`read:${runId}`); return fail('unexpected_read', 'must not read after generation failure'); },
    };
    expect(await loadDevDiagnostics(store, 'pending-run')).toBe(generationError);
    expect(calls).toEqual(['generate:pending-run']);
    expect(diagnosticsForRun(null, 'pending-run')).toBeNull();
  });
});
