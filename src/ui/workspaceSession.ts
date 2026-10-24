import { fail } from '../core/result.ts';
import type { Store } from '../store/Store.ts';

export type WorkspaceLease = {
  readonly mode: 'memory' | 'live'; readonly owner: string | null;
  readonly epoch: number; readonly authEpoch: number;
};

/** Local identity/epoch state only; never reads auth or performs requests. */
export function createWorkspaceSession() {
  let owner: string | null = null;
  let authEpoch = 0;
  let epoch = 0;
  let active: WorkspaceLease | null = null;
  const isCurrent = (lease: WorkspaceLease): boolean => active === lease
    && (lease.mode === 'memory' || (lease.authEpoch === authEpoch && lease.owner === owner));
  return {
    /** True only when an opening/open live workspace was invalidated. */
    observeAuth(userId: string | null): boolean {
      if (owner === userId) return false;
      owner = userId; authEpoch++;
      if (active?.mode !== 'live') return false;
      active = null; epoch++;
      return true;
    },
    begin(mode: WorkspaceLease['mode']): WorkspaceLease | null {
      if (mode === 'live' && owner === null) return null;
      active = { mode, owner: mode === 'live' ? owner : null, epoch: ++epoch, authEpoch };
      return active;
    },
    clear(): void { active = null; epoch++; },
    isCurrent,
    acceptsSnapshot(lease: WorkspaceLease, snapshot: { mode: 'memory' | 'live'; owner: string }): boolean {
      return isCurrent(lease) && snapshot.mode === lease.mode && (lease.mode === 'memory' || snapshot.owner === lease.owner);
    },
  };
}

/** Stop stale browser-driven call chains before another request and discard late results. */
export function fenceLiveStore<T extends Partial<Store>>(store: T, isCurrent: () => boolean): T {
  return new Proxy(store, {
    get(target, property) {
      const method: unknown = Reflect.get(target, property, target);
      if (typeof method !== 'function') return method;
      return async (...args: unknown[]) => {
        if (!isCurrent()) return fail('session_changed', 'Open your workspace again after the session change.');
        const result: unknown = await Reflect.apply(method, target, args);
        if (!isCurrent()) return fail('session_changed', 'Open your workspace again after the session change.');
        return result;
      };
    },
  });
}
