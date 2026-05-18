/**
 * get-active-quote — authenticated lookup for a customer's active quote on
 * a given product.
 *
 * Auth: `Authorization: Bearer <user-jwt>` header (Supabase auth session).
 *       Anonymous / guest callers receive 401 — MVP requires sign-in.
 *
 * Body:
 *   { product_id: string }      // supplier_product_id
 *
 * Returns:
 *   { quote: <row> | null }     // newest active, non-expired quote whose
 *                               // customer_email matches the JWT's email,
 *                               // or null when nothing applies.
 *
 * The redeem_token is included in the response so the client can pass it
 * back to create-checkout-order on Buy Now. The token is only ever returned
 * to the authenticated owner of the email — RLS would also catch a mismatch.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')         ?? '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface RequestBody { product_id: string }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST')    return jsonResponse({ error: 'Method not allowed' }, 405);

  // ── Resolve caller identity from Bearer JWT ─────────────────────────────
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) {
    return jsonResponse({ error: 'authorization bearer token required' }, 401);
  }

  // Use anon client to resolve the user; falls back to service role on error.
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return jsonResponse({ error: 'invalid auth token' }, 401);
  }
  const email = (userData.user.email ?? '').trim();
  if (!email) {
    return jsonResponse({ error: 'user has no email — sign in with an email to receive a quote' }, 403);
  }

  // ── Parse body ──────────────────────────────────────────────────────────
  let body: RequestBody;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  if (!body.product_id || typeof body.product_id !== 'string') {
    return jsonResponse({ error: 'product_id required (string)' }, 400);
  }

  // ── Lookup the newest active, non-expired quote ─────────────────────────
  // Service-role bypasses RLS so we can also stamp user_id back-fill if we
  // ever want it. customer_email is citext so the comparison is
  // case-insensitive at the column level.
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase
    .from('support_quotes')
    .select('id, redeem_token, product_id, supplier_sku, quoted_price_cents, original_price_cents, max_qty, currency, expires_at, status')
    .eq('product_id', body.product_id)
    .eq('customer_email', email)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[get-active-quote] query failed:', error.message);
    return jsonResponse({ error: 'lookup failed' }, 500);
  }

  return jsonResponse({ quote: data ?? null });
});
