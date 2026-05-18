/**
 * create-checkout-order — Phase 8 server-authoritative checkout entry point.
 *
 * Responsibilities (in order):
 *   1. Validate cart items and address
 *   2. Check real inventory (same logic as validate-checkout-inventory)
 *   3. Call plan-fulfillment to select warehouse + shipping
 *   4. Create orders row (status = pending_payment)
 *   5. Create order_items rows
 *   6. Create inventory_reservations rows (TTL = 10 min)
 *   7. Create Stripe PaymentIntent (idempotency key = orderId)
 *   8. Save payment_intent_id on order
 *   9. Return { orderId, guestToken, clientSecret, paymentIntentId, totals }
 *
 * Callers: CheckoutScreen (Phase 8 integration, not yet wired).
 * Test with: curl commands in PHASE8_ORDER_SYSTEM_IMPLEMENTATION.md
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Secrets ───────────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = (Deno.env.get('STRIPE_SECRET_KEY') ?? '')
  // eslint-disable-next-line no-control-regex
  .replace(/[^\x20-\x7E]/g, '')
  .trim();

const SUPABASE_URL             = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// Needed only for the quote-redemption path: we verify the caller's JWT to
// match the quote's customer_email server-side. Set this in Function Secrets.
const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')         ?? '';

// ── Constants ─────────────────────────────────────────────────────────────────
const RESERVATION_TTL_MINUTES = 10;
const STALE_THRESHOLD_HOURS   = 24;
const MAX_CART_ITEMS          = 20;
const MAX_QTY_PER_ITEM        = 99;
const SKU_PATTERN             = /^[A-Za-z0-9_-]{1,60}$/;
const MAX_FIELD_LENGTH        = 200;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface CartItem {
  /** GIGA display SKU — used for display and as supplier_sku in order_items */
  sku: string;
  /** supplier_product_id — key into inventory_cache */
  productId: string;
  qty: number;
  title: string;
  /** Price in cents */
  unitPriceCents: number;
}

interface CustomerInfo {
  email?: string;
  phone?: string;
}

interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
}

interface RequestBody {
  items: CartItem[];
  customer: CustomerInfo;
  address: Address;
  /** Default: 'delivery' */
  fulfillmentMethod?: 'delivery' | 'pickup';
  /** Authenticated Supabase user ID — omit for guest */
  userId?: string;
  /** Resume token from a previous guest checkout attempt */
  guestToken?: string;
  /** 'card' | 'affirm' | '' (auto) */
  paymentMethodSelected?: string;
  /**
   * Optional custom-quote redeem token. When present, the line price is
   * replaced by the server-stored quoted_price_cents, and the request must
   * include a Bearer JWT whose `email` claim matches the quote's
   * customer_email. MVP supports single-item buy-now only.
   */
  quoteToken?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  try {
    // ── Parse body ────────────────────────────────────────────────────────────
    let body: RequestBody;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }

    const {
      items,
      customer = {},
      address,
      fulfillmentMethod = 'delivery',
      userId,
      guestToken: providedGuestToken,
      paymentMethodSelected = '',
      quoteToken,
    } = body;

    // ── Input validation ──────────────────────────────────────────────────────
    if (!items || !Array.isArray(items) || items.length === 0) {
      return jsonResponse({ error: 'items array is required and must be non-empty' }, 400);
    }
    if (items.length > MAX_CART_ITEMS) {
      return jsonResponse({ error: `Cart cannot exceed ${MAX_CART_ITEMS} items` }, 400);
    }
    if (!address?.line1 || !address?.city || !address?.state || !address?.zip) {
      return jsonResponse({ error: 'address.line1, city, state, and zip are required' }, 400);
    }
    if (address.line1.length > MAX_FIELD_LENGTH || address.city.length > MAX_FIELD_LENGTH) {
      return jsonResponse({ error: 'Address fields exceed maximum length' }, 400);
    }

    for (const item of items) {
      if (!item.productId || !SKU_PATTERN.test(item.productId)) {
        return jsonResponse({ error: 'Invalid product ID format' }, 400);
      }
      if (typeof item.qty !== 'number' || item.qty < 1 || item.qty > MAX_QTY_PER_ITEM) {
        return jsonResponse({ error: `qty must be between 1 and ${MAX_QTY_PER_ITEM}` }, 400);
      }
      if (typeof item.unitPriceCents !== 'number' || item.unitPriceCents < 0) {
        return jsonResponse({ error: 'unitPriceCents must be a non-negative integer' }, 400);
      }
    }

    if (!STRIPE_SECRET_KEY || STRIPE_SECRET_KEY === 'sk_test_REPLACE_ME') {
      return jsonResponse({ error: 'Stripe not configured on server' }, 500);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // ── Quote validation (only when quoteToken is present) ───────────────────
    // MVP rule: redemption requires sign-in. We verify the caller's JWT and
    // match `email` against support_quotes.customer_email. We override the
    // line price with the server-stored quoted_price_cents so the client's
    // unitPriceCents cannot influence the charge. The quote is "claimed"
    // atomically after the order row is inserted (see below); a Stripe
    // failure reverts the quote back to 'active' (see rollback block).
    let quoteRecord: {
      id: string;
      product_id: string;
      supplier_sku: string;
      quoted_price_cents: number;
      max_qty: number;
    } | null = null;

    if (quoteToken) {
      const authHeader = req.headers.get('authorization') ?? '';
      const jwt = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim() : '';
      if (!jwt) {
        return jsonResponse({ error: 'quote_redemption_requires_signin' }, 401);
      }

      const authClient = createClient(
        SUPABASE_URL,
        SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY,
        {
          auth: { persistSession: false },
          global: { headers: { Authorization: `Bearer ${jwt}` } },
        },
      );
      const { data: userData, error: userErr } = await authClient.auth.getUser(jwt);
      if (userErr || !userData?.user) {
        return jsonResponse({ error: 'invalid_auth_token' }, 401);
      }
      const callerEmail = (userData.user.email ?? '').trim().toLowerCase();
      if (!callerEmail) {
        return jsonResponse({ error: 'quote_redemption_requires_email' }, 403);
      }

      const { data: quote, error: qErr } = await supabase
        .from('support_quotes')
        .select('id, product_id, supplier_sku, customer_email, quoted_price_cents, max_qty, status, expires_at')
        .eq('redeem_token', quoteToken)
        .maybeSingle();

      if (qErr) {
        console.error('[create-checkout-order] quote lookup failed:', qErr.message);
        return jsonResponse({ error: 'quote_lookup_failed' }, 500);
      }
      if (!quote)                          return jsonResponse({ error: 'quote_invalid' }, 422);
      if (quote.status !== 'active')       return jsonResponse({ error: `quote_${quote.status}` }, 422);
      if (new Date(quote.expires_at).getTime() <= Date.now()) {
        return jsonResponse({ error: 'quote_expired' }, 422);
      }
      if (String(quote.customer_email).trim().toLowerCase() !== callerEmail) {
        return jsonResponse({ error: 'quote_email_mismatch' }, 422);
      }
      // The cart may contain other items at their normal client-supplied
      // prices; the quote applies to exactly one line that matches both the
      // product_id and supplier_sku stored on the quote. Other lines are
      // unaffected. Multi-quote-per-cart is intentionally NOT supported in
      // this revision — body still carries a single `quoteToken` at root.
      const matchingIndex = items.findIndex(it =>
        it.productId === quote.product_id && it.sku === quote.supplier_sku
      );
      if (matchingIndex === -1) {
        return jsonResponse({ error: 'quote_not_in_cart' }, 422);
      }
      const matchingItem = items[matchingIndex];
      if (matchingItem.qty > quote.max_qty) {
        return jsonResponse({ error: 'quote_qty_exceeded', max_qty: quote.max_qty }, 422);
      }

      // Server overrides the client-supplied price for the matched line
      // only. All other cart lines retain their original `unitPriceCents`.
      items[matchingIndex] = { ...matchingItem, unitPriceCents: quote.quoted_price_cents };
      quoteRecord = {
        id:                 quote.id,
        product_id:         quote.product_id,
        supplier_sku:       quote.supplier_sku,
        quoted_price_cents: quote.quoted_price_cents,
        max_qty:            quote.max_qty,
      };
      console.log(
        '[create-checkout-order] quote validated:',
        quoteRecord.id,
        '| caller_email:', callerEmail,
        '| product:', quoteRecord.product_id,
        '| price_cents:', quoteRecord.quoted_price_cents,
      );
    }

    // ── Inventory validation ──────────────────────────────────────────────────
    // STRICT: only fresh per-warehouse website_scrape rows count. If those are
    // missing, abort with inventory_unavailable rather than silently inventing
    // a warehouse — see plan-fulfillment for the rationale (CAX1 incident).
    const productIds = [...new Set(items.map(i => i.productId))];
    const staleThreshold = new Date(
      Date.now() - STALE_THRESHOLD_HOURS * 60 * 60 * 1000,
    ).toISOString();

    const { data: freshRows, error: invError } = await supabase
      .from('inventory_cache')
      .select('product_id, quantity, warehouse_code')
      .in('product_id', productIds)
      .eq('source_type', 'website_scrape')
      .eq('sync_status', 'ok')
      .gte('last_synced_at', staleThreshold);

    if (invError) {
      console.error('[create-checkout-order] Inventory query failed:', invError.message);
      return jsonResponse({ error: 'Inventory check failed' }, 500);
    }

    // productId → { totalQty, firstWarehouseCode }
    const stockMap = new Map<string, number>();
    const warehouseMap = new Map<string, string>(); // productId → first warehouse seen
    for (const row of freshRows ?? []) {
      const pid = row.product_id as string;
      const qty = Math.max(0, Number(row.quantity ?? 0));
      stockMap.set(pid, (stockMap.get(pid) ?? 0) + qty);
      if (!warehouseMap.has(pid)) warehouseMap.set(pid, row.warehouse_code as string);
    }

    const inventoryFailures: { productId: string; sku: string; reason: string }[] = [];
    for (const item of items) {
      if (!stockMap.has(item.productId)) {
        inventoryFailures.push({ productId: item.productId, sku: item.sku, reason: 'inventory_unavailable' });
      } else if ((stockMap.get(item.productId) ?? 0) < item.qty) {
        inventoryFailures.push({ productId: item.productId, sku: item.sku, reason: 'insufficient_qty' });
      }
    }

    if (inventoryFailures.length > 0) {
      return jsonResponse({ error: 'One or more items are unavailable', failures: inventoryFailures }, 422);
    }

    // ── Fulfillment planning ──────────────────────────────────────────────────
    const planItems = items.map(i => ({ sku: i.sku, productId: i.productId, qty: i.qty }));
    const planAddress = {
      line1: address.line1,
      city:  address.city,
      state: address.state,
      zip:   address.zip,
      country: address.country ?? 'US',
    };

    const { data: planData, error: planError } = await supabase.functions.invoke('plan-fulfillment', {
      body: { items: planItems, address: planAddress },
    });

    if (planError || !planData?.valid || !planData?.selectedWarehouse) {
      const reason = planError?.message ?? planData?.fulfillmentStatus ?? 'plan_failed';
      console.error('[create-checkout-order] plan-fulfillment failed:', reason);
      return jsonResponse({
        error: 'Unable to plan fulfillment for the given address and items',
        details: reason,
      }, 422);
    }

    // ── Compute totals ────────────────────────────────────────────────────────
    const subtotalCents = items.reduce((sum, i) => sum + i.qty * i.unitPriceCents, 0);
    // plan-fulfillment returns shipping in dollars; convert to cents. Pickup = free.
    const shippingCents = planData.usePickup ? 0 : Math.round((planData.shipping ?? 99) * 100);
    const taxCents      = 0; // Tax calculation TBD — placeholder
    const totalCents    = subtotalCents + shippingCents + taxCents;

    if (totalCents < 50) {
      return jsonResponse({ error: 'Order total is below the minimum charge amount ($0.50)' }, 400);
    }

    // ── Generate IDs ──────────────────────────────────────────────────────────
    const orderId    = crypto.randomUUID();
    const guestToken = userId ? null : (providedGuestToken ?? crypto.randomUUID());
    const now        = new Date().toISOString();
    const expiresAt  = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000).toISOString();

    const orderNumber = `ORD-${orderId.slice(0, 8).toUpperCase()}`;
    const orderDate   = new Date().toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });

    // ── Create order (pending_payment) ────────────────────────────────────────
    // Write both the new cents columns and the legacy dollar columns so existing
    // OrdersContext code that reads total/subtotal/etc. continues to work.
    const { error: orderError } = await supabase
      .from('orders')
      .insert({
        order_id:              orderId,
        order_number:          orderNumber,
        user_id:               userId ?? null,
        guest_token:           guestToken,
        customer_email:        customer.email ?? null,
        customer_phone:        customer.phone ?? null,
        status:                'pending_payment',
        payment_status:        'pending',
        fulfillment_method:    fulfillmentMethod,
        fulfillment_plan:      planData,
        // Phase 8 cents columns
        subtotal_cents:        subtotalCents,
        shipping_cents:        shippingCents,
        tax_cents:             taxCents,
        total_cents:           totalCents,
        // Legacy dollar columns (keep existing code working)
        total:                 totalCents / 100,
        subtotal:              subtotalCents / 100,
        shipping_total:        shippingCents / 100,
        tax:                   taxCents / 100,
        date:                  orderDate,
        address_json:          address,
        items_json:            items.map(i => ({
          sku:   i.sku,
          name:  i.title,
          img:   '',
          price: i.unitPriceCents / 100,
          qty:   i.qty,
        })),
        fulfillment_groups_json: [],
        quote_id:              quoteRecord?.id ?? null,
        created_at:            now,
        updated_at:            now,
      });

    if (orderError) {
      console.error('[create-checkout-order] Order insert failed:', orderError.message);
      return jsonResponse({ error: 'Failed to create order record' }, 500);
    }

    // ── Atomic quote claim ────────────────────────────────────────────────────
    // First writer wins. Concurrent redemptions of the same redeem_token lose
    // the race and trigger a rollback of the just-created order row. The
    // WHERE clause also re-checks expiration so a quote can't be claimed after
    // it expired between validation and this update.
    if (quoteRecord) {
      const { data: claimRows, error: claimErr } = await supabase
        .from('support_quotes')
        .update({ status: 'used', order_id: orderId, used_at: now })
        .eq('id', quoteRecord.id)
        .eq('status', 'active')
        .gt('expires_at', now)
        .select('id');

      if (claimErr) {
        console.error('[create-checkout-order] quote claim failed:', claimErr.message);
        await supabase.from('orders')
          .update({ status: 'abandoned', updated_at: new Date().toISOString() })
          .eq('order_id', orderId);
        return jsonResponse({ error: 'quote_claim_failed' }, 500);
      }
      if (!claimRows || claimRows.length === 0) {
        await supabase.from('orders')
          .update({ status: 'abandoned', updated_at: new Date().toISOString() })
          .eq('order_id', orderId);
        return jsonResponse({ error: 'quote_already_used_or_expired' }, 409);
      }
    }

    // ── Create order_items ────────────────────────────────────────────────────
    const orderItemRows = items.map(i => ({
      order_id:        orderId,
      product_id:      i.productId,
      supplier_sku:    i.sku,
      title:           i.title,
      quantity:        i.qty,
      unit_price_cents: i.unitPriceCents,
      total_cents:     i.qty * i.unitPriceCents,
      created_at:      now,
    }));

    const { error: itemsError } = await supabase.from('order_items').insert(orderItemRows);
    if (itemsError) {
      // Non-fatal: items are also stored in items_json on the order row
      console.error('[create-checkout-order] order_items insert failed (non-fatal):', itemsError.message);
    }

    // ── Create inventory reservations ─────────────────────────────────────────
    const selectedWarehouseCode = planData.selectedWarehouse?.code ?? 'UNKNOWN';
    const reservationRows = items.map(i => ({
      order_id:       orderId,
      product_id:     i.productId,
      supplier_sku:   i.sku,
      warehouse_code: warehouseMap.get(i.productId) ?? selectedWarehouseCode,
      quantity:       i.qty,
      status:         'reserved',
      expires_at:     expiresAt,
      created_at:     now,
      updated_at:     now,
    }));

    const { error: reservationError } = await supabase
      .from('inventory_reservations')
      .insert(reservationRows);

    if (reservationError) {
      // Non-fatal for MVP: log and continue. Reservation failure does not block checkout.
      console.error('[create-checkout-order] Reservation insert failed (non-fatal):', reservationError.message);
    }

    // ── Create Stripe PaymentIntent ───────────────────────────────────────────
    const stripeParams = new URLSearchParams();
    stripeParams.append('amount',   String(totalCents));
    stripeParams.append('currency', 'usd');

    if (paymentMethodSelected === 'card') {
      stripeParams.append('payment_method_types[]', 'card');
    } else if (paymentMethodSelected === 'affirm') {
      stripeParams.append('payment_method_types[]', 'affirm');
    } else {
      stripeParams.append('automatic_payment_methods[enabled]', 'true');
    }

    stripeParams.append('metadata[order_id]',          orderId);
    stripeParams.append('metadata[fulfillment_method]', fulfillmentMethod);
    if (guestToken) stripeParams.append('metadata[guest_token]', guestToken);
    if (customer.email) stripeParams.append('receipt_email', customer.email);

    const keyMode = STRIPE_SECRET_KEY.startsWith('sk_live') ? 'LIVE' : 'test';
    console.log('[create-checkout-order] Creating Stripe PI — mode:', keyMode, '| amount:', totalCents, '| order:', orderId);

    const stripeRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-06-20',
        'Idempotency-Key': orderId, // same orderId → same PI on retry
      },
      body: stripeParams.toString(),
    });

    const stripeJson = await stripeRes.json() as Record<string, unknown>;

    if (!stripeRes.ok) {
      const errMsg = (stripeJson?.error as Record<string, unknown>)?.message ?? 'Stripe error';
      console.error('[create-checkout-order] Stripe PI creation failed:', errMsg);
      const rollbackTs = new Date().toISOString();
      const rollbackOps: Array<Promise<unknown>> = [
        supabase.from('orders')
          .update({ status: 'abandoned', updated_at: rollbackTs })
          .eq('order_id', orderId),
        supabase.from('inventory_reservations')
          .update({ status: 'released', updated_at: rollbackTs })
          .eq('order_id', orderId),
      ];
      // Revert the claimed quote so the customer can retry the offer.
      if (quoteRecord) {
        rollbackOps.push(
          supabase.from('support_quotes')
            .update({ status: 'active', order_id: null, used_at: null })
            .eq('id', quoteRecord.id)
            .eq('order_id', orderId)
            .eq('status', 'used'),
        );
      }
      await Promise.all(rollbackOps);
      return jsonResponse({ error: String(errMsg) }, 502);
    }

    const paymentIntentId = stripeJson.id as string;
    const clientSecret    = stripeJson.client_secret as string;

    // ── Save payment_intent_id on order (idempotency anchor) ─────────────────
    const { error: piUpdateError } = await supabase
      .from('orders')
      .update({
        payment_intent_id:         paymentIntentId,
        stripe_payment_intent_id:  paymentIntentId, // also populate legacy column
        updated_at:                new Date().toISOString(),
      })
      .eq('order_id', orderId);

    if (piUpdateError) {
      // Non-fatal: webhook can still match via order_id in PI metadata
      console.error('[create-checkout-order] PI update on order failed (non-fatal):', piUpdateError.message);
    }

    console.log('[create-checkout-order] Done — order:', orderId, '| PI:', paymentIntentId, '| total:', totalCents, 'cents');

    return jsonResponse({
      orderId,
      orderNumber,
      guestToken,
      clientSecret,
      paymentIntentId,
      totalCents,
      subtotalCents,
      shippingCents,
      taxCents,
      isPickup: planData.usePickup ?? false,
      fulfillmentPlan: planData,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[create-checkout-order] Unexpected error:', msg);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
