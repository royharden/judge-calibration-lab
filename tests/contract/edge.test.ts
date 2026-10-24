import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('function authorization and source contracts', () => {
  it('authenticates and owner-checks before service role construction', () => {
    const source = read('supabase/functions/judge-run/index.ts');
    const service = source.indexOf("service = createClient(url, requiredSecret('SUPABASE_SERVICE_ROLE_KEY')");
    expect(source.indexOf('userClient.auth.getUser()')).toBeLessThan(service);
    expect(source.indexOf(".eq('owner_id', owner)")).toBeLessThan(service);
    expect(source).toContain("['score', 'preregister', 'report']");
    expect(source).toContain('Access-Control-Allow-Methods');
    expect(source).toContain("'POST, OPTIONS'");
    expect(read('supabase/config.toml')).toMatch(/verify_jwt\s*=\s*true/);
  });
  it('uses a bounded serialized chunk and claim → send → settle', () => {
    const source = read('supabase/functions/judge-run/score.ts');
    expect(source).toContain('maxItems > 10');
    expect(source).toContain('canStartAttempt(CHUNK_WORK_BUDGET_MS');
    expect(source.indexOf("'claim_attempt'")).toBeLessThan(source.indexOf("'mark_sent'"));
    expect(source.indexOf("'mark_sent'")).toBeLessThan(source.indexOf("'settle_attempt'"));
    expect(source).toContain('call.usage === null');
    expect(source).toContain("'mark_ambiguous'");
    expect(source).not.toMatch(/Promise\.all\([^]*?call(Anthropic|Typesafe|OpenAI)/);
  });
  it('provider transport pins timeout, reads endpoint config only from server env and preserves receipts', () => {
    const source = read('supabase/functions/judge-run/providers/transport.ts');
    expect(source).toContain('20_000');
    expect(source).toContain('AbortController');
    expect(source).toContain("'OPENAI_COMPATIBLE_BASE_URL'");
    expect(source).toContain("controller.signal.aborted ? 'timeout'");
    expect(source).toContain('reportedModel');
    expect(source).toContain('rawResponse');
    expect(source).toContain("redirect: 'error'");
  });
  it('preregistration verifies stored rows and recomputes dev fits instead of accepting UI fits', () => {
    const source = read('supabase/functions/judge-run/integrity.ts');
    for (const name of ['fingerprintMap', 'contentHashOf', 'annotationHashOf', 'computeSplit', 'rubricContentHash', 'configHash', 'computeDevFits', 'devResultHash']) expect(source).toContain(name);
    expect(source).not.toMatch(/body\.fit/);
    expect(source).toContain('assembleBeforeAfter');
  });
});
