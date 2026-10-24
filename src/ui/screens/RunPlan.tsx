import { useEffect, useState } from 'react';
import type { JudgeConfig, MockDefect, Provider, Rubric } from '../../core/types.ts';
import type { RunPlan as Plan } from '../../core/plan/runPlan.ts';
import type { ChunkProgress, PublicGoldSet, Store, StoreResult, StoreSnapshot } from '../../store/Store.ts';
import { MOCK_DEFECTS } from '../../core/judge/mock.ts';
import { OUTPUT_SCHEMA_VERSION, PROMPT_TEMPLATE_VERSION } from '../../core/judge/prompt.ts';
import { LEVEL_MAP_VERSION } from '../../core/judge/levelMap.ts';
import type { Action } from '../uiTypes.ts';
import { EmptyState, EvidenceDetails, PageTitle } from '../components/Evidence.tsx';

export async function driveRun(store: Store, runId: string): Promise<StoreResult<ChunkProgress>> {
  // Browser-driven and resumable. Stop at a refusal or a chunk that makes no progress.
  for (let count = 0; count < 10000; count++) {
    const result = await store.runChunk({ runId, maxItems: 10 });
    if (!result.ok || result.value.status === 'complete' || result.value.status === 'failed' || result.value.processed === 0) return result;
  }
  return { ok: false, error: { reason: 'paused', message: 'Chunk limit reached; resume explicitly.' } };
}

export function RunPlan({ store, snapshot, set, rubric, config, selectConfig, selectRun, act, busy, next }: {
  store: Store; snapshot: StoreSnapshot; set: PublicGoldSet | undefined; rubric: Rubric | undefined;
  config: JudgeConfig | undefined; selectConfig: (id: string) => void; selectRun: (id: string) => void;
  act: Action; busy: boolean; next: () => void;
}) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [probes, setProbes] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [defect, setDefect] = useState<MockDefect>('merges-3-4');
  const [provider, setProvider] = useState<Provider>('mock');
  const [model, setModel] = useState('');
  const [cap, setCap] = useState('5');
  const [capReason, setCapReason] = useState('');
  useEffect(() => { setPlan(null); setConfirm(false); }, [set?.id, rubric?.id, config?.id, probes]);
  const args = set && rubric && config ? { setId: set.id, rubricId: rubric.id, judgeConfigId: config.id, includeProbes: probes } : null;
  const runs = snapshot.runs.filter((run) => run.setId === set?.id && run.split === 'dev');
  const budget = snapshot.budgets.find((item) => item.judgeConfigId === config?.id);
  return <><PageTitle step="03 / RUN PLAN" title="See the cost before you score.">Preview calls and token bounds, then explicitly confirm. Runs progress only while this browser drives chunks; you can resume a paused run.</PageTitle>
    <div className="grid-two"><section className="panel"><h2>Judge configuration</h2><label>Selected judge<select value={config?.id ?? ''} onChange={(e) => selectConfig(e.target.value)}><option value="" disabled>Select a judge</option>{snapshot.judgeConfigs.map((item) => <option key={item.id} value={item.id}>{item.provider} / {item.model} {item.params.mockDefect ?? ''}</option>)}</select></label><p className="prose-note">Set: {set?.name ?? 'Select a set'}<br />Rubric: {rubric ? `v${rubric.version} · ${rubric.changeNote}` : 'Select a rubric'}</p><label className="checkbox-label"><input type="checkbox" checked={probes} onChange={(e) => setProbes(e.target.checked)} />Include all four exploratory dev probes</label>
      <button type="button" disabled={busy || !args || !set?.frozen} onClick={() => void act(() => store.planRun(args!), setPlan)}>Preview dry-run plan</button>
      {!set?.frozen && <p className="notice">Freeze a gold set before planning a run.</p>}
      {plan && <><hr className="section-divider" /><div className="table-wrap"><table><thead><tr><th>Planned work</th><th>Estimate</th><th>Worst case</th></tr></thead><tbody><tr><td>Calls</td><td colSpan={2}>{plan.calls}</td></tr><tr><td>Input tokens</td><td>{plan.projectedInputTokens.toLocaleString()}</td><td>{plan.worstCaseInputTokens.toLocaleString()}</td></tr><tr><td>Output tokens</td><td>{plan.projectedOutputTokens.toLocaleString()}</td><td>{plan.worstCaseOutputTokens.toLocaleString()}</td></tr><tr><td>USD</td><td>${plan.projectedUsd.toFixed(6)}</td><td>${plan.worstCaseUsd.toFixed(6)}</td></tr></tbody></table></div><p className="prose-note">Token bounds assume the documented provider framing and pricing. {config?.provider === 'mock' ? 'Mock calls cost $0.' : 'Live pricing and provider behavior require activation verification.'}</p><label className="checkbox-label"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />I confirm this run and its displayed plan.</label><button type="button" className="primary" disabled={busy || !args || !confirm} onClick={() => void act(async () => { const created = await store.createDevRun({ ...args!, confirmed: true }); if (!created.ok) return created; selectRun(created.value.id); return driveRun(store, created.value.id); })}>Confirm & score dev set</button><EvidenceDetails label="Complete run plan" value={plan} /></>}
    </section><section className="panel"><h2>Create a judge configuration</h2><p>Configurations are immutable. Choose a new configuration to compare another judge; each has its own held-out scope.</p><label>Provider<select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}><option value="mock">Seeded mock</option>{snapshot.mode === 'live' && <><option value="anthropic">Anthropic</option><option value="openai_compatible">OpenAI-compatible</option><option value="typesafe">TypeSafe / Jev</option></>}</select></label>{provider === 'mock' ? <label>Planted behavior<select value={defect} onChange={(e) => setDefect(e.target.value as MockDefect)}>{MOCK_DEFECTS.map((item) => <option key={item}>{item}</option>)}</select></label> : <label>Pinned model ID<input value={provider === 'typesafe' ? 'jev-1.13.0' : model} disabled={provider === 'typesafe'} onChange={(e) => setModel(e.target.value)} placeholder="Enter the exact model ID" /></label>}
      <button type="button" disabled={busy || (provider !== 'mock' && provider !== 'typesafe' && !model.trim())} onClick={() => void act(() => store.createJudgeConfig({ provider, model: provider === 'mock' ? `seeded-${defect}` : provider === 'typesafe' ? 'jev-1.13.0' : model.trim(), params: { temperature: 0, maxOutputTokens: 64, ...(provider === 'mock' ? { mockDefect: defect } : {}) }, promptTemplateVersion: PROMPT_TEMPLATE_VERSION, outputSchemaVersion: OUTPUT_SCHEMA_VERSION, levelMapVersion: LEVEL_MAP_VERSION, scoreReadout: provider === 'typesafe' ? 'argmax_probabilities' : 'json_score' }), (item) => selectConfig(item.id))}>Create judge</button>
      {budget && <><hr className="section-divider" /><h3>Server-style budget</h3><p>Cap ${budget.capUsd.toFixed(2)} · spent ${budget.spentUsd.toFixed(6)} · reserved ${budget.reservedUsd.toFixed(6)}</p><label>New cap · USD<input type="number" min="0" step="0.01" value={cap} onChange={(e) => setCap(e.target.value)} /></label><label>Reason<input value={capReason} onChange={(e) => setCapReason(e.target.value)} /></label><button type="button" disabled={busy || !capReason.trim()} onClick={() => void act(() => store.setBudget({ judgeConfigId: config!.id, capUsd: Number(cap), reason: capReason }))}>Record cap change</button></>}
    </section></div>
    <section className="panel"><div className="panel-heading"><h2>Dev run history</h2><button type="button" onClick={next}>Open diagnostics →</button></div>{runs.length === 0 ? <EmptyState title="No dev results yet">Preview a plan, then confirm a run.</EmptyState> : <div className="table-wrap"><table><thead><tr><th>Run / rubric</th><th>Progress</th><th>Status</th><th>Action</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td>{run.id}<small>{snapshot.rubrics.find((item) => item.id === run.rubricId)?.changeNote}</small></td><td>{run.completedCalls} / {run.plannedCalls} calls<div className="progress"><span style={{ width: `${run.plannedCalls ? 100 * run.completedCalls / run.plannedCalls : 0}%` }} /></div></td><td><span className="badge neutral">{run.status}</span>{run.error && <small>{run.error.message}</small>}</td><td><button type="button" disabled={busy} onClick={() => { selectRun(run.id); if (run.status === 'complete') next(); else void act(() => driveRun(store, run.id)); }}>{run.status === 'complete' ? 'Inspect dev' : 'Resume chunks'}</button></td></tr>)}</tbody></table></div>}</section>
  </>;
}
