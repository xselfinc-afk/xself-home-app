/**
 * pickup-supplier-order-create (XOne Ops write API).
 *
 * Ops endpoint (X-Pickup-Token). Records a supplier order against a shared pickup order and advances
 * pickup_stage. Inserting the supplier_orders row fires the DB trigger that releases the
 * pickup_hold inventory reservation (the supplier order now owns the inventory fact).
 * Idempotent per (order_id, supplier_order_ref). Pickup orders only. Writes to shared backend only.
 *
 * Body (JSON): { orderId, supplierName?, supplierOrderRef }
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

  let body: { orderId?: string; supplierName?: string; supplierOrderRef?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid_request' }, 400); }
  const orderId = (body.orderId ?? '').trim();
  const supplierOrderRef = (body.supplierOrderRef ?? '').trim();
  if (!orderId || !supplierOrderRef) return json({ error: 'orderId_and_supplierOrderRef_required' }, 400);

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: orders } = await db.from('orders').select('order_id, fulfillment_method, pickup_stage').eq('order_id', orderId).limit(1);
  const order = orders?.[0];
  if (!order) return json({ error: 'order_not_found' }, 404);
  if (order.fulfillment_method !== 'pickup') return json({ error: 'not_pickup_order' }, 422);

  // Idempotent: same (order, ref) is a no-op.
  const { data: existing } = await db.from('supplier_orders').select('id').eq('order_id', orderId).eq('supplier_order_ref', supplierOrderRef).limit(1);
  if (existing?.length) return json({ ok: true, action: 'already_recorded', id: existing[0].id });

  const { data: row, error } = await db.from('supplier_orders')
    .insert({ order_id: orderId, supplier_name: body.supplierName ?? 'GIGA', supplier_order_ref: supplierOrderRef })
    .select('id').single();  // trigger releases the pickup_hold reservation here
  if (error) { console.error('[pickup-supplier-order-create]', error.message); return json({ error: 'insert_failed' }, 500); }

  // Advance stage from AWAITING_SUPPLIER_ORDER (only forward; never regress a later stage).
  await db.from('orders').update({ pickup_stage: 'BOL_READY', updated_at: new Date().toISOString() })
    .eq('order_id', orderId).eq('pickup_stage', 'AWAITING_SUPPLIER_ORDER');
  await db.from('pickup_audit_events').insert({ order_id: orderId, event_type: 'SUPPLIER_ORDER_RECORDED', payload: { supplierOrderRef, supplierName: body.supplierName ?? 'GIGA' } });

  return json({ ok: true, action: 'recorded', id: row.id });
});
