/**
 * pickup-orders-list (XOne Ops Console read API).
 *
 * Ops endpoint (X-Pickup-Token). Lists shared PICKUP orders with their pickup lifecycle state so
 * XOne renders an Action Center over the SINGLE shared `orders` authority — no local order source.
 * Read-only. Never touches Delivery orders.
 *
 * Body (JSON, all optional): { stage?, limit?, offset? }
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

  let body: { stage?: string; limit?: number; offset?: number };
  try { body = await req.json(); } catch { body = {}; }
  const limit = Math.min(Math.max(Number(body.limit ?? 50), 1), 200);
  const offset = Math.max(Number(body.offset ?? 0), 0);

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  let q = db.from('orders')
    .select('order_id, order_number, status, payment_status, pickup_stage, total_cents, customer_email, authorization_status, authorization_amount_cents, capture_before, pickup_confirmed_at, payment_due_at, payment_due_basis, created_at, updated_at')
    .eq('fulfillment_method', 'pickup')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (body.stage) q = q.eq('pickup_stage', body.stage);

  const { data, error } = await q;
  if (error) { console.error('[pickup-orders-list]', error.message); return json({ error: 'list_failed' }, 500); }
  return json({ ok: true, count: data?.length ?? 0, orders: data ?? [] });
});
