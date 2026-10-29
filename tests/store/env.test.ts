import { describe, expect, it } from 'vitest';
import { readBrowserEnv } from '../../src/lib/env.ts';
import { createSupabaseClient } from '../../src/lib/supabase.ts';

describe('explicit setup boundary', () => {
  it('missing public env leaves the client null with actionable names', () => {
    const env = readBrowserEnv({});
    expect(env.ready).toBe(false);
    expect(env.missing).toEqual(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']);
    expect(createSupabaseClient(env)).toBe(null);
  });
  it('validates public URL shape and ignores unrelated input fields', () => {
    const invalid = readBrowserEnv({ VITE_SUPABASE_URL: 'javascript:bad', VITE_SUPABASE_ANON_KEY: 'public-placeholder', unrelated: 'ignored' });
    expect(invalid.ready).toBe(false);
    expect(createSupabaseClient(invalid)).toBe(null);
    const valid = readBrowserEnv({ VITE_SUPABASE_URL: 'https://project.example.invalid', VITE_SUPABASE_ANON_KEY: 'public-placeholder' });
    expect(valid.ready).toBe(true);
    // Do not construct a ready client in this suite: auth refresh would be a live side effect.
  });
});
