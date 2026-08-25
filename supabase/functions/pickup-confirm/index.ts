/**
 * pickup-confirm (Phase 1, item G).
 *
 * Ops-only "Confirm Pickup". This is the ONLY thing that starts the 24h payment clock. Requires a
 * Signed/Completed BOL on file. Sets pickup_confirmed_at and computes payment_due_at from the real
 * pickup timing (never from a customer action, BOL download, or authorization success). Idempotent.
 *
 * Ops endpoint (X-Pickup-Token). Not wired to XOne this phase.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { computePaymentDue, evaluatePickupConfirm, type DuePolicyConfig } from '../_shared/pickup/pickupDomain.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PICKUP_ADMIN_TOKEN = Deno.env.get('PICKUP_ADMIN_TOKEN') ?? '';
// Warehouse-local day boundary for the END_OF_NEXT_DAY fallback. Config, not guessed per-order.
const DUE_CFG: DuePolicyConfig = {
  paymentTermHours: 24,
  dayEndLocalTime: Deno.env.get('PICKUP_DAY_END_LOCAL_TIME') ?? '23:59',
  timezoneOffsetMinutes: Number(Deno.env.get('PICKUP_TZ_OFFSET_MINUTES') ?? '-420'),
};
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

  let body: { orderId?: string; pickedUpAt?: string; pickupDate?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid_request' }, 400); }
  const orderId = (body.orderId ?? '').trim();
  if (!orderId) return json({ error: 'orderId_required' }, 400);

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: orders } = await db.from('orders')
    .select('order_id, fulfillment_method, pickup_confirmed_at').eq('order_id', orderId).limit(1);
  const order = orders?.[0];
  if (!order) return json({ error: 'order_not_found' }, 404);

  const { data: signed } = await db.from('pickup_documents').select('id')
    .eq('order_id', orderId).eq('document_type', 'SIGNED_BOL').limit(1);
  const gate = evaluatePickupConfirm({ order, signedBolExists: Boolean(signed?.length) });
  if (!gate.ok) return json({ error: 'confirm_gate_failed', reason: gate.reason }, 422);

  let due;
  try {
    due = computePaymentDue({ pickedUpAt: body.pickedUpAt ?? null, pickupDate: body.pickupDate ?? null }, DUE_CFG);
  } catch (e) {
    return json({ error: 'pickup_timing_required', detail: e instanceof Error ? e.message : String(e) }, 422);
  }

  const nowIso = new Date().toISOString();
  // Idempotent: only the first confirm writes (WHERE pickup_confirmed_at IS NULL).
  const { data: updated } = await db.from('orders').update({
    pickup_confirmed_at: nowIso,
    picked_up_at: body.pickedUpAt ?? null,
    payment_due_at: due.paymentDueAt,
    payment_due_basis: due.basis,
    pickup_stage: 'CONFIRMED',
    updated_at: nowIso,
  }).eq('order_id', orderId).is('pickup_confirmed_at', null).select('order_id');

  await db.from('pickup_audit_events').insert({
    order_id: orderId, event_type: 'PICKUP_CONFIRMED',
    payload: { paymentDueAt: due.paymentDueAt, basis: due.basis, explanation: due.explanation },
  });

  return json({ ok: true, action: (updated?.length ?? 0) > 0 ? 'confirmed' : 'already_confirmed', paymentDueAt: due.paymentDueAt, basis: due.basis });
});
