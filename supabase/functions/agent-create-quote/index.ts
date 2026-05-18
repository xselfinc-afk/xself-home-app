/**
 * agent-create-quote — support-agent entry point for custom quotes.
 *
 * Auth: shared secret in `X-Agent-Token` header. Set via:
 *   npx supabase secrets set AGENT_ADMIN_TOKEN=<long-random-string>
 *
 * Request body:
 *   {
 *     product_id:           string,           // supplier_product_id
 *     supplier_sku:         string,
 *     customer_email:       string,
 *     quoted_price_cents:   number,           // integer, $50 floor, ≥ 50% of original
 *     agent_name:           string,
 *     expires_in_hours?:    number,           // default 168 (7 days), max 720 (30 days)
 *     max_qty?:             number,           // default 1, max 10
 *     crisp_session_id?:    string            // optional; if present we post a system msg
 *   }
 *
 * Server-side guardrails:
 *   - Looks up original price from standardized_products (selling_price ?? price).
 *   - quoted_price_cents must be >= 5000 ($50 floor).
 *   - quoted_price_cents must be >= 50% of original_price_cents.
 *   - quoted_price_cents must be <= original_price_cents.
 *
 * On success, posts a customer-facing Crisp message (token NEVER included)
 * and returns { id, redeem_token, expires_at, status, original_price_cents }.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const AGENT_TOKEN              = (Deno.env.get('AGENT_ADMIN_TOKEN')        ?? '').trim();
const SUPABASE_URL             = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Crisp credentials — same secrets the support-chat function uses. Optional
// for this function: we only post a Crisp message when crisp_session_id is
// provided in the request body.
const CRISP_WEBSITE_ID = (Deno.env.get('CRISP_WEBSITE_ID') ?? '').trim();
const CRISP_IDENTIFIER = (Deno.env.get('CRISP_IDENTIFIER') ?? '').trim();
const CRISP_KEY        = (Deno.env.get('CRISP_KEY')        ?? '').trim();
const CRISP_TIER       = ((Deno.env.get('CRISP_TOKEN_TIER') ?? 'website').trim() || 'website') as
  | 'website' | 'plugin' | 'user';

const MIN_PRICE_CENTS      = 5000;        // $50.00 floor — never sell below this.
const DEFAULT_EXPIRES_HRS  = 1;           // 1 hour — short urgency window.
const MAX_EXPIRES_HRS      = 24 * 30;     // 30 days.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-agent-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface CreateQuoteBody {
  product_id:         string;
  supplier_sku:       string;
  customer_email:     string;
  quoted_price_cents: number;
  agent_name:         string;
  expires_in_hours?:  number;
  max_qty?:           number;
  crisp_session_id?:  string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function randomRedeemToken(): string {
  // 32 hex chars from 16 random bytes — unguessable, URL-safe.
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}

function isValidEmail(s: string): boolean {
  // Conservative; full validation isn't needed — agent enters by hand.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function priceFmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function postCrispMessage(sessionId: string, text: string): Promise<void> {
  if (!CRISP_WEBSITE_ID || !CRISP_IDENTIFIER || !CRISP_KEY) {
    console.warn('[agent-create-quote] Crisp creds missing — skipping message post.');
    return;
  }
  try {
    const res = await fetch(
      `https://api.crisp.chat/v1/website/${CRISP_WEBSITE_ID}/conversation/${sessionId}/message`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${CRISP_IDENTIFIER}:${CRISP_KEY}`),
          'X-Crisp-Tier':  CRISP_TIER,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          type: 'text',
          from: 'operator',
          origin: 'chat',
          content: text,
        }),
      },
    );
    if (res.status >= 400) {
      const raw = await res.text();
      console.warn('[agent-create-quote] Crisp post failed:', res.status, raw.slice(0, 200));
    }
  } catch (err) {
    console.warn('[agent-create-quote] Crisp post error:', err instanceof Error ? err.message : err);
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST')    return jsonResponse({ error: 'Method not allowed' }, 405);

  if (!AGENT_TOKEN) {
    return jsonResponse({ error: 'Server: AGENT_ADMIN_TOKEN not configured' }, 500);
  }
  const supplied = req.headers.get('x-agent-token') ?? '';
  if (supplied !== AGENT_TOKEN) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  let body: CreateQuoteBody;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  // ── Input validation ────────────────────────────────────────────────────
  const {
    product_id, supplier_sku, customer_email,
    quoted_price_cents, agent_name,
    expires_in_hours, max_qty, crisp_session_id,
  } = body;

  if (!product_id   || typeof product_id   !== 'string') return jsonResponse({ error: 'product_id required (string)'   }, 400);
  if (!supplier_sku || typeof supplier_sku !== 'string') return jsonResponse({ error: 'supplier_sku required (string)' }, 400);
  if (!customer_email || typeof customer_email !== 'string' || !isValidEmail(customer_email)) {
    return jsonResponse({ error: 'customer_email required (valid email)' }, 400);
  }
  if (typeof quoted_price_cents !== 'number' || !Number.isInteger(quoted_price_cents) || quoted_price_cents < MIN_PRICE_CENTS) {
    return jsonResponse({ error: `quoted_price_cents must be an integer >= ${MIN_PRICE_CENTS} ($50.00)` }, 400);
  }
  if (!agent_name || typeof agent_name !== 'string' || agent_name.trim().length === 0) {
    return jsonResponse({ error: 'agent_name required' }, 400);
  }

  const hours = (typeof expires_in_hours === 'number' && Number.isInteger(expires_in_hours))
    ? expires_in_hours : DEFAULT_EXPIRES_HRS;
  if (hours < 1 || hours > MAX_EXPIRES_HRS) {
    return jsonResponse({ error: `expires_in_hours must be 1..${MAX_EXPIRES_HRS}` }, 400);
  }

  const qty = (typeof max_qty === 'number' && Number.isInteger(max_qty)) ? max_qty : 1;
  if (qty < 1 || qty > 10) return jsonResponse({ error: 'max_qty must be 1..10' }, 400);

  // ── Supabase client (service role) ──────────────────────────────────────
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // ── Lookup original price for the product ───────────────────────────────
  const { data: productRow, error: productErr } = await supabase
    .from('standardized_products')
    .select('supplier_product_id, sku_custom, price, selling_price, product_title')
    .eq('supplier_product_id', product_id)
    .maybeSingle();

  if (productErr) {
    console.error('[agent-create-quote] product lookup failed:', productErr.message);
    return jsonResponse({ error: 'product lookup failed' }, 500);
  }
  if (!productRow) return jsonResponse({ error: 'product_id not found' }, 404);

  const sellingDollars = productRow.selling_price != null && Number(productRow.selling_price) > 0
    ? Number(productRow.selling_price)
    : Number(productRow.price ?? 0);
  const original_price_cents = Math.round(sellingDollars * 100);
  if (original_price_cents <= 0) {
    return jsonResponse({ error: 'product has no positive price on file' }, 422);
  }

  // ── Server-side discount guardrails ─────────────────────────────────────
  // (Database CHECK constraints also enforce these; we surface the error
  // here with a useful message before the round-trip to PG.)
  if (quoted_price_cents > original_price_cents) {
    return jsonResponse({
      error: 'quoted_price_cents cannot exceed original price',
      original_price_cents,
    }, 400);
  }
  if (quoted_price_cents * 2 < original_price_cents) {
    return jsonResponse({
      error: 'quoted_price_cents must be at least 50% of original price',
      original_price_cents,
      minimum_allowed_cents: Math.ceil(original_price_cents / 2),
    }, 400);
  }

  // ── Insert quote ────────────────────────────────────────────────────────
  const redeem_token = randomRedeemToken();
  const expires_at   = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  const { data: insertRow, error: insertErr } = await supabase
    .from('support_quotes')
    .insert({
      redeem_token,
      product_id,
      supplier_sku,
      customer_email,
      quoted_price_cents,
      original_price_cents,
      max_qty:           qty,
      crisp_session_id:  crisp_session_id ?? null,
      created_by_agent:  agent_name.trim(),
      expires_at,
    })
    .select('id, redeem_token, expires_at, status')
    .single();

  if (insertErr) {
    console.error('[agent-create-quote] insert failed:', insertErr.message);
    return jsonResponse({ error: 'failed to create quote', details: insertErr.message }, 500);
  }

  // Customer-facing Crisp notification removed — the in-app Special Offer
  // card at the top of SupportScreen is now the sole customer signal that a
  // quote is live. `crisp_session_id` is still accepted and persisted to
  // `support_quotes.crisp_session_id` for audit, but no chat post fires.

  console.log(
    '[agent-create-quote] created:',
    insertRow.id,
    '| agent:', agent_name,
    '| email:', customer_email,
    '| price_cents:', quoted_price_cents,
    '| original_cents:', original_price_cents,
    '| expires:', expires_at,
  );

  return jsonResponse({
    id:                   insertRow.id,
    redeem_token:         insertRow.redeem_token,
    expires_at:           insertRow.expires_at,
    status:               insertRow.status,
    original_price_cents,
  }, 201);
});
