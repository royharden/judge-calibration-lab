import type { Item, JudgeConfig, Presentation, Rubric } from '../_core/core/types.ts';
import { parseJudgeOutput } from '../_core/core/judge/parse.ts';
import { buildRequest, parseResponse } from '../_core/shared/providers.ts';
import type { JudgeResult } from '../_core/core/judge/judge.ts';
import { requiredSecret } from '../runtime.ts';

export type ProviderCall = { result: JudgeResult; usage: { inputTokens: number; outputTokens: number } | null; rawResponse: string; reportedModel: string | null };
export function providerConnection(config: JudgeConfig): { url: string; headers: Record<string, string> } {
  if (config.provider === 'anthropic') return { url: 'https://api.anthropic.com/v1/messages', headers: { 'x-api-key': requiredSecret('ANTHROPIC_API_KEY') } };
  if (config.provider === 'typesafe') return { url: 'https://api.typesafe.ai/v1/systemone', headers: { authorization: `Bearer ${requiredSecret('TYPESAFE_API_KEY')}` } };
  const key = requiredSecret('OPENAI_COMPATIBLE_API_KEY');
  const base = requiredSecret('OPENAI_COMPATIBLE_BASE_URL');
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('OPENAI_COMPATIBLE_BASE_URL must be a server-configured HTTPS origin/path');
  return { url: `${base.replace(/\/$/, '')}/chat/completions`, headers: { authorization: `Bearer ${key}` } };
}
export async function callProvider(item: Item, rubric: Rubric, config: JudgeConfig, presentation: Presentation): Promise<ProviderCall> {
  const connection = providerConnection(config); // Missing secrets fail before mark_sent in caller preflight.
  const request = buildRequest(item, rubric, config, presentation);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let rawResponse = '';
  try {
    const response = await fetch(connection.url, { method: 'POST', headers: { ...request.headers, ...connection.headers }, body: JSON.stringify(request.body), signal: controller.signal, redirect: 'error' });
    rawResponse = await response.text();
    const parsed = parseResponse(rawResponse, rubric, config, presentation);
    const usage = parsed.usage.inputTokens === null || parsed.usage.outputTokens === null ? null : { inputTokens: parsed.usage.inputTokens, outputTokens: parsed.usage.outputTokens };
    if (!response.ok || parsed.kind === 'unusable') return { result: { kind: 'unusable', unusable: parsed.kind === 'unusable' ? parsed.unusable : 'provider_error', raw: rawResponse }, usage, rawResponse, reportedModel: parsed.reportedModel };
    const output = parseJudgeOutput(parsed.raw, rubric.levels.map((l) => l.value));
    const result: JudgeResult = output.kind === 'score' ? { kind: 'score', score: output.index, raw: parsed.raw } : { kind: 'unusable', unusable: output.reason, raw: parsed.raw };
    return { result, usage, rawResponse, reportedModel: parsed.reportedModel };
  } catch (error) {
    return { result: { kind: 'unusable', unusable: controller.signal.aborted ? 'timeout' : 'provider_error', raw: rawResponse || (error instanceof Error ? error.message : String(error)) }, usage: null, rawResponse, reportedModel: null };
  } finally { clearTimeout(timer); }
}
