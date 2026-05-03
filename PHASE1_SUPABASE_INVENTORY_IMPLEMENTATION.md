# Phase 1: Supabase Inventory Source of Truth — Implementation
**Date:** 2026-04-30  
**Scope:** Backend only — SQL migration, aggregation functions, view, edge function.  
**App code:** Not modified. No UI changes.

---

## Deliverables

| File | Purpose |
|------|---------|
| `supabase/inventory_source_of_truth.sql` | Full migration: columns, warehouses table, functions, view, pg_cron |
| `supabase/functions/validate-checkout-inventory/index.ts` | Edge Function: pre-payment inventory gate |

---

## 1. SQL Migration

**File:** `supabase/inventory_source_of_truth.sql`

Run this in the Supabase SQL Editor. All statements are idempotent (`IF NOT EXISTS` / `OR REPLACE`).

**Do NOT run Section 6 (RLS policy change) until the Playwright scraper has been run and at least one product has `inventory_status = 'in_stock'`. Running it before that hides all products.**

### 1a. New columns on `standardized_products`

```sql
ALTER TABLE public.standardized_products
  ADD COLUMN IF NOT EXISTS published                 boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inventory_status          text         NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS total_available_qty       integer      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS available_warehouse_count integer      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS has_ca_pickup             boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_valid_inventory       boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inventory_last_synced_at  timestamptz  NULL;
```

| Column | Type | Default | Set by |
|--------|------|---------|--------|
| `published` | boolean | false | `refresh_product_inventory_status()` |
| `inventory_status` | text | 'unknown' | `refresh_product_inventory_status()` |
| `total_available_qty` | integer | 0 | `refresh_product_inventory_status()` |
| `available_warehouse_count` | integer | 0 | `refresh_product_inventory_status()` |
| `has_ca_pickup` | boolean | false | `refresh_product_inventory_status()` |
| `has_valid_inventory` | boolean | false | `refresh_product_inventory_status()` |
| `inventory_last_synced_at` | timestamptz | NULL | `refresh_product_inventory_status()` |

`inventory_status` values:

| Value | Meaning |
|-------|---------|
| `'in_stock'` | `website_scrape` data, fresh (≤24h), total qty > 0 |
| `'out_of_stock'` | `website_scrape` data, fresh, all warehouses qty = 0 |
| `'stale'` | `website_scrape` data exists but older than 24 hours |
| `'unknown'` | No `website_scrape` data has ever been written |

`has_valid_inventory` and `published` are both set to `true` only when `inventory_status = 'in_stock'`. The app never writes these columns.

### 1b. `warehouses` table

Moves 34 warehouse entries out of `src/data/warehouses.ts` into Supabase. `lat`/`lng` columns are NULL until a one-time geocoding script populates them. The future `plan-fulfillment` edge function reads pre-geocoded coordinates — no Google Maps calls at checkout request time.

```sql
CREATE TABLE IF NOT EXISTS public.warehouses (
  code              text PRIMARY KEY,
  label             text NOT NULL,
  address           text NOT NULL,
  state             text NOT NULL,
  city              text,
  lat               numeric(9,6),   -- populated by geocoding script (Phase 2)
  lng               numeric(9,6),
  supports_pickup   boolean NOT NULL DEFAULT false,
  supports_shipping boolean NOT NULL DEFAULT true,
  active            boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
```

`supports_pickup = true` for all 18 CA-prefixed codes (matches existing `/^CA/i` pickup gate in fulfillmentPlanner.ts).

---

## 2. Aggregation Functions

### `refresh_product_inventory_status(p_supplier_product_id text)`

Called by the Playwright scraper (`syncGigaFurnitureInventory.ts`) after writing inventory rows.

**Logic:**
1. Query `inventory_cache WHERE product_id = $1 AND source_type = 'website_scrape' AND sync_status = 'ok'`
2. Aggregate: `SUM(quantity)`, `COUNT(warehouses with qty > 0)`, `bool_or(CA pickup)`, `MAX(last_synced_at)`
3. Set status:
   - `v_last_synced IS NULL` → `'unknown'`
   - `v_last_synced < now() - 24h` → `'stale'`
   - `v_total_qty = 0` → `'out_of_stock'`
   - else → `'in_stock'`
4. `UPDATE standardized_products SET inventory_status, total_available_qty, available_warehouse_count, has_ca_pickup, has_valid_inventory, published, inventory_last_synced_at`

**Key guarantee:** Only `source_type = 'website_scrape'` rows are read. `price_synthesis` and `api_availability_only` data never affects `has_valid_inventory` or `published`.

### `refresh_all_inventory_status()` → integer

Bulk variant — loops over every distinct `product_id` in `inventory_cache` where `source_type = 'website_scrape'`, calls the single-product function for each. Returns count of products updated.

Use for:
- Manual backfills after first scraper run
- Recovery after a data issue

### `sweep_stale_inventory()` → integer

Flips products from `in_stock` to `stale` when `inventory_last_synced_at < now() - 24h`. Called hourly by pg_cron. Returns count of products flipped.

---

## 3. `sellable_products` View

```sql
CREATE OR REPLACE VIEW public.sellable_products AS
SELECT sp.*
FROM public.standardized_products sp
WHERE sp.normalization_status     = 'done'
  AND sp.published                = true
  AND sp.inventory_status         = 'in_stock'
  AND sp.total_available_qty      > 0
  AND sp.inventory_last_synced_at > (now() - interval '24 hours');
```

- Schema-compatible with `standardized_products` (returns `sp.*`)
- Drop-in replacement for app's `from('standardized_products')` queries (Phase 2)
- Filters out: not normalized, no inventory, stale inventory, zero qty

---

## 4. `validate-checkout-inventory` Edge Function

**File:** `supabase/functions/validate-checkout-inventory/index.ts`

### Input

```json
{
  "items": [
    { "sku": "N725S412541K", "productId": "12345", "qty": 2 },
    { "sku": "M831T990123X", "productId": "67890", "qty": 1 }
  ]
}
```

- `sku` — display SKU (GIGA item code), used in failure messages only
- `productId` — `supplier_product_id` / `inventory_cache.product_id` — the canonical key
- `qty` — requested quantity

### Output

```json
{
  "valid": true,
  "failures": []
}
```

Or on failure:

```json
{
  "valid": false,
  "failures": [
    { "sku": "N725S412541K", "productId": "12345", "reason": "insufficient_qty", "available": 1 },
    { "sku": "M831T990123X", "productId": "67890", "reason": "unknown", "available": 0 }
  ]
}
```

### Failure reasons

| Reason | Meaning |
|--------|---------|
| `out_of_stock` | Fresh website_scrape data shows qty = 0 across all warehouses |
| `stale` | website_scrape data exists but is older than 24 hours |
| `unknown` | No website_scrape data has ever been written for this product |
| `insufficient_qty` | Total available < requested qty |

### Logic

1. Query `inventory_cache` WHERE `product_id IN (...)` AND `source_type = 'website_scrape'` AND `sync_status = 'ok'` AND `last_synced_at >= now() - 24h`
2. Sum quantities per `product_id` across all warehouses
3. For products with no fresh data: run a second query without the freshness filter to distinguish `stale` vs `unknown`
4. Return `valid: true` only if every cart item has sufficient fresh real inventory

### Deploy

```bash
supabase functions deploy validate-checkout-inventory
```

---

## 5. pg_cron Setup

Enable pg_cron in Supabase Dashboard → Database → Extensions → `pg_cron`, then run:

```sql
SELECT cron.schedule(
  'sweep-stale-inventory',
  '0 * * * *',
  $$ SELECT public.sweep_stale_inventory(); $$
);
```

Verify it was registered:

```sql
SELECT jobname, schedule, command, active FROM cron.job WHERE jobname = 'sweep-stale-inventory';
```

---

## 6. Test Queries

Run these in the Supabase SQL Editor after the migration to verify the schema.

### Verify columns exist

```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'standardized_products'
  AND column_name  IN (
    'published', 'inventory_status', 'total_available_qty',
    'available_warehouse_count', 'has_ca_pickup',
    'has_valid_inventory', 'inventory_last_synced_at'
  )
ORDER BY column_name;
```

Expected: 7 rows returned.

### Verify warehouses table

```sql
SELECT COUNT(*), COUNT(*) FILTER (WHERE supports_pickup) AS pickup_count
FROM public.warehouses;
```

Expected: `count = 34`, `pickup_count = 18`.

### Verify functions exist

```sql
SELECT routine_name, routine_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'refresh_product_inventory_status',
    'refresh_all_inventory_status',
    'sweep_stale_inventory'
  );
```

Expected: 3 rows returned.

### Verify sellable_products view

```sql
SELECT COUNT(*) FROM public.sellable_products;
```

Expected: 0 (no products have been scraped yet — all have `inventory_status = 'unknown'`).

### Manually test the aggregation function (after scraper runs)

```sql
-- After syncGigaFurnitureInventory.ts writes at least one product:
SELECT public.refresh_product_inventory_status('<supplier_product_id>');

SELECT supplier_product_id, inventory_status, total_available_qty,
       available_warehouse_count, has_valid_inventory, published,
       inventory_last_synced_at
FROM public.standardized_products
WHERE supplier_product_id = '<supplier_product_id>';
```

### Simulate the staleness sweep

```sql
-- Temporarily set a product's sync time to 25 hours ago, then sweep
UPDATE public.inventory_cache
SET last_synced_at = now() - interval '25 hours'
WHERE product_id = '<supplier_product_id>'
  AND source_type = 'website_scrape';

SELECT public.refresh_product_inventory_status('<supplier_product_id>');
-- inventory_status should now be 'stale'

SELECT public.sweep_stale_inventory();
-- published and has_valid_inventory should now be false
```

### Test validate-checkout-inventory edge function

```bash
# Replace <SUPABASE_URL> and <ANON_KEY> with values from Dashboard → Settings → API
curl -X POST '<SUPABASE_URL>/functions/v1/validate-checkout-inventory' \
  -H 'Authorization: Bearer <ANON_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"sku":"N725S412541K","productId":"<product_id>","qty":1}]}'
```

Expected before scraper runs:
```json
{ "valid": false, "failures": [{ "reason": "unknown", "available": 0, ... }] }
```

Expected after scraper runs with qty > 0:
```json
{ "valid": true, "failures": [] }
```

---

## 7. Integration Points for Phase 2

When Phase 2 begins (app refactor), the following changes connect to this infrastructure:

| Change | Detail |
|--------|--------|
| Switch product queries to `sellable_products` | Replace `from('standardized_products').eq('normalization_status','done')` with `from('sellable_products')` in 5 app locations |
| Apply RLS policy change | Run Section 6 of `inventory_source_of_truth.sql` AFTER scraper has run |
| Call `validate-checkout-inventory` in CheckoutScreen | Before `plan-fulfillment` — block checkout if `valid: false` |
| Call `refresh_product_inventory_status()` in scraper | Add to `syncGigaFurnitureInventory.ts` after each `upsert` to `inventory_cache` |
| Schedule scraper | GitHub Action or pg_cron daily/every 6h |

---

## 8. Execution Order for Phase 1

1. **Run** `supabase/inventory_source_of_truth.sql` in Supabase SQL Editor (Sections 1–5 and 7)
2. **Verify** with test queries in Section 6 above
3. **Deploy** edge function: `supabase functions deploy validate-checkout-inventory`
4. **Enable** pg_cron extension in Dashboard, then run the `cron.schedule(...)` statement
5. **Do NOT** run Section 6 (RLS change) until after scraper has populated real inventory

Phase 1 complete. App continues to work unchanged. Supabase is now ready to accept real inventory data.
