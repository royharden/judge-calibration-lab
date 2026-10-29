// Modal baseline (PLAN.md §3.7): the most frequent DEV label (all dev labels pooled), ties to
// the lower level. It is a constant judge, so its QWK against any annotator is undefined by
// construction (constant marginal) — reported as "undefined (constant judge)", never 0. Its
// exact agreement is still informative.

import type { Annotation, SplitManifest } from '../types.ts';
import type { Reason, Result } from '../result.ts';
import { fail, ok } from '../result.ts';
import type { Judge } from './judge.ts';
import { baselineResult } from './lexical.ts';

export const MODAL_ALGO_VERSION = 'modal-dev-label-lowtie/v1';
export const MODAL_KAPPA_NOTE = 'undefined (constant judge)';

export type ModalFit = {
  kind: 'modal';
  algoVersion: string;
  k: number;
  /** Modal level index. */
  level: number;
  /** Dev label count per level index. */
  counts: number[];
  nLabels: number;
  fittedOn: 'dev';
  /** Modal kappa is undefined by construction. */
  kappaNote: string;
};

export type ModalRefusal = Reason<'no_dev_labels' | 'bad_level_count'>;

/** Fit on labels of DEV items only (labels of items outside split.dev are ignored). */
export function fitModal(annotations: readonly Annotation[], split: Pick<SplitManifest, 'dev'>, k: number): Result<ModalFit, ModalRefusal> {
  if (!Number.isInteger(k) || k < 2) return fail('bad_level_count', `level count must be >= 2, got ${String(k)}`);
  const dev = new Set(split.dev);
  const counts = new Array<number>(k).fill(0);
  let n = 0;
  for (const a of annotations) {
    if (!dev.has(a.itemKey)) continue;
    if (!Number.isInteger(a.score) || a.score < 0 || a.score >= k) throw new RangeError(`fitModal: score ${String(a.score)} not in [0, ${k})`);
    counts[a.score] = counts[a.score]! + 1;
    n += 1;
  }
  if (n === 0) return fail('no_dev_labels', 'no dev labels to fit the modal baseline');
  let level = 0;
  for (let i = 1; i < k; i++) if (counts[i]! > counts[level]!) level = i; // strict > keeps the lower level on ties
  return ok({ kind: 'modal', algoVersion: MODAL_ALGO_VERSION, k, level, counts, nLabels: n, fittedOn: 'dev', kappaNote: MODAL_KAPPA_NOTE });
}

export function createModalJudge(fit: ModalFit, id = 'baseline:modal'): Judge {
  return {
    id,
    score(_item, rubric) {
      return Promise.resolve(baselineResult(rubric, fit.level, fit.k));
    },
  };
}
