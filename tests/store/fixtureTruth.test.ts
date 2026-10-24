import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/MemoryStore.ts';
import { unwrap } from '../../src/core/result.ts';
import { generateSyntheticSet } from '../../src/core/fixtures/synthetic.ts';
import { toCsv } from '../../src/core/goldset/csv.ts';

describe('renamed fixture truth reuse', () => {
  it('retains planted truth for prototype-named item ids after a content-identical reimport', async () => {
    // what_bug_this_catches: assigning __proto__ to a plain truth object loses the own truth entry.
    const store = new MemoryStore();
    const ids = unwrap(await store.loadDemo());
    const original = unwrap(await store.freezeSet({ setId: ids.setId }));
    const fixture = generateSyntheticSet(36);
    const aliases = new Map(original.split!.dev.slice(0, 3).map((key, i) => [key, ['__proto__', 'constructor', 'toString'][i]!] as const));
    const rename = (key: string): string => aliases.get(key) ?? `renamed-${key}`;
    const files = {
      ...fixture.files,
      itemsJsonl: fixture.items.map((item) => JSON.stringify({ id: rename(item.key), task_text: item.taskText, answer: item.answer, source: item.source })).join('\n') + '\n',
      annotatorCsvs: fixture.annotatorIds.map((annotatorId) => ({
        name: `${annotatorId}.csv`,
        text: toCsv([
          ['item_id', 'annotator_id', 'score'],
          ...fixture.annotations.filter((a) => a.annotatorId === annotatorId).map((a) => [rename(a.itemKey), annotatorId, String(fixture.scale.levels[a.score]!.value)]),
        ]),
      })),
    };
    const imported = unwrap(await store.importSet({ files }));
    const renamed = unwrap(await store.freezeSet({ setId: imported.set.id }));
    expect(renamed.contentHash).toBe(original.contentHash);
    expect(renamed.split!.splitHash).toBe(original.split!.splitHash);
    for (const alias of aliases.values()) expect(renamed.split!.dev).toContain(alias);
    const rubric = unwrap(await store.createRubric({ setId: renamed.id, ...fixture.rubricV1 }));
    const originalConfig = unwrap(await store.getSnapshot()).judgeConfigs[0]!;
    const clean = unwrap(await store.createJudgeConfig({ provider: 'mock', model: 'mock-clean', params: { ...originalConfig.params, mockDefect: 'clean' },
      promptTemplateVersion: originalConfig.promptTemplateVersion, outputSchemaVersion: originalConfig.outputSchemaVersion,
      levelMapVersion: originalConfig.levelMapVersion, scoreReadout: originalConfig.scoreReadout }));
    const run = unwrap(await store.createDevRun({ setId: renamed.id, rubricId: rubric.id, judgeConfigId: clean.id, includeProbes: false, confirmed: true }));
    for (let chunks = 0; chunks < 150; chunks++) {
      const progress = unwrap(await store.runChunk({ runId: run.id, maxItems: 10 }));
      if (progress.status === 'complete') break;
      if (chunks === 149) throw new Error('bounded renamed fixture run did not complete');
    }
    const verdicts = unwrap(await store.listVerdicts({ runId: run.id }));
    expect(verdicts).toHaveLength(renamed.split!.dev.length);
    for (const [originalKey, alias] of aliases) {
      expect(verdicts.find((v) => v.itemKey === alias)).toMatchObject({ score: fixture.truth[originalKey], unusableReason: null });
    }
  }, 30_000);
});
