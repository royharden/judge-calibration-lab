import { canonicalHash } from '../canonical.ts';
import { assertDevResults, diagnose, type DevResults, type DiagnosticFindings, type Finding } from './findings.ts';

export type Suggestion = Finding & { suggestionId: string; id: string; runId: string; inputHash: string; split: 'dev' };
export const SUGGESTION_TEMPLATES = ['adjacent_confusion', 'leniency', 'verbosity', 'scale_order', 'injection', 'instability', 'unusable'] as const;
/** IDs bind the template, score run and exact dev verdict hash. No rubric edits happen here. */
export function generateSuggestions(input: DevResults, evidence?: DiagnosticFindings): { suggestions: Suggestion[]; notices: string[] } {
  assertDevResults(input);
  const diagnostics = evidence ?? diagnose(input);
  if (diagnostics.split !== 'dev' || diagnostics.runId !== input.runId || diagnostics.inputHash !== input.inputHash) throw new RangeError('suggestion evidence is not this dev run');
  const allowed = new Set(input.devKeys);
  if (diagnostics.findings.some((f) => f.itemKeys.some((key) => !allowed.has(key)))) throw new RangeError('suggestion evidence includes a non-dev item');
  const suggestions: Suggestion[] = [];
  for (const template of SUGGESTION_TEMPLATES) {
    const found = diagnostics.findings.filter((f) => f.template === template && f.statistic.kind === 'value');
    if (!found.length) continue;
    const id = canonicalHash({ template, runId: input.runId, devInputHash: input.inputHash });
    const itemKeys = [...new Set(found.flatMap((f) => f.itemKeys))].slice(0, 5);
    suggestions.push({ ...found[0]!, template, message: found.map((f) => f.message).join('; '), fields: [...new Set(found.flatMap((f) => f.fields))], itemKeys,
      suggestionId: id, id, runId: input.runId, inputHash: input.inputHash, split: 'dev' });
  }
  return { suggestions, notices: [...diagnostics.notices] };
}
