/**
 * ops-orders-list — XOne「交易履约」read API over the shared `orders` authority.
 *
 * Sibling of `pickup-orders-list`, same ops-token auth, wider scope: every
 * ecommerce order (App / Web / Meta, delivery and pickup) projected into the
 * fields an operations console actually needs.
 *
 * ── The security boundary is this function ──────────────────────────────────
 * The service-role key lives here, in Deno, on Supabase's side of the wire.
 * It is never handed to XOne, never shipped in the desktop bundle, never
 * written to localStorage. The caller holds only `PICKUP_ADMIN_TOKEN` — the
 * same ops secret its sibling already uses — which grants exactly one
 * capability: read this projection. There is no write path in this file at
 * all: not an update, not an insert, not a delete.
 *
 * ── Read-only, and a projection, not a copy ─────────────────────────────────
 * `orders` stays the single authority for ecommerce order state. XOne renders
 * what it reads here and keeps only its own workflow metadata (route order,
 * notes) keyed by `order_id`. That is why the select list is explicit and
 * short: an ops console does not need Stripe intent ids, guest tokens or
 * saved-payment-method timestamps, so they are not sent.
 *
 * Body (JSON, all optional):
 *   { source?, fulfillmentMethod?, status?, since?, limit?, offset? }
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
/**
 * The same ops secret `pickup-orders-list` already uses.
 *
 * Deliberately NOT a second credential: one more token to provision, rotate and
 * leak is a real cost, and this endpoint has exactly the same trust level as
 * its sibling — read-only, ops-console-only, over the same table.
 */
const OPS_TOKEN = Deno.env.get('PICKUP_ADMIN_TOKEN') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-pickup-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** Operational fields only. Anything not on this list never leaves the database. */
const ORDER_COLUMNS_BASE = [
  'order_id',
  'order_number',
  'status',
  'payment_status',
  'fulfillment_method',
  'pickup_stage',
  'user_id',
  'customer_email',
  'customer_phone',
  'subtotal_cents',
  'shipping_cents',
  'tax_cents',
  'total_cents',
  'address_json',
  'items_json',
  'authorization_status',
  'authorization_amount_cents',
  'capture_before',
  'pickup_confirmed_at',
  'payment_due_at',
  'payment_due_basis',
  'created_at',
  'updated_at',
];

/**
 * `source` is selected separately because the column may not exist yet.
 *
 * The attribution migration is additive and deploys on its own schedule; this
 * function must work on both sides of it. Selecting a column Postgres does not
 * have is a hard 42703 error that would take the whole console down, so the
 * query is tried with `source` and retried without it. Orders read from a
 * pre-migration database come back with `source: null`, which the console
 * renders as LEGACY — the honest answer, and the same answer every historical
 * order gets anyway.
 */
const ORDER_COLUMNS = [...ORDER_COLUMNS_BASE, 'source'].join(', ');
const ORDER_COLUMNS_WITHOUT_SOURCE = ORDER_COLUMNS_BASE.join(', ');

const MAX_LIMIT = 500;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  /*
   * Fail closed on a missing secret.
   *
   * If `OPS_TOKEN` were empty and we compared it to an empty header, an
   * unconfigured deployment would answer every anonymous caller with the whole
   * order book. The `!OPS_TOKEN` check is the part that matters.
   */
  const presented = req.headers.get('x-pickup-token') ?? '';
  if (!OPS_TOKEN || presented !== OPS_TOKEN) return json({ error: 'unauthorized' }, 401);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'not_configured' }, 500);

  let body: {
    source?: string;
    fulfillmentMethod?: string;
    status?: string;
    since?: string;
    limit?: number;
    offset?: number;
  };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const limit = Math.min(Math.max(Number(body.limit ?? 200), 1), MAX_LIMIT);
  const offset = Math.max(Number(body.offset ?? 0), 0);

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const runOrdersQuery = async (columns: string, withSourceFilter: boolean) => {
    let query = db
      .from('orders')
      .select(columns)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (withSourceFilter && body.source) query = query.eq('source', String(body.source));
    if (body.fulfillmentMethod) query = query.eq('fulfillment_method', String(body.fulfillmentMethod));
    if (body.status) query = query.eq('status', String(body.status));
    if (body.since) query = query.gte('created_at', String(body.since));
    return await query;
  };

  let attributionAvailable = true;
  let { data: orders, error } = await runOrdersQuery(ORDER_COLUMNS, true);
  if (error && /column .*source.* does not exist|42703/i.test(`${error.message} ${error.code ?? ''}`)) {
    // Pre-migration database. Read everything else and report the gap honestly
    // rather than showing an empty console.
    attributionAvailable = false;
    ({ data: orders, error } = await runOrdersQuery(ORDER_COLUMNS_WITHOUT_SOURCE, false));
  }
  if (error) {
    console.error('[ops-orders-list] orders read failed:', error.message);
    return json({ error: 'list_failed' }, 500);
  }

  /*
   * Line items come from `order_items`, not from `items_json`.
   *
   * Both exist. `items_json` is the snapshot written at checkout and is what
   * the customer's own order view renders; `order_items` is the normalized
   * table with per-line SKU, quantity and cents. A picking sheet needs the
   * latter. `items_json` still travels with the order so the console can fall
   * back to it (and show the product image) when a legacy order predates the
   * normalized rows.
   */
  const orderIds = (orders ?? []).map((row) => (row as { order_id: string }).order_id);
  let itemsByOrder: Record<string, unknown[]> = {};
  if (orderIds.length > 0) {
    const { data: items, error: itemsError } = await db
      .from('order_items')
      .select('order_id, product_id, supplier_sku, title, quantity, unit_price_cents, total_cents')
      .in('order_id', orderIds);
    if (itemsError) {
      // Fail closed: half an order is worse than no order. A picking sheet
      // built from a partial line list sends the driver out short.
      console.error('[ops-orders-list] order_items read failed:', itemsError.message);
      return json({ error: 'list_failed' }, 500);
    }
    itemsByOrder = (items ?? []).reduce<Record<string, unknown[]>>((acc, item) => {
      const key = (item as { order_id: string }).order_id;
      (acc[key] ??= []).push(item);
      return acc;
    }, {});
  }

  const projected = (orders ?? []).map((row) => {
    const order = row as Record<string, unknown> & { order_id: string };
    return {
      ...order,
      // Absent column and absent value mean the same thing to the console:
      // origin unknown, do not guess.
      source: attributionAvailable ? (order.source ?? null) : null,
      items: itemsByOrder[order.order_id] ?? [],
    };
  });

  return json({
    ok: true,
    count: projected.length,
    /** false = the attribution migration has not been applied yet. */
    attributionAvailable,
    orders: projected,
  });
});
