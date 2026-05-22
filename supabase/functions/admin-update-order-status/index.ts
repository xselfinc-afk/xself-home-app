/**
 * admin-update-order-status — server-enforced order status state machine.
 *
 * Auth model (same as admin-create-payment-link):
 *   1. Supabase Auth JWT in `Authorization: Bearer <token>`.
 *   2. Reject service_role JWTs — only end-user admins are accepted.
 *   3. Verify the JWT via supabase.auth.getUser.
 *   4. Confirm the user's email is in public.admin_users.
 *
 * State machine (server-enforced, never trusts client choices):
 *
 *   DELIVERY:
 *     paid → processing → scheduled_delivery → delivered
 *
 *   PICKUP:
 *     paid → pending_pickup → ready_for_pickup → picked_up
 *
 *   CANCEL (any non-final state → cancelled; requires non-empty reason)
 *
 *   FINAL: delivered | picked_up | cancelled — no further transitions
 *
 * Body (POST JSON):
 *   {
 *     "order_id":  string,           // required — public.orders.order_id
 *     "to_status": string,           // required — the desired next status
 *     "reason":    string (optional, REQUIRED iff to_status === "cancelled")
 *   }
 *
 * On success:
 *   {
 *     ok: true,
 *     order_id, from_status, to_status,
 *     event: { id, created_at } | null   // null if audit insert failed
 *   }
 *
 * On failure:
 *   { ok: false, error, detail }
 *
 * Side effects:
 *   1. UPDATE public.orders SET status = to_status, updated_at = now()
 *      WHERE order_id = order_id;
 *   2. INSERT INTO public.order_status_events (audit row)
 *
 * Secrets required (set via `supabase secrets set ...`):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ── State machine ────────────────────────────────────────────────────────────
// Keys = current status; values = the single status the caller may advance INTO
// from the key. Cancellation is added programmatically below (allowed from any
// non-final state).
const DELIVERY_NEXT: Record<string, string> = {
  paid:                'processing',
  processing:          'scheduled_delivery',
  scheduled_delivery:  'delivered',
};
const PICKUP_NEXT: Record<string, string> = {
  paid:               'pending_pickup',
  pending_pickup:     'ready_for_pickup',
  ready_for_pickup:   'picked_up',
};
const FINAL_STATES = new Set(['delivered', 'picked_up', 'cancelled']);

function allowedNextStates(method: string | null, currentStatus: string): string[] {
  const fm  = (method ?? '').toLowerCase();
  const cur = (currentStatus ?? '').toLowerCase();
  if (FINAL_STATES.has(cur)) return [];
  const path = fm === 'pickup' ? PICKUP_NEXT : DELIVERY_NEXT;
  const next = path[cur];
  return next ? [next, 'cancelled'] : ['cancelled'];
}

// ── Types + helpers ──────────────────────────────────────────────────────────

interface ReqBody {
  order_id:  string;
  to_status: string;
  reason?:   string | null;
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

function decodeJwtRole(jwt: string): string | null {
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    const padded  = part + '==='.slice((part.length + 3) % 4);
    const decoded = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof decoded?.role === 'string' ? decoded.role : null;
  } catch {
    return null;
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST')    return fail('method_not_allowed', 'Only POST is supported', 405);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return fail('misconfigured', 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing on the server', 500);
  }

  // 1. Auth — Bearer JWT, reject service_role.
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) return fail('unauthorized', 'Missing Authorization: Bearer <jwt>', 401);
  if (decodeJwtRole(jwt) === 'service_role') {
    return fail('unauthorized', 'Service-role tokens are not accepted', 401);
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(jwt);
  if (userError || !userData?.user?.email) {
    return fail('unauthorized', 'Invalid or expired token', 401);
  }
  const adminEmail = userData.user.email;

  // 2. Admin allowlist.
  const adminRow = await supabaseAdmin
    .from('admin_users')
    .select('email')
    .ilike('email', adminEmail)
    .maybeSingle();
  if (adminRow.error || !adminRow.data) {
    return fail('forbidden', 'Caller is not on the admin allowlist', 403);
  }

  // 3. Parse + validate input.
  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return fail('bad_request', 'Body must be valid JSON', 400);
  }

  const orderIdRaw  = typeof body.order_id  === 'string' ? body.order_id.trim()  : '';
  const toStatusRaw = typeof body.to_status === 'string' ? body.to_status.trim().toLowerCase() : '';
  const reasonRaw   = typeof body.reason    === 'string' ? body.reason.trim()    : '';

  if (!orderIdRaw)  return fail('bad_request', 'order_id is required', 400);
  if (!toStatusRaw) return fail('bad_request', 'to_status is required', 400);

  // 4. Load current order.
  const orderResp = await supabaseAdmin
    .from('orders')
    .select('order_id, order_number, status, fulfillment_method')
    .eq('order_id', orderIdRaw)
    .maybeSingle();
  if (orderResp.error) {
    return fail('db_error', `orders.select failed: ${orderResp.error.message}`, 500);
  }
  if (!orderResp.data) {
    return fail('not_found', `Order not found: ${orderIdRaw}`, 404);
  }
  const order      = orderResp.data;
  const fromStatus = String(order.status ?? '').toLowerCase();
  const method     = String(order.fulfillment_method ?? '').toLowerCase();

  // 5. Enforce state machine.
  if (FINAL_STATES.has(fromStatus)) {
    return fail(
      'invalid_transition',
      `Order is in a final state (${fromStatus}) and cannot transition`,
      409,
    );
  }
  const allowed = allowedNextStates(method, fromStatus);
  if (!allowed.includes(toStatusRaw)) {
    return fail(
      'invalid_transition',
      `Cannot transition from "${fromStatus}" to "${toStatusRaw}" for ${method || 'unknown'} order. ` +
      `Allowed next: ${allowed.join(', ') || '(none)'}`,
      409,
    );
  }
  if (toStatusRaw === 'cancelled' && !reasonRaw) {
    return fail('bad_request', 'Cancellation requires a non-empty reason', 400);
  }
  if (toStatusRaw === fromStatus) {
    return fail('invalid_transition', 'to_status must differ from current status', 409);
  }

  // 6. Update orders.
  const { error: updateErr } = await supabaseAdmin
    .from('orders')
    .update({ status: toStatusRaw, updated_at: new Date().toISOString() })
    .eq('order_id', orderIdRaw);
  if (updateErr) {
    return fail('db_error', `orders.update failed: ${updateErr.message}`, 500);
  }

  // 7. Append audit event. If this fails the status change has already
  // happened; surface the failure in the response but still return ok=true so
  // the caller doesn't double-fire the update.
  const { data: eventRow, error: eventErr } = await supabaseAdmin
    .from('order_status_events')
    .insert({
      order_id:     orderIdRaw,
      order_number: order.order_number ?? null,
      from_status:  fromStatus,
      to_status:    toStatusRaw,
      reason:       reasonRaw.length > 0 ? reasonRaw.slice(0, 1000) : null,
      admin_email:  adminEmail,
    })
    .select('id, created_at')
    .maybeSingle();
  if (eventErr) {
    console.error('[admin-update-order-status] Audit insert failed:', eventErr.message);
  }

  return jsonResponse({
    ok:          true,
    order_id:    orderIdRaw,
    from_status: fromStatus,
    to_status:   toStatusRaw,
    event:       eventRow ?? null,
    audit_warning: eventErr ? `Audit insert failed: ${eventErr.message}` : null,
  });
});
