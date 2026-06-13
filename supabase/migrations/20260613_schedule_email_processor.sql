-- ============================================================================
-- Schedule the email queue processor every minute (Phase C4.3).
-- ============================================================================
-- RUN MANUALLY IN THE SUPABASE SQL EDITOR. Requires the deployed function
-- process-order-email-queues and the email_processor_lock table to exist first.
--
-- The service-role key is read from Vault (never inline it in cron.job).
-- Run the one-time Vault step ONCE before scheduling (replace the placeholder
-- with the real service-role key — do not commit the real key):
--
--   select vault.create_secret('<SERVICE_ROLE_KEY>', 'service_role_key');
--
-- (If the secret already exists, skip; to rotate:
--   select vault.update_secret((select id from vault.secrets where name='service_role_key'), '<NEW_KEY>'); )
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: drop any prior schedule of the same name before re-creating.
select cron.unschedule('process-order-email-queues-every-minute')
where exists (select 1 from cron.job where jobname = 'process-order-email-queues-every-minute');

select cron.schedule(
  'process-order-email-queues-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://erbimgfbztkzmpamzwky.supabase.co/functions/v1/process-order-email-queues',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body    := jsonb_build_object('dry_run', false, 'batch_size', 10, 'max_attempts', 3)
  );
  $$
);

-- ============================================================================
-- ROLLBACK (operator-run — turns automation OFF instantly):
--   select cron.unschedule('process-order-email-queues-every-minute');
-- ============================================================================
