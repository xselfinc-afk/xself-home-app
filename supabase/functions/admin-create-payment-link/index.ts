/**
 * admin-create-payment-link — admin-only Stripe Payment Link generator for
 * negotiated pricing. Phase 5.2.
 *
 * Auth model: Supabase Auth JWT in `Authorization: Bearer <token>`. The
 * function verifies the JWT via supabase.auth.getUser, then checks the
 * caller's email is in public.admin_users (the same allowlist used by
 * /admin/orders.html in Phase 5.0). Non-admin → 403. Bad/missing JWT → 401.
 *
 * Body (POST JSON):
 *   {
 *     order_id?, order_number?,
 *     customer_email?, customer_phone?,
 *     product_id?, supplier_sku?,
 *     title?,                        // default "Xself Home Custom Order"
 *     quantity?,                     // default 1, must be positive integer
 *     negotiated_unit_price_cents,   // REQUIRED positive integer
 *     note?,
 *   }
 *
 * Server-side guardrails:
 *   - negotiated_unit_price_cents must be a positive integer.
 *   - quantity must be a positive integer.
 *   - quantity * unit_price must be ≥ 50 cents (Stripe's minimum charge).
 *   - currency is 'usd' (single-currency for now).
 *   - No catalog / standardized_products mutation. The Stripe Price is
 *     created fresh per link via inline product_data.
 *
 * On success returns:
 *   { ok: true, url, payment_link_id, price_id, amount_cents, quantity }
 *
 * On failure returns:
 *   { ok: false, error, detail }
 *
 * Secrets required (set via `supabase secrets set ...`):
 *   STRIPE_SECRET_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Strip any non-printable / non-ASCII bytes that would make the Stripe
// Authorization header fail the ByteString validity check.
const STRIPE_SECRET_KEY = (Deno.env.get('STRIPE_SECRET_KEY') ?? '')
  // eslint-disable-next-line no-control-regex
  .replace(/[^\x20-\x7E]/g, '')
  .trim();

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const STRIPE_MIN_TOTAL_CENTS = 50; // Stripe's minimum charge in USD cents.

interface ReqBody {
  order_id?:                   string | null;
  order_number?:               string | null;
  customer_email?:             string | null;
  customer_phone?:             string | null;
  product_id?:                 string | null;
  supplier_sku?:               string | null;
  title?:                      string | null;
  quantity?:                   number;
  negotiated_unit_price_cents: number;
  note?:                       string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function fail(error: string, detail: string, status: number): Response {
  return jsonResponse({ ok: false, error, detail }, status);
}

function isPositiveInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n > 0;
}

async function stripeForm(
  path: string,
  form: URLSearchParams,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const resp = await fetch(`https://api.stripe.com/v1${path}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  const json = await resp.json().catch(() => ({} as Record<string, unknown>));
  return { ok: resp.ok, status: resp.status, json: json as Record<string, unknown> };
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST')    return fail('method_not_allowed', 'Only POST is supported', 405);

  // ── Config sanity ─────────────────────────────────────────────────────────
  if (!STRIPE_SECRET_KEY || STRIPE_SECRET_KEY === 'sk_test_REPLACE_ME') {
    return fail('misconfigured', 'STRIPE_SECRET_KEY is missing on the server', 500);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return fail('misconfigured', 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing on the server', 500);
  }

  const keyMode = STRIPE_SECRET_KEY.startsWith('sk_live') ? 'LIVE' : 'test';
  console.log('[admin-create-payment-link] Stripe key mode:', keyMode);

  // ── 1. Auth: verify Bearer JWT ────────────────────────────────────────────
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) {
    return fail('unauthorized', 'Missing Authorization: Bearer <jwt>', 401);
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(jwt);
  if (userError || !userData?.user?.email) {
    return fail('unauthorized', 'Invalid or expired token', 401);
  }
  const adminEmail = userData.user.email;

  // ── 2. Admin allowlist ────────────────────────────────────────────────────
  const adminRow = await supabaseAdmin
    .from('admin_users')
    .select('email')
    .ilike('email', adminEmail)
    .maybeSingle();
  if (adminRow.error || !adminRow.data) {
    return fail('forbidden', 'Caller is not on the admin allowlist', 403);
  }

  // ── 3. Parse + validate input ─────────────────────────────────────────────
  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return fail('bad_request', 'Body must be valid JSON', 400);
  }

  const unitCents = Number(body.negotiated_unit_price_cents);
  if (!isPositiveInteger(unitCents)) {
    return fail('bad_request', 'negotiated_unit_price_cents must be a positive integer (cents)', 400);
  }

  const rawQty = body.quantity == null ? 1 : Number(body.quantity);
  const quantity = isPositiveInteger(rawQty) ? rawQty : 1;

  const totalCents = unitCents * quantity;
  if (totalCents < STRIPE_MIN_TOTAL_CENTS) {
    return fail(
      'bad_request',
      `Total ${totalCents}¢ is below Stripe's minimum charge (${STRIPE_MIN_TOTAL_CENTS}¢)`,
      400,
    );
  }

  const titleRaw = typeof body.title === 'string' ? body.title.trim() : '';
  const title = titleRaw.length > 0 ? titleRaw.slice(0, 250) : 'Xself Home Custom Order';

  // ── 4. Create Stripe Price (with inline product_data) ─────────────────────
  const priceForm = new URLSearchParams();
  priceForm.set('unit_amount', String(unitCents));
  priceForm.set('currency', 'usd');
  priceForm.set('product_data[name]', title);
  if (body.product_id) {
    priceForm.set('product_data[metadata][supplier_product_id]', String(body.product_id));
  }
  if (body.supplier_sku) {
    priceForm.set('product_data[metadata][supplier_sku]', String(body.supplier_sku));
  }
  priceForm.set('product_data[metadata][source]', 'admin_negotiated_price');

  const priceResp = await stripeForm('/prices', priceForm);
  if (!priceResp.ok) {
    const msg = (priceResp.json?.error as { message?: string } | undefined)?.message
      ?? `Stripe /prices returned ${priceResp.status}`;
    return fail('stripe_error', msg, 502);
  }
  const priceId   = priceResp.json.id as string;
  const productId = (priceResp.json.product as string | undefined) ?? null;

  // ── 5. Create Stripe Payment Link ─────────────────────────────────────────
  const linkForm = new URLSearchParams();
  linkForm.set('line_items[0][price]',    priceId);
  linkForm.set('line_items[0][quantity]', String(quantity));
  linkForm.set('metadata[source]',           'admin_negotiated_price');
  linkForm.set('metadata[created_by_email]', adminEmail);
  if (body.order_id)       linkForm.set('metadata[order_id]',       String(body.order_id));
  if (body.order_number)   linkForm.set('metadata[order_number]',   String(body.order_number));
  if (body.product_id)     linkForm.set('metadata[product_id]',     String(body.product_id));
  if (body.supplier_sku)   linkForm.set('metadata[supplier_sku]',   String(body.supplier_sku));
  if (body.customer_email) linkForm.set('metadata[customer_email]', String(body.customer_email));
  if (body.note)           linkForm.set('metadata[note]',           String(body.note).slice(0, 500));

  const linkResp = await stripeForm('/payment_links', linkForm);
  if (!linkResp.ok) {
    const msg = (linkResp.json?.error as { message?: string } | undefined)?.message
      ?? `Stripe /payment_links returned ${linkResp.status}`;
    return fail('stripe_error', msg, 502);
  }
  const linkId  = linkResp.json.id  as string;
  const linkUrl = linkResp.json.url as string;

  // ── 6. Persist record ─────────────────────────────────────────────────────
  const { error: insertErr } = await supabaseAdmin
    .from('admin_custom_payment_links')
    .insert({
      order_id:                    body.order_id ?? null,
      order_number:                body.order_number ?? null,
      customer_email:              body.customer_email ?? null,
      customer_phone:              body.customer_phone ?? null,
      product_id:                  body.product_id ?? null,
      supplier_sku:                body.supplier_sku ?? null,
      title,
      quantity,
      negotiated_unit_price_cents: unitCents,
      negotiated_total_cents:      totalCents,
      currency:                    'usd',
      stripe_payment_link_id:      linkId,
      stripe_price_id:             priceId,
      stripe_product_id:           productId,
      stripe_url:                  linkUrl,
      status:                      'created',
      created_by_email:            adminEmail,
    });

  if (insertErr) {
    // Stripe artifacts already exist; surface the persistence failure but
    // still return the URL so the admin can use it.
    console.error('[admin-create-payment-link] DB insert failed:', insertErr.message);
    return jsonResponse({
      ok:              true,
      url:             linkUrl,
      payment_link_id: linkId,
      price_id:        priceId,
      amount_cents:    totalCents,
      quantity,
      warning:         'Persistence failed: ' + insertErr.message,
    });
  }

  return jsonResponse({
    ok:              true,
    url:             linkUrl,
    payment_link_id: linkId,
    price_id:        priceId,
    amount_cents:    totalCents,
    quantity,
  });
});
