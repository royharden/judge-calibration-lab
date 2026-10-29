import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readBrowserEnv, type BrowserEnv } from './env.ts';

/** Missing env is represented by null; no fake URL/key and no automatic demo fallback. */
export function createSupabaseClient(env: BrowserEnv = readBrowserEnv()): SupabaseClient | null {
  if (!env.ready || env.url === null || env.anonKey === null) return null;
  return createClient(env.url, env.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
}
