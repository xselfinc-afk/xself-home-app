/**
 * pickup-authorization-create (Phase 1, item E + K).
 *
 * Ops/system endpoint (X-Pickup-Token). At BOL-ready it RE-CONFIRMS the authoritative amount
 * (subtotal from order_items + final pickup tax, shipping $0), then places a manual-capture
 * PaymentIntent HOLD on the customer's saved card. It NEVER captures and NEVER sets paid.
 *
 * Idempotent retry: an unfinished intent (requires_action/confirmation) is REUSED — its
 * client_secret is returned again rather than creating a duplicate hold. Amount is server-only.
 *
 * Not wired to XOne this phase; no scheduler. Verified against the prod-schema replica via
 * domain + DB-effect tests (no live Stripe call in tests → no real charge).
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { calculateTax, extractUsZip, findOrCreatePerformanceLocation, type TaxAddress } from '../_shared/stripeTax.ts';
import {
  authorizationIntentReuseDecision,
  buildAuthorizationPaymentIntentParams,
  computeFinalPickupAmountCents,
  extractCaptureBeforeIso,
  mapAuthorizationStatus,
} from '../_shared/pickup/pickupDomain.ts';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const STRIPE_SECRET_KEY         = (Deno.env.get('STRIPE_SECRET_KEY') ?? '').replace(/[^\x20-\x7E]/g, '').trim();
const STRIPE_API_BASE           = Deno.env.get('STRIPE_API_BASE') ?? 'https://api.stripe.com';
const PICKUP_ADMIN_TOKEN        = Deno.env.get('PICKUP_ADMIN_TOKEN') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-pickup-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// deno-lint-ignore no-explicit-any
async function stripePost(path: string, params: URLSearchParams, idempotencyKey?: string): Promise<{ ok: boolean; json: any }> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': '2024-06-20',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${STRIPE_API_BASE}${path}`, { method: 'POST', headers, body: params.toString() });
  return { ok: res.ok, json: await res.json() };
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!PICKUP_ADMIN_TOKEN || req.headers.get('x-pickup-token') !== PICKUP_ADMIN_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body: { orderId?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid_request' }, 400); }
  const orderId = (body.orderId ?? '').trim();
  if (!orderId) return json({ error: 'orderId_required' }, 400);

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // ── Load order — must be a pickup order with a saved card ────────────────────
  const { data: orders, error: oErr } = await db.from('orders')
    .select('order_id, fulfillment_method, payment_status, stripe_customer_id, setup_intent_id, address_json, fulfillment_plan, authorization_payment_intent_id')
    .eq('order_id', orderId).limit(1);
  if (oErr) return json({ error: 'lookup_failed' }, 500);
  const order = orders?.[0];
  if (!order) return json({ error: 'order_not_found' }, 404);
  if (order.fulfillment_method !== 'pickup') return json({ error: 'not_pickup_order' }, 422);
  if (order.payment_status !== 'card_saved' && order.payment_status !== 'authorized') {
    return json({ error: 'card_not_saved' }, 422);   // must have completed SetupIntent
  }
  if (!order.stripe_customer_id) return json({ error: 'no_stripe_customer' }, 422);

  // ── Reuse an unfinished / terminal authorization before creating another ─────
  const { data: existingAuths } = await db.from('pickup_payment_authorizations')
    .select('provider_payment_intent_id, status, amount_cents, capture_before')
    .eq('order_id', orderId).order('created_at', { ascending: false }).limit(1);
  const existing = existingAuths?.[0];
  const decision = authorizationIntentReuseDecision(existing ? { status: existing.status } : undefined);
  if (decision === 'reuse' && existing?.provider_payment_intent_id) {
    // Return the same intent's client_secret — no duplicate PaymentIntent.
    const { ok, json: pi } = await stripePost(`/v1/payment_intents/${existing.provider_payment_intent_id}`, new URLSearchParams());
    if (ok && pi?.client_secret) {
      return json({ mode: 'reuse', status: existing.status, clientSecret: pi.client_secret, paymentIntentId: existing.provider_payment_intent_id });
    }
    // fall through to create if the intent could not be retrieved
  }
  if (decision === 'terminal') {
    return json({ mode: 'terminal', status: existing!.status, paymentIntentId: existing!.provider_payment_intent_id });
  }

  // ── Re-confirm the authoritative amount (subtotal from order_items + pickup tax) ──
  const { data: itemRows, error: iErr } = await db.from('order_items')
    .select('product_id, quantity, unit_price_cents').eq('order_id', orderId);
  if (iErr || !itemRows?.length) return json({ error: 'no_order_items' }, 422);
  const subtotalCents = itemRows.reduce((s: number, r: { quantity: number; unit_price_cents: number }) => s + r.quantity * r.unit_price_cents, 0);

  // Pickup tax at the warehouse performance location. Customer address stays the tax address.
  const addr = (order.address_json ?? {}) as Record<string, string>;
  const plan = (order.fulfillment_plan ?? {}) as { selectedWarehouse?: Record<string, string> };
  const wh = plan.selectedWarehouse;
  let performanceLocationId: string | null = null;
  if (wh?.code) {
    performanceLocationId = await findOrCreatePerformanceLocation(STRIPE_SECRET_KEY, String(wh.code), {
      line1: String(wh.address ?? ''), city: String(wh.city ?? ''), state: String(wh.state ?? ''),
      postalCode: extractUsZip(wh.address) ?? '', country: 'US',
    });
  }
  const taxAddress: TaxAddress = {
    line1: addr.line1 ?? '', line2: addr.line2 ?? null, city: addr.city ?? '',
    state: addr.state ?? '', postalCode: addr.zip ?? '', country: addr.country ?? 'US',
  };
  let taxCents = 0; let taxCalculationId: string | null = null;
  try {
    const calc = await calculateTax(STRIPE_SECRET_KEY, {
      lineItems: itemRows.map((r: { product_id: string; quantity: number; unit_price_cents: number }) => ({ productId: r.product_id, qty: r.quantity, unitPriceCents: r.unit_price_cents })),
      shippingCents: 0, address: taxAddress, performanceLocationId,
    });
    taxCents = calc.taxCents; taxCalculationId = calc.calculationId;
  } catch (e) {
    console.error('[pickup-authorization-create] tax recompute failed:', e instanceof Error ? e.message : e);
    return json({ error: 'tax_calculation_failed' }, 422);
  }

  const amountCents = computeFinalPickupAmountCents(subtotalCents, taxCents); // subtotal + tax + $0 shipping

  // Resolve the saved payment method from the SetupIntent.
  let paymentMethodId: string | null = null;
  if (order.setup_intent_id) {
    const { ok, json: si } = await stripePost(`/v1/setup_intents/${order.setup_intent_id}`, new URLSearchParams());
    if (ok) paymentMethodId = (si?.payment_method as string) ?? null;
  }

  // ── Create the manual-capture hold. Idempotency-Key ties retries to (order, amount). ──
  const idempotencyKey = `${orderId}:${amountCents}:auth`;
  const params = buildAuthorizationPaymentIntentParams({ orderId, customerId: order.stripe_customer_id, paymentMethodId, amountCents, taxCalculationId });
  params.append('expand[]', 'latest_charge'); // so the response carries the charge's capture_before
  const { ok, json: pi } = await stripePost('/v1/payment_intents', params, idempotencyKey);
  if (!ok) {
    // requires_payment_method as a hard error here = declined; record FAILED, not abandoned.
    console.error('[pickup-authorization-create] PI create failed:', pi?.error?.message ?? 'unknown');
    return json({ error: 'authorization_failed', detail: pi?.error?.message ?? null }, 502);
  }

  const stripeStatus = String(pi.status ?? '');
  const authStatus = mapAuthorizationStatus(stripeStatus, { afterConfirmAttempt: true });
  // Real hold expiry from Stripe (charge.payment_method_details.card.capture_before). Never guessed.
  let captureBefore = extractCaptureBeforeIso(pi);
  if (captureBefore === null && typeof pi?.latest_charge === 'string' && pi.latest_charge) {
    const { ok: chOk, json: charge } = await stripePost(`/v1/charges/${pi.latest_charge}`, new URLSearchParams());
    if (chOk) captureBefore = extractCaptureBeforeIso(charge);
  }

  // Persist ledger + order fields. authorization != paid: payment_status only advances to
  // 'authorized' when the hold is live (requires_capture); otherwise it stays 'card_saved'.
  await db.from('pickup_payment_authorizations').upsert({
    order_id: orderId, provider_payment_intent_id: pi.id, status: authStatus,
    amount_cents: amountCents, capture_before: captureBefore, tax_calculation_id: taxCalculationId,
    idempotency_key: idempotencyKey, updated_at: new Date().toISOString(),
  }, { onConflict: 'idempotency_key', ignoreDuplicates: false });

  const orderPatch: Record<string, unknown> = {
    authorization_payment_intent_id: pi.id,
    authorization_status: authStatus,
    authorization_amount_cents: amountCents,
    capture_before: captureBefore,
    tax_cents: taxCents, total_cents: amountCents, total: amountCents / 100, tax: taxCents / 100,
    updated_at: new Date().toISOString(),
  };
  if (authStatus === 'AUTHORIZED') { orderPatch.payment_status = 'authorized'; orderPatch.pickup_stage = 'AUTHORIZED'; }
  await db.from('orders').update(orderPatch).eq('order_id', orderId).not('payment_status', 'in', '(paid)');

  return json({
    mode: 'authorization',
    status: authStatus,
    paymentIntentId: pi.id,
    clientSecret: pi.client_secret ?? null,   // requires_action/confirmation → client finishes auth
    amountCents,
  });
});
