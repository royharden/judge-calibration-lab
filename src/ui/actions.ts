import type { DevDisplay, Store, StoreResult } from '../store/Store.ts';

/** Generate the selected completed run's suggestions before reading its display. */
export async function loadDevDiagnostics(
  store: Pick<Store, 'generateSuggestions' | 'getDevResults'>,
  runId: string,
): Promise<StoreResult<DevDisplay>> {
  const generated = await store.generateSuggestions({ runId });
  if (!generated.ok) return generated;
  return store.getDevResults({ runId });
}

/** A late request for another run must never supply the selected run's evidence. */
export function diagnosticsForRun(display: DevDisplay | null, runId: string | undefined): DevDisplay | null {
  return display?.diagnostics.runId === runId ? display : null;
}
