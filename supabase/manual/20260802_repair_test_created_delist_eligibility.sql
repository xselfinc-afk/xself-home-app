-- ============================================================================
-- SCOPED REPAIR — NOT EXECUTED. Review, then run manually if approved.
--
-- WHY
-- ---
-- Two SKUs reached `eligible_for_delist` during bounded persistence testing. They were advanced by
-- immediate re-runs of the same command, not by separate 3-day observation cycles:
--
--   N707P186617W   consecutive_out_of_stock = 3   (appeared in both the 5-SKU and 25-SKU batches)
--   W1445P419757   consecutive_out_of_stock = 2
--
-- Each had exactly ONE genuine observation cycle. Every further increment came from a retry that
-- the (now added) minimum-confirmation-interval guard would reject as duplicate_or_too_soon.
--
-- WHAT THIS CHANGES
-- -----------------
--   workflow_state           -> 'pending_out_of_stock'   (correct first-strike state)
--   consecutive_out_of_stock -> 1                        (the one genuine cycle)
--
-- WHAT THIS PRESERVES
-- -------------------
--   * product_availability_current — the confirmed availability evidence is CORRECT and untouched.
--     Both SKUs genuinely are unavailable at the supplier; only the strike COUNT was inflated.
--   * product_availability_checks  — the full audit history stays intact, including the retries.
--   * last_observed_at             — left as-is, so the interval clock keeps running from the most
--     recent observation. Resetting it would let the very next scan count as a second strike,
--     re-creating the defect this repair exists to undo.
--   * published / sellable_products — NOT touched. Neither SKU was ever delisted.
--
-- Scoped to exactly two supplier_product_ids. No other row can match.
-- ============================================================================

BEGIN;

-- Verify the pre-state before changing anything (expect exactly the 2 rows described above).
SELECT supplier_product_id, workflow_state, consecutive_out_of_stock, consecutive_in_stock, last_observed_at
FROM public.inventory_workflow_states
WHERE supplier_product_id IN ('N707P186617W', 'W1445P419757');

UPDATE public.inventory_workflow_states
SET workflow_state           = 'pending_out_of_stock',
    consecutive_out_of_stock = 1,
    transition_reason        = 'repair: strikes inflated by bounded-test retries, not by separate observation cycles',
    updated_at               = now()
WHERE supplier_product_id IN ('N707P186617W', 'W1445P419757')
  AND workflow_state = 'eligible_for_delist';   -- no-op if already repaired (idempotent)

-- Confirm exactly 2 rows changed and nothing else moved.
SELECT supplier_product_id, workflow_state, consecutive_out_of_stock
FROM public.inventory_workflow_states
WHERE supplier_product_id IN ('N707P186617W', 'W1445P419757');

SELECT count(*) FILTER (WHERE workflow_state = 'eligible_for_delist') AS still_eligible_expect_0,
       count(*)                                                        AS total_workflow_rows_expect_126
FROM public.inventory_workflow_states;

COMMIT;

-- ============================================================================
-- ROLLBACK — restores the exact pre-repair values
-- ============================================================================
-- BEGIN;
-- UPDATE public.inventory_workflow_states
-- SET workflow_state = 'eligible_for_delist', consecutive_out_of_stock = 3, updated_at = now()
-- WHERE supplier_product_id = 'N707P186617W';
-- UPDATE public.inventory_workflow_states
-- SET workflow_state = 'eligible_for_delist', consecutive_out_of_stock = 2, updated_at = now()
-- WHERE supplier_product_id = 'W1445P419757';
-- COMMIT;
--
-- Nothing else is altered in either direction, so rollback is exact.
-- ============================================================================
