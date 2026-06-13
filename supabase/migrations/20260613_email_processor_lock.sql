-- ============================================================================
-- Single-flight lock for the email queue processor (Phase C4.2).
-- ============================================================================
-- Additive only. Idempotent. Safe to re-run.
--
-- One-row mutex. process-order-email-queues claims it atomically
--   (UPDATE … WHERE id=1 AND locked_until < now() RETURNING)
-- so two overlapping runs can never drain the same pending row concurrently.
-- locked_until acts as a TTL so a crashed run self-recovers after it expires.
-- Service-role only via RLS.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.email_processor_lock (
  id           integer     PRIMARY KEY,
  locked_until timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Seed the single lock row (immediately claimable).
INSERT INTO public.email_processor_lock (id, locked_until)
VALUES (1, now())
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.email_processor_lock ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'email_processor_lock'
       AND policyname = 'service_role_all_email_processor_lock'
  ) THEN
    CREATE POLICY service_role_all_email_processor_lock
      ON public.email_processor_lock
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
-- No authenticated/anon policy → default deny.

-- ============================================================================
-- ROLLBACK (operator-run):
--   DROP POLICY IF EXISTS service_role_all_email_processor_lock ON public.email_processor_lock;
--   DROP TABLE  IF EXISTS public.email_processor_lock;
-- ============================================================================
