import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalHash } from '../../src/core/canonical.ts';
import { S36_V1, policyHash } from '../../src/core/heldoutlock/policyConst.ts';
const root = fileURLToPath(new URL('../../', import.meta.url));
const names = readdirSync(resolve(root, 'supabase/migrations')).filter((n) => n.endsWith('.sql')).sort();
const source = names.map((n) => readFileSync(resolve(root, 'supabase/migrations', n), 'utf8')).join('\n');
function fn(name: string) { return new RegExp(`create(?: or replace)? function public\\.${name}\\([^]*?\\$\\$;`, 'i').exec(source)?.[0] ?? ''; }

/** Expand only full row-level rejection triggers, including the actual bound DO-loop template. */
function appendOnlyTables(sql: string): Set<string> {
  const active = sql.replace(/--[^\r\n]*|\/\*[^]*?\*\//g, '');
  const tables = new Set([...active.matchAll(/create\s+trigger\s+\w+\s+before\s+update\s+or\s+delete\s+on\s+public\.(\w+)\s+for\s+each\s+row\s+execute\s+function\s+public\.append_only\(\)\s*;/gi)].map((m) => m[1]!));
  const loops = /do\s+\$\$\s+declare\s+(\w+)\s+text\s*;\s*begin\s+foreach\s+\1\s+in\s+array\s+array\s*\[([^\]]+)\]\s+loop\s+execute\s+format\(\s*'create\s+trigger\s+\w+\s+before\s+update\s+or\s+delete\s+on\s+public\.%I\s+for\s+each\s+row\s+execute\s+function\s+public\.append_only\(\)'\s*,\s*\1\s*\)\s*;\s*end\s+loop\s*;\s*end\s+\$\$\s*;/gi;
  for (const loop of active.matchAll(loops)) {
    if (!/^\s*'\w+'(?:\s*,\s*'\w+')*\s*$/.test(loop[2]!)) continue;
    for (const table of loop[2]!.matchAll(/'(\w+)'/g)) tables.add(table[1]!);
  }
  return tables;
}

describe('migration construction invariants (SQL execution remains deferred)', () => {
  it('has exactly the three planned migrations and RLS on every table', () => {
    expect(names).toHaveLength(3);
    const tables = [...source.matchAll(/create table public\.(\w+)\s*\(/gi)].map((m) => m[1]!);
    expect(tables.length).toBeGreaterThanOrEqual(20);
    for (const table of tables) expect(source).toMatch(new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  });
  it('never gives clients label/runs/ledger look writes or held-out label reads', () => {
    const policies = [...source.matchAll(/create policy[^;]+;/gi)].map((m) => m[0]);
    for (const policy of policies) {
      if (/on public\.(runs|verdicts|call_attempts|heldout_log|preregistrations|dev_annotations|heldout_annotations)\b/i.test(policy)) expect(policy).not.toMatch(/for (insert|update|all)\b/i);
      if (/on public\.heldout_annotations\b/i.test(policy)) expect(policy).not.toMatch(/for (select|all)\b/i);
    }
  });
  it('append-only/immutable tables have mutation rejection triggers', () => {
    const protectedTables = appendOnlyTables(source);
    for (const table of ['verdicts', 'heldout_log', 'preregistrations', 'rulings', 'ledger_events', 'budget_changes', 'price_book', 'rubric_versions', 'judge_configs']) {
      expect(protectedTables.has(table), `${table} must reject row updates and deletes`).toBe(true);
    }
    expect(fn('append_only')).toMatch(/raise exception 'immutable:/i);
    expect(source).toMatch(/freeze/i);
    expect(fn('freeze_set')).toMatch(/heldoutItemKeys/);
    expect(fn('freeze_set')).toMatch(/20/);
  });
  it('requires the complete dynamic rejection trigger and every listed target', () => {
    // what_bug_this_catches: table-name-only assertions accept a missing or weakened DO-loop trigger.
    const block = [...source.matchAll(/do\s+\$\$[^]*?\$\$\s*;/gi)].map((m) => m[0]).find((sql) => /create trigger insert_only\b/i.test(sql)) ?? '';
    const targets = ['price_book', 'budget_changes', 'ledger_events', 'rulings', 'suggestions', 'response_cache'];
    expect([...appendOnlyTables(block)].sort()).toEqual([...targets].sort());
    for (const table of targets) expect(appendOnlyTables(block.replace(`'${table}'`, "'unprotected_other_table'"))).not.toContain(table);
    for (const weakened of [
      block.replace('before update or delete', 'before update'),
      block.replace('before update or delete', 'after update or delete'),
      block.replace('public.append_only()', 'public.frozen_guard()'),
      block.replace("()',t)", "()',other)"),
      `/* ${block} */`,
    ]) expect(appendOnlyTables(weakened).size).toBe(0);
  });
  it('locks look scopes and budget claims and retains ambiguous reservations', () => {
    expect(fn('request_heldout_look')).toMatch(/for update/i);
    expect(fn('claim_attempt')).toMatch(/for update|lock_ledger_run/i);
    expect(source).toMatch(/for update/i);
    expect(fn('claim_attempt')).toMatch(/budget_exceeded/);
    expect(fn('claim_attempt')).toMatch(/max_attempts/);
    expect(fn('acquire_run_lease')).toMatch(/ambiguous/);
    expect(fn('settle_attempt')).toMatch(/result_hash/);
    expect(fn('append_ruling')).toMatch(/stale/);
  });
  it('uses current prices for claims and real usage at the attempt price for settlement', () => {
    const claim = fn('claim_attempt');
    expect(claim).toMatch(/select\s+\*\s+into\s+p\s+from\s+price_book\s+where\s+provider=j\.provider\s+and\s+model=j\.model\s+order\s+by\s+effective_date\s+desc\s+limit\s+1/i);
    expect(claim).toContain("'missing_price: live provider has no price book entry'");
    expect(claim).not.toContain('r.plan');
    expect(claim).toContain("reserve:=(bytes*(price->>'usdPerInputMTok')::numeric+(j.params->>'maxOutputTokens')::integer*(price->>'usdPerOutputMTok')::numeric)/1000000");
    expect(claim).toContain('b.spent_usd+b.reserved_usd+reserve>b.cap_usd');
    expect(claim).toContain('bytes,price,reserve');
    const settle = fn('settle_attempt');
    expect(settle).toContain("cost:=((v_usage->>'inputTokens')::numeric*(a.price_snapshot->>'usdPerInputMTok')::numeric+(v_usage->>'outputTokens')::numeric*(a.price_snapshot->>'usdPerOutputMTok')::numeric)/1000000");
    expect(settle).toContain("'bad_request: usage token counts'");
    expect(fn('ensure_run_jobs')).toMatch(/if r\.jobs_installed then[^]*?r\.plan is distinct from plan/);
    expect(fn('ensure_run_jobs')).toContain('jsonb_array_length(jobs)=0');
    expect(fn('ensure_run_jobs')).toContain('jobs_installed=true');
  });
  it('all SECURITY DEFINER functions pin search_path and ledger grants are service-only', () => {
    for (const match of source.matchAll(/create(?: or replace)? function[^]*?\$\$;/gi)) if (/security definer/i.test(match[0])) expect(match[0]).toMatch(/set search_path\s*=\s*public,\s*pg_temp/i);
    expect(source).toMatch(/revoke execute on all functions in schema public from public,\s*anon,\s*authenticated/i);
    for (const name of ['acquire_run_lease', 'claim_attempt', 'mark_sent', 'settle_attempt', 'fail_before_call', 'mark_ambiguous']) {
      const grants = [...source.matchAll(/grant execute[^;]+;/gi)].map((m) => m[0]).filter((g) => g.includes(`public.${name}(`));
      expect(grants.length).toBeGreaterThan(0);
      expect(grants.every((g) => /to service_role\s*;/i.test(g))).toBe(true);
    }
  });
  it('hashes explicit canonical bytes and includes idempotency input binding', () => {
    expect(fn('canonical_hash')).toMatch(/canonical_json/);
    expect(fn('canonical_hash')).not.toMatch(/digest\([^]*?::text/);
    expect(fn('claim_request')).toMatch(/input_hash/);
    expect(fn('claim_request')).toMatch(/different input/);
    expect(source).not.toMatch(/POLICY_HASH_PLACEHOLDER|TODO_POLICY_HASH/);
  });
  it('matches the standard policy JSON/hash and enforces the actual policyHash pin', () => {
    const literal = /select\s+'([^']+)'\s*::jsonb\s*;/i.exec(fn('standard_policy'))?.[1];
    expect(literal).toBeDefined();
    const policy: unknown = JSON.parse(literal ?? 'null');
    expect(policy).toEqual(S36_V1);
    expect(canonicalHash(policy)).toBe(policyHash);
    const pins = fn('check_prereg_pins');
    expect(pins).toMatch(/pol\s+jsonb\s*:=\s*standard_policy\(\)/i);
    expect(pins).toMatch(/'policyHash'\s*,\s*canonical_hash\(pol\)/);
    expect(pins).toMatch(/p\.pins-'fitHashes'\s+is\s+distinct\s+from\s+actual_pins/);
  });
});
