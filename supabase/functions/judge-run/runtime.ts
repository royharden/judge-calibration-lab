import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.47.10';
import type { ApiError } from './contracts.ts';
export class ApiFault extends Error {
  code: string; retryable: boolean;
  constructor(code: string, message: string, retryable = false) { super(message); this.code = code; this.retryable = retryable; }
}
export function apiError(error: unknown): ApiError {
  return error instanceof ApiFault ? { code: error.code, message: error.message, retryable: error.retryable } : { code: 'bad_request', message: error instanceof Error ? error.message : String(error), retryable: false };
}
export function requiredSecret(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new ApiFault('missing_secret', `Missing server secret ${name}`);
  return value;
}
export async function rpc<T>(client: SupabaseClient, name: string, args: unknown): Promise<T> {
  const result = await client.rpc(name, { p_args: args });
  if (result.error) {
    const match = /^([a-z_]+):\s*(.*)$/s.exec(result.error.message);
    const code = match?.[1] ?? 'bad_request';
    throw new ApiFault(code, match?.[2] ?? result.error.message, ['busy', 'budget_exceeded', 'attempt_ambiguous'].includes(code));
  }
  return result.data as T;
}
export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]; if (typeof value !== 'string' || value.length === 0 || value.length > 250) throw new ApiFault('bad_request', `${field} must be a non-empty bounded string`); return value;
}
