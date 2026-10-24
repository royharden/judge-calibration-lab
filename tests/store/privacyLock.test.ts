import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/MemoryStore.ts';
import { unwrap } from '../../src/core/result.ts';
import { generateSyntheticSet, syntheticRubricV2Edits } from '../../src/core/fixtures/synthetic.ts';
import { burnConfirmationText } from '../../src/core/heldoutlock/policy.ts';

async function complete(store: MemoryStore, runId: string) {
  for (let n = 0; n < 150; n++) { const p = unwrap(await store.runChunk({ runId })); if (p.status === 'complete') return; }
  throw new Error('bounded run did not complete');
}
async function setup() {
  const store = new MemoryStore(); const ids = unwrap(await store.loadDemo());
  unwrap(await store.freezeSet({ setId: ids.setId }));
  const baseline = unwrap(await store.createDevRun({ ...ids, includeProbes: false, confirmed: true }));
  await complete(store, baseline.id);
  const child = unwrap(await store.createChild({ rubricId: ids.rubricId, edits: syntheticRubricV2Edits(), changeNote: 'fixture repair' }));
  const prereg = unwrap(await store.preregister({ setId: ids.setId, judgeConfigId: ids.judgeConfigId, baselineRubricId: ids.rubricId, chosenRubricId: child.id }));
  return { store, ids, baseline, child, prereg };
}

describe('public privacy, immutable copies and lock transitions', () => {
  it('never exposes staged or held-out labels, and snapshots cannot mutate internal records', async () => {
    const store = new MemoryStore(); const ids = unwrap(await store.loadDemo());
    const staged = unwrap(await store.getSnapshot());
    expect(staged.sets[0]!.devAnnotations).toEqual([]);
    for (const name of ['heldoutAnnotations', 'stagedAnnotations', 'truth']) expect(JSON.stringify(staged)).not.toContain(`"${name}"`);
    const original = staged.sets[0]!.items[0]!.answer;
    staged.sets[0]!.items[0]!.answer = 'external mutation';
    staged.judgeConfigs[0]!.params.mockDefect = 'constant';
    expect(unwrap(await store.getSnapshot()).sets[0]!.items[0]!.answer).toBe(original);
    expect(unwrap(await store.getSnapshot()).judgeConfigs[0]!.params.mockDefect).toBe('merges-3-4');
    const frozen = unwrap(await store.freezeSet({ setId: ids.setId }));
    const dev = new Set(frozen.split!.dev);
    expect(frozen.devAnnotations.every((a) => dev.has(a.itemKey))).toBe(true);
    expect('heldoutAnnotations' in frozen).toBe(false);
    const sheet = unwrap(await store.labellingSheet({ setId: ids.setId, split: 'heldout' }));
    expect(sheet).toContain('item_id,task_text,answer,source,score');
    expect(sheet).not.toContain('annotator_id');
  });
  it('serializes concurrent look requests and reuses looked runs with zero additional slots', async () => {
    const { store, prereg } = await setup();
    const [a, b] = await Promise.all([store.requestHeldoutLook({ preregId: prereg.id, confirmed: true }), store.requestHeldoutLook({ preregId: prereg.id, confirmed: true })]);
    const first = unwrap(a); const second = unwrap(b);
    expect(first.newSlotsUsed).toBe(2);
    expect(second.newSlotsUsed).toBe(0);
    expect(second.looks.every((l) => l.reused)).toBe(true);
    expect(second.looks.map((l) => l.runId)).toEqual(first.looks.map((l) => l.runId));
    expect(unwrap(await store.getSnapshot()).runs.filter((r) => r.split === 'heldout')).toHaveLength(2);
    expect((await store.getDevResults({ runId: first.looks[0]!.runId })).ok).toBe(false);
    expect((await store.generateSuggestions({ runId: first.looks[0]!.runId })).ok).toBe(false);
  }, 30_000);
  it('refuses a new split after a look until the looked scope is burned', async () => {
    const { store, ids, prereg } = await setup();
    unwrap(await store.requestHeldoutLook({ preregId: prereg.id, confirmed: true }));
    const fixture = generateSyntheticSet(36);
    const imported = unwrap(await store.importSet({ files: fixture.files }));
    const refused = await store.freezeSet({ setId: imported.set.id, seed: 37 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.reason).toBe('resplit_refused');
    unwrap(await store.burnScope({ scopeKey: prereg.scopeKey, reason: 'new exploratory split', confirmation: burnConfirmationText(prereg.scopeKey) }));
    const allowed = unwrap(await store.freezeSet({ setId: imported.set.id, seed: 37 }));
    expect(allowed.inheritedContamination).toBe(true);
    expect(unwrap(await store.contaminationStatus({ setId: allowed.id, judgeConfigId: ids.judgeConfigId })).status).toBe('contaminated');
  }, 30_000);
  it('rejects stale rulings after a newer completed run of the same config and rubric', async () => {
    const { store, ids, baseline } = await setup();
    const old = unwrap(await store.generateSuggestions({ runId: baseline.id }))[0]!;
    const newer = unwrap(await store.createDevRun({ ...ids, includeProbes: false, confirmed: true }));
    await complete(store, newer.id);
    const stale = await store.appendRuling({ suggestionId: old.suggestionId, decision: 'accept' });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.reason).toBe('stale');
    const current = unwrap(await store.generateSuggestions({ runId: newer.id }))[0]!;
    unwrap(await store.appendRuling({ suggestionId: current.suggestionId, decision: 'accept', note: 'first' }));
    unwrap(await store.appendRuling({ suggestionId: current.suggestionId, decision: 'reject', note: 'second' }));
    expect(unwrap(await store.getSnapshot()).rulings.map((r) => r.note)).toEqual(['first', 'second']);
  }, 30_000);
});
