/**
 * stripe-webhook — Phase 8 server-authoritative order finalizer.
 *
 * Events handled:
 *   payment_intent.succeeded    → mark order paid, fulfill reservations
 *   payment_intent.payment_failed → mark order failed, release reservations
 *   payment_intent.canceled     → mark order canceled, release reservations
 *
 * Order lookup strategy (backward-compatible):
 *   1. Look up by orders.payment_intent_id (Phase 8 flow)
 *   2. Fall back to orders.order_id matched against PI metadata.order_id (pre-Phase 8)
 *
 * Idempotency:
 *   - succeeded: no-op if order.status is already 'paid' or 'pending_pickup'
 *   - failed/canceled: WHERE NOT IN (paid, pending_pickup) prevents downgrading paid orders
 *   - reservation updates use WHERE status='reserved' — already-transitioned rows are no-ops
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Secrets ───────────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = (Deno.env.get('STRIPE_SECRET_KEY') ?? '')
  // eslint-disable-next-line no-control-regex
  .replace(/[^\x20-\x7E]/g, '')
  .trim();

const STRIPE_WEBHOOK_SECRET = (Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '')
  .replace(/[^\x20-\x7E]/g, '')
  .trim();

const SUPABASE_URL             = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// ── Stripe webhook signature verification ─────────────────────────────────────
// Manual HMAC-SHA256 verification — Stripe Node SDK is not available in Deno.
async function verifyStripeSignature(
  payload: string,
  sigHeader: string,
  secret: string,
): Promise<boolean> {
  const parts: Record<string, string[]> = {};
  for (const part of sigHeader.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx);
    const val = part.slice(idx + 1);
    if (!parts[key]) parts[key] = [];
    parts[key].push(val);
  }

  const timestamp  = parts['t']?.[0];
  const signatures = parts['v1'] ?? [];
  if (!timestamp || signatures.length === 0) return false;

  // Reject events older than 5 minutes
  const ts = parseInt(timestamp, 10);
  if (Math.abs(Date.now() / 1000 - ts) > 300) {
    console.log('[Webhook] Signature timestamp too old:', ts);
    return false;
  }

  const signedPayload = `${timestamp}.${payload}`;
  const keyData = new TextEncoder().encode(secret);
  const msgData = new TextEncoder().encode(signedPayload);

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  const expectedSig = Array.from(new Uint8Array(signatureBytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return signatures.some(sig => sig === expectedSig);
}

// ── Handler ───────────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  if (!STRIPE_WEBHOOK_SECRET) {
    console.log('[Webhook] STRIPE_WEBHOOK_SECRET not configured');
    return new Response(JSON.stringify({ error: 'Webhook secret not configured' }), { status: 500 });
  }

  // Raw body must be read before any other body access
  const rawBody  = await req.text();
  const sigHeader = req.headers.get('stripe-signature') ?? '';

  const valid = await verifyStripeSignature(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    console.log('[Webhook] Invalid Stripe signature — rejecting');
    return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 400 });
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const eventType = event.type as string;
  console.log('[Webhook] Event received:', eventType);

  const HANDLED = [
    'payment_intent.succeeded',
    'payment_intent.payment_failed',
    'payment_intent.canceled',
  ];

  if (!HANDLED.includes(eventType)) {
    return new Response(JSON.stringify({ received: true, action: 'ignored' }), { status: 200 });
  }

  const paymentIntent   = (event.data as Record<string, unknown>)?.object as Record<string, unknown>;
  const paymentIntentId = paymentIntent?.id as string;
  const metadata        = ((paymentIntent?.metadata ?? {}) as Record<string, string>);
  const orderIdMeta     = metadata.order_id; // fallback for pre-Phase-8 orders

  if (!paymentIntentId) {
    console.log('[Webhook] Missing paymentIntent.id — ignoring');
    return new Response(JSON.stringify({ received: true, action: 'no_pi_id' }), { status: 200 });
  }

  console.log('[Webhook]', eventType, '— PI:', paymentIntentId, '| meta order_id:', orderIdMeta ?? 'none');

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // ── Find order (two-phase lookup for backward compatibility) ──────────────
  let orderId:     string | null = null;
  let orderStatus: string | null = null;

  // Phase 8: look up by payment_intent_id column
  const { data: byPiRows } = await supabase
    .from('orders')
    .select('order_id, status, payment_status')
    .eq('payment_intent_id', paymentIntentId)
    .limit(1);

  if (byPiRows && byPiRows.length > 0) {
    orderId     = byPiRows[0].order_id as string;
    orderStatus = byPiRows[0].status as string;
    console.log('[Webhook] Found order via payment_intent_id column:', orderId);
  } else if (orderIdMeta) {
    // Pre-Phase-8: look up by order_id from PI metadata
    const { data: byMetaRows } = await supabase
      .from('orders')
      .select('order_id, status, payment_status')
      .eq('order_id', orderIdMeta)
      .limit(1);

    if (byMetaRows && byMetaRows.length > 0) {
      orderId     = byMetaRows[0].order_id as string;
      orderStatus = byMetaRows[0].status as string;
      console.log('[Webhook] Found order via metadata order_id:', orderId);
    }
  }

  if (!orderId) {
    console.log('[Webhook] No order found for PI:', paymentIntentId, '— acknowledging');
    return new Response(JSON.stringify({ received: true, action: 'no_order_found' }), { status: 200 });
  }

  // ── payment_intent.succeeded ──────────────────────────────────────────────
  if (eventType === 'payment_intent.succeeded') {
    // Idempotency: already paid orders are a no-op
    if (orderStatus === 'paid' || orderStatus === 'pending_pickup') {
      console.log('[Webhook] Order already finalized — no-op:', orderId, '(', orderStatus, ')');
      return new Response(JSON.stringify({ received: true, action: 'no_op', orderId }), { status: 200 });
    }

    const fulfillmentMethod = metadata.fulfillment_method ?? '';
    const fulfillmentChoice = metadata.fulfillment_choice ?? ''; // pre-Phase-8 key
    const isPickup = fulfillmentMethod === 'pickup' || fulfillmentChoice === 'pickup';
    const newStatus = isPickup ? 'pending_pickup' : 'paid';

    const { error: orderErr } = await supabase
      .from('orders')
      .update({
        status:                    newStatus,
        payment_status:            'paid',
        stripe_payment_intent_id:  paymentIntentId,
        payment_intent_id:         paymentIntentId,
        updated_at:                new Date().toISOString(),
      })
      .eq('order_id', orderId);

    if (orderErr) {
      console.error('[Webhook] Order update failed:', orderErr.message);
      // Return 500 so Stripe retries — do not return 200 on DB failure
      return new Response(JSON.stringify({ error: orderErr.message }), { status: 500 });
    }

    // Mark reservations fulfilled — idempotent (WHERE status='reserved' is a no-op if already fulfilled)
    const { error: reservErr } = await supabase
      .from('inventory_reservations')
      .update({ status: 'fulfilled', updated_at: new Date().toISOString() })
      .eq('order_id', orderId)
      .eq('status', 'reserved');

    if (reservErr) {
      // Non-fatal: order is confirmed; reservation update logged but 200 returned so Stripe doesn't retry
      console.error('[Webhook] Reservation fulfillment failed (non-fatal):', reservErr.message);
    }

    console.log('[Webhook] Order confirmed:', orderId, '→', newStatus);
    return new Response(
      JSON.stringify({ received: true, action: 'confirmed', orderId, status: newStatus }),
      { status: 200 },
    );
  }

  // ── payment_intent.payment_failed ─────────────────────────────────────────
  if (eventType === 'payment_intent.payment_failed') {
    const { error: orderErr } = await supabase
      .from('orders')
      .update({ status: 'failed', payment_status: 'failed', updated_at: new Date().toISOString() })
      .eq('order_id', orderId)
      .not('status', 'in', '(paid,pending_pickup)'); // never downgrade a paid order

    if (orderErr) {
      console.error('[Webhook] Failed-status update error:', orderErr.message);
      return new Response(JSON.stringify({ error: orderErr.message }), { status: 500 });
    }

    // Release reservations — idempotent (WHERE status='reserved')
    await supabase
      .from('inventory_reservations')
      .update({ status: 'released', updated_at: new Date().toISOString() })
      .eq('order_id', orderId)
      .eq('status', 'reserved');

    console.log('[Webhook] Order marked failed:', orderId);
    return new Response(JSON.stringify({ received: true, action: 'failed', orderId }), { status: 200 });
  }

  // ── payment_intent.canceled ───────────────────────────────────────────────
  if (eventType === 'payment_intent.canceled') {
    const { error: orderErr } = await supabase
      .from('orders')
      .update({ status: 'canceled', payment_status: 'failed', updated_at: new Date().toISOString() })
      .eq('order_id', orderId)
      .not('status', 'in', '(paid,pending_pickup)');

    if (orderErr) {
      console.error('[Webhook] Canceled-status update error:', orderErr.message);
      return new Response(JSON.stringify({ error: orderErr.message }), { status: 500 });
    }

    await supabase
      .from('inventory_reservations')
      .update({ status: 'released', updated_at: new Date().toISOString() })
      .eq('order_id', orderId)
      .eq('status', 'reserved');

    console.log('[Webhook] Order marked canceled:', orderId);
    return new Response(JSON.stringify({ received: true, action: 'canceled', orderId }), { status: 200 });
  }

  // Unreachable — all HANDLED events are covered above
  return new Response(JSON.stringify({ received: true, action: 'unhandled' }), { status: 200 });
});
