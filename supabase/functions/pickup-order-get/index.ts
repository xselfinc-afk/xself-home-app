/**
 * pickup-order-get (XOne Ops Console order-detail read API).
 *
 * Ops endpoint (X-Pickup-Token). Returns one shared pickup order with its full pickup context —
 * supplier order, BOL documents, authorizations, open issues, audit trail — assembled from the
 * shared backend (the single order authority). Read-only. Pickup orders only.
 *
 * Body (JSON): { orderId }
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PICKUP_ADMIN_TOKEN = Deno.env.get('PICKUP_ADMIN_TOKEN') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-pickup-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } }); }

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!PICKUP_ADMIN_TOKEN || req.headers.get('x-pickup-token') !== PICKUP_ADMIN_TOKEN) return json({ error: 'unauthorized' }, 401);

  let body: { orderId?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid_request' }, 400); }
  const orderId = (body.orderId ?? '').trim();
  if (!orderId) return json({ error: 'orderId_required' }, 400);

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: orders } = await db.from('orders').select('*').eq('order_id', orderId).eq('fulfillment_method', 'pickup').limit(1);
  const order = orders?.[0];
  if (!order) return json({ error: 'pickup_order_not_found' }, 404);

  const [items, supplier, documents, authorizations, issues, audit] = await Promise.all([
    db.from('order_items').select('product_id, supplier_sku, title, quantity, unit_price_cents, total_cents').eq('order_id', orderId),
    db.from('supplier_orders').select('*').eq('order_id', orderId).order('created_at', { ascending: false }),
    db.from('pickup_documents').select('id, document_type, file_name, content_sha256, released_at, superseded_at, uploaded_at').eq('order_id', orderId).order('uploaded_at', { ascending: false }),
    db.from('pickup_payment_authorizations').select('id, provider_payment_intent_id, status, amount_cents, capture_before, created_at').eq('order_id', orderId).order('created_at', { ascending: false }),
    db.from('pickup_issues').select('id, kind, detail, status, created_at, resolved_at').eq('order_id', orderId).order('created_at', { ascending: false }),
    db.from('pickup_audit_events').select('event_type, actor, payload, created_at').eq('order_id', orderId).order('created_at', { ascending: false }).limit(100),
  ]);

  return json({
    ok: true,
    order,
    items: items.data ?? [],
    supplierOrders: supplier.data ?? [],
    documents: documents.data ?? [],
    authorizations: authorizations.data ?? [],
    issues: issues.data ?? [],
    audit: audit.data ?? [],
  });
});
