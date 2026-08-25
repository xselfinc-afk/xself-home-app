/**
 * pickup-bol-release (Phase 1, item F).
 *
 * The shared backend is the ONLY BOL-release gate authority. Every precondition is re-evaluated
 * server-side here: pickup order, valid, payment set up, supplier order + Original BOL exist, and
 * a LIVE AUTHORIZED hold for the order's CURRENT amount that has not expired and matches the final
 * total. Fail-closed. Release NEVER captures — it only hands over the document. Idempotent + audited.
 *
 * Ops endpoint (X-Pickup-Token). Not wired to XOne this phase.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { evaluateReleaseGate, type AuthorizationRecord } from '../_shared/pickup/pickupDomain.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PICKUP_ADMIN_TOKEN = Deno.env.get('PICKUP_ADMIN_TOKEN') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-pickup-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } }); }

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!PICKUP_ADMIN_TOKEN || req.headers.get('x-pickup-token') !== PICKUP_ADMIN_TOKEN) return json({ error: 'unauthorized' }, 401);

  let body: { orderId?: string }; try { body = await req.json(); } catch { return json({ error: 'invalid_request' }, 400); }
  const orderId = (body.orderId ?? '').trim();
  if (!orderId) return json({ error: 'orderId_required' }, 400);

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: orders } = await db.from('orders')
    .select('order_id, fulfillment_method, status, pickup_stage, total_cents, payment_method_saved_at, customer_email')
    .eq('order_id', orderId).limit(1);
  const order = orders?.[0];
  if (!order) return json({ error: 'order_not_found' }, 404);

  const { data: supRows } = await db.from('supplier_orders').select('id').eq('order_id', orderId).limit(1);
  const { data: bolRows } = await db.from('pickup_documents')
    .select('document_type, released_at, superseded_at').eq('order_id', orderId).eq('document_type', 'ORIGINAL_BOL')
    .order('uploaded_at', { ascending: false }).limit(1);
  const originalBol = bolRows?.[0];
  const { data: authRows } = await db.from('pickup_payment_authorizations')
    .select('status, amount_cents, capture_before, provider_payment_intent_id, void_reason')
    .eq('order_id', orderId).order('created_at', { ascending: false }).limit(1);
  const authorization = authRows?.[0] as AuthorizationRecord | undefined;

  const gate = evaluateReleaseGate({
    order, supplierOrderExists: Boolean(supRows?.length), originalBol, authorization,
  });
  if (!gate.ok) {
    return json({ error: 'release_gate_failed', failed: gate.failed.map(f => ({ key: f.key, detail: f.detail })) }, 422);
  }

  // Idempotent: release the Original BOL exactly once. NEVER captures.
  const nowIso = new Date().toISOString();
  const { data: released } = await db.from('pickup_documents')
    .update({ released_at: nowIso }).eq('order_id', orderId).eq('document_type', 'ORIGINAL_BOL')
    .is('released_at', null).select('id');
  await db.from('orders').update({ pickup_stage: 'BOL_RELEASED', updated_at: nowIso }).eq('order_id', orderId);
  await db.from('pickup_audit_events').insert({ order_id: orderId, event_type: 'BOL_RELEASED', payload: { gate: 'passed' } });

  return json({ ok: true, released: (released?.length ?? 0) > 0, action: (released?.length ?? 0) > 0 ? 'released' : 'already_released' });
});
