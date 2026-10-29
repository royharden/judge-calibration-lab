import type { Item, JudgeConfig, Presentation, Rubric } from '../_core/core/types.ts';
import { callProvider } from './transport.ts';
export function callOpenAICompatible(item: Item, rubric: Rubric, config: JudgeConfig, presentation: Presentation) {
  if (config.provider !== 'openai_compatible') throw new Error('OpenAI-compatible adapter/config mismatch');
  return callProvider(item, rubric, config, presentation);
}
