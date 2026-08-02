-- ============================================================================
-- set_publication_from_availability()  (NOT APPLIED — Step 3 applies this)
--
-- WHY A NEW FUNCTION RATHER THAN CHANGING THE EXISTING ONE
-- --------------------------------------------------------
-- `refresh_product_inventory_status()` derives `published` from `inventory_cache` rows with
-- source_type='website_scrape' and a 24-hour staleness rule. It cannot see Open API availability at
-- all. Every published product currently has warehouse evidence 10–40 days old, so calling it today
-- resolves to 'stale' and unpublishes — regardless of what the supplier API says.
--
-- It is NOT modified here. Other paths (onboarding, manual upload, the warehouse sync) depend on its
-- current behaviour, and changing a shared authority to serve one consumer would be a redesign.
-- Instead this adds a second, narrower writer that consumes Open API evidence and touches ONLY
-- `published` / `delist_reason`. The two never write the same decision inputs.
--
-- WHAT IT GUARANTEES
-- ------------------
--   * Delist requires FRESH, CONFIRMED-UNAVAILABLE Open API evidence. Never a failure, never stale.
--   * Relist requires FRESH, CONFIRMED-AVAILABLE evidence AND provenance proving WE delisted it AND
--     every quality gate `sellable_products` enforces. A manually hidden product can never return.
--   * An active manual hold blocks both directions.
--   * Every flip writes `publication_audit_log`, so rollback is a replay.
--   * It returns a machine-readable status instead of raising, so a batch runner can report skips
--     per SKU without aborting.
--
-- It never writes inventory_status, total_available_qty, has_ca_pickup, or any warehouse field.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_publication_from_availability(
  p_supplier_product_id text,
  p_target_published    boolean,
  p_actor               text,
  p_run_id              text    DEFAULT NULL,
  p_grace_hours         integer DEFAULT 72
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_published        boolean;
  v_delist_reason    text;
  v_norm             text;
  v_title            text;
  v_image            text;
  v_price            numeric;
  v_selling          numeric;
  v_inv_status       text;
  v_qty              integer;
  v_avail            boolean;
  v_avail_status     text;
  v_checked_at       timestamptz;
  v_held             boolean;
BEGIN
  -- ── Product must exist ────────────────────────────────────────────────────────────────────
  SELECT published, delist_reason, normalization_status, product_title, primary_image,
         price, selling_price, inventory_status, total_available_qty
    INTO v_published, v_delist_reason, v_norm, v_title, v_image,
         v_price, v_selling, v_inv_status, v_qty
  FROM public.standardized_products
  WHERE supplier_product_id = p_supplier_product_id;

  IF NOT FOUND THEN RETURN 'skipped_product_not_found'; END IF;

  -- ── A manual hold outranks everything, in both directions ─────────────────────────────────
  SELECT EXISTS (SELECT 1 FROM public.active_inventory_holds WHERE supplier_product_id = p_supplier_product_id)
    INTO v_held;
  IF v_held THEN RETURN 'skipped_manual_hold'; END IF;

  -- ── Already in the requested state → idempotent no-op ─────────────────────────────────────
  IF v_published IS NOT DISTINCT FROM p_target_published THEN
    RETURN 'skipped_already_' || CASE WHEN p_target_published THEN 'published' ELSE 'unpublished' END;
  END IF;

  -- ── Availability evidence is mandatory in both directions ─────────────────────────────────
  SELECT available, status, checked_at
    INTO v_avail, v_avail_status, v_checked_at
  FROM public.product_availability_current
  WHERE supplier_product_id = p_supplier_product_id;

  IF NOT FOUND THEN RETURN 'skipped_no_availability_evidence'; END IF;
  IF v_checked_at < now() - make_interval(hours => p_grace_hours) THEN
    RETURN 'skipped_evidence_stale';
  END IF;

  -- ════════════════════════════════════ DELIST ═════════════════════════════════════════════
  IF p_target_published = false THEN
    IF v_avail IS NOT false THEN RETURN 'skipped_evidence_not_unavailable'; END IF;

    UPDATE public.standardized_products
       SET published = false, delist_reason = 'inventory_unavailable', updated_at = now()
     WHERE supplier_product_id = p_supplier_product_id;

    INSERT INTO public.publication_audit_log
      (supplier_product_id, from_published, to_published, action, reason, actor, run_id, evidence_checked_at)
    VALUES (p_supplier_product_id, v_published, false, 'delist', 'inventory_unavailable', p_actor, p_run_id, v_checked_at);

    RETURN 'delisted';
  END IF;

  -- ════════════════════════════════════ RELIST ═════════════════════════════════════════════
  -- Provenance first. NULL means we do not know why it was hidden, which must read as MANUAL.
  IF v_delist_reason IS DISTINCT FROM 'inventory_unavailable' THEN
    RETURN 'skipped_not_inventory_delisted';
  END IF;

  IF v_avail IS NOT true THEN RETURN 'skipped_evidence_not_available'; END IF;

  -- Re-assert every gate `sellable_products` enforces, so relisting can never surface a product
  -- that would be broken or invisible anyway.
  IF v_norm IS DISTINCT FROM 'done'                      THEN RETURN 'skipped_quality_normalization'; END IF;
  IF v_title IS NULL OR btrim(v_title) = ''              THEN RETURN 'skipped_quality_title';         END IF;
  IF v_image IS NULL OR btrim(v_image) = ''              THEN RETURN 'skipped_quality_image';         END IF;
  IF v_price IS NULL OR v_price <= 0                     THEN RETURN 'skipped_quality_price';         END IF;
  IF v_selling IS NULL OR v_selling <= 0                 THEN RETURN 'skipped_quality_selling_price'; END IF;
  -- Fulfillment path: the warehouse authority must still consider it stocked. Open API proves the
  -- supplier has it; this proves we can actually fulfil it.
  IF v_inv_status IS DISTINCT FROM 'in_stock'            THEN RETURN 'skipped_no_fulfillment_path';   END IF;
  IF v_qty IS NULL OR v_qty <= 0                         THEN RETURN 'skipped_no_fulfillment_qty';    END IF;

  UPDATE public.standardized_products
     SET published = true, delist_reason = NULL, updated_at = now()
   WHERE supplier_product_id = p_supplier_product_id;

  INSERT INTO public.publication_audit_log
    (supplier_product_id, from_published, to_published, action, reason, actor, run_id, evidence_checked_at)
  VALUES (p_supplier_product_id, v_published, true, 'relist', 'inventory_restored', p_actor, p_run_id, v_checked_at);

  RETURN 'relisted';
END $$;

COMMENT ON FUNCTION public.set_publication_from_availability(text, boolean, text, text, integer) IS
  'Availability-driven publication writer. Delist requires fresh confirmed-unavailable Open API '
  'evidence; relist additionally requires provenance proving the inventory lifecycle delisted it, '
  'plus every sellable_products quality gate. Manual holds block both. Writes publication_audit_log. '
  'Never touches inventory_status or any warehouse field. Returns a status; never raises.';

REVOKE ALL ON FUNCTION public.set_publication_from_availability(text, boolean, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_publication_from_availability(text, boolean, text, text, integer) TO service_role;

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- DROP FUNCTION IF EXISTS public.set_publication_from_availability(text, boolean, text, text, integer);
--
-- To reverse actual publication changes, replay publication_audit_log:
--   UPDATE public.standardized_products sp
--      SET published = a.from_published,
--          delist_reason = CASE WHEN a.from_published THEN NULL ELSE sp.delist_reason END,
--          updated_at = now()
--     FROM public.publication_audit_log a
--    WHERE a.supplier_product_id = sp.supplier_product_id
--      AND a.run_id = '<run_id>';
-- ============================================================================
