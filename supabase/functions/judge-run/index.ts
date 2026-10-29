import { createClient } from 'npm:@supabase/supabase-js@2.47.10';
import { canonicalHash } from './_core/core/canonical.ts';
import { ApiFault, apiError, requiredSecret, requireString, rpc } from './runtime.ts';
import { scoreAction } from './score.ts';
import { preregisterAction, reportAction } from './integrity.ts';
import type { RequestReceipt } from './contracts.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } }); }
export async function handleRequest(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ code: 'bad_request', message: 'POST required', retryable: false }, 405);
  let service: ReturnType<typeof createClient> | null = null;
  let receiptArgs: { owner: string; action: string; requestId: string } | null = null;
  let receiptClaimed = false;
  try {
    if (Number(request.headers.get('content-length') ?? 0) > 64_000) throw new ApiFault('bad_request', 'request body too large');
    const authorization = request.headers.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) throw new ApiFault('unauthenticated', 'Bearer authentication required');
    const url = requiredSecret('SUPABASE_URL');
    const userClient = createClient(url, requiredSecret('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
    const userResult = await userClient.auth.getUser();
    if (userResult.error || !userResult.data.user) throw new ApiFault('unauthenticated', 'session is invalid or expired');
    const owner = userResult.data.user.id;
    const text = await request.text(); if (text.length > 64_000) throw new ApiFault('bad_request', 'request body too large');
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ApiFault('bad_request', 'JSON object required');
    const body = value as Record<string, unknown>;
    const action = requireString(body, 'action');
    if (!['score', 'preregister', 'report'].includes(action)) throw new ApiFault('bad_request', 'unknown judge-run action');
    // All owner checks run under the caller JWT before constructing a service-role client.
    const checks = action === 'score' ? [['runs', requireString(body, 'run_id')]] : action === 'report' ? [['preregistrations', requireString(body, 'prereg_id')]] : [
      ['gold_sets', requireString(body, 'set_id')], ['judge_configs', requireString(body, 'judge_config_id')], ['rubric_versions', requireString(body, 'baseline_rubric_id')], ['rubric_versions', requireString(body, 'chosen_rubric_id')],
    ];
    for (const [table, id] of checks) {
      if (table === 'rubric_versions') {
        const found = await userClient.from('rubric_versions').select('id,set_id').eq('id', id!).eq('set_id', String(body.set_id)).maybeSingle();
        if (found.error || !found.data || found.data.set_id !== body.set_id) throw new ApiFault('forbidden', 'requested rubric is outside the owned set');
        continue;
      }
      const found = await userClient.from(table!).select('id,owner_id').eq('id', id!).eq('owner_id', owner).maybeSingle();
      if (found.error || !found.data || found.data.owner_id !== owner) throw new ApiFault('forbidden', 'requested resource is not owned by the signed-in user');
    }
    service = createClient(url, requiredSecret('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
    if (action !== 'report') {
      receiptArgs = { owner, action, requestId: requireString(body, 'request_id') };
      const receipt = await rpc<RequestReceipt>(service, 'claim_request', { ...receiptArgs, inputHash: canonicalHash(body) });
      if (receipt.state === 'busy') throw new ApiFault('busy', 'this request is already being processed', true);
      if (receipt.state === 'complete' && receipt.response) return receipt.response.ok ? json(receipt.response.data) : json(receipt.response.error, 400);
      receiptClaimed = receipt.state === 'new';
    }
    const data = action === 'score' ? await scoreAction(service, owner, body) : action === 'preregister' ? await preregisterAction(service, owner, body) : await reportAction(service, String(body.prereg_id));
    if (receiptArgs) await rpc(service, 'finish_request', { ...receiptArgs, response: { ok: true, data } });
    return json(data);
  } catch (error) {
    const formatted = apiError(error);
    if (service && receiptArgs && receiptClaimed && formatted.code !== 'busy') { try { await rpc(service, 'finish_request', { ...receiptArgs, response: { ok: false, error: formatted } }); } catch { /* first failure remains authoritative */ } }
    const status = formatted.code === 'unauthenticated' ? 401 : formatted.code === 'forbidden' ? 403 : formatted.code === 'busy' ? 409 : 400;
    return json(formatted, status);
  }
}
Deno.serve(handleRequest);
