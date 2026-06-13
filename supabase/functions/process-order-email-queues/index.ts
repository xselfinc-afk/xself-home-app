// ─────────────────────────────────────────────────────────────────────────────
// process-order-email-queues — scheduled queue drainer (Phase C4.2).
//
// Drains the two notification queues by invoking the existing sender functions.
// It NEVER sends email itself (no Resend, no Crisp), NEVER scans/creates orders,
// NEVER creates queue rows, and NEVER touches order/payment status. It only:
//   • claims a single-flight lock (email_processor_lock),
//   • selects pending / failed(attempts<max) rows from order_notifications and
//     customer_order_emails (batch-limited),
//   • POSTs each order_id to the matching sender (send-order-notification /
//     send-customer-order-email), which performs the send + status bookkeeping,
//   • releases the lock.
//
// The senders own dedupe (PK + already_sent guard) and retry bookkeeping
// (status='failed', attempts+1, last_error). The lock guarantees no two runs
// drain the same row concurrently.
//
// AUTH: service-role only (Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>).
// Invoked by pg_cron via pg_net; can also be invoked manually for testing.
//
// Request (POST): { "dry_run"?: bool, "batch_size"?: int, "max_attempts"?: int }
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL              = (Deno.env.get('SUPABASE_URL')              ?? '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
const FUNCTIONS_BASE = `${SUPABASE_URL}/functions/v1`;
const LOCK_TTL_MS = 2 * 60 * 1000; // 2 minutes — TTL recovers a crashed run

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

interface QueueSpec { table: string; fn: string; key: 'internal' | 'customer' }
const QUEUES: QueueSpec[] = [
  { table: 'order_notifications',   fn: 'send-order-notification',   key: 'internal' },
  { table: 'customer_order_emails', fn: 'send-customer-order-email', key: 'customer' },
];

interface SendResult {
  order_id: string;
  ok: boolean;
  http?: number;
  result?: unknown;
  error?: string;
}

async function invokeSender(fn: string, orderId: string): Promise<SendResult> {
  try {
    const res = await fetch(`${FUNCTIONS_BASE}/${fn}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ order_id: orderId }),
    });
    const body = await res.json().catch(() => null) as { ok?: boolean } | null;
    return { order_id: orderId, ok: res.status === 200 && body?.ok !== false, http: res.status, result: body };
  } catch (e) {
    return { order_id: orderId, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'server_not_configured' }, 500);
  }

  // Service-role-only gate.
  const auth = req.headers.get('Authorization') ?? '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (bearer !== SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'unauthorized', detail: 'service-role bearer required' }, 401);
  }

  let body: { dry_run?: unknown; batch_size?: unknown; max_attempts?: unknown };
  try { body = await req.json(); } catch { body = {}; }
  const dryRun      = body.dry_run === true;
  const batchSize   = Math.min(100, Math.max(1, Number(body.batch_size) || 10));
  const maxAttempts = Math.min(10,  Math.max(1, Number(body.max_attempts) || 3));

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // ── Claim single-flight lock (atomic: WHERE id=1 AND locked_until < now) ────
  const nowIso = new Date().toISOString();
  const untilIso = new Date(Date.now() + LOCK_TTL_MS).toISOString();
  const { data: lockRows, error: lockErr } = await supabase
    .from('email_processor_lock')
    .update({ locked_until: untilIso, updated_at: nowIso })
    .eq('id', 1)
    .lt('locked_until', nowIso)
    .select('id');
  if (lockErr) {
    console.error('[process-queues] lock error:', lockErr.message);
    return json({ ok: false, error: 'lock_error', detail: lockErr.message }, 500);
  }
  if (!lockRows || lockRows.length === 0) {
    return json({ ok: true, skipped: true, reason: 'locked' });
  }

  const summary: Record<string, unknown> = {};
  try {
    for (const q of QUEUES) {
      const { data: rows, error } = await supabase
        .from(q.table)
        .select('order_id, status, attempts')
        .or(`status.eq.pending,and(status.eq.failed,attempts.lt.${maxAttempts})`)
        .limit(batchSize);
      if (error) { summary[q.key] = { error: error.message }; continue; }
      const ids = (rows ?? []).map((r) => r.order_id as string);
      if (dryRun) { summary[q.key] = { would_process: ids.length, order_ids: ids }; continue; }
      const results: SendResult[] = [];
      for (const id of ids) results.push(await invokeSender(q.fn, id));
      summary[q.key] = {
        selected: ids.length,
        sent_ok:  results.filter((r) => r.ok).length,
        failed:   results.filter((r) => !r.ok).length,
        results,
      };
    }
  } finally {
    // Release the lock so the next run can claim immediately.
    const ts = new Date().toISOString();
    const { error: relErr } = await supabase
      .from('email_processor_lock')
      .update({ locked_until: ts, updated_at: ts })
      .eq('id', 1);
    if (relErr) console.error('[process-queues] lock release failed (TTL will recover):', relErr.message);
  }

  console.log('[process-queues] done', JSON.stringify({ dryRun, batchSize, maxAttempts, summary }));
  return json({ ok: true, dry_run: dryRun, batch_size: batchSize, max_attempts: maxAttempts, summary });
});
