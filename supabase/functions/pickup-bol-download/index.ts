/**
 * pickup-bol-download (BOL storage closed loop — authorized read).
 *
 * Returns a short-lived signed URL for a BOL in the PRIVATE `pickup-documents` bucket. The bucket
 * is never public; access is authorized here:
 *   - OPS: X-Pickup-Token → any document.
 *   - CUSTOMER: proves order ownership via guest_token (guests) or a Supabase user JWT whose
 *     user_id matches the order. Customers may fetch the ORIGINAL_BOL only AFTER it is released.
 *
 * Body (JSON): { orderId, documentId?, documentType?, guestToken? }  (Authorization: Bearer <jwt> optional)
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const PICKUP_ADMIN_TOKEN = Deno.env.get('PICKUP_ADMIN_TOKEN') ?? '';
const BUCKET = 'pickup-documents';
const SIGNED_TTL_SECONDS = 300;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-pickup-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } }); }

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: { orderId?: string; documentId?: string; documentType?: string; guestToken?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid_request' }, 400); }
  const orderId = (body.orderId ?? '').trim();
  if (!orderId) return json({ error: 'orderId_required' }, 400);

  const isOps = Boolean(PICKUP_ADMIN_TOKEN) && req.headers.get('x-pickup-token') === PICKUP_ADMIN_TOKEN;
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: orders } = await db.from('orders').select('order_id, user_id, guest_token, fulfillment_method').eq('order_id', orderId).limit(1);
  const order = orders?.[0];
  if (!order) return json({ error: 'order_not_found' }, 404);

  // ── Authorize the caller ─────────────────────────────────────────────────────
  let isCustomer = false;
  if (!isOps) {
    const authHeader = req.headers.get('authorization') ?? '';
    const jwt = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    if (jwt && jwt !== SUPABASE_ANON_KEY && order.user_id) {
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
      const { data: u } = await userClient.auth.getUser(jwt);
      if (u?.user?.id && u.user.id === order.user_id) isCustomer = true;
    }
    if (!isCustomer && body.guestToken && order.guest_token && body.guestToken === order.guest_token) isCustomer = true;
    if (!isCustomer) return json({ error: 'unauthorized' }, 401);
  }

  // ── Pick the document ────────────────────────────────────────────────────────
  let q = db.from('pickup_documents').select('id, document_type, storage_path, file_name, content_sha256, released_at, superseded_at')
    .eq('order_id', orderId).is('superseded_at', null);
  if (body.documentId) q = q.eq('id', body.documentId);
  else if (body.documentType) q = q.eq('document_type', body.documentType);
  const { data: docs } = await q.order('uploaded_at', { ascending: false }).limit(1);
  const doc = docs?.[0];
  if (!doc) return json({ error: 'document_not_found' }, 404);

  // Customers may only fetch a released Original BOL. Signed BOL is ops-only.
  if (isCustomer) {
    if (doc.document_type === 'SIGNED_BOL') return json({ error: 'forbidden' }, 403);
    if (doc.document_type === 'ORIGINAL_BOL' && !doc.released_at) return json({ error: 'bol_not_released' }, 403);
  }

  const { data: signed, error: signErr } = await db.storage.from(BUCKET).createSignedUrl(doc.storage_path, SIGNED_TTL_SECONDS);
  if (signErr || !signed?.signedUrl) { console.error('[pickup-bol-download] sign failed:', signErr?.message); return json({ error: 'sign_failed' }, 500); }

  return json({ ok: true, documentType: doc.document_type, fileName: doc.file_name, sha256: doc.content_sha256, url: signed.signedUrl, expiresInSeconds: SIGNED_TTL_SECONDS });
});
