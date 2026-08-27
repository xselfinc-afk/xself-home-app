/**
 * pickup-capture-sweep (auto-capture scheduler endpoint).
 *
 * Called by pg_cron (every 30 min) — finds pickup orders whose 24h payment window is due
 * (pickup_stage='CONFIRMED', payment_due_at <= now) and forwards each to the deployed
 * `pickup-capture` function, which remains the SINGLE capture authority (all guards live
 * there: due window, live AUTHORIZED hold, no open issue, already-captured idempotent no-op,
 * fail-closed on lapse). This sweep is just the alarm clock — it never talks to Stripe.
 *
 * Auth: EITHER X-Pickup-Token (ops/manual) OR Authorization: Bearer <service_role_key>
 * (the established pg_cron → net.http_post pattern, key from Vault).
 *
 * Body (JSON, optional): { dryRun?: boolean, lookaheadHours?: number, limit?: number }
 *   dryRun: report candidates without capturing. lookaheadHours widens the window for
 *   dry-run inspection only — a REAL run always uses payment_due_at <= now.
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

  const bearer = (req.headers.get('authorization') ?? '').replace(/^bearer /i, '').trim();
  const isOps = Boolean(PICKUP_ADMIN_TOKEN) && req.headers.get('x-pickup-token') === PICKUP_ADMIN_TOKEN;
  const isCron = Boolean(SUPABASE_SERVICE_ROLE_KEY) && bearer === SUPABASE_SERVICE_ROLE_KEY;
  if (!isOps && !isCron) return json({ error: 'unauthorized' }, 401);

  let body: { dryRun?: boolean; lookaheadHours?: number; limit?: number };
  try { body = await req.json(); } catch { body = {}; }
  const dryRun = body.dryRun === true;
  const limit = Math.min(Math.max(Number(body.limit ?? 20), 1), 50);
  // Lookahead applies to DRY RUN only; a real sweep captures strictly-due orders.
  const horizonMs = dryRun ? Math.max(0, Number(body.lookaheadHours ?? 0)) * 3600_000 : 0;
  const horizonIso = new Date(Date.now() + horizonMs).toISOString();

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: due, error } = await db.from('orders')
    .select('order_id, order_number, payment_due_at, total_cents')
    .eq('fulfillment_method', 'pickup')
    .eq('pickup_stage', 'CONFIRMED')
    .not('payment_due_at', 'is', null)
    .lte('payment_due_at', horizonIso)
    .order('payment_due_at', { ascending: true })
    .limit(limit);
  if (error) { console.error('[pickup-capture-sweep] query failed:', error.message); return json({ error: 'query_failed' }, 500); }

  const candidates = due ?? [];
  if (dryRun) {
    return json({ ok: true, dryRun: true, horizon: horizonIso, count: candidates.length, candidates });
  }

  // Forward each due order to the capture authority. Its guards decide; we just report.
  const results: Array<{ orderId: string; orderNumber: string; action: string; reason?: string | null }> = [];
  for (const o of candidates) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/pickup-capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pickup-token': PICKUP_ADMIN_TOKEN },
        body: JSON.stringify({ orderId: o.order_id }),
      });
      const r = await resp.json().catch(() => ({}));
      results.push({ orderId: o.order_id, orderNumber: o.order_number, action: r.action ?? `http_${resp.status}`, reason: r.reason ?? r.detail ?? null });
    } catch (e) {
      results.push({ orderId: o.order_id, orderNumber: o.order_number, action: 'sweep_error', reason: (e as Error).message });
    }
  }

  // Audit only when there was work — an empty half-hourly sweep stays silent.
  if (results.length > 0) {
    await db.from('pickup_audit_events').insert({
      order_id: results[0].orderId, event_type: 'CAPTURE_SWEEP', actor: 'scheduler',
      payload: { count: results.length, results },
    });
  }
  return json({ ok: true, count: results.length, results });
});
