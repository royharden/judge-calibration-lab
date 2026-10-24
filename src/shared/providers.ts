// Pure wire builders/parsers. Origins and credentials are supplied ONLY by edge wrappers.
// Jev wire fields follow the local pinned guide; live schema/model verification is deferred.
import type { Item, JudgeConfig, Presentation, Rubric, UnusableReason } from '../core/types.ts';
import { canonicalHash } from '../core/canonical.ts';
import { deriveStream } from '../core/prng.ts';
import { buildPrompt, type RandomSource } from '../core/judge/prompt.ts';
import { presentationOrder, jevPositionToSemantic } from '../core/judge/levelMap.ts';
import { formatScoreJson } from '../core/judge/parse.ts';

export const JEV_MODEL = 'jev-1.13.0';
export type LiveProvider = Exclude<JudgeConfig['provider'], 'mock'>;
export type ProviderUsage = { inputTokens: number | null; outputTokens: number | null; raw: unknown };
export type ProviderRequest = { provider: LiveProvider; method: 'POST'; path: '/v1/messages' | '/chat/completions' | '/v1/systemone'; headers: Readonly<Record<string, string>>; body: Record<string, unknown> };
export type ProviderResponse = {
  kind: 'response'; raw: string; usage: ProviderUsage; reportedModel: string | null;
  /** Jev only: semantic index after positional mapping. Generative raw uses parseJudgeOutput. */
  score?: number;
} | { kind: 'unusable'; unusable: UnusableReason; raw: string; usage: ProviderUsage; reportedModel: string | null };

function record(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function count(v: unknown): number | null { return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null; }
function parsed(body: unknown): unknown { if (typeof body !== 'string') return body; try { return JSON.parse(body) as unknown; } catch { return null; } }
function rawBody(body: unknown): string { if (typeof body === 'string') return body; try { return JSON.stringify(body) ?? ''; } catch { return '[unserializable response]'; } }
function envelope(body: unknown, inputField: string, outputField: string): { obj: Record<string, unknown> | null; usage: ProviderUsage; reportedModel: string | null } {
  const obj = parsed(body);
  const usage = record(obj) && record(obj.usage) ? obj.usage : null;
  return { obj: record(obj) ? obj : null, reportedModel: record(obj) && typeof obj.model === 'string' ? obj.model : null,
    usage: { inputTokens: usage === null ? null : count(usage[inputField]), outputTokens: usage === null ? null : count(usage[outputField]), raw: usage } };
}
function failure(body: unknown, info: { usage: ProviderUsage; reportedModel: string | null }, unusable: UnusableReason = 'provider_error'): ProviderResponse {
  return { kind: 'unusable', unusable, raw: rawBody(body), usage: info.usage, reportedModel: info.reportedModel };
}
function assertConfig(config: JudgeConfig, rubric: Rubric): void {
  if (!Number.isInteger(config.params.maxOutputTokens) || config.params.maxOutputTokens < 1) throw new RangeError('maxOutputTokens must be positive');
  if (config.params.temperature !== undefined && (!Number.isFinite(config.params.temperature) || config.params.temperature < 0)) throw new RangeError('invalid temperature');
  if (rubric.levels.length < 2 || rubric.levels.length > 7) throw new RangeError('provider rubric must have 2–7 levels');
}
function prompt(item: Item, rubric: Rubric, config: JudgeConfig, presentation: Presentation, rng?: RandomSource) {
  return buildPrompt(item, rubric, presentation, rng ?? deriveStream(36, `provider-nonce:${canonicalHash({ item, rubric: rubric.contentHash, config: config.configHash, presentation })}`));
}
export function buildAnthropicRequest(item: Item, rubric: Rubric, config: JudgeConfig, presentation: Presentation = 'ascending', rng?: RandomSource): ProviderRequest {
  assertConfig(config, rubric);
  if (config.provider !== 'anthropic' || config.scoreReadout !== 'json_score') throw new RangeError('Anthropic requires json_score config');
  const p = prompt(item, rubric, config, presentation, rng);
  return { provider: 'anthropic', method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: { model: config.model, system: p.system, messages: [{ role: 'user', content: p.user }], temperature: config.params.temperature ?? 0, max_tokens: config.params.maxOutputTokens } };
}
export function buildOpenAICompatibleRequest(item: Item, rubric: Rubric, config: JudgeConfig, presentation: Presentation = 'ascending', rng?: RandomSource): ProviderRequest {
  assertConfig(config, rubric);
  if (config.provider !== 'openai_compatible' || config.scoreReadout !== 'json_score') throw new RangeError('OpenAI-compatible requires json_score config');
  const p = prompt(item, rubric, config, presentation, rng);
  return { provider: 'openai_compatible', method: 'POST', path: '/chat/completions', headers: { 'content-type': 'application/json' },
    body: { model: config.model, messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }], temperature: config.params.temperature ?? 0, max_tokens: config.params.maxOutputTokens,
      response_format: { type: 'json_schema', json_schema: { name: 'judge_score', strict: true, schema: { type: 'object', properties: { score: { type: 'integer', enum: rubric.levels.map((l) => l.value) } }, required: ['score'], additionalProperties: false } } } } };
}
export function buildTypesafeRequest(item: Item, rubric: Rubric, config: JudgeConfig, presentation: Presentation = 'ascending'): ProviderRequest {
  assertConfig(config, rubric);
  if (config.provider !== 'typesafe' || config.model !== JEV_MODEL || (config.scoreReadout !== 'argmax_probabilities' && config.scoreReadout !== 'rounded_score')) throw new RangeError('TypeSafe requires pinned Jev model and positional readout');
  const legend = presentationOrder(rubric.levels.length, presentation).map((i) => rubric.levels[i]!.description);
  return { provider: 'typesafe', method: 'POST', path: '/v1/systemone', headers: { 'content-type': 'application/json' },
    body: { model: JEV_MODEL, state: { task: item.taskText, answer: item.answer, source: item.source ?? '' },
      questions: { score: { type: 'score', instructions: rubric.instructions, legend } } } };
}
export function buildRequest(item: Item, rubric: Rubric, config: JudgeConfig, presentation: Presentation = 'ascending', rng?: RandomSource): ProviderRequest {
  switch (config.provider) {
    case 'anthropic': return buildAnthropicRequest(item, rubric, config, presentation, rng);
    case 'openai_compatible': return buildOpenAICompatibleRequest(item, rubric, config, presentation, rng);
    case 'typesafe': return buildTypesafeRequest(item, rubric, config, presentation);
    case 'mock': throw new RangeError('mock judges do not make provider requests');
  }
}
export function parseAnthropicResponse(body: unknown): ProviderResponse {
  const info = envelope(body, 'input_tokens', 'output_tokens');
  const obj = info.obj;
  if (!obj || obj.error !== undefined || !Array.isArray(obj.content) || obj.content.length === 0) return failure(body, info);
  if (obj.content.some((block) => !record(block) || block.type !== 'text' || typeof block.text !== 'string')) return failure(body, info);
  return { kind: 'response', raw: obj.content.map((b: unknown) => (b as { text: string }).text).join(''), usage: info.usage, reportedModel: info.reportedModel };
}
export function parseOpenAICompatibleResponse(body: unknown): ProviderResponse {
  const info = envelope(body, 'prompt_tokens', 'completion_tokens');
  const obj = info.obj;
  if (!obj || obj.error !== undefined || !Array.isArray(obj.choices) || obj.choices.length !== 1) return failure(body, info);
  const choice: unknown = obj.choices[0];
  if (!record(choice) || !record(choice.message) || typeof choice.message.content !== 'string' || choice.message.refusal) return failure(body, info);
  return { kind: 'response', raw: choice.message.content, usage: info.usage, reportedModel: info.reportedModel };
}
export function parseTypesafeResponse(body: unknown, rubric: Rubric, config: JudgeConfig, presentation: Presentation = 'ascending'): ProviderResponse {
  const info = envelope(body, 'input_tokens', 'output_tokens');
  const obj = info.obj;
  if (!obj || obj.error !== undefined || config.provider !== 'typesafe' || config.model !== JEV_MODEL || info.reportedModel !== JEV_MODEL || !record(obj.answers) || !record(obj.answers.score)) return failure(body, info);
  const answer = obj.answers.score;
  const k = rubric.levels.length;
  const probabilities = answer.probabilities;
  const legend = answer.legend;
  if (k < 2 || k > 7 || !Array.isArray(probabilities) || probabilities.length !== k || !Array.isArray(legend) || legend.length !== k) return failure(body, info);
  const expectedLegend = presentationOrder(k, presentation).map((i) => rubric.levels[i]!.description);
  if (legend.some((l, i) => l !== expectedLegend[i]) || probabilities.some((p) => typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1)) return failure(body, info);
  const probs = probabilities as number[];
  if (Math.abs(probs.reduce((a, b) => a + b, 0) - 1) > 1e-6 * k) return failure(body, info);
  let position = 0;
  if (config.scoreReadout === 'argmax_probabilities') {
    for (let i = 1; i < k; i++) if (probs[i]! > probs[position]!) position = i; // strict > chooses lowest POSITION on ties
  } else if (config.scoreReadout === 'rounded_score') {
    if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > k - 1) return failure(body, info);
    position = Math.round(answer.score);
  } else return failure(body, info);
  const score = jevPositionToSemantic(position, k, presentation);
  return { kind: 'response', raw: formatScoreJson(rubric.levels[score]!.value), usage: info.usage, reportedModel: info.reportedModel, score };
}
export function parseResponse(body: unknown, rubric: Rubric, config: JudgeConfig, presentation: Presentation = 'ascending'): ProviderResponse {
  switch (config.provider) {
    case 'anthropic': return parseAnthropicResponse(body);
    case 'openai_compatible': return parseOpenAICompatibleResponse(body);
    case 'typesafe': return parseTypesafeResponse(body, rubric, config, presentation);
    case 'mock': return failure(body, { usage: { inputTokens: null, outputTokens: null, raw: null }, reportedModel: null });
  }
}
