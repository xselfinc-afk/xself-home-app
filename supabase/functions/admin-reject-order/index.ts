/**
 * admin-reject-order — Phase 2b.3: admin rejection gate (no GIGA call)
 *
 * Rejects ONE paid order in the admin approval queue. Does NOT call GIGA.
 * Does NOT issue refunds (handled in Stripe dashboard separately). Does NOT
 * change orders.status (customer-facing cancellation is a separate decision
 * handled via admin-update-order-status).
 *
 * Auth: end-user Supabase Auth JWT in `Authorization: Bearer <session.access_token>`.
 *   1. Bearer JWT required → 401 if missing.
 *   2. Service-role JWTs are explicitly rejected (defense in depth) → 401.
 *   3. `supabase.auth.getUser(jwt)` resolves the caller's email → 401 if invalid/expired.
 *   4. Caller's email must exist in public.admin_users (case-insensitive) → 403 otherwise.
 *   Mirrors the pattern in admin-approve-order. Deploy WITHOUT --no-verify-jwt
 *   so the Supabase Functions gateway verifies the JWT format before the
 *   function runs.
 *
 * Request:
 *   POST /functions/v1/admin-reject-order
 *   Headers:
 *     apikey:        <SUPABASE_ANON_KEY>
 *     Authorization: Bearer <session.access_token>
 *     Content-Type:  application/json
 *   Body: {
 *     "order_id": "<uuid>",
 *     "reason":   "<required rejection reason, 5-500 chars>"
 *   }
 *
 * Pre-flight invariants (all must hold to reject — identical to approve):
 *   - order exists
 *   - payment_status         = 'paid'
 *   - admin_approval_status  = 'pending'
 *   - supplier_sync_status   = 'not_submitted'
 *   - supplier_order_id IS NULL
 *
 * Atomic update writes the WHERE-belt against all 4 invariants — concurrent
 * approve / reject calls lose the race deterministically (only one caller
 * wins, the other receives a state_changed 409 and is logged with
 * approved:false).
 *
 * Audit log: one row in supplier_purchase_log per call (success or invariant
 * failure). Uses event='approve_attempt' (the existing CHECK constraint
 * value) with response_json.action='rejected' to disambiguate from approve.
 * response_json.approved is always false for this function.
 *
 * Response (success):
 *   200 {
 *     "success":                        true,
 *     "order_id":                       "<uuid>",
 *     "admin_approval_status":          "rejected",
 *     "admin_approval_rejected_reason": "<reason>",
 *     "admin_approved_at":              "<iso>",   // decision timestamp
 *     "admin_approved_by":              "<email>", // decision maker
 *     "status":                         "<unchanged>",
 *     "payment_status":                 "paid",
 *     "supplier_sync_status":           "not_submitted",
 *     "supplier_order_id":              null
 *   }
 *
 * Response (failure — pre-flight invariant violated):
 *   400 / 404 / 409 with { success:false, error, current_state, hint }
 *
 * Auth failure:
 *   401 { success: false, error: 'unauthorized', detail: '<reason>' }
 *   403 { success: false, error: 'forbidden',    detail: '<reason>' }
 *
 * Body / validation failure:
 *   400 { success: false, error: 'bad_request' | 'invalid_json', detail: '<reason>' }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Env ────────────────────────────────────────────────────────────────────
const SUPABASE_URL              = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Reason field bounds — server-side authoritative. Client UI mirrors these.
const REASON_MIN_LEN = 5;
const REASON_MAX_LEN = 500;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

interface RequestBody {
  order_id?: string;
  reason?:   string;
}

interface OrderRow {
  order_id:                string;
  status:                  string;
  payment_status:          string | null;
  admin_approval_status:   string | null;
  supplier_sync_status:    string | null;
  supplier_order_id:       string | null;
}

// ── JWT helpers ────────────────────────────────────────────────────────────
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

// ── Handler ────────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  // ── 0. Env sanity ────────────────────────────────────────────────────────
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'misconfigured',
                  detail: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing' }, 500);
  }

  // ── 1. Extract Bearer JWT ────────────────────────────────────────────────
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) {
    return json({ success: false, error: 'unauthorized',
                  detail: 'Missing Authorization: Bearer <jwt>' }, 401);
  }

  // ── 2. Defensive: reject service-role JWTs ───────────────────────────────
  // Browser admin clients must never hold the service-role key. This belt
  // catches a misconfigured caller before any DB lookup runs.
  if (decodeJwtRole(jwt) === 'service_role') {
    return json({ success: false, error: 'unauthorized',
                  detail: 'Service-role tokens are not accepted' }, 401);
  }

  // ── 3. Service-role client + resolve caller identity ─────────────────────
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
  if (userError || !userData?.user?.email) {
    return json({ success: false, error: 'unauthorized',
                  detail: 'Invalid or expired token' }, 401);
  }
  const adminEmail = userData.user.email;

  // ── 4. Admin allowlist (case-insensitive) ────────────────────────────────
  const adminRow = await supabase
    .from('admin_users')
    .select('email')
    .ilike('email', adminEmail)
    .maybeSingle();
  if (adminRow.error || !adminRow.data) {
    return json({ success: false, error: 'forbidden',
                  detail: 'Caller is not on the admin allowlist' }, 403);
  }

  // ── 5. Parse + validate body ─────────────────────────────────────────────
  let body: RequestBody;
  try {
    body = await req.json() as RequestBody;
  } catch {
    return json({ success: false, error: 'invalid_json',
                  detail: 'Body must be valid JSON' }, 400);
  }

  const order_id   = (body.order_id ?? '').trim();
  const reasonText = (body.reason   ?? '').trim().slice(0, REASON_MAX_LEN);

  if (!order_id || !/^[0-9a-fA-F-]{36}$/.test(order_id)) {
    return json({ success: false, error: 'bad_request',
                  detail: 'order_id must be a UUID' }, 400);
  }
  if (reasonText.length < REASON_MIN_LEN) {
    return json({ success: false, error: 'bad_request',
                  detail: `reason is required (min ${REASON_MIN_LEN} chars)` }, 400);
  }

  const caller = adminEmail; // authoritative — never trust the body
  const nowIso = new Date().toISOString();

  // ── 6. Pre-flight: read current row state ────────────────────────────────
  const { data: orderRow, error: orderErr } = await supabase
    .from('orders')
    .select('order_id, status, payment_status, admin_approval_status, supplier_sync_status, supplier_order_id')
    .eq('order_id', order_id)
    .maybeSingle();

  if (orderErr) {
    console.error('[admin-reject-order] lookup failed:', orderErr.message);
    return json({ success: false, error: 'order_lookup_failed', detail: orderErr.message }, 500);
  }
  if (!orderRow) {
    return json({ success: false, error: 'order_not_found', order_id }, 404);
  }

  const row = orderRow as OrderRow;

  // ── 7. Invariant validation (clear error messages before atomic UPDATE) ──
  type FailureReason =
    | 'payment_not_complete'
    | 'not_in_pending_state'
    | 'supplier_already_in_flight'
    | 'supplier_order_already_recorded';

  let failureReason: FailureReason | null = null;
  let failureStatus = 409;
  let failureHint   = '';

  if (row.payment_status !== 'paid') {
    failureReason = 'payment_not_complete';
    failureStatus = 400;
    failureHint   = "Reject is only permitted after payment_status='paid'.";
  } else if (row.admin_approval_status !== 'pending') {
    failureReason = 'not_in_pending_state';
    failureHint   = "Reject is only permitted while admin_approval_status='pending'. Order may already be approved/rejected.";
  } else if (row.supplier_sync_status !== 'not_submitted') {
    failureReason = 'supplier_already_in_flight';
    failureHint   = "Cannot reject: supplier_sync_status is not 'not_submitted'.";
  } else if (row.supplier_order_id !== null) {
    failureReason = 'supplier_order_already_recorded';
    failureHint   = "Cannot reject: supplier_order_id is already set, suggesting a prior submission.";
  }

  // Helper to insert the audit log row. Best-effort; logging failure never
  // blocks the response since the canonical state lives on the orders row.
  // Uses event='approve_attempt' (already in the CHECK constraint) with
  // response_json.action='rejected' to disambiguate from approve in the UI.
  async function writeLog(rejected: boolean, httpStatus: number) {
    const { error } = await supabase.from('supplier_purchase_log').insert({
      order_id,
      event: 'approve_attempt',
      caller,
      http_status: httpStatus,
      response_json: {
        action:   'rejected',
        approved: false,            // always false for reject — success or failure
        rejected,                   // disambiguates: true on success, false on failure
        reason:   reasonText,
        prior_state: {
          payment_status:        row.payment_status,
          admin_approval_status: row.admin_approval_status,
          supplier_sync_status:  row.supplier_sync_status,
          supplier_order_id:     row.supplier_order_id,
        },
        new_state: rejected ? {
          admin_approval_status:          'rejected',
          admin_approval_rejected_reason: reasonText,
          admin_approved_by:              caller,   // reused as decision-maker
          admin_approved_at:              nowIso,   // reused as decision timestamp
        } : null,
        failure_reason: rejected ? null : failureReason,
      },
      request_payload: { order_id, admin_email: adminEmail, reason: reasonText },
    });
    if (error) {
      console.error('[admin-reject-order] audit log insert failed (non-fatal):', error.message);
    }
  }

  if (failureReason) {
    await writeLog(false, failureStatus);
    return json({
      success: false,
      error:   failureReason,
      current_state: {
        payment_status:        row.payment_status,
        admin_approval_status: row.admin_approval_status,
        supplier_sync_status:  row.supplier_sync_status,
        supplier_order_id:     row.supplier_order_id,
      },
      hint: failureHint,
    }, failureStatus);
  }

  // ── 8. Atomic UPDATE with WHERE-belt for race safety ─────────────────────
  // Reuses admin_approved_at / admin_approved_by as the "approval decision
  // finalized at / by" columns. admin_approval_status disambiguates whether
  // the decision was approved or rejected.
  const { data: updatedRows, error: updErr } = await supabase
    .from('orders')
    .update({
      admin_approval_status:          'rejected',
      admin_approval_rejected_reason: reasonText,
      admin_approved_at:              nowIso,
      admin_approved_by:              caller,
      updated_at:                     nowIso,
    })
    .eq('order_id',                   order_id)
    .eq('payment_status',             'paid')
    .eq('admin_approval_status',      'pending')
    .eq('supplier_sync_status',       'not_submitted')
    .is('supplier_order_id',          null)
    .select('order_id, admin_approval_status, admin_approval_rejected_reason, admin_approved_at, admin_approved_by, status, payment_status, supplier_sync_status, supplier_order_id');

  if (updErr) {
    console.error('[admin-reject-order] update failed:', updErr.message);
    await writeLog(false, 500);
    return json({ success: false, error: 'update_failed', detail: updErr.message }, 500);
  }

  if (!updatedRows || updatedRows.length === 0) {
    // Race lost: another caller updated the row between our pre-flight read
    // and our UPDATE. Treat as a concurrency conflict.
    failureReason = 'not_in_pending_state';
    failureHint   = 'State changed between pre-flight and update — likely a concurrent approve/reject. Re-fetch and decide.';
    await writeLog(false, 409);
    return json({
      success: false,
      error:   'state_changed',
      hint:    failureHint,
    }, 409);
  }

  // ── 9. Success path ──────────────────────────────────────────────────────
  await writeLog(true, 200);

  const updated = updatedRows[0];
  return json({
    success:                        true,
    order_id,
    admin_approval_status:          updated.admin_approval_status,
    admin_approval_rejected_reason: updated.admin_approval_rejected_reason,
    admin_approved_at:              updated.admin_approved_at,
    admin_approved_by:              updated.admin_approved_by,
    // Echo unchanged fields so callers can verify nothing else moved:
    status:                updated.status,
    payment_status:        updated.payment_status,
    supplier_sync_status:  updated.supplier_sync_status,
    supplier_order_id:     updated.supplier_order_id,
  });
});
