-- 20260826_pickup_bol_evidence.sql
--
-- BOL evidence/audit columns on public.pickup_documents. Additive / reversible / fail-safe.
-- The private `pickup-documents` storage bucket already exists (bucket authority = shared backend).
-- These columns make each stored BOL tamper-evident (sha256) and attributable (uploaded_by).

BEGIN;

ALTER TABLE public.pickup_documents
  ADD COLUMN IF NOT EXISTS content_sha256 text,     -- hex sha256 of the uploaded bytes (immutability evidence)
  ADD COLUMN IF NOT EXISTS file_size_bytes integer,
  ADD COLUMN IF NOT EXISTS content_type   text,
  ADD COLUMN IF NOT EXISTS uploaded_by     text;    -- ops actor / 'system'

COMMENT ON COLUMN public.pickup_documents.content_sha256 IS
  'Hex sha256 of the stored bytes, computed server-side at upload. Lets any later read prove the '
  'document was not altered. Never recomputed client-side.';

COMMIT;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- ALTER TABLE public.pickup_documents
--   DROP COLUMN IF EXISTS uploaded_by, DROP COLUMN IF EXISTS content_type,
--   DROP COLUMN IF EXISTS file_size_bytes, DROP COLUMN IF EXISTS content_sha256;
