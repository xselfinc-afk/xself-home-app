/**
 * pickup-capture (Phase 1, item H) — endpoint + domain only. NO scheduler is enabled this phase.
 *
 * Captures the ORIGINAL authorization PaymentIntent (never a second PI). Runs only when pickup is
 * CONFIRMED, the 24h window is due (or the hold is about to lapse), a live AUTHORIZED hold exists,
 * and NO open issue blocks it. Fail-closed on expiry. Before capturing it flips the PI metadata
 * phase to 'pickup_capture' so the resulting succeeded event routes to the webhook's capture
 * authority, which sets payment_status='paid' and files the tax transaction exactly once.
 *
 * Ops endpoint (X-Pickup-Token). No real charge occurs in tests (STRIPE_API_BASE → fake).
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { type AuthorizationRecord, evaluateCaptureEligibility } from '../_shared/pickup/pickupDomain.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const STRIPE_SECRET_KEY = (Deno.env.get('STRIPE_SECRET_KEY') ?? '').replace(/[^\x20-\x7E]/g, '').trim();
const STRIPE_API_BASE = Deno.env.get('STRIPE_API_BASE') ?? 'https://api.stripe.com';
const PICKUP_ADMIN_TOKEN = Deno.env.get('PICKUP_ADMIN_TOKEN') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-pickup-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } }); }
// deno-lint-ignore no-explicit-any
async function stripePost(path: string, params: URLSearchParams): Promise<{ ok: boolean; json: any }> {
  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20' },
    body: params.toString(),
  });
  return { ok: res.ok, json: await res.json() };
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!PICKUP_ADMIN_TOKEN || req.headers.get('x-pickup-token') !== PICKUP_ADMIN_TOKEN) return json({ error: 'unauthorized' }, 401);

  let body: { orderId?: string; allowBeforeDue?: boolean };
  try { body = await req.json(); } catch { return json({ error: 'invalid_request' }, 400); }
  const orderId = (body.orderId ?? '').trim();
  if (!orderId) return json({ error: 'orderId_required' }, 400);

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: orders } = await db.from('orders')
    .select('order_id, pickup_stage, pickup_confirmed_at, payment_due_at').eq('order_id', orderId).limit(1);
  const order = orders?.[0];
  if (!order) return json({ error: 'order_not_found' }, 404);

  const { data: authRows } = await db.from('pickup_payment_authorizations')
    .select('status, amount_cents, capture_before, provider_payment_intent_id')
    .eq('order_id', orderId).order('created_at', { ascending: false }).limit(1);
  const authorization = authRows?.[0] as AuthorizationRecord | undefined;

  const { data: issues } = await db.from('pickup_issues').select('id').eq('order_id', orderId).eq('status', 'OPEN').limit(1);

  const elig = evaluateCaptureEligibility({
    order, authorization, hasOpenIssue: Boolean(issues?.length), allowBeforeDue: body.allowBeforeDue === true,
  });
  if (!elig.capturable) return json({ ok: false, action: 'skipped', reason: elig.reason }, 200);

  const piId = authorization!.provider_payment_intent_id!;
  // Route the eventual succeeded event to the webhook capture authority.
  const meta = new URLSearchParams(); meta.append('metadata[phase]', 'pickup_capture');
  await stripePost(`/v1/payment_intents/${piId}`, meta);

  // Capture the ORIGINAL PI. No second PaymentIntent is ever created.
  const { ok, json: pi } = await stripePost(`/v1/payment_intents/${piId}/capture`, new URLSearchParams());
  if (!ok) {
    console.error('[pickup-capture] capture failed:', pi?.error?.message ?? 'unknown');
    return json({ ok: false, action: 'capture_failed', detail: pi?.error?.message ?? null }, 502);
  }

  // payment_status='paid' is written by the webhook (pickup_capture authority) on the succeeded
  // event. We only advance the operational stage here; the ledger flips on webhook confirmation.
  await db.from('pickup_audit_events').insert({ order_id: orderId, event_type: 'CAPTURE_REQUESTED', payload: { pi: piId } });
  return json({ ok: true, action: 'captured', paymentIntentId: piId, stripeStatus: pi?.status ?? null });
});
