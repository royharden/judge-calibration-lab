import { useRef, useState } from 'react';
import { MemoryStore } from '../store/MemoryStore.ts';
import type { Store, StoreError, StoreSnapshot } from '../store/Store.ts';
import { readBrowserEnv } from '../lib/env.ts';
import { LabShell, type Screen } from './components/LabShell.tsx';
import { EvidenceDetails } from './components/Evidence.tsx';
import { Setup } from './screens/Setup.tsx';
import { Sets } from './screens/Sets.tsx';
import { Rubrics } from './screens/Rubrics.tsx';
import { RunPlan } from './screens/RunPlan.tsx';
import { Diagnostics } from './screens/Diagnostics.tsx';
import { Preregister } from './screens/Preregister.tsx';
import { Report } from './screens/Report.tsx';
import type { Action } from './uiTypes.ts';

export default function App() {
  const [store, setStore] = useState<Store | null>(null);
  const [snapshot, setSnapshot] = useState<StoreSnapshot | null>(null);
  const [screen, setScreen] = useState<Screen>('sets');
  const [setId, setSetId] = useState('');
  const [rubricId, setRubricId] = useState('');
  const [configId, setConfigId] = useState('');
  const [runId, setRunId] = useState('');
  const [preregId, setPreregId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StoreError | null>(null);
  const acting = useRef(false);
  const env = readBrowserEnv();

  const act: Action = async (work, success) => {
    if (acting.current) return;
    acting.current = true; setBusy(true); setError(null);
    try {
      const result = await work();
      if (!result.ok) setError(result.error);
      else success?.(result.value);
      if (store) {
        const view = await store.getSnapshot();
        if (view.ok) setSnapshot(view.value);
        else setError(view.error);
      }
    } catch (cause) {
      setError({ reason: 'operation_failed', message: cause instanceof Error ? cause.message : 'The operation could not complete.' });
    } finally { acting.current = false; setBusy(false); }
  };

  async function startDemo() {
    if (acting.current) return;
    acting.current = true; setBusy(true); setError(null);
    try {
      const memory = new MemoryStore();
      const loaded = await memory.loadDemo();
      if (!loaded.ok) { setError(loaded.error); return; }
      const view = await memory.getSnapshot();
      if (!view.ok) { setError(view.error); return; }
      setStore(memory); setSnapshot(view.value); setSetId(loaded.value.setId);
      setRubricId(loaded.value.rubricId); setConfigId(loaded.value.judgeConfigId);
      setRunId(''); setPreregId(''); setScreen('sets');
    } catch (cause) { setError({ reason: 'demo_failed', message: cause instanceof Error ? cause.message : 'Demo initialization failed.' }); }
    finally { acting.current = false; setBusy(false); }
  }
  function exit() {
    setStore(null); setSnapshot(null); setSetId(''); setRubricId(''); setConfigId(''); setRunId(''); setPreregId(''); setError(null);
  }
  const errorView = error && <div className="error-message toast" role="alert"><div><strong>{error.reason.replaceAll('_', ' ')}</strong><div>{error.message}</div>{error.details !== undefined && <EvidenceDetails label="Issue details" value={error.details} />}</div><button type="button" aria-label="Dismiss message" onClick={() => setError(null)}>Dismiss</button></div>;
  if (!store || !snapshot) return <>{errorView}<Setup configured={env.ready} onDemo={() => void startDemo()} onLive={() => setError({ reason: 'live_unavailable', message: 'Live workspace sign-in is unavailable in this source snapshot.' })} pending={busy} /></>;

  const selected = snapshot.sets.find((item) => item.id === setId) ?? snapshot.sets[0];
  const rubrics = snapshot.rubrics.filter((item) => item.setId === selected?.id);
  const rubric = rubrics.find((item) => item.id === rubricId) ?? rubrics.at(-1);
  const config = snapshot.judgeConfigs.find((item) => item.id === configId) ?? snapshot.judgeConfigs[0];
  const runs = snapshot.runs.filter((item) => item.setId === selected?.id && item.judgeConfigId === config?.id && item.split === 'dev');
  const run = runs.find((item) => item.id === runId) ?? runs.at(-1);
  const preregs = snapshot.preregistrations.filter((item) => item.pins.setId === selected?.id && item.pins.judgeConfigHash === config?.configHash);
  const prereg = preregs.find((item) => item.id === preregId) ?? preregs.at(-1);
  const report = snapshot.reports.find((item) => item.preregId === prereg?.id);
  function chooseRun(id: string) {
    setRunId(id);
    const selectedRun = snapshot!.runs.find((item) => item.id === id);
    if (selectedRun) setConfigId(selectedRun.judgeConfigId);
  }
  return <LabShell screen={screen} onNavigate={setScreen} mode={snapshot.mode === 'memory' ? 'demo' : 'live'} onExit={exit} busy={busy}>
    {errorView}
    {screen === 'sets' && <Sets store={store} snapshot={snapshot} selected={selected} select={(id) => { setSetId(id); setRubricId(''); setRunId(''); setPreregId(''); }} act={act} busy={busy} next={() => setScreen('rubrics')} />}
    {screen === 'rubrics' && <Rubrics store={store} set={selected} rubrics={rubrics} selected={rubric} select={setRubricId} act={act} busy={busy} demo={snapshot.mode === 'memory'} next={() => setScreen('run')} />}
    {screen === 'run' && <RunPlan store={store} snapshot={snapshot} set={selected} rubric={rubric} config={config} selectConfig={(id) => { setConfigId(id); setRunId(''); setPreregId(''); }} selectRun={chooseRun} act={act} busy={busy} next={() => setScreen('diagnostics')} />}
    {screen === 'diagnostics' && <Diagnostics store={store} snapshot={snapshot} set={selected} run={run} selectRun={chooseRun} act={act} busy={busy} edit={(id) => { setRubricId(id); setScreen('rubrics'); }} />}
    {screen === 'preregister' && <Preregister store={store} snapshot={snapshot} set={selected} config={config} rubrics={rubrics} chosen={rubric} chooseRubric={setRubricId} prereg={prereg} selectPrereg={setPreregId} act={act} busy={busy} openReport={() => setScreen('report')} />}
    {screen === 'report' && <Report store={store} prereg={prereg} report={report} act={act} busy={busy} />}
  </LabShell>;
}
