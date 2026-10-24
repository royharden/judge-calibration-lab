// K x K confusion matrix over level indices.
// Orientation: counts[row][col], rows = first argument, cols = second argument.
// Convention used by diagnostics: rows = human (consensus) level, cols = judge level,
// so counts[4][3] reads "human-4 items scored 3".

export type ConfusionMatrix = {
  k: number;
  counts: number[][];
  n: number;
};

/** Throws RangeError unless k is an integer >= 2. */
export function assertLevelCount(k: number): void {
  if (!Number.isInteger(k) || k < 2) throw new RangeError(`level count K must be an integer >= 2, got ${String(k)}`);
}

/** Throws RangeError unless every score is an integer index in [0, k). Contract check, not data validation. */
export function assertLevelIndices(scores: readonly number[], k: number, label = 'scores'): void {
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i]!;
    if (!Number.isInteger(s) || s < 0 || s >= k) {
      throw new RangeError(`${label}[${i}] = ${String(s)} is not a level index in [0, ${k})`);
    }
  }
}

export function confusionMatrix(rows: readonly number[], cols: readonly number[], k: number): ConfusionMatrix {
  assertLevelCount(k);
  if (rows.length !== cols.length) {
    throw new RangeError(`confusionMatrix: length mismatch (${rows.length} vs ${cols.length})`);
  }
  assertLevelIndices(rows, k, 'rows');
  assertLevelIndices(cols, k, 'cols');
  const counts: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < rows.length; i++) {
    const row = counts[rows[i]!]!;
    const j = cols[i]!;
    row[j] = row[j]! + 1;
  }
  return { k, counts, n: rows.length };
}

export function rowMarginals(m: ConfusionMatrix): number[] {
  return m.counts.map((r) => r.reduce((a, b) => a + b, 0));
}

export function colMarginals(m: ConfusionMatrix): number[] {
  const out = new Array<number>(m.k).fill(0);
  for (const r of m.counts) for (let j = 0; j < m.k; j++) out[j] = out[j]! + r[j]!;
  return out;
}
