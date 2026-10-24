import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStore } from '../../src/store/SupabaseStore.ts';
import { unwrap } from '../../src/core/result.ts';
import type { StoreSnapshot } from '../../src/store/Store.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function fake() {
  const calls: { name: string; args: unknown }[] = [];
  const snapshot: StoreSnapshot = { mode: 'live', owner: 'owner', banner: 'Live', sets: [], rubrics: [], judgeConfigs: [], runs: [], suggestions: [], rulings: [], preregistrations: [], reports: [], contamination: [], budgets: [] };
  const client = {
    rpc: async (name: string, args: unknown) => { calls.push({ name, args }); return { data: name === 'public_snapshot' ? snapshot : { acknowledged: true }, error: null }; },
    functions: { invoke: async (_name: string, args: { body: Record<string, unknown> }) => { calls.push({ name: 'judge-run', args }); return { error: null, data: { run_id: args.body.run_id, status: 'paused', processed: 3, remaining: 4, unusable_count: 1, spent_usd: 0.1, reserved_usd: 0 } }; } },
  } as unknown as SupabaseClient;
  return { store: new SupabaseStore(client), calls };
}

describe('live Store boundary contracts', () => {
  it('owner writes use the named RPC with a structured p_args payload', async () => {
    const { store, calls } = fake();
    unwrap(await store.setBudget({ judgeConfigId: 'j', capUsd: 7, reason: 'continue' }));
    unwrap(await store.appendRuling({ suggestionId: 's', decision: 'accept', note: 'reviewed' }));
    expect(calls).toEqual([
      { name: 'set_budget', args: { p_args: { judgeConfigId: 'j', capUsd: 7, reason: 'continue' } } },
      { name: 'append_ruling', args: { p_args: { suggestionId: 's', decision: 'accept', note: 'reviewed' } } },
    ]);
  });
  it('held-out authorization cannot omit explicit confirmation', async () => {
    const { store, calls } = fake();
    expect((await store.requestHeldoutLook({ preregId: 'p' })).ok).toBe(false);
    expect(calls).toEqual([]);
    unwrap(await store.requestHeldoutLook({ preregId: 'p', confirmed: true }));
    expect(calls[0]).toEqual({ name: 'request_heldout_look', args: { p_args: { preregId: 'p', confirmed: true } } });
  });
  it('maps score DTO casing exactly and gives each explicit chunk a request id', async () => {
    const { store, calls } = fake();
    const result = unwrap(await store.runChunk({ runId: 'r', maxItems: 3 }));
    expect(result).toEqual({ runId: 'r', status: 'paused', processed: 3, remaining: 4, unusableCount: 1, spentUsd: 0.1, reservedUsd: 0 });
    expect(calls[0]!.args).toMatchObject({ body: { action: 'score', run_id: 'r', max_items: 3, request_id: expect.any(String) } });
    expect((await store.loadDemo()).ok).toBe(false);
  });
  it('SQL contains every named RPC consumed by Store and edge handlers', () => {
    const folder = new URL('../../supabase/migrations/', import.meta.url);
    const sql = readdirSync(folder).filter((n) => n.endsWith('.sql')).map((n) => readFileSync(new URL(n, folder), 'utf8')).join('\n');
    const names = ['public_snapshot', 'import_set', 'freeze_input', 'freeze_set', 'import_probe_sets', 'create_rubric', 'create_judge_config', 'create_dev_run', 'dev_run_rows', 'append_suggestions', 'append_ruling', 'request_heldout_look', 'burn_scope', 'set_budget', 'resolve_ambiguous', 'reconcile_ledger', 'price_book_rows', 'list_verdicts', 'scope_status', 'server_set_bundle', 'server_run_bundle', 'ensure_run_jobs', 'preregister', 'heldout_report_rows', 'acquire_run_lease', 'claim_attempt', 'mark_sent', 'settle_attempt', 'fail_before_call', 'mark_ambiguous', 'release_run_lease', 'claim_request', 'finish_request'];
    for (const name of names) expect(sql).toMatch(new RegExp(`create(?: or replace)? function public\\.${name}\\(`, 'i'));
    expect(fileURLToPath(folder)).toContain('migrations');
  });
});
