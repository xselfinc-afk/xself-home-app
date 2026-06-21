-- 20260621_guard_onsite_merchant_inventory.sql
--
-- PURPOSE: Prevent ON-SITE MERCHANT warehouse codes from ever becoming ACTIVE
-- canonical stock in inventory_cache. The supplier portal and every inventory
-- sync path (Node scripts AND the deployed edge functions giga-warehouse-stock /
-- verify-inventory-live) can write merchant-prefixed warehouse codes such as
-- B2761-CA1, B082-CA4, B062-FL1, T2574-OH1, W2178-GA3. Those are platform-merchant
-- "On-Site" warehouses, NOT GIGA self-operated canonical warehouses, and must not
-- drive sellable_products / plan-fulfillment. This DB-level guard covers ALL write
-- paths at once (no app or edge-function changes, no redeploys).
--
-- SCOPE (intentionally narrow): quarantine ONLY codes matching the merchant-prefix
-- pattern  ^.+-[A-Z]{2}[0-9]+$  that are NOT present in public.warehouses(code).
--   * Canonical codes (CA3, NJ1, AT4, NJX3, CAN2, ...) have no hyphen -> untouched.
--   * Bare non-canonical codes (CA1, NJ5, NJX6) have no hyphen -> NOT matched, NOT
--     quarantined (separate investigation; may be real GIGA self-operated warehouses
--     to be seeded into warehouses later). This guard deliberately leaves them alone.
--
-- BEHAVIOR: write-time BEFORE INSERT OR UPDATE. For a matching row it forces
-- sync_status='error' and tags raw_payload.quarantine_reason='on_site_merchant_not_canonical'.
-- quantity and all existing raw_payload keys are preserved; the row still writes but
-- stays INACTIVE (refresh_product_inventory_status and plan-fulfillment both require
-- sync_status='ok'). Applying this migration does NOT modify existing rows (write-time
-- only); existing On-Site rows are already soft-disabled, and CA1/NJ5/NJX6 are untouched.

CREATE OR REPLACE FUNCTION public.guard_onsite_merchant_inventory()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only merchant-prefixed On-Site codes that are NOT canonical warehouses.
  IF NEW.warehouse_code ~ '^.+-[A-Z]{2}[0-9]+$'
     AND NOT EXISTS (SELECT 1 FROM public.warehouses w WHERE w.code = NEW.warehouse_code)
  THEN
    NEW.sync_status := 'error';
    NEW.raw_payload := COALESCE(NEW.raw_payload, '{}'::jsonb)
                       || jsonb_build_object('quarantine_reason', 'on_site_merchant_not_canonical');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_onsite_merchant_inventory ON public.inventory_cache;
CREATE TRIGGER trg_guard_onsite_merchant_inventory
  BEFORE INSERT OR UPDATE ON public.inventory_cache
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_onsite_merchant_inventory();
