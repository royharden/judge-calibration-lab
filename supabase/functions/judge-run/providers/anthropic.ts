import type { Item, JudgeConfig, Presentation, Rubric } from '../_core/core/types.ts';
import { callProvider } from './transport.ts';
export function callAnthropic(item: Item, rubric: Rubric, config: JudgeConfig, presentation: Presentation) {
  if (config.provider !== 'anthropic') throw new Error('Anthropic adapter/config mismatch');
  return callProvider(item, rubric, config, presentation);
}
