-- 20260826_pickup_capture_sweep_cron.sql
--
-- Auto-capture scheduler (applied to production 2026-08-26 via `supabase db query --linked`;
-- this file is the committed record). Every 30 minutes pg_cron POSTs to the
-- pickup-capture-sweep edge function, which forwards strictly-due CONFIRMED pickup orders to
-- pickup-capture — the single capture authority (due window, live hold, no open issue,
-- already-captured idempotent no-op, fail-closed on lapse). Double capture is impossible:
-- the guards skip CAPTURED authorizations, and Stripe rejects a second capture of the
-- original PI regardless. The Ops "Capture" button remains as a manual override.
--
-- Pattern mirrors cron job 2 (process-order-email-queues): net.http_post with the
-- service_role_key from Vault.

select cron.schedule(
  'pickup-capture-sweep-every-30min',
  '*/30 * * * *',
  $$
  select net.http_post(
    url := 'https://erbimgfbztkzmpamzwky.supabase.co/functions/v1/pickup-capture-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
      )
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- select cron.unschedule('pickup-capture-sweep-every-30min');
