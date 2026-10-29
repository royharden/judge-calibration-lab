import { describe, expect, it } from 'vitest';
import type { JudgeConfig, Presentation, Provider } from '../../src/core/types.ts';
import { createRubric } from '../../src/core/rubric/rubric.ts';
import { unwrap } from '../../src/core/result.ts';
import { parseJudgeOutput } from '../../src/core/judge/parse.ts';
import { JEV_MODEL, buildRequest, buildTypesafeRequest, parseResponse, parseAnthropicResponse, parseOpenAICompatibleResponse, parseTypesafeResponse } from '../../src/shared/providers.ts';

const scale = { levels: [1, 2, 3, 4, 5].map((value) => ({ value, label: String(value) })) };
const rubric = unwrap(createRubric({ setId: 's', instructions: 'Grade the answer only.', levels: scale.levels.map((l) => ({ value: l.value, description: `description ${l.value}` })) }, scale));
const item = { key: 'x', taskText: 'task', answer: 'answer', source: 'source', facts: ['private-to-fixture'], groupId: 'g' };
function config(provider: Provider, readout: JudgeConfig['scoreReadout'] = provider === 'typesafe' ? 'argmax_probabilities' : 'json_score'): JudgeConfig {
  return { id: 'c', provider, model: provider === 'typesafe' ? JEV_MODEL : 'pinned-model', params: { temperature: 0.17, maxOutputTokens: 57 }, promptTemplateVersion: 'judge-prompt/v1', outputSchemaVersion: 'score-json/v1', scoreReadout: readout, levelMapVersion: 'levelmap/v1', configHash: 'h' };
}
function jevBody(probabilities = [0.1, 0.2, 0.3, 0.3, 0.1], presentation: Presentation = 'ascending', score = 2.4) {
  const legend = rubric.levels.map((l) => l.description);
  if (presentation === 'reversed') legend.reverse();
  return { model: JEV_MODEL, answers: { score: { score, probabilities, legend } }, usage: { input_tokens: 100, output_tokens: 0 } };
}

describe('pure provider requests', () => {
  it.each(['anthropic', 'openai_compatible'] as const)('%s carries strict JSON instruction and frozen decoding params', (provider) => {
    const request = buildRequest(item, rubric, config(provider));
    const body = JSON.stringify(request.body);
    expect(body).toContain('exactly one JSON object');
    expect(body).toContain('No other keys');
    expect(body).toContain('score');
    expect(request.body.temperature).toBe(0.17);
    expect(request.body.max_tokens).toBe(57);
    expect(request.body.model).toBe('pinned-model');
    expect('url' in request).toBe(false);
    expect('authorization' in request.headers).toBe(false);
    expect(buildRequest(item, rubric, config(provider))).toEqual(request);
  });
  it('OpenAI-compatible schema permits only the displayed integer score', () => {
    const r = buildRequest(item, rubric, config('openai_compatible'));
    expect(r.body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true, schema: { required: ['score'], additionalProperties: false, properties: { score: { type: 'integer', enum: [1, 2, 3, 4, 5] } } } } });
  });
  it('TypeSafe pins model, restricts state and reverses only the legend', () => {
    const r = buildTypesafeRequest(item, rubric, config('typesafe'), 'reversed');
    expect(r.body.model).toBe('jev-1.13.0');
    expect(r.body.state).toEqual({ task: 'task', answer: 'answer', source: 'source' });
    expect(r.body.questions).toEqual({ score: { type: 'score', instructions: rubric.instructions, legend: [...rubric.levels].reverse().map((l) => l.description) } });
    expect(() => buildTypesafeRequest(item, rubric, { ...config('typesafe'), model: 'jev-latest' })).toThrow('pinned');
  });
  it('data cannot supply a provider base URL and bad config fails before a call', () => {
    const r = buildRequest({ ...item, source: 'https://untrusted.invalid/' }, rubric, { ...config('anthropic'), ...{ baseUrl: 'https://untrusted.invalid' } });
    expect(r.path).toBe('/v1/messages');
    expect('baseUrl' in r).toBe(false);
    expect(() => buildRequest(item, rubric, config('mock'))).toThrow('mock');
    expect(() => buildRequest(item, rubric, { ...config('anthropic'), params: { maxOutputTokens: 0 } })).toThrow('maxOutputTokens');
  });
});

describe('pure provider response parsing', () => {
  it('extracts exact Anthropic text and usage; does not repair score output', () => {
    const parsed = parseAnthropicResponse({ model: 'reported', content: [{ type: 'text', text: '{"score":5}' }], usage: { input_tokens: 17, output_tokens: 3 } });
    expect(parsed).toMatchObject({ kind: 'response', raw: '{"score":5}', usage: { inputTokens: 17, outputTokens: 3 }, reportedModel: 'reported' });
    if (parsed.kind === 'response') expect(parseJudgeOutput(parsed.raw, [1, 2, 3, 4, 5])).toMatchObject({ kind: 'score', index: 4 });
    const broken = parseAnthropicResponse({ content: [{ type: 'text', text: '```json\n{"score":5}\n```' }] });
    expect(broken.kind).toBe('response');
    if (broken.kind === 'response') expect(parseJudgeOutput(broken.raw, [1, 2, 3, 4, 5]).kind).toBe('unusable');
  });
  it('extracts OpenAI-compatible output and rejects refusal/multiple choices', () => {
    const body = { model: 'reported', choices: [{ message: { content: '{"score":1}' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } };
    expect(parseOpenAICompatibleResponse(body)).toMatchObject({ kind: 'response', raw: '{"score":1}', usage: { inputTokens: 12, outputTokens: 3 } });
    expect(parseOpenAICompatibleResponse({ ...body, choices: [body.choices[0], body.choices[0]] }).kind).toBe('unusable');
    expect(parseOpenAICompatibleResponse({ choices: [{ message: { content: '', refusal: 'refused' } }] }).kind).toBe('unusable');
  });
  it('TypeSafe argmax chooses the lowest POSITION tie then maps to semantic level', () => {
    const a = parseTypesafeResponse(jevBody(), rubric, config('typesafe'));
    expect(a).toMatchObject({ kind: 'response', score: 2, raw: '{"score":3}' });
    const reverse = parseTypesafeResponse(jevBody([0.5, 0.5, 0, 0, 0], 'reversed'), rubric, config('typesafe'), 'reversed');
    expect(reverse).toMatchObject({ kind: 'response', score: 4, raw: '{"score":5}' });
  });
  it('rounded_score reads fractional position, then maps reversed order', () => {
    expect(parseTypesafeResponse(jevBody(undefined, 'reversed', 1.6), rubric, config('typesafe', 'rounded_score'), 'reversed')).toMatchObject({ kind: 'response', score: 2 });
    expect(parseTypesafeResponse(jevBody(undefined, 'ascending', 1.5), rubric, config('typesafe', 'rounded_score'))).toMatchObject({ kind: 'response', score: 2 });
  });
  it('validates model echo, K, legend and every probability and its total', () => {
    const c = config('typesafe');
    const valid = jevBody();
    for (const body of [
      { ...valid, model: 'jev-other' },
      { ...valid, answers: { score: { ...valid.answers.score, probabilities: [1, 0] } } },
      { ...valid, answers: { score: { ...valid.answers.score, legend: ['wrong'] } } },
      jevBody([1, 1, 0, 0, 0]), jevBody([-1, 1, 1, 0, 0]), jevBody([Number.NaN, 0, 0, 0, 1]),
      jevBody([0.1, 0.1, 0.1, 0.1, 0.1]),
    ]) expect(parseTypesafeResponse(body, rubric, c).kind).toBe('unusable');
    expect(parseTypesafeResponse(jevBody([0.2, 0.2, 0.2, 0.2, 0.200004]), rubric, c).kind).toBe('response');
    expect(parseTypesafeResponse(jevBody([0.2, 0.2, 0.2, 0.2, 0.200006]), rubric, c).kind).toBe('unusable');
    expect(parseTypesafeResponse(jevBody(undefined, 'ascending', 5), rubric, config('typesafe', 'rounded_score')).kind).toBe('unusable');
  });
  it('malformed provider envelope preserves raw failure and never fabricates a score', () => {
    for (const provider of ['anthropic', 'openai_compatible', 'typesafe'] as const) {
      const result = parseResponse('{bad-json', rubric, config(provider));
      expect(result).toMatchObject({ kind: 'unusable', unusable: 'provider_error', raw: '{bad-json' });
      expect('score' in result).toBe(false);
    }
  });
});
