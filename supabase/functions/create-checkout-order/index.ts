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

import { sendMetaEvents, hashedUserData } from '../_shared/metaCapi.ts';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { LEGACY_DELIVERY_FEE_DOLLARS } from '../_shared/deliveryFee.ts';
import { evaluateCheckoutCart } from '../_shared/checkoutInventoryRevalidation.ts';
import { calculateTax, extractUsZip, findOrCreatePerformanceLocation, type TaxAddress } from '../_shared/stripeTax.ts';
import { buildSetupIntentParams, shouldUsePayAfterPickup } from '../_shared/pickup/pickupDomain.ts';

// ── Secrets ───────────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = (Deno.env.get('STRIPE_SECRET_KEY') ?? '')
  // eslint-disable-next-line no-control-regex
  .replace(/[^\x20-\x7E]/g, '')
  .trim();

const SUPABASE_URL             = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Stripe API base — overridable ONLY for local integration tests (fake Stripe). Defaults to the
// real API, so production behaviour (Delivery included) is byte-identical.
const STRIPE_API_BASE = Deno.env.get('STRIPE_API_BASE') ?? 'https://api.stripe.com';

/** Reuse the caller's existing Stripe customer if any prior order carries one; else create. */
// deno-lint-ignore no-explicit-any — supabase-js query builders are thenable at runtime; their
// generic type under Deno's strict resolution doesn't model Promise (same friction as the
// existing quote-rollback code). `any` here keeps this private helper free of that type noise.
async function getOrCreateStripeCustomer(
  supabase: any,
  opts: { userId: string | null; email: string | null },
): Promise<string> {
  if (opts.userId || opts.email) {
    const q = supabase.from('orders').select('stripe_customer_id').not('stripe_customer_id', 'is', null).limit(1);
    const { data } = opts.userId
      ? await q.eq('user_id', opts.userId)
      : await q.eq('customer_email', opts.email as string);
    const existing = data?.[0]?.stripe_customer_id as string | undefined;
    if (existing) return existing;
  }
  const params = new URLSearchParams();
  if (opts.email) params.append('email', opts.email);
  const res = await fetch(`${STRIPE_API_BASE}/v1/customers`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(`stripe customer create failed: ${(json?.error as Record<string, unknown>)?.message ?? res.status}`);
  return json.id as string;
}
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

// ── Meta InitiateCheckout — fired at the REAL order-creation entry (both paths).
// event_id = ic:{checkoutSessionId || orderId}; contained failure, never blocks.
async function emitMetaInitiateCheckout(input: {
  dedupKey: string; email?: string | null; phone?: string | null;
  totalCents: number; items: Array<{ sku: string; qty: number; unitPriceCents: number }>;
}): Promise<void> {
  try {
    await sendMetaEvents([{
      event_name: 'InitiateCheckout',
      event_id: `ic:${input.dedupKey}`,
      user_data: await hashedUserData({ email: input.email, phone: input.phone }),
      custom_data: {
        currency: 'USD',
        value: input.totalCents / 100,
        num_items: input.items.reduce((s, i) => s + i.qty, 0),
        content_type: 'product',
        content_ids: input.items.map((i) => i.sku),
      },
    }], 'initiate-checkout');
  } catch (e) {
    console.error('[metaCapi] emitMetaInitiateCheckout contained failure:', e instanceof Error ? e.message : String(e));
  }
}

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
  /** 🔒 Version gate: only NEW app builds send true. Absent/false → legacy-compatible behavior. */
  clientSupportsDynamicDelivery?: boolean;
  /**
   * 🔒 Pay-After-Pickup capability gate. ONLY a build whose Checkout can drive the SetupIntent
   * (save-card, $0-today) flow sends true. Absent/false → the order takes the existing
   * automatic-capture PaymentIntent path, exactly as today. This never affects Delivery: the
   * Pay-After-Pickup branch also requires fulfillmentMethod==='pickup' AND a pickup plan.
   */
  clientSupportsPayAfterPickup?: boolean;
  /**
   * 🔒 Tax capability gate. Only builds whose Checkout renders the server's taxCents send this.
   * Absent → false → tax stays 0, exactly as every already-installed build expects.
   *
   * Without this gate the backend charges tax that older Checkout screens never display, so the
   * customer is billed more than the total they approved. Version numbers are deliberately NOT
   * consulted: the client declares what it can render, the same way clientSupportsDynamicDelivery
   * already works.
   */
  clientSupportsTax?: boolean;
  /** Authenticated Supabase user ID — omit for guest */
  userId?: string;
  /** Resume token from a previous guest checkout attempt */
  guestToken?: string;
  /** Client checkout session id — used ONLY as the Meta InitiateCheckout dedup key
   *  (event_id ic:{id}, shared with the iOS SDK). Optional/additive; absent → the
   *  server falls back to the orderId (old clients send no client-side event, so
   *  no double count either way). Never used for auth or business logic. */
  checkoutSessionId?: string;
  /** 'card' | 'affirm' | '' (auto) */
  paymentMethodSelected?: string;
  /**
   * Customer full name ("First Last"). Used as shipping[name] on Affirm
   * PaymentIntents so risk underwriting receives a real human name rather
   * than an email local-part. Falls back to email-derived value when absent.
   */
  customerName?: string;
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
      customerName,
      quoteToken,
      clientSupportsDynamicDelivery = false,
      clientSupportsTax = false,
      clientSupportsPayAfterPickup = false,
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

    // ── Server-side price authority ───────────────────────────────────────────
    // The client's unitPriceCents is a display snapshot, never the final price.
    //   1. Resolve the caller's email (soft — guests continue with null).
    //   2. Auto-attach the caller's active quote when the client sent no token,
    //      so an offer created after add-to-cart still applies at checkout.
    //   3. Re-price every non-quoted line from the catalog:
    //        server < snapshot → charge the LOWER price (customer-favorable, silent)
    //        server > snapshot → 409 price_changed (client refreshes + re-confirms)
    //      This runs BEFORE quote claim / order insert / Stripe, so an abort here
    //      has nothing to roll back.
    let callerEmailSoft: string | null = null;
    {
      const authHeaderSoft = req.headers.get('authorization') ?? '';
      const jwtSoft = authHeaderSoft.toLowerCase().startsWith('bearer ')
        ? authHeaderSoft.slice(7).trim() : '';
      if (jwtSoft) {
        try {
          const softClient = createClient(
            SUPABASE_URL,
            SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY,
            {
              auth: { persistSession: false },
              global: { headers: { Authorization: `Bearer ${jwtSoft}` } },
            },
          );
          const { data: softUser } = await softClient.auth.getUser(jwtSoft);
          callerEmailSoft = (softUser?.user?.email ?? '').trim().toLowerCase() || null;
        } catch (_e) {
          callerEmailSoft = null; // soft path: an unreadable JWT just means "guest"
        }
      }
    }

    let effectiveQuoteToken = quoteToken;
    if (!effectiveQuoteToken && callerEmailSoft) {
      const { data: autoQuotes, error: autoErr } = await supabase
        .from('support_quotes')
        .select('redeem_token, product_id, supplier_sku, expires_at')
        .eq('customer_email', callerEmailSoft)
        .eq('status', 'active')
        .gt('expires_at', new Date().toISOString())
        .in('product_id', items.map((i) => i.productId));
      if (!autoErr) {
        const autoMatch = (autoQuotes ?? []).find((q) =>
          items.some((it) => it.productId === q.product_id && it.sku === q.supplier_sku),
        );
        if (autoMatch) {
          effectiveQuoteToken = autoMatch.redeem_token;
          console.log('[create-checkout-order] auto-attached active quote for product:', autoMatch.product_id);
        }
      }
    }

    // Identify which line the quote will override (readonly peek — the quote
    // block below still re-validates and claims). That line is exempt from the
    // catalog reprice; its price becomes quoted_price_cents authoritatively.
    let quotedLineIdx = -1;
    if (effectiveQuoteToken) {
      const { data: qPeek } = await supabase
        .from('support_quotes')
        .select('product_id, supplier_sku')
        .eq('redeem_token', effectiveQuoteToken)
        .maybeSingle();
      if (qPeek) {
        quotedLineIdx = items.findIndex((it) =>
          it.productId === qPeek.product_id && it.sku === qPeek.supplier_sku,
        );
      }
    }

    const uniqueProductIds = [...new Set(items.map((i) => i.productId))];
    const { data: catalogRows, error: catalogErr } = await supabase
      .from('standardized_products')
      .select('supplier_product_id, sku_custom, selling_price, price, primary_image')
      .in('supplier_product_id', uniqueProductIds);
    if (catalogErr) {
      // Fail closed: never fall back to trusting client prices.
      console.error('[create-checkout-order] catalog price lookup failed:', catalogErr.message);
      return jsonResponse({ error: 'catalog_price_lookup_failed' }, 500);
    }
    const catalogCentsByProductId = new Map<string, number>();
    // Image SNAPSHOT for items_json: resolved server-side (service role, RLS-free) so
    // My Orders thumbnails survive the product later going out of stock / stale-sync,
    // when the public read policy hides the standardized_products row from the app.
    const imgByProductId = new Map<string, string>();
    for (const row of catalogRows ?? []) {
      const dollars = (typeof row.selling_price === 'number' && row.selling_price > 0)
        ? row.selling_price
        : (typeof row.price === 'number' && row.price > 0 ? row.price : null);
      if (dollars != null) catalogCentsByProductId.set(row.supplier_product_id, Math.round(dollars * 100));
      if (typeof row.primary_image === 'string' && row.primary_image) {
        imgByProductId.set(row.supplier_product_id, row.primary_image);
      }
    }

    const priceChanges: Array<{
      productId: string; sku: string; oldUnitPriceCents: number; newUnitPriceCents: number;
    }> = [];
    items.forEach((it, idx) => {
      if (idx === quotedLineIdx) return; // quote overrides this line below
      const serverCents = catalogCentsByProductId.get(it.productId);
      if (serverCents == null) return;   // defensive: unpriced rows never pass the sellable gate
      if (serverCents < it.unitPriceCents) {
        items[idx] = { ...it, unitPriceCents: serverCents };
      } else if (serverCents > it.unitPriceCents) {
        priceChanges.push({
          productId: it.productId, sku: it.sku,
          oldUnitPriceCents: it.unitPriceCents, newUnitPriceCents: serverCents,
        });
      }
    });
    if (priceChanges.length > 0) {
      return jsonResponse({ error: 'price_changed', changes: priceChanges }, 409);
    }

    // ── Quote validation (only when a quote token is present) ────────────────
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

    if (effectiveQuoteToken) {
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
        .eq('redeem_token', effectiveQuoteToken)
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
    // Accept ANY per-warehouse website_scrape rows (regardless of age). The
    // staleness gate previously blocked all checkouts whenever GIGA sync
    // paused; we now let stale rows flow through (per-warehouse binding still
    // prevents CAX1) and rely on the qty check below for out-of-stock
    // protection. Freshness is surfaced via plan-fulfillment's
    // inventoryFreshness field, which the client renders as a fallback
    // banner. STALE_THRESHOLD_HOURS is kept only for legacy reference.
    const productIds = [...new Set(items.map(i => i.productId))];
    void STALE_THRESHOLD_HOURS;

    const { data: freshRows, error: invError } = await supabase
      .from('inventory_cache')
      .select('product_id, quantity, warehouse_code, last_synced_at')
      .in('product_id', productIds)
      .in('source_type', ['website_scrape', 'official_api'])
      .eq('sync_status', 'ok');

    if (invError) {
      console.error('[create-checkout-order] Inventory query failed:', invError.message);
      return jsonResponse({ error: 'Inventory check failed' }, 500);
    }

    // productId → { totalQty, firstWarehouseCode }
    const stockMap = new Map<string, number>();
    const warehouseMap = new Map<string, string>(); // productId → first warehouse seen
    const rowsByProduct = new Map<string, { quantity: number | null; lastSyncedAt: string | null }[]>();
    for (const row of freshRows ?? []) {
      const pid = row.product_id as string;
      const qty = Math.max(0, Number(row.quantity ?? 0));
      stockMap.set(pid, (stockMap.get(pid) ?? 0) + qty);
      if (!warehouseMap.has(pid)) warehouseMap.set(pid, row.warehouse_code as string);
      const arr = rowsByProduct.get(pid) ?? [];
      arr.push({ quantity: row.quantity as number | null, lastSyncedAt: row.last_synced_at as string | null });
      rowsByProduct.set(pid, arr);
    }

    const inventoryFailures: { productId: string; sku: string; reason: string }[] = [];
    for (const item of items) {
      if (!stockMap.has(item.productId)) {
        inventoryFailures.push({ productId: item.productId, sku: item.sku, reason: 'inventory_unavailable' });
      } else if ((stockMap.get(item.productId) ?? 0) < item.qty) {
        inventoryFailures.push({ productId: item.productId, sku: item.sku, reason: 'insufficient_qty' });
      }
    }

    // Flag-gated stale/unknown revalidation (Scope G). DEFAULT OFF via remote config
    // `inventory_checkout_revalidation_enabled`; while off this block is a strict no-op and
    // the existing out-of-stock/insufficient behavior above is unchanged. When on, a line
    // whose trusted cache rows are all older than the freshness threshold (or absent) is NOT
    // accepted as confirmed stock (structured reason). Server-authoritative — never trusts
    // client inventory state; touches only inventory, not fulfillment/Stripe/Affirm/pickup.
    let checkoutRevalidationEnabled = false;
    try {
      const { data: flagRows } = await supabase
        .from('home_content_config').select('value')
        .eq('screen', 'inventory_automation').eq('key', 'inventory_checkout_revalidation_enabled')
        .eq('is_active', true).limit(1);
      checkoutRevalidationEnabled = flagRows?.[0]?.value === 'true' || flagRows?.[0]?.value === '1';
    } catch { checkoutRevalidationEnabled = false; }

    if (checkoutRevalidationEnabled) {
      const reval = evaluateCheckoutCart(
        items.map(i => ({ productId: i.productId, sku: i.sku, qty: i.qty, rows: rowsByProduct.get(i.productId) ?? [] })),
        { enabled: true, staleThresholdMs: STALE_THRESHOLD_HOURS * 3600_000, nowMs: Date.now() },
      );
      for (const f of reval.failures) {
        if (inventoryFailures.some(x => x.productId === f.productId)) continue; // already blocked above
        inventoryFailures.push({ productId: f.productId, sku: f.sku, reason: f.reason });
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
      // Capability flag: old clients omit it → legacy shipping. preferredMethod: without it the
      // planner defaults to "pickup whenever eligible", so a customer in the radius who chose
      // Delivery got planned as Pickup ($0 shipping, warehouse-sourced tax) while the order still
      // said fulfillment_method='delivery'.
      body: { items: planItems, address: planAddress, clientSupportsDynamicDelivery, preferredMethod: fulfillmentMethod },
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

    // ── Pay-After-Pickup branch ($0 today, save card, capture after pickup) ──────
    // Enters ONLY for pickup + declared capability + a real pickup plan. Everything below
    // this block (Delivery fee, tax, automatic-capture PaymentIntent) is untouched: Delivery
    // and pickup-without-capability fall straight through. No charge is created here.
    if (shouldUsePayAfterPickup(fulfillmentMethod, clientSupportsPayAfterPickup, planData.usePickup === true)) {
      const puOrderId    = crypto.randomUUID();
      const puGuestToken = userId ? null : (providedGuestToken ?? crypto.randomUUID());
      const puNow        = new Date().toISOString();
      const puDeadline   = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // pickup_hold: 24h
      const puOrderNumber = `ORD-${puOrderId.slice(0, 8).toUpperCase()}`;
      const puOrderDate   = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      // Provisional amount: subtotal only. Shipping is $0 for pickup and final tax is re-confirmed
      // at BOL-ready (authorization step), where the amount actually charged is computed. Nothing
      // is charged now, so this figure never bills the customer.
      const puTotalCents = subtotalCents;

      let stripeCustomerId: string;
      try {
        stripeCustomerId = await getOrCreateStripeCustomer(supabase, { userId: userId ?? null, email: customer.email ?? null });
      } catch (e) {
        console.error('[create-checkout-order] pickup customer setup failed:', e instanceof Error ? e.message : e);
        return jsonResponse({ error: 'pickup_setup_failed' }, 502);
      }

      // Insert the order FIRST (pending_pickup, NOT paid) so a SetupIntent always has a home.
      const { error: puOrderErr } = await supabase.from('orders').insert({
        order_id:           puOrderId,
        order_number:       puOrderNumber,
        user_id:            userId ?? null,
        guest_token:        puGuestToken,
        customer_email:     customer.email ?? null,
        customer_phone:     customer.phone ?? null,
        status:             'pending_pickup',
        payment_status:     'pending',            // 🔒 NOT paid — $0 collected; card only saved after SetupIntent succeeds
        fulfillment_method: 'pickup',
        fulfillment_plan:   planData,
        pickup_stage:       'AWAITING_SUPPLIER_ORDER',
        stripe_customer_id: stripeCustomerId,
        subtotal_cents:     subtotalCents,
        shipping_cents:     0,
        tax_cents:          0,                     // re-confirmed at authorization (BOL ready)
        total_cents:        puTotalCents,
        total:              puTotalCents / 100,
        subtotal:           subtotalCents / 100,
        shipping_total:     0,
        tax:                0,
        date:               puOrderDate,
        address_json:       address,
        items_json:         items.map(i => ({ sku: i.sku, name: i.title, img: imgByProductId.get(i.productId) ?? '', price: i.unitPriceCents / 100, qty: i.qty })),
        fulfillment_groups_json: [],
        created_at:         puNow,
        updated_at:         puNow,
      });
      if (puOrderErr) {
        console.error('[create-checkout-order] pickup order insert failed:', puOrderErr.message);
        return jsonResponse({ error: 'Failed to create order record' }, 500);
      }

      await supabase.from('order_items').insert(items.map(i => ({
        order_id: puOrderId, product_id: i.productId, supplier_sku: i.sku, title: i.title,
        quantity: i.qty, unit_price_cents: i.unitPriceCents, total_cents: i.qty * i.unitPriceCents, created_at: puNow,
      })));

      // pickup_hold reservation: held past the 10-min payment sweep (which only touches
      // reservation_policy='payment_10min'); a supplier order later takes over, else the 24h
      // deadline releases it. expires_at is NOT NULL, so it mirrors the deadline.
      const puWhCode = planData.selectedWarehouse?.code ?? 'UNKNOWN';
      await supabase.from('inventory_reservations').insert(items.map(i => ({
        order_id: puOrderId, product_id: i.productId, supplier_sku: i.sku,
        warehouse_code: warehouseMap.get(i.productId) ?? puWhCode, quantity: i.qty,
        status: 'reserved', reservation_policy: 'pickup_hold',
        expires_at: puDeadline, pickup_release_deadline: puDeadline,
        created_at: puNow, updated_at: puNow,
      })));

      // SetupIntent — $0 today. Idempotency-Key keeps a retry from creating a second one.
      const siRes = await fetch(`${STRIPE_API_BASE}/v1/setup_intents`, {
        method: 'POST',
        headers: {
          'Authorization':  `Bearer ${STRIPE_SECRET_KEY}`,
          'Content-Type':   'application/x-www-form-urlencoded',
          'Stripe-Version': '2024-06-20',
          'Idempotency-Key': `${puOrderId}:setup`,
        },
        body: buildSetupIntentParams(puOrderId, stripeCustomerId).toString(),
      });
      const siJson = await siRes.json() as Record<string, unknown>;
      if (!siRes.ok) {
        console.error('[create-checkout-order] SetupIntent create failed:', (siJson?.error as Record<string, unknown>)?.message ?? siRes.status);
        await supabase.from('orders').update({ status: 'abandoned', updated_at: new Date().toISOString() }).eq('order_id', puOrderId);
        await supabase.from('inventory_reservations').update({ status: 'released', updated_at: new Date().toISOString() }).eq('order_id', puOrderId).eq('status', 'reserved');
        return jsonResponse({ error: 'pickup_setup_failed' }, 502);
      }

      await supabase.from('orders').update({ setup_intent_id: siJson.id as string, updated_at: new Date().toISOString() }).eq('order_id', puOrderId);

      await emitMetaInitiateCheckout({
        dedupKey: String(body.checkoutSessionId ?? puOrderId),
        email: customer.email, phone: customer.phone,
        totalCents: puTotalCents,
        items: items.map(i => ({ sku: i.sku, qty: i.qty, unitPriceCents: i.unitPriceCents })),
      });
      // mode='setup' tells the client to confirm a SetupIntent (save card), NOT pay.
      return jsonResponse({
        mode:            'setup',
        orderId:         puOrderId,
        orderNumber:     puOrderNumber,
        guestToken:      puGuestToken,
        setupClientSecret: siJson.client_secret as string,
        setupIntentId:   siJson.id as string,
        stripeCustomerId,
        isPickup:        true,
        subtotalCents,
      });
    }

    // Delivery fee is SERVER-AUTHORITATIVE from plan-fulfillment (GIGA product/price/v1).
    // 🔒 Pickup is always free ($0) — the `usePickup ? 0 :` form is required by the Pickup-lock guard.
    const pickupShippingCents = planData.usePickup ? 0 : null;
    let shippingCents: number;
    if (pickupShippingCents !== null) {
      shippingCents = pickupShippingCents;                       // Pickup → $0
    } else if (clientSupportsDynamicDelivery) {
      // NEW client: require the verified dynamic GIGA fee. No $99 fallback — fail closed.
      if (typeof planData.deliveryFeeCents === 'number' && planData.deliveryAvailable) {
        shippingCents = planData.deliveryFeeCents;
      } else {
        console.error('[create-checkout-order] New client + Delivery fee unavailable — blocking order (no fallback).');
        return jsonResponse({ error: 'delivery_fee_unavailable' }, 422);
      }
    } else {
      // 🔒 LEGACY compatibility — old shipped builds ONLY (they don't send clientSupportsDynamicDelivery).
      // Keep shipping numeric and NEVER 422 so old Delivery checkout keeps working until the new
      // app is rolled out. plan-fulfillment already returned a numeric legacy `shipping` here.
      const legacyDollars = typeof planData.shipping === 'number' ? planData.shipping : LEGACY_DELIVERY_FEE_DOLLARS;
      shippingCents = Math.round(legacyDollars * 100);
    }
    // ── Sales tax (Stripe Tax) ───────────────────────────────────────────────
    // Delivery is sourced to where the goods land; Pickup to the warehouse the customer collects
    // from — that is where possession transfers. Both are handed to Stripe as an address; rates,
    // registrations and shipping taxability live in the account's Tax settings, not here.
    const pickupWarehouse = planData.usePickup ? planData.selectedWarehouse : null;

    // The customer's own address ALWAYS goes to Stripe — including for Pickup. Stripe needs it for
    // reverse-charge determination, so swapping in the warehouse would be wrong.
    const taxAddress: TaxAddress = {
      line1:      address.line1,
      line2:      (address as { line2?: string }).line2 ?? null,
      city:       address.city,
      state:      address.state,
      postalCode: address.zip,
      country:    address.country ?? 'US',
    };

    // Pickup is an in-person sale: tax belongs at the warehouse where the customer collects. Stripe
    // expresses that with a `performance_location` on the line item, NOT by rewriting the customer
    // address (docs: Tax → in-person sales at a specific location). Null → normal destination
    // sourcing, which is the safe degradation.
    let performanceLocationId: string | null = null;
    if (pickupWarehouse) {
      performanceLocationId = await findOrCreatePerformanceLocation(STRIPE_SECRET_KEY, String(pickupWarehouse.code), {
        line1:      String(pickupWarehouse.address ?? ''),
        city:       String(pickupWarehouse.city ?? ''),
        state:      String(pickupWarehouse.state ?? ''),
        postalCode: extractUsZip(pickupWarehouse.address) ?? '',
        country:    'US',
      });
      if (!performanceLocationId) {
        console.error('[create-checkout-order] pickup performance location unavailable for', pickupWarehouse.code);
      }
    }

    let taxCents = 0;
    let taxCalculationId: string | null = null;
    // Old clients: no tax, no calculation, no Stripe call. Their Checkout shows $0 and that is
    // exactly what gets charged — displayed total and PaymentIntent stay equal.
    if (clientSupportsTax) try {
      const calc = await calculateTax(STRIPE_SECRET_KEY, {
        // Authoritative prices only — `items` was already reconciled against the catalogue above.
        lineItems: items.map((i) => ({ productId: i.productId, qty: i.qty, unitPriceCents: i.unitPriceCents })),
        shippingCents,
        address: taxAddress,
        performanceLocationId,
      });
      taxCents = calc.taxCents;
      taxCalculationId = calc.calculationId;
      // Logged so the calculation→transaction handoff is auditable: PaymentIntent metadata is
      // redacted for client-side reads, so this is the only place the id is observable.
      console.log(`[create-checkout-order] tax calc=${taxCalculationId} cents=${taxCents} pickup=${!!pickupWarehouse} perfLoc=${performanceLocationId ?? 'none'}`);
    } catch (taxErr) {
      // Fail closed. Charging an amount whose tax we could not verify is worse than not taking the
      // order — and silently falling back to 0 would under-collect where we ARE registered.
      console.error('[create-checkout-order] tax calculation failed:', (taxErr as Error).message);
      return jsonResponse({ error: 'tax_calculation_failed' }, 422);
    }

    const totalCents = subtotalCents + shippingCents + taxCents;

    if (totalCents < 50) {
      return jsonResponse({ error: 'Order total is below the minimum charge amount ($0.50)' }, 400);
    }

    // Affirm requires a minimum order of $50 USD. Reject before we create a
    // PaymentIntent so the client receives a typed error rather than a Stripe
    // confirm-time failure that's hard to diagnose.
    if (paymentMethodSelected === 'affirm' && totalCents < 5000) {
      return jsonResponse({ error: 'affirm_minimum_amount' }, 400);
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
          img:   imgByProductId.get(i.productId) ?? '',
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

      // Affirm requires a shipping block on the PaymentIntent for risk
      // underwriting. Prefer the explicit `customerName` the client now sends
      // (selectedAddress.first_name + last_name) so Affirm receives a real
      // human name. Fall back to deriving from customer.email only when no
      // name was provided.
      const trimmedCustomerName = (customerName ?? '').trim();
      const email = (customer.email ?? '').trim();
      const emailLocal = email.includes('@') ? email.slice(0, email.indexOf('@')) : email;
      const emailFallback = (emailLocal.replace(/[._+\-]+/g, ' ').trim() || email || 'Xself Home Customer');
      const shippingName = (trimmedCustomerName || emailFallback).slice(0, 200);

      stripeParams.append('shipping[name]',                shippingName);
      stripeParams.append('shipping[address][line1]',      String(address.line1));
      if ((address as { line2?: string }).line2) {
        stripeParams.append('shipping[address][line2]',    String((address as { line2?: string }).line2));
      }
      stripeParams.append('shipping[address][city]',       String(address.city));
      stripeParams.append('shipping[address][state]',      String(address.state));
      stripeParams.append('shipping[address][postal_code]', String(address.zip));
      stripeParams.append('shipping[address][country]',    String(address.country ?? 'US'));
    } else {
      stripeParams.append('automatic_payment_methods[enabled]', 'true');
    }

    stripeParams.append('metadata[order_id]',          orderId);
    stripeParams.append('metadata[fulfillment_method]', fulfillmentMethod);
    if (guestToken) stripeParams.append('metadata[guest_token]', guestToken);
    // Carries the tax quote to the webhook, which turns it into a filed Tax Transaction once the
    // payment succeeds. Metadata rather than a new orders column: the value is only ever needed
    // between these two hops, and it keeps the tax wiring out of the order schema.
    if (taxCalculationId) stripeParams.append('metadata[tax_calculation_id]', taxCalculationId);
    if (customer.email) stripeParams.append('receipt_email', customer.email);

    const keyMode = STRIPE_SECRET_KEY.startsWith('sk_live') ? 'LIVE' : 'test';
    console.log('[create-checkout-order] Creating Stripe PI — mode:', keyMode, '| amount:', totalCents, '| order:', orderId);

    const stripeRes = await fetch(`${STRIPE_API_BASE}/v1/payment_intents`, {
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

    await emitMetaInitiateCheckout({
      dedupKey: String(body.checkoutSessionId ?? orderId),
      email: customer.email, phone: customer.phone,
      totalCents,
      items: items.map(i => ({ sku: i.sku, qty: i.qty, unitPriceCents: i.unitPriceCents })),
    });

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
      // Returned so the tax quote behind this charge is auditable end-to-end. PaymentIntent
      // metadata is redacted for client-side reads, so this is the only externally observable
      // handle on the calculation the webhook later files as a Tax Transaction.
      taxCalculationId,
      isPickup: planData.usePickup ?? false,
      fulfillmentPlan: planData,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[create-checkout-order] Unexpected error:', msg);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
