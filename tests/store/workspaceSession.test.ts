import { describe, expect, it } from 'vitest';
import { ok, unwrap } from '../../src/core/result.ts';
import type { ChunkProgress, StoreResult, StoreSnapshot } from '../../src/store/Store.ts';
import { createWorkspaceSession, fenceLiveStore } from '../../src/ui/workspaceSession.ts';

function liveSnapshot(owner: string): StoreSnapshot {
  return { mode: 'live', banner: '', owner, sets: [], rubrics: [], judgeConfigs: [], runs: [], suggestions: [], rulings: [],
    preregistrations: [], reports: [], contamination: [], budgets: [] };
}

describe('workspace identity epochs', () => {
  it('requires a signed-in identity and accepts only its live snapshot', () => {
    const state = createWorkspaceSession();
    expect(state.begin('live')).toBeNull();
    state.observeAuth('alice');
    const lease = state.begin('live')!;
    expect(state.acceptsSnapshot(lease, liveSnapshot('alice'))).toBe(true);
    expect(state.acceptsSnapshot(lease, liveSnapshot('bob'))).toBe(false);
    expect(state.acceptsSnapshot(lease, { mode: 'memory', owner: 'alice' })).toBe(false);
    expect(state.observeAuth('alice')).toBe(false); // Same-user refresh does not close the workspace.
    expect(state.isCurrent(lease)).toBe(true);
  });

  it('invalidates signout/account changes and never revives an old lease when the same user returns', () => {
    // what_bug_this_catches: a late result from an earlier login installs old reports/selections.
    const state = createWorkspaceSession();
    state.observeAuth('alice');
    const old = state.begin('live')!;
    expect(state.observeAuth(null)).toBe(true);
    expect(state.isCurrent(old)).toBe(false);
    expect(state.begin('live')).toBeNull();
    state.observeAuth('alice');
    expect(state.acceptsSnapshot(old, liveSnapshot('alice'))).toBe(false);
    const reopened = state.begin('live')!; // An explicit new open is required.
    expect(reopened.epoch).toBeGreaterThan(old.epoch);
    expect(state.observeAuth('bob')).toBe(true);
    expect(state.isCurrent(reopened)).toBe(false);
    const bob = state.begin('live')!;
    expect(state.acceptsSnapshot(bob, liveSnapshot('bob'))).toBe(true);
    expect(state.acceptsSnapshot(reopened, liveSnapshot('alice'))).toBe(false);
  });

  it('keeps offline demo state current across live authentication changes', () => {
    const state = createWorkspaceSession();
    const demo = state.begin('memory')!;
    for (const user of ['alice', null, 'bob']) {
      expect(state.observeAuth(user)).toBe(false);
      expect(state.isCurrent(demo)).toBe(true);
      expect(state.acceptsSnapshot(demo, { mode: 'memory', owner: 'offline-demo-owner' })).toBe(true);
    }
    state.clear();
    expect(state.isCurrent(demo)).toBe(false);
  });
});

describe('live Store request fence', () => {
  it('drops an old opening response and refuses further old calls while a new workspace opens', async () => {
    const state = createWorkspaceSession();
    state.observeAuth('alice');
    const old = state.begin('live')!;
    let complete: (result: StoreResult<StoreSnapshot>) => void = () => { throw new Error('request not started'); };
    const response = new Promise<StoreResult<StoreSnapshot>>((resolve) => { complete = resolve; });
    let requests = 0;
    const api = fenceLiveStore({ getSnapshot: () => { requests++; return response; } }, () => state.isCurrent(old));
    const pending = api.getSnapshot();
    expect(requests).toBe(1);
    expect(state.observeAuth('bob')).toBe(true);
    const current = state.begin('live')!;
    complete(ok(liveSnapshot('alice')));
    const late = await pending;
    expect(late).toMatchObject({ ok: false, error: { reason: 'session_changed' } });
    expect(state.acceptsSnapshot(old, liveSnapshot('alice'))).toBe(false);
    expect(state.isCurrent(current)).toBe(true);
    expect(await api.getSnapshot()).toMatchObject({ ok: false, error: { reason: 'session_changed' } });
    expect(requests).toBe(1);
  });

  it('stops an in-flight browser chunk chain before its selection callback or next request', async () => {
    const state = createWorkspaceSession();
    state.observeAuth('alice');
    const lease = state.begin('live')!;
    let complete: (result: StoreResult<ChunkProgress>) => void = () => { throw new Error('request not started'); };
    const response = new Promise<StoreResult<ChunkProgress>>((resolve) => { complete = resolve; });
    let requests = 0;
    let selections = 0;
    const api = fenceLiveStore({ runChunk: () => { requests++; return response; } }, () => state.isCurrent(lease));
    const work = async () => {
      const first = await api.runChunk();
      if (!first.ok) return first;
      selections++;
      return api.runChunk();
    };
    const pending = work();
    state.observeAuth(null);
    complete(ok({ runId: 'old-run', status: 'paused', processed: 10, remaining: 10, unusableCount: 0, spentUsd: 0, reservedUsd: 0 }));
    expect(await pending).toMatchObject({ ok: false, error: { reason: 'session_changed' } });
    expect(selections).toBe(0);
    expect(requests).toBe(1);
  });

  it('preserves method receivers and same-user responses', async () => {
    const state = createWorkspaceSession();
    state.observeAuth('alice');
    const lease = state.begin('live')!;
    const raw = { owner: 'alice', async getSnapshot() { return ok(liveSnapshot(this.owner)); } };
    const api = fenceLiveStore(raw, () => state.isCurrent(lease));
    state.observeAuth('alice');
    expect(unwrap(await api.getSnapshot()).owner).toBe('alice');
  });
});
