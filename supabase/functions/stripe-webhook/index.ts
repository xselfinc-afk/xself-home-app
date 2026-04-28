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

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// ── Stripe webhook signature verification ─────────────────────────────────────
// Implements the HMAC-SHA256 signature check that Stripe specifies.
// We cannot use the Stripe Node SDK in Deno, so we verify manually.
async function verifyStripeSignature(
  payload: string,
  sigHeader: string,
  secret: string,
): Promise<boolean> {
  // sigHeader format: t=<timestamp>,v1=<sig1>,v1=<sig2>,...
  const parts: Record<string, string[]> = {};
  for (const part of sigHeader.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx);
    const val = part.slice(idx + 1);
    if (!parts[key]) parts[key] = [];
    parts[key].push(val);
  }

  const timestamp = parts['t']?.[0];
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

  // Read raw body — must happen before any other body consumption
  const rawBody = await req.text();
  const sigHeader = req.headers.get('stripe-signature') ?? '';

  // Verify signature — reject anything that doesn't come from Stripe
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

  // Only handle payment_intent.succeeded — acknowledge everything else
  if (eventType !== 'payment_intent.succeeded') {
    return new Response(JSON.stringify({ received: true, action: 'ignored' }), { status: 200 });
  }

  const paymentIntent = (event.data as Record<string, unknown>)?.object as Record<string, unknown>;
  if (!paymentIntent) {
    console.log('[Webhook] Missing paymentIntent object in event');
    return new Response(JSON.stringify({ error: 'Missing paymentIntent' }), { status: 400 });
  }

  const paymentIntentId = paymentIntent.id as string;
  const metadata = (paymentIntent.metadata ?? {}) as Record<string, string>;
  const orderId = metadata.order_id;
  const fulfillmentChoice = metadata.fulfillment_choice ?? 'delivery';

  console.log('[Webhook] payment_intent.succeeded — pi:', paymentIntentId, '| order_id:', orderId ?? 'missing');

  // No order_id → can't match to an order — acknowledge and move on
  if (!orderId) {
    console.log('[Webhook] No order_id in metadata — ignoring');
    return new Response(JSON.stringify({ received: true, action: 'no_order_id' }), { status: 200 });
  }

  // Derive order status from fulfillment choice
  const newStatus = fulfillmentChoice === 'pickup' ? 'pending_pickup' : 'processing';

  // Use service role key to bypass RLS — this is a server-side operation
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Idempotency guard: only update if not already paid
  const { data, error } = await supabase
    .from('orders')
    .update({
      status: newStatus,
      payment_status: 'paid',
      stripe_payment_intent_id: paymentIntentId,
      updated_at: new Date().toISOString(),
    })
    .eq('order_id', orderId)
    .neq('payment_status', 'paid')   // no-op if already confirmed
    .select('order_id, status, payment_status');

  if (error) {
    console.log('[Webhook] Supabase update failed:', error.message);
    // Return 500 so Stripe retries the webhook
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (!data || data.length === 0) {
    // Row not found or already paid — safe no-op
    console.log('[Webhook] No-op: order already confirmed or not found:', orderId);
    return new Response(JSON.stringify({ received: true, action: 'no_op' }), { status: 200 });
  }

  console.log('[Webhook] Order confirmed via webhook:', orderId, '→', newStatus);
  return new Response(
    JSON.stringify({ received: true, action: 'confirmed', orderId, status: newStatus }),
    { status: 200 },
  );
});
