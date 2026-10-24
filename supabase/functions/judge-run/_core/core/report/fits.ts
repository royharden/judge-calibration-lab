import type { Annotation, Item, Verdict } from '../types.ts';
import { canonicalHash } from '../canonical.ts';
import { fitLexical, type LexicalFit } from '../judge/lexical.ts';
import { fitModal, type ModalFit } from '../judge/modal.ts';
import { meanHumanByItem } from '../judgestats/consensus.ts';
import { fitPav, PAV_ALGO_VERSION, type PavMap } from '../judgestats/pav.ts';
import { fail, ok, type Reason, type Result } from '../result.ts';
import type { FitHashes } from '../heldoutlock/policy.ts';

export type FitInput = { devItems: readonly Item[]; devKeys: readonly string[]; devAnnotations: readonly Annotation[]; baselineVerdicts: readonly Verdict[]; k: number };
export type DevFits = { fittedOn: 'dev'; lexical: LexicalFit; modal: ModalFit; pav: PavMap; hashes: FitHashes; devInputHash: string };
export type FitRefusal = Reason<'not_dev' | 'invalid_fit_input' | 'no_dev_items' | 'no_dev_labels' | 'no_data' | 'bad_level_count'>;
export function fitHashes(fits: Pick<DevFits, 'lexical' | 'modal' | 'pav'>): FitHashes {
  return { lexicalCutPoints: canonicalHash(fits.lexical), modalLevel: canonicalHash(fits.modal), pavMap: canonicalHash({ version: PAV_ALGO_VERSION, ...fits.pav }) };
}
/** All learned transforms are fitted once on the baseline dev pass, never held-out rows. */
export function computeDevFits(input: FitInput): Result<DevFits, FitRefusal> {
  const keys = new Set(input.devKeys);
  if (keys.size !== input.devKeys.length || new Set(input.devItems.map((i) => i.key)).size !== input.devItems.length || input.devItems.length !== keys.size) return fail('invalid_fit_input', 'dev item universe must contain exactly the declared dev keys');
  for (const row of [...input.devItems.map((i) => ({ ...i, itemKey: i.key })), ...input.devAnnotations, ...input.baselineVerdicts]) {
    if (!keys.has(row.itemKey) || ('split' in row && row.split !== 'dev')) return fail('not_dev', 'fits accept only rows in the dev split');
  }
  if (new Set(input.baselineVerdicts.map((v) => v.itemKey)).size !== input.baselineVerdicts.length) return fail('invalid_fit_input', 'fits require one baseline score per dev item');
  if (input.baselineVerdicts.length !== keys.size) return fail('invalid_fit_input', 'a complete baseline dev score run is required');
  const items = [...input.devItems].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const annotations = [...input.devAnnotations].sort((a, b) => a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : a.annotatorId < b.annotatorId ? -1 : a.annotatorId > b.annotatorId ? 1 : 0);
  const verdicts = [...input.baselineVerdicts].sort((a, b) => a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0);
  const lexical = fitLexical(items, { dev: [...keys] }, input.k);
  if (!lexical.ok) return lexical;
  const modal = fitModal(annotations, { dev: [...keys] }, input.k);
  if (!modal.ok) return modal;
  const means = meanHumanByItem(annotations);
  const pav = fitPav(verdicts.filter((v) => v.score !== null && means.has(v.itemKey)).map((v) => ({ judge: v.score!, human: means.get(v.itemKey)! })), input.k);
  if (!pav.ok) return pav;
  const fits = { lexical: lexical.value, modal: modal.value, pav: pav.value };
  return ok({ ...fits, fittedOn: 'dev', hashes: fitHashes(fits), devInputHash: canonicalHash({ items, annotations, verdicts, k: input.k }) });
}
