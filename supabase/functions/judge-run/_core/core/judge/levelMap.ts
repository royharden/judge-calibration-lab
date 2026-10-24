// Presentation order <-> semantic level index (PLAN.md §3.7, scale-order probe).
// Semantic index s in 0..K-1 is the level's position on the ascending scale. When levels are
// presented reversed, display position p shows semantic level K-1-p. Generative judges answer
// with the displayed VALUE (unchanged by order), so only positional outputs need mapping:
// Jev returns a 0-based position (or a probability per position), mapped back with
// semantic = K-1-position when reversed.

import type { Presentation } from '../types.ts';

export const LEVEL_MAP_VERSION = 'levelmap/v1';

function assertK(k: number): void {
  if (!Number.isInteger(k) || k < 2) throw new RangeError(`level count must be an integer >= 2, got ${String(k)}`);
}

function assertIndex(i: number, k: number, what: string): void {
  if (!Number.isInteger(i) || i < 0 || i >= k) throw new RangeError(`${what} ${String(i)} not in [0, ${k})`);
}

/** Semantic indices in display order. */
export function presentationOrder(k: number, presentation: Presentation): number[] {
  assertK(k);
  const asc = Array.from({ length: k }, (_, i) => i);
  return presentation === 'reversed' ? asc.reverse() : asc;
}

/** Display position -> semantic index. */
export function positionToSemantic(position: number, k: number, presentation: Presentation): number {
  assertK(k);
  assertIndex(position, k, 'position');
  return presentation === 'reversed' ? k - 1 - position : position;
}

/** Semantic index -> display position (the mapping is its own inverse). */
export function semanticToPosition(index: number, k: number, presentation: Presentation): number {
  assertK(k);
  assertIndex(index, k, 'index');
  return presentation === 'reversed' ? k - 1 - index : index;
}

/** Jev positional index (0-based, in presentation order) -> semantic index. */
export function jevPositionToSemantic(position: number, k: number, presentation: Presentation): number {
  return positionToSemantic(position, k, presentation);
}

/** Probabilities listed per display position -> probabilities per semantic index. */
export function probabilitiesToSemantic(byPosition: readonly number[], presentation: Presentation): number[] {
  const k = byPosition.length;
  assertK(k);
  const out = new Array<number>(k).fill(0);
  for (let p = 0; p < k; p++) out[positionToSemantic(p, k, presentation)] = byPosition[p]!;
  return out;
}
