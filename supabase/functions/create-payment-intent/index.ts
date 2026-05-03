/**
 * @deprecated Phase 8 — use `create-checkout-order` instead.
 * create-checkout-order creates the order record, inventory reservations, and
 * Stripe PaymentIntent in a single atomic call and is the authoritative entry
 * point for all new checkout sessions.
 *
 * This function is kept for backward compatibility while CheckoutScreen is
 * still wired to the pre-Phase-8 flow. Remove after CheckoutScreen integration.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// Strip any non-printable or non-ASCII bytes that would make the Authorization
// header fail the ByteString validity check (e.g. UTF-8 BOM, stray newlines).
const STRIPE_SECRET_KEY = (Deno.env.get('STRIPE_SECRET_KEY') ?? '')
  // eslint-disable-next-line no-control-regex
  .replace(/[^\x20-\x7E]/g, '')
  .trim();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (!STRIPE_SECRET_KEY || STRIPE_SECRET_KEY === 'sk_test_REPLACE_ME') {
      return new Response(
        JSON.stringify({ error: 'Stripe secret key not configured on server' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const keyMode = STRIPE_SECRET_KEY.startsWith('sk_live') ? 'LIVE' : 'test';
    console.log('[PaymentIntent] Stripe secret key mode:', keyMode);

    const body = await req.json() as {
      amount: number;          // cents
      currency?: string;
      orderId?: string;
      customerEmail?: string;
      metadata?: Record<string, string>;
      shippingAddress?: {
        name?: string;
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        zip?: string;
        country?: string;
      };
    };

    const { amount, currency = 'usd', orderId, customerEmail, metadata, shippingAddress } = body;

    // Server-side amount validation
    if (!amount || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 50) {
      return new Response(
        JSON.stringify({ error: `Invalid amount: ${amount}. Minimum is 50 cents.` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const params = new URLSearchParams();
    params.append('amount', String(Math.round(amount)));
    params.append('currency', currency);

    // Card-only PaymentSheet: restrict to card so Link and Bank don't appear.
    // Apple Pay and wallet flows use automatic_payment_methods (Apple Pay tokenises as a card).
    const paymentMethodSelected = metadata?.payment_method_selected ?? '';
    if (paymentMethodSelected === 'card') {
      params.append('payment_method_types[]', 'card');
    } else if (paymentMethodSelected === 'affirm') {
      params.append('payment_method_types[]', 'affirm');
    } else {
      params.append('automatic_payment_methods[enabled]', 'true');
    }

    if (orderId) params.append('metadata[order_id]', orderId);
    if (customerEmail) params.append('receipt_email', customerEmail);

    // Forward caller-supplied metadata (payment_method_selected, fulfillment_choice, etc.)
    if (metadata && typeof metadata === 'object') {
      for (const [key, value] of Object.entries(metadata)) {
        if (key && value != null) params.append(`metadata[${key}]`, String(value));
      }
    }

    // Shipping info improves Affirm eligibility
    if (shippingAddress) {
      if (shippingAddress.name) params.append('shipping[name]', shippingAddress.name);
      if (shippingAddress.line1) params.append('shipping[address][line1]', shippingAddress.line1);
      if (shippingAddress.line2) params.append('shipping[address][line2]', shippingAddress.line2);
      if (shippingAddress.city) params.append('shipping[address][city]', shippingAddress.city);
      if (shippingAddress.state) params.append('shipping[address][state]', shippingAddress.state);
      if (shippingAddress.zip) params.append('shipping[address][postal_code]', shippingAddress.zip);
      params.append('shipping[address][country]', shippingAddress.country ?? 'US');
    }

    console.log('[Stripe] Creating PaymentIntent — amount:', amount, 'orderId:', orderId,
      '| key prefix:', STRIPE_SECRET_KEY.slice(0, 8), '| key len:', STRIPE_SECRET_KEY.length);

    // orderId is used as the Stripe idempotency key so that retrying the same
    // checkout session never creates a second PaymentIntent or a second charge.
    const requestHeaders: Record<string, string> = {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20',
    };
    if (orderId) requestHeaders['Idempotency-Key'] = orderId;

    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: requestHeaders,
      body: params.toString(),
    });

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      const errMsg = (data?.error as Record<string, unknown>)?.message ?? 'Stripe error';
      console.log('[Stripe] PaymentIntent creation failed:', errMsg);
      return new Response(
        JSON.stringify({ error: String(errMsg) }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    console.log('[Stripe] PaymentIntent created:', data.id);

    return new Response(
      JSON.stringify({
        clientSecret: data.client_secret,
        paymentIntentId: data.id,
        amount: data.amount,
        currency: data.currency,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log('[Stripe] Unhandled error:', message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
