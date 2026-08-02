-- ============================================================================
-- Publication provenance  (NOT APPLIED — Step 3 applies this)
--
-- WHY
-- ---
-- Today nothing distinguishes "unpublished because the supplier ran out" from "unpublished
-- deliberately by a human". Without that distinction an automatic relist would resurrect a product
-- a Founder had intentionally hidden — the single most dangerous defect found in the Step 1 audit.
--
-- Adds three things and nothing else:
--   standardized_products.delist_reason  — provenance on the existing publication row
--   publication_audit_log               — every publication flip, who/why/which run
--   inventory_manual_hold               — per-SKU freeze that automation must never cross
--
-- ADDITIVE ONLY. No existing column is altered, no row is rewritten, no function is redefined,
-- and `sellable_products` is untouched. Applying this changes zero customer-visible behaviour.
-- ============================================================================

-- ── 1. Provenance on the publication row ────────────────────────────────────────────────────
-- NULL  = published, or unpublished before provenance tracking existed (unknown → treated as
--         MANUAL by the relist path, which is the safe reading).
ALTER TABLE public.standardized_products
  ADD COLUMN IF NOT EXISTS delist_reason text NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'std_delist_reason_chk') THEN
    ALTER TABLE public.standardized_products
      ADD CONSTRAINT std_delist_reason_chk
      CHECK (delist_reason IS NULL OR delist_reason IN ('inventory_unavailable', 'manual', 'quality_gate'));
  END IF;
END $$;

COMMENT ON COLUMN public.standardized_products.delist_reason IS
  'Why this product is unpublished. Only ''inventory_unavailable'' may be auto-relisted. NULL on an '
  'unpublished row means provenance is unknown and is treated as manual — automation must not touch it.';

CREATE INDEX IF NOT EXISTS std_delist_reason_idx
  ON public.standardized_products (delist_reason) WHERE delist_reason IS NOT NULL;

-- ── 2. Publication audit log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.publication_audit_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_product_id text        NOT NULL,
  from_published      boolean     NULL,          -- NULL when the prior value was unreadable
  to_published        boolean     NOT NULL,
  action              text        NOT NULL,      -- 'delist' | 'relist'
  reason              text        NOT NULL,      -- provenance written onto delist_reason
  actor               text        NOT NULL,      -- human approver, or 'system:<script>'
  run_id              text        NULL,
  evidence_checked_at timestamptz NULL,          -- availability evidence the decision rested on
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pal_action_chk CHECK (action IN ('delist', 'relist')),
  CONSTRAINT pal_reason_chk CHECK (reason IN ('inventory_unavailable', 'manual', 'quality_gate', 'inventory_restored'))
);

CREATE INDEX IF NOT EXISTS pal_sku_idx     ON public.publication_audit_log (supplier_product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pal_run_idx     ON public.publication_audit_log (run_id);

COMMENT ON TABLE public.publication_audit_log IS
  'Append-only record of every publication flip made by the inventory lifecycle. Rollback source of '
  'truth: replaying from_published restores the exact prior state.';

-- ── 3. Per-SKU manual hold ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.inventory_manual_hold (
  supplier_product_id text        PRIMARY KEY,
  reason              text        NOT NULL,
  held_by             text        NOT NULL,
  held_until          timestamptz NULL,          -- NULL = indefinite
  created_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.inventory_manual_hold IS
  'SKUs frozen against ALL inventory automation. A hold blocks delist AND relist. NULL held_until '
  'means indefinite.';

CREATE OR REPLACE VIEW public.active_inventory_holds AS
SELECT supplier_product_id, reason, held_by, held_until
FROM public.inventory_manual_hold
WHERE held_until IS NULL OR held_until > now();

-- ── 4. RLS — service role only ──────────────────────────────────────────────────────────────
ALTER TABLE public.publication_audit_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_manual_hold  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pal_service_role_all ON public.publication_audit_log;
CREATE POLICY pal_service_role_all ON public.publication_audit_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS imh_service_role_all ON public.inventory_manual_hold;
CREATE POLICY imh_service_role_all ON public.inventory_manual_hold
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- DROP VIEW  IF EXISTS public.active_inventory_holds;
-- DROP TABLE IF EXISTS public.inventory_manual_hold;
-- DROP TABLE IF EXISTS public.publication_audit_log;
-- ALTER TABLE public.standardized_products DROP CONSTRAINT IF EXISTS std_delist_reason_chk;
-- ALTER TABLE public.standardized_products DROP COLUMN IF EXISTS delist_reason;
--
-- Lossless: no existing column or row is modified by this migration in either direction.
-- ============================================================================
