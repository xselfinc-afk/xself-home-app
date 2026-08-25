/**
 * admin-approve-order — Phase 2b.1: admin approval gate (no GIGA call yet)
 *
 * Approves ONE paid order for future GIGA submission. Does NOT call GIGA.
 * Does NOT change supplier_sync_status. Does NOT change orders.status.
 *
 * Auth: end-user Supabase Auth JWT in `Authorization: Bearer <session.access_token>`.
 *   1. Bearer JWT required → 401 if missing.
 *   2. Service-role JWTs are explicitly rejected (defense in depth) → 401.
 *   3. `supabase.auth.getUser(jwt)` resolves the caller's email → 401 if invalid/expired.
 *   4. Caller's email must exist in public.admin_users (case-insensitive) → 403 otherwise.
 *   Mirrors the pattern in admin-update-order-status. Deploy WITHOUT --no-verify-jwt
 *   so the Supabase Functions gateway verifies the JWT format before the function runs.
 *
 * Request:
 *   POST /functions/v1/admin-approve-order
 *   Headers:
 *     apikey:        <SUPABASE_ANON_KEY>
 *     Authorization: Bearer <session.access_token>
 *     Content-Type:  application/json
 *   Body: {
 *     "order_id": "<uuid>",
 *     "note":     "<optional free-text>"
 *   }
 *
 * Pre-flight invariants (all must hold to approve):
 *   - order exists
 *   - payment_status         = 'paid'
 *   - admin_approval_status  = 'pending'
 *   - supplier_sync_status   = 'not_submitted'
 *   - supplier_order_id IS NULL
 *
 * Atomic update writes the WHERE-belt against all 4 invariants — concurrent
 * approvals lose the race deterministically (only one caller wins, the other
 * receives a state_changed 409 and is logged as approved:false).
 *
 * Audit log: one row in supplier_purchase_log per call (success or invariant
 * failure). event = 'approve_attempt' for both; response_json.approved
 * carries the true/false outcome.
 *
 * Response (success):
 *   200 {
 *     "success":               true,
 *     "order_id":              "<uuid>",
 *     "admin_approval_status": "approved",
 *     "admin_approved_at":     "<iso>",
 *     "admin_approved_by":     "<caller>"
 *   }
 *
 * Response (failure — pre-flight invariant violated):
 *   400 / 404 / 409 with { success:false, error, current_state, hint }
 *
 * Auth failure:
 *   401 { success: false, error: 'unauthorized', detail: '<reason>' }
 *   403 { success: false, error: 'forbidden',    detail: '<reason>' }
 *
 * Body parse failure:
 *   400 { success: false, error: 'invalid_json', detail: '<reason>' }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { canApproveForSupplierFlow } from '../_shared/pickup/pickupDomain.ts';

// ── Env ────────────────────────────────────────────────────────────────────
const SUPABASE_URL              = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

interface RequestBody {
  order_id?: string;
  note?:     string;
}

interface OrderRow {
  order_id:                string;
  status:                  string;
  payment_status:          string | null;
  fulfillment_method:      string | null;
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

  // ── 5. Parse body ────────────────────────────────────────────────────────
  let body: RequestBody;
  try {
    body = await req.json() as RequestBody;
  } catch {
    return json({ success: false, error: 'invalid_json',
                  detail: 'Body must be valid JSON' }, 400);
  }

  const order_id = (body.order_id ?? '').trim();
  const note     = (body.note     ?? '').trim().slice(0, 500) || null;

  if (!order_id || !/^[0-9a-fA-F-]{36}$/.test(order_id)) {
    return json({ success: false, error: 'bad_request',
                  detail: 'order_id must be a UUID' }, 400);
  }

  const caller = adminEmail; // authoritative — never trust the body
  const nowIso = new Date().toISOString();

  // ── 3. Pre-flight: read current row state ────────────────────────────────
  const { data: orderRow, error: orderErr } = await supabase
    .from('orders')
    .select('order_id, status, payment_status, fulfillment_method, admin_approval_status, supplier_sync_status, supplier_order_id')
    .eq('order_id', order_id)
    .maybeSingle();

  if (orderErr) {
    console.error('[admin-approve-order] lookup failed:', orderErr.message);
    return json({ success: false, error: 'order_lookup_failed', detail: orderErr.message }, 500);
  }
  if (!orderRow) {
    return json({ success: false, error: 'order_not_found', order_id }, 404);
  }

  const row = orderRow as OrderRow;

  // ── 4. Invariant validation (clear error messages before atomic UPDATE) ──
  type FailureReason =
    | 'payment_not_complete'
    | 'not_in_pending_state'
    | 'supplier_already_in_flight'
    | 'supplier_order_already_recorded';

  let failureReason: FailureReason | null = null;
  let failureStatus = 409;
  let failureHint   = '';

  // Delivery: unchanged — requires payment_status='paid'. Pay-After-Pickup: may proceed once the
  // card is saved / authorized (never on a bare pending order). The gate is NOT loosened wholesale.
  const approvalGate = canApproveForSupplierFlow({ fulfillment_method: row.fulfillment_method, payment_status: row.payment_status });
  if (!approvalGate.ok) {
    failureReason = 'payment_not_complete';
    failureStatus = 400;
    failureHint   = `Approve blocked: ${approvalGate.reason}.`;
  } else if (row.admin_approval_status !== 'pending') {
    failureReason = 'not_in_pending_state';
    failureHint   = "Approve is only permitted while admin_approval_status='pending'. Order may already be approved/rejected.";
  } else if (row.supplier_sync_status !== 'not_submitted') {
    failureReason = 'supplier_already_in_flight';
    failureHint   = "Cannot re-approve: supplier_sync_status is not 'not_submitted'.";
  } else if (row.supplier_order_id !== null) {
    failureReason = 'supplier_order_already_recorded';
    failureHint   = "Cannot approve: supplier_order_id is already set, suggesting a prior submission.";
  }

  // Helper to insert the audit log row. Best-effort; logging failure never
  // blocks the response since the canonical state lives on the orders row.
  async function writeLog(approved: boolean, httpStatus: number) {
    const { error } = await supabase.from('supplier_purchase_log').insert({
      order_id,
      event: 'approve_attempt',
      caller,
      http_status: httpStatus,
      response_json: {
        approved,
        note,
        prior_state: {
          payment_status:        row.payment_status,
          admin_approval_status: row.admin_approval_status,
          supplier_sync_status:  row.supplier_sync_status,
          supplier_order_id:     row.supplier_order_id,
        },
        new_state: approved ? {
          admin_approval_status: 'approved',
          admin_approved_by:     caller,
          admin_approved_at:     nowIso,
        } : null,
        failure_reason: approved ? null : failureReason,
      },
      request_payload: { order_id, admin_email: adminEmail, note },
    });
    if (error) {
      console.error('[admin-approve-order] audit log insert failed (non-fatal):', error.message);
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

  // ── 5. Atomic UPDATE with WHERE-belt for race safety ─────────────────────
  const { data: updatedRows, error: updErr } = await supabase
    .from('orders')
    .update({
      admin_approval_status: 'approved',
      admin_approved_at:     nowIso,
      admin_approved_by:     caller,
      updated_at:            nowIso,
    })
    .eq('order_id',                   order_id)
    // Race-belt pinned to the exact value we validated (still race-safe; works for delivery 'paid'
    // and pickup 'card_saved'/'authorized' alike without loosening the gate).
    .eq('payment_status',             row.payment_status as string)
    .eq('admin_approval_status',      'pending')
    .eq('supplier_sync_status',       'not_submitted')
    .is('supplier_order_id',          null)
    .select('order_id, admin_approval_status, admin_approved_at, admin_approved_by, status, payment_status, supplier_sync_status, supplier_order_id');

  if (updErr) {
    console.error('[admin-approve-order] update failed:', updErr.message);
    await writeLog(false, 500);
    return json({ success: false, error: 'update_failed', detail: updErr.message }, 500);
  }

  if (!updatedRows || updatedRows.length === 0) {
    // Race lost: another caller updated the row between our pre-flight read
    // and our UPDATE. Treat as a concurrency conflict.
    failureReason = 'not_in_pending_state';
    failureHint   = 'State changed between pre-flight and update — likely a concurrent approval. Re-fetch and decide.';
    await writeLog(false, 409);
    return json({
      success: false,
      error:   'state_changed',
      hint:    failureHint,
    }, 409);
  }

  // ── 6. Success path ──────────────────────────────────────────────────────
  await writeLog(true, 200);

  const updated = updatedRows[0];
  return json({
    success:               true,
    order_id,
    admin_approval_status: updated.admin_approval_status,
    admin_approved_at:     updated.admin_approved_at,
    admin_approved_by:     updated.admin_approved_by,
    // Echo unchanged fields so callers can verify nothing else moved:
    status:                updated.status,
    payment_status:        updated.payment_status,
    supplier_sync_status:  updated.supplier_sync_status,
    supplier_order_id:     updated.supplier_order_id,
  });
});
