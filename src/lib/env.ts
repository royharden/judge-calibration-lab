export type BrowserEnv = { ready: boolean; url: string | null; anonKey: string | null; missing: string[] };
/** Only these two public browser variables are read. A failed live session never selects demo. */
export function readBrowserEnv(input: Record<string, unknown> = import.meta.env): BrowserEnv {
  const url = typeof input.VITE_SUPABASE_URL === 'string' && input.VITE_SUPABASE_URL.trim() ? input.VITE_SUPABASE_URL.trim() : null;
  const anonKey = typeof input.VITE_SUPABASE_ANON_KEY === 'string' && input.VITE_SUPABASE_ANON_KEY.trim() ? input.VITE_SUPABASE_ANON_KEY.trim() : null;
  const missing: string[] = [];
  if (url === null) missing.push('VITE_SUPABASE_URL');
  if (anonKey === null) missing.push('VITE_SUPABASE_ANON_KEY');
  if (url !== null) { try { const parsed = new URL(url); if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') missing.push('valid VITE_SUPABASE_URL'); } catch { missing.push('valid VITE_SUPABASE_URL'); } }
  return { ready: missing.length === 0, url, anonKey, missing };
}
