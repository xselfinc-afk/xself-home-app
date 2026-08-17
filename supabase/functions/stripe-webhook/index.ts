/**
 * stripe-webhook — Phase 8 server-authoritative order finalizer.
 *
 * Events handled:
 *   payment_intent.succeeded    → mark order paid, fulfill reservations
 *   payment_intent.payment_failed → mark order failed, release reservations
 *   payment_intent.canceled     → mark order canceled, release reservations
 *   checkout.session.completed  → mark admin custom Payment Link paid
 *
 * Order lookup strategy (backward-compatible):
 *   1. Look up by orders.payment_intent_id (Phase 8 flow)
 *   2. Fall back to orders.order_id matched against PI metadata.order_id (pre-Phase 8)
 *
 * Idempotency:
 *   - succeeded: no-op if order.status is already 'paid' or 'pending_pickup'
 *   - failed/canceled: WHERE NOT IN (paid, pending_pickup) prevents downgrading paid orders
 *   - reservation updates use WHERE status='reserved' — already-transitioned rows are no-ops
 *   - admin Payment Link sync updates the same row by Stripe payment_link id
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createTaxTransaction } from '../_shared/stripeTax.ts';

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

function stripeId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object') {
    const id = (value as Record<string, unknown>).id;
    return typeof id === 'string' && id.trim() ? id : null;
  }
  return null;
}

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
    // Phase 5.4 — admin-negotiated Payment Link payments arrive as
    // Checkout Sessions. PI metadata is not propagated by default for
    // Payment Links, so the session is the authoritative match anchor.
    'checkout.session.completed',
  ];

  if (!HANDLED.includes(eventType)) {
    return new Response(JSON.stringify({ received: true, action: 'ignored' }), { status: 200 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // ── Phase 5.4 — Payment Link checkout sessions (admin negotiated prices) ──
  // Branched BEFORE the existing payment_intent handler so app-order behaviour
  // is unchanged. Matches by stripe_payment_link_id; Stripe retries safely
  // rewrite the same paid fields on the same row.
  if (eventType === 'checkout.session.completed') {
    const session     = (event.data as Record<string, unknown>)?.object as Record<string, unknown>;
    const sessionId   = session?.id as string | undefined;
    const paymentLink = stripeId(session?.payment_link);
    const piId        = stripeId(session?.payment_intent);
    const paymentStatus = session?.payment_status as string | undefined;
    const eventCreated = event.created as number | undefined;

    if (!paymentLink) {
      console.log('[Webhook] checkout.session.completed without payment_link — ignoring');
      return new Response(
        JSON.stringify({ received: true, action: 'no_payment_link', session_id: sessionId ?? null }),
        { status: 200 },
      );
    }

    if (paymentStatus && paymentStatus !== 'paid') {
      console.log('[Webhook] checkout.session.completed payment_link is not paid yet:', paymentLink, paymentStatus);
      return new Response(
        JSON.stringify({
          received: true,
          action: 'admin_link_not_paid',
          payment_link: paymentLink,
          session_id: sessionId ?? null,
          payment_status: paymentStatus,
        }),
        { status: 200 },
      );
    }

    const paidAtIso = eventCreated ? new Date(eventCreated * 1000).toISOString() : new Date().toISOString();

    const { data: updated, error: updErr } = await supabase
      .from('admin_custom_payment_links')
      .update({
        status:                     'paid',
        paid_at:                    paidAtIso,
        stripe_checkout_session_id: sessionId ?? null,
        stripe_payment_intent_id:   piId ?? null,
      })
      .eq('stripe_payment_link_id', paymentLink)
      .select('id, order_id, order_number, negotiated_total_cents');

    if (updErr) {
      console.error('[Webhook] admin_custom_payment_links update failed:', updErr.message);
      // Return 500 so Stripe retries — do not return 200 on DB failure
      return new Response(JSON.stringify({ error: updErr.message }), { status: 500 });
    }

    if (!updated || updated.length === 0) {
      console.log('[Webhook] checkout.session.completed — no admin link matched:', paymentLink);
      return new Response(
        JSON.stringify({ received: true, action: 'no_admin_link_match', payment_link: paymentLink }),
        { status: 200 },
      );
    }

    console.log('[Webhook] admin link paid:', paymentLink, '→ row', updated[0]?.id, '· session', sessionId);
    return new Response(
      JSON.stringify({
        received:        true,
        action:          'admin_link_paid',
        rows:            updated.length,
        payment_link:    paymentLink,
        session_id:      sessionId,
        order_id:        updated[0]?.order_id ?? null,
      }),
      { status: 200 },
    );
  }

  // ── payment_intent.* events (existing flow, unchanged below this line) ────
  const paymentIntent   = (event.data as Record<string, unknown>)?.object as Record<string, unknown>;
  const paymentIntentId = paymentIntent?.id as string;
  const metadata        = ((paymentIntent?.metadata ?? {}) as Record<string, string>);
  const orderIdMeta     = metadata.order_id; // fallback for pre-Phase-8 orders

  if (!paymentIntentId) {
    console.log('[Webhook] Missing paymentIntent.id — ignoring');
    return new Response(JSON.stringify({ received: true, action: 'no_pi_id' }), { status: 200 });
  }

  console.log('[Webhook]', eventType, '— PI:', paymentIntentId, '| meta order_id:', orderIdMeta ?? 'none');

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

    // File the tax with Stripe. The calculation made at order creation is only a quote until it
    // becomes a Transaction — that is what lands in Stripe's tax reports. Deliberately NOT fatal:
    // the money has already moved, so a reporting hiccup must not leave the order unpaid. It is
    // logged loudly instead, and the Idempotency-Key makes webhook redelivery safe.
    const taxCalculationId = metadata.tax_calculation_id ?? '';
    if (taxCalculationId && orderId) {
      const taxTxn = await createTaxTransaction(STRIPE_SECRET_KEY, taxCalculationId, orderId);
      if (taxTxn.ok) {
        console.log('[Webhook] Tax transaction recorded:', taxTxn.transactionId, 'for order', orderId);
      } else {
        console.error('[Webhook] TAX TRANSACTION FAILED (order stays paid, needs manual filing):', orderId, taxTxn.error);
      }
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
        // Admin-approval gate (Phase 1 of GIGA Auto-Purchase workflow):
        // paid orders enter the admin review queue. supplier_sync_status is
        // explicitly set to 'not_submitted' to guard against any pre-existing
        // value on the row from prior writes. Neither field triggers a GIGA
        // call here — the actual submission requires explicit admin approval
        // in a separate Phase 2 edge function.
        admin_approval_status:     'pending',
        supplier_sync_status:      'not_submitted',
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

    // ── Enqueue paid-order notification (Phase 2 — ENQUEUE ONLY, no send here) ──
    // A separate sender Edge Function (Phase 3+) reads pending rows and delivers.
    // STRICTLY NON-FATAL: the order is already confirmed; a queue failure must never
    // change order status or cause Stripe to retry. We upsert ON CONFLICT DO NOTHING
    // keyed on the order_id PK, so duplicate Stripe deliveries can't create duplicate
    // jobs and can't reset a row the sender already advanced to 'sent'/'failed'.
    try {
      const { error: notifyErr } = await supabase
        .from('order_notifications')
        .upsert(
          {
            order_id:      orderId,
            channel:       'email',
            status:        'pending',
            customer_name: metadata.customer_name ?? null,
          },
          { onConflict: 'order_id', ignoreDuplicates: true },
        );
      if (notifyErr) {
        console.error('[Webhook] order_notifications enqueue failed (non-fatal):', notifyErr.message);
      }
    } catch (e) {
      console.error('[Webhook] order_notifications enqueue threw (non-fatal):', e instanceof Error ? e.message : e);
    }

    // ── Enqueue customer order-confirmation (Phase C4.1 — ENQUEUE ONLY, no send) ──
    // A separate processor drains this queue later; send-customer-order-email
    // resolves the recipient from orders.customer_email at send time (so we do NOT
    // read/store it here). STRICTLY NON-FATAL: the order is already confirmed paid;
    // a queue failure must never change order status or cause Stripe to retry.
    // ON CONFLICT (order_id) DO NOTHING dedupes duplicate Stripe deliveries.
    try {
      const { error: custErr } = await supabase
        .from('customer_order_emails')
        .upsert(
          { order_id: orderId, status: 'pending' },
          { onConflict: 'order_id', ignoreDuplicates: true },
        );
      if (custErr) {
        console.error('[Webhook] customer_order_emails enqueue failed (non-fatal):', custErr.message);
      }
    } catch (e) {
      console.error('[Webhook] customer_order_emails enqueue threw (non-fatal):', e instanceof Error ? e.message : e);
    }

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
