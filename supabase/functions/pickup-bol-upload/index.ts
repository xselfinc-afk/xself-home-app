/**
 * pickup-bol-upload (BOL storage closed loop — ops side).
 *
 * Ops/system endpoint (X-Pickup-Token). Uploads an Original or Signed BOL for a pickup order into
 * the PRIVATE `pickup-documents` bucket, computes a server-side sha256 (tamper evidence), and
 * records it in public.pickup_documents. The shared backend is the sole BOL authority.
 *
 * Body (JSON): { orderId, documentType: 'ORIGINAL_BOL'|'SIGNED_BOL', fileName, contentBase64, contentType? }
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PICKUP_ADMIN_TOKEN = Deno.env.get('PICKUP_ADMIN_TOKEN') ?? '';
const BUCKET = 'pickup-documents';
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-pickup-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } }); }

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a standalone ArrayBuffer so the type is BufferSource<ArrayBuffer> (Deno strict).
  const buf = bytes.slice().buffer;
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^;]+;base64,/, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!PICKUP_ADMIN_TOKEN || req.headers.get('x-pickup-token') !== PICKUP_ADMIN_TOKEN) return json({ error: 'unauthorized' }, 401);

  let body: { orderId?: string; documentType?: string; fileName?: string; contentBase64?: string; contentType?: string; uploadedBy?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid_request' }, 400); }
  const orderId = (body.orderId ?? '').trim();
  const documentType = body.documentType ?? '';
  const fileName = (body.fileName ?? '').trim();
  if (!orderId || !fileName) return json({ error: 'orderId_and_fileName_required' }, 400);
  if (documentType !== 'ORIGINAL_BOL' && documentType !== 'SIGNED_BOL') return json({ error: 'invalid_document_type' }, 400);
  if (!body.contentBase64) return json({ error: 'contentBase64_required' }, 400);

  const bytes = b64ToBytes(body.contentBase64);
  if (bytes.length === 0) return json({ error: 'empty_file' }, 400);
  if (bytes.length > MAX_BYTES) return json({ error: 'file_too_large' }, 413);

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Order must exist and be a pickup order.
  const { data: orders } = await db.from('orders').select('order_id, fulfillment_method').eq('order_id', orderId).limit(1);
  if (!orders?.length) return json({ error: 'order_not_found' }, 404);
  if (orders[0].fulfillment_method !== 'pickup') return json({ error: 'not_pickup_order' }, 422);

  const sha = await sha256Hex(bytes);
  const contentType = body.contentType || 'application/pdf';
  const storagePath = `${orderId}/${documentType}/${Date.now()}_${fileName}`.replace(/[^A-Za-z0-9._/-]/g, '_');

  const { error: upErr } = await db.storage.from(BUCKET).upload(storagePath, bytes, { contentType, upsert: false });
  if (upErr) { console.error('[pickup-bol-upload] storage upload failed:', upErr.message); return json({ error: 'upload_failed' }, 500); }

  // Supersede any prior non-superseded doc of the same type (keeps one current per type).
  await db.from('pickup_documents').update({ superseded_at: new Date().toISOString() })
    .eq('order_id', orderId).eq('document_type', documentType).is('superseded_at', null);

  const { data: row, error: insErr } = await db.from('pickup_documents').insert({
    order_id: orderId, document_type: documentType, file_name: fileName, storage_path: storagePath,
    content_sha256: sha, file_size_bytes: bytes.length, content_type: contentType,
    uploaded_by: body.uploadedBy ?? 'ops',
  }).select('id').single();
  if (insErr) { console.error('[pickup-bol-upload] row insert failed:', insErr.message); return json({ error: 'record_failed' }, 500); }

  await db.from('pickup_audit_events').insert({ order_id: orderId, event_type: 'BOL_UPLOADED', actor: body.uploadedBy ?? 'ops', payload: { documentType, sha256: sha, bytes: bytes.length } });
  return json({ ok: true, id: row.id, documentType, sha256: sha, bytes: bytes.length, storagePath });
});
