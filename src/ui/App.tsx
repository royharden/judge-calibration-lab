import { useCallback, useEffect, useRef, useState } from 'react';
import { MemoryStore } from '../store/MemoryStore.ts';
import { SupabaseStore } from '../store/SupabaseStore.ts';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Store, StoreError, StoreSnapshot } from '../store/Store.ts';
import { readBrowserEnv } from '../lib/env.ts';
import { createSupabaseClient } from '../lib/supabase.ts';
import { LabShell, type Screen } from './components/LabShell.tsx';
import { EvidenceDetails } from './components/Evidence.tsx';
import { Setup } from './screens/Setup.tsx';
import { Auth } from './screens/Auth.tsx';
import { Sets } from './screens/Sets.tsx';
import { Rubrics } from './screens/Rubrics.tsx';
import { RunPlan } from './screens/RunPlan.tsx';
import { Diagnostics } from './screens/Diagnostics.tsx';
import { Preregister } from './screens/Preregister.tsx';
import { Report } from './screens/Report.tsx';
import type { Action } from './uiTypes.ts';
import { createWorkspaceSession, fenceLiveStore, type WorkspaceLease } from './workspaceSession.ts';

export default function App() {
  const env = readBrowserEnv();
  const [authOpen, setAuthOpen] = useState(location.pathname === '/auth/callback' || location.pathname === '/auth/recovery');
  const [liveClient, setLiveClient] = useState<SupabaseClient | null>(() => location.pathname === '/auth/callback' || location.pathname === '/auth/recovery' ? createSupabaseClient(env) : null);
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
  const acting = useRef<symbol | null>(null);
  const signingOut = useRef<symbol | null>(null);
  const session = useRef(createWorkspaceSession());
  const workspace = useRef<{ store: Store; lease: WorkspaceLease } | null>(null);

  const clearWorkspace = useCallback((reopen = false) => {
    session.current.clear(); workspace.current = null; acting.current = null; signingOut.current = null;
    setStore(null); setSnapshot(null); setSetId(''); setRubricId(''); setConfigId(''); setRunId(''); setPreregId(''); setError(null);
    setScreen('sets'); setBusy(false); setAuthOpen(reopen);
    if (location.pathname.startsWith('/auth/')) history.replaceState({}, document.title, '/');
  }, []);

  useEffect(() => {
    if (!liveClient) return;
    let active = true;
    const { data } = liveClient.auth.onAuthStateChange((_event, authSession) => {
      // Synchronous invalidation only. No auth requests are made from this callback.
      if (!active || !session.current.observeAuth(authSession?.user.id ?? null)) return;
      const explicitSignout = signingOut.current !== null && signingOut.current === acting.current;
      clearWorkspace(!explicitSignout);
      if (!explicitSignout) setError({ reason: 'session_changed', message: 'Your session changed. Open your workspace again to continue.' });
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, [liveClient, clearWorkspace]);

  function beginOperation(): symbol | null {
    if (acting.current !== null) return null;
    const operation = Symbol('workspace-operation');
    acting.current = operation; setBusy(true); setError(null);
    return operation;
  }
  function finishOperation(operation: symbol) {
    // A cancelled operation's finally cannot unlock a newer operation.
    if (acting.current === operation) { acting.current = null; setBusy(false); }
  }

  const act: Action = async (work, success) => {
    const current = workspace.current;
    if (!current || current.store !== store || !session.current.isCurrent(current.lease)) return;
    const operation = beginOperation();
    if (operation === null) return;
    const isCurrent = () => acting.current === operation && workspace.current === current && session.current.isCurrent(current.lease);
    try {
      const result = await work();
      if (!isCurrent()) return;
      if (!result.ok) setError(result.error);
      else success?.(result.value);
      if (!isCurrent()) return;
      const view = await current.store.getSnapshot();
      if (!isCurrent()) return;
      if (view.ok) {
        if (!session.current.acceptsSnapshot(current.lease, view.value)) {
          clearWorkspace(current.lease.mode === 'live');
          setError({ reason: 'session_changed', message: 'The workspace owner changed. Open your workspace again.' });
          return;
        }
        setSnapshot(view.value);
      }
      else setError(view.error);
    } catch (cause) {
      if (isCurrent()) setError({ reason: 'operation_failed', message: cause instanceof Error ? cause.message : 'The operation could not complete.' });
    } finally { finishOperation(operation); }
  };

  async function startDemo() {
    const operation = beginOperation();
    if (operation === null) return;
    const lease = session.current.begin('memory');
    if (!lease) { finishOperation(operation); return; }
    const isCurrent = () => acting.current === operation && session.current.isCurrent(lease);
    try {
      const memory = new MemoryStore();
      const loaded = await memory.loadDemo();
      if (!isCurrent()) return;
      if (!loaded.ok) { setError(loaded.error); return; }
      const view = await memory.getSnapshot();
      if (!isCurrent()) return;
      if (!view.ok) { setError(view.error); return; }
      workspace.current = { store: memory, lease };
      setStore(memory); setSnapshot(view.value); setSetId(loaded.value.setId);
      setRubricId(loaded.value.rubricId); setConfigId(loaded.value.judgeConfigId);
      setRunId(''); setPreregId(''); setScreen('sets');
    } catch (cause) { if (isCurrent()) setError({ reason: 'demo_failed', message: cause instanceof Error ? cause.message : 'Demo initialization failed.' }); }
    finally { finishOperation(operation); }
  }
  async function exit() {
    if (acting.current !== null) return;
    if (snapshot?.mode === 'live' && liveClient) {
      const current = workspace.current;
      if (!current || !session.current.isCurrent(current.lease)) return;
      const operation = beginOperation();
      if (operation === null) return;
      signingOut.current = operation;
      const isCurrent = () => acting.current === operation && session.current.isCurrent(current.lease);
      try {
        const result = await liveClient.auth.signOut();
        if (!isCurrent()) return;
        if (result.error) { setError({ reason: 'signout_failed', message: result.error.message }); return; }
        clearWorkspace();
      } catch (cause) { if (isCurrent()) setError({ reason: 'signout_failed', message: cause instanceof Error ? cause.message : 'Sign out failed.' }); }
      finally { if (signingOut.current === operation) signingOut.current = null; finishOperation(operation); }
    } else clearWorkspace();
  }
  function startLive() {
    if (acting.current !== null) return;
    const client = liveClient ?? createSupabaseClient(env);
    if (!client) { setError({ reason: 'missing_configuration', message: 'Configure the public workspace connection before signing in.' }); return; }
    setError(null); setLiveClient(client); setAuthOpen(true);
  }
  async function openWorkspace() {
    if (!liveClient || acting.current !== null) return;
    const lease = session.current.begin('live');
    if (!lease) { setError({ reason: 'authentication_required', message: 'Sign in before opening your workspace.' }); return; }
    const operation = beginOperation();
    if (operation === null) return;
    const isCurrent = () => acting.current === operation && session.current.isCurrent(lease);
    try {
      const live = fenceLiveStore(new SupabaseStore(liveClient), () => session.current.isCurrent(lease));
      const view = await live.getSnapshot();
      if (!isCurrent()) return;
      if (!view.ok) { setError(view.error); return; }
      if (!session.current.acceptsSnapshot(lease, view.value)) {
        clearWorkspace(true);
        setError({ reason: 'session_changed', message: 'The workspace owner changed. Open your workspace again.' });
        return;
      }
      workspace.current = { store: live, lease };
      setStore(live); setSnapshot(view.value); setSetId(''); setRubricId(''); setConfigId(''); setRunId(''); setPreregId(''); setScreen('sets'); setAuthOpen(false);
      if (location.pathname.startsWith('/auth/')) history.replaceState({}, document.title, '/');
    } catch (cause) { if (isCurrent()) setError({ reason: 'workspace_unavailable', message: cause instanceof Error ? cause.message : 'The live workspace could not open.' }); }
    finally { finishOperation(operation); }
  }
  const errorView = error && <div className="error-message toast" role="alert"><div><strong>{error.reason.replaceAll('_', ' ')}</strong><div>{error.message}</div>{error.details !== undefined && <EvidenceDetails label="Issue details" value={error.details} />}</div><button type="button" aria-label="Dismiss message" onClick={() => setError(null)}>Dismiss</button></div>;
  if (!store || !snapshot) return <>{errorView}{authOpen ? <Auth client={liveClient} onOpen={() => void openWorkspace()} onBack={() => { setAuthOpen(false); setError(null); }} opening={busy} /> : <Setup configured={env.ready} onDemo={() => void startDemo()} onLive={startLive} pending={busy} />}</>;

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
    const current = workspace.current;
    if (!current || current.store !== store || !session.current.isCurrent(current.lease)) return;
    setRunId(id);
    const selectedRun = snapshot!.runs.find((item) => item.id === id);
    if (selectedRun) setConfigId(selectedRun.judgeConfigId);
  }
  return <LabShell screen={screen} onNavigate={setScreen} mode={snapshot.mode === 'memory' ? 'demo' : 'live'} onExit={() => void exit()} busy={busy}>
    {errorView}
    {screen === 'sets' && <Sets store={store} snapshot={snapshot} selected={selected} select={(id) => { setSetId(id); setRubricId(''); setRunId(''); setPreregId(''); }} act={act} busy={busy} next={() => setScreen('rubrics')} />}
    {screen === 'rubrics' && <Rubrics store={store} set={selected} rubrics={rubrics} selected={rubric} select={setRubricId} act={act} busy={busy} demo={snapshot.mode === 'memory'} next={() => setScreen('run')} />}
    {screen === 'run' && <RunPlan store={store} snapshot={snapshot} set={selected} rubric={rubric} config={config} selectConfig={(id) => { setConfigId(id); setRunId(''); setPreregId(''); }} selectRun={chooseRun} act={act} busy={busy} next={() => setScreen('diagnostics')} />}
    {screen === 'diagnostics' && <Diagnostics store={store} snapshot={snapshot} set={selected} run={run} selectRun={chooseRun} act={act} busy={busy} edit={(id) => { setRubricId(id); setScreen('rubrics'); }} />}
    {screen === 'preregister' && <Preregister store={store} snapshot={snapshot} set={selected} config={config} rubrics={rubrics} chosen={rubric} chooseRubric={setRubricId} prereg={prereg} selectPrereg={setPreregId} act={act} busy={busy} openReport={() => setScreen('report')} />}
    {screen === 'report' && <Report store={store} prereg={prereg} report={report} act={act} busy={busy} />}
  </LabShell>;
}
