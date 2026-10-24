import type { Item, JudgeConfig, Presentation, Rubric } from '../_core/core/types.ts';
import { callProvider } from './transport.ts';
export function callTypesafe(item: Item, rubric: Rubric, config: JudgeConfig, presentation: Presentation) {
  if (config.provider !== 'typesafe') throw new Error('TypeSafe adapter/config mismatch');
  return callProvider(item, rubric, config, presentation);
}
