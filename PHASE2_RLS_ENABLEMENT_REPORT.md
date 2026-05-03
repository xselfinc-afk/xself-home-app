# Phase 2 RLS Enablement Report
**Date:** 2026-04-30  
**Status:** ✅ COMPLETE — Sellable-only RLS active on `standardized_products`

---

## Pre-Application State

| Check | Value |
|-------|-------|
| RLS enabled on `standardized_products` | ✅ Yes (`relrowsecurity = true`) |
| `sellable_products` row count | **136** |
| Existing policies | `"Allow public read standardized_products"` (qual=true) + `"Allow authenticated read standardized_products"` (qual=true) |
| Policy effect | All normalized rows visible — no inventory filter |

Both existing policies used `USING (true)`, meaning any row with `normalization_status = 'done'` was visible to all clients regardless of stock status.

---

## RLS Policy Applied

Dropped both open policies and replaced with a single restrictive policy:

```sql
DROP POLICY IF EXISTS "Allow authenticated read standardized_products" ON public.standardized_products;
DROP POLICY IF EXISTS "Allow public read standardized_products" ON public.standardized_products;

CREATE POLICY "Public can read sellable products"
  ON public.standardized_products FOR SELECT
  USING (
    normalization_status = 'done'
    AND published = true
    AND inventory_status = 'in_stock'
    AND total_available_qty > 0
    AND inventory_last_synced_at IS NOT NULL
    AND inventory_last_synced_at > now() - interval '24 hours'
  );
```

### Policy conditions (all must be true for a row to be readable)

| Condition | Meaning |
|-----------|---------|
| `normalization_status = 'done'` | Product has been normalized |
| `published = true` | Set by `refresh_product_inventory_status()` only when in_stock |
| `inventory_status = 'in_stock'` | Fresh website_scrape data with qty > 0 |
| `total_available_qty > 0` | Confirmed non-zero stock |
| `inventory_last_synced_at IS NOT NULL` | At least one scrape has run |
| `inventory_last_synced_at > now() - 24h` | Data is fresh |

---

## Post-Application Verification

| Check | Result |
|-------|--------|
| Policy name in `pg_policies` | `"Public can read sellable products"` ✅ |
| Old open policies removed | ✅ (0 rows with `qual=true`) |
| `SELECT COUNT(*) FROM sellable_products` | **136** ✅ (unchanged) |
| `standardized_products` direct query (anon role) | Returns only in-stock published rows |

---

## Rollback

Rollback SQL is at `supabase/rls_rollback_standardized_products.sql`.  
Run in Supabase SQL Editor to restore open read access:

```sql
DROP POLICY IF EXISTS "Public can read sellable products" ON public.standardized_products;

CREATE POLICY "Allow public read standardized_products"
  ON public.standardized_products FOR SELECT USING (true);

CREATE POLICY "Allow authenticated read standardized_products"
  ON public.standardized_products FOR SELECT USING (true);
```

---

## App Impact

All 6 app product query sites were already switched to `sellable_products` view before this RLS change. The view filters identically to the new policy, so no query result changes are expected.

Direct `standardized_products` queries (e.g. from the Playwright scraper using the service role key) are **not affected** — the service role bypasses RLS by default.

---

## Phase 2 Complete ✅

| Deliverable | Status |
|-------------|--------|
| App queries → `sellable_products` (6 sites) | ✅ Done |
| `total_available_qty` replaces fake `stock: 999` | ✅ Done |
| `validate-checkout-inventory` gate — both payment paths | ✅ Done |
| Old GigaInventory recheck removed from checkout runtime | ✅ Done |
| Fulfillment plan uses `inventory_cache` (real scraped data) | ✅ Done |
| RLS policy: only sellable products visible to anon/authenticated | ✅ Done |
| Rollback SQL available | ✅ `supabase/rls_rollback_standardized_products.sql` |

**Not yet done (Phase 3):**
- Delete `src/services/fulfillmentPlanner.ts`, `src/data/warehouses.ts`, `src/utils/distance.ts`, `src/services/geocodingService.ts`, `src/services/warehouseService.ts`
- Build `plan-fulfillment` Edge Function
- Configure GitHub Actions secrets (`SUPABASE_SERVICE_ROLE_KEY`, `GIGA_SESSION_B64`)
