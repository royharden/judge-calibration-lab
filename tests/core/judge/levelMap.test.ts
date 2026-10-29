import { describe, expect, it } from 'vitest';
import {
  jevPositionToSemantic,
  positionToSemantic,
  presentationOrder,
  probabilitiesToSemantic,
  semanticToPosition,
} from '../../../src/core/judge/levelMap.ts';

describe('levelMap', () => {
  it('presentation order', () => {
    expect(presentationOrder(5, 'ascending')).toEqual([0, 1, 2, 3, 4]);
    expect(presentationOrder(5, 'reversed')).toEqual([4, 3, 2, 1, 0]);
  });

  it('reversed: semantic = K - 1 - position; ascending: identity', () => {
    expect(positionToSemantic(0, 5, 'reversed')).toBe(4);
    expect(positionToSemantic(4, 5, 'reversed')).toBe(0);
    expect(positionToSemantic(1, 3, 'reversed')).toBe(1);
    expect(positionToSemantic(2, 5, 'ascending')).toBe(2);
  });

  it('round-trips for every K in 2..7 and both orders', () => {
    for (let k = 2; k <= 7; k++) {
      for (const pres of ['ascending', 'reversed'] as const) {
        for (let i = 0; i < k; i++) {
          expect(positionToSemantic(semanticToPosition(i, k, pres), k, pres)).toBe(i);
          expect(presentationOrder(k, pres)[semanticToPosition(i, k, pres)]).toBe(i);
        }
      }
    }
  });

  it('Jev positional index maps back to the semantic level', () => {
    // Levels shown reversed on a 1-5 scale: Jev picks position 1 (the second shown = level "4").
    expect(jevPositionToSemantic(1, 5, 'reversed')).toBe(3);
    expect(jevPositionToSemantic(1, 5, 'ascending')).toBe(1);
  });

  it('per-position probabilities are reordered to semantic order', () => {
    expect(probabilitiesToSemantic([0.1, 0.2, 0.3, 0.4], 'reversed')).toEqual([0.4, 0.3, 0.2, 0.1]);
    expect(probabilitiesToSemantic([0.1, 0.2, 0.3, 0.4], 'ascending')).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('rejects out-of-range input', () => {
    expect(() => positionToSemantic(5, 5, 'reversed')).toThrow(RangeError);
    expect(() => positionToSemantic(-1, 5, 'ascending')).toThrow(RangeError);
    expect(() => presentationOrder(1, 'ascending')).toThrow(RangeError);
  });
});
