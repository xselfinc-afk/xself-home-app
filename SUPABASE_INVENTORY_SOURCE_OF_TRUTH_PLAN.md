# Supabase Inventory Source of Truth — Migration Plan
**Date:** 2026-04-30 (revised)  
**Architecture rule:** The app is a reader and display layer only. All inventory validation and fulfillment computation run in Supabase Edge Functions.

```
App           = reader / display only
Supabase      = inventory source of truth
Edge Functions = validation + fulfillment computation
Scraper        = real warehouse inventory ingestion
```

---

## 1. Current App-Side Calculation Risks

| Risk | Location | Impact |
|------|----------|--------|
| All products shown regardless of stock | App.tsx:547, 1086, 1727, 2033; DiscoverScreen:96 — filter only `normalization_status='done'` | Out-of-stock products displayed and purchasable |
| Fake 999/0 inventory synthesis | `giga-warehouse-stock/index.ts` lines 272–285 | Fulfillment planner always finds "stock"; quantity check is meaningless |
| Fulfillment planned entirely in app | `fulfillmentPlanner.ts` 277 lines of geocoding + Haversine + strategy logic | Every checkout recalculates from scratch; results differ per device; uses fake stock |
| Geography-only fallback proceeds to payment | `CheckoutScreen.tsx` lines 255–272 | Orders placed with zero inventory confirmation |
| No-stock item assigned to nearest warehouse | `fulfillmentPlanner.ts` lines 188–199 — optimistic silent assignment | Items assigned to warehouses that cannot fulfill them |
| `stock: 999` hardcoded in adapter | `detailProductAdapter.ts` line 121 | Product cards always show in-stock regardless of reality |
| Price API `skuAvailable` used as stock signal | `giga-warehouse-stock/index.ts` line 275 | Binary flag treated as warehouse-level quantity data |
| No inventory age enforcement on product feed | All product queries | Stale or never-scraped products shown in Home/Discover |
| Warehouse list hardcoded in app bundle | `src/data/warehouses.ts` — 35 entries | App carries stale geography; cannot be updated without a release |
| Distance calculation in app | `src/utils/distance.ts`, `src/services/fulfillmentPlanner.ts` | Client computes warehouse ranking; incorrect results on low-end devices are undetectable |
| Geocoding in app | `src/services/geocodingService.ts`, called from `fulfillmentPlanner.ts` | Google Maps API key exposed client-side; results not auditable |

---

## 2. Supabase Table / View Design

### 2a. Columns to Add to `standardized_products`

```sql
ALTER TABLE public.standardized_products
  ADD COLUMN IF NOT EXISTS published                 boolean       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inventory_status          text          NOT NULL DEFAULT 'unknown',
  -- 'in_stock' | 'out_of_stock' | 'stale' | 'unknown'
  ADD COLUMN IF NOT EXISTS total_available_qty       integer       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS available_warehouse_count integer       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS has_ca_pickup             boolean       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inventory_last_synced_at  timestamptz   NULL;
```

These fields are written only by the scraper and pg_cron. The app never writes them.

**Sellable rule:**
```
published = true
AND inventory_status = 'in_stock'
AND total_available_qty > 0
AND inventory_last_synced_at > now() - interval '24 hours'
```

### 2b. `warehouses` Table (move out of app bundle)

```sql
CREATE TABLE IF NOT EXISTS public.warehouses (
  code              text PRIMARY KEY,        -- 'CA2', 'NJ1', etc.
  label             text NOT NULL,           -- display name
  address           text NOT NULL,           -- full street address for geocoding
  state             text NOT NULL,           -- 'CA' | 'NJ' | 'MD' | 'GA' | 'TX'
  city              text,
  lat               numeric(9,6),            -- pre-geocoded, populated once
  lng               numeric(9,6),
  supports_pickup   boolean NOT NULL DEFAULT false,
  supports_shipping boolean NOT NULL DEFAULT true,
  active            boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.warehouses TO anon, authenticated;
```

Pre-populate with the 35 entries from `src/data/warehouses.ts`. The `lat`/`lng` columns are populated once by running the geocoding script server-side, so the Edge Function never needs to call Google Maps for warehouse addresses at request time.

### 2c. `sellable_products` View

```sql
CREATE OR REPLACE VIEW public.sellable_products AS
SELECT sp.*
FROM public.standardized_products sp
WHERE sp.normalization_status      = 'done'
  AND sp.published                 = true
  AND sp.inventory_status          = 'in_stock'
  AND sp.total_available_qty       > 0
  AND sp.inventory_last_synced_at  > (now() - interval '24 hours');

GRANT SELECT ON public.sellable_products TO anon, authenticated;
```

Drop-in replacement for the app's `from('standardized_products')` queries — schema-compatible.

### 2d. RLS Update for `standardized_products`

```sql
DROP POLICY IF EXISTS "Public can read normalized products" ON public.standardized_products;

CREATE POLICY "Public can read sellable products"
  ON public.standardized_products FOR SELECT
  USING (
    normalization_status = 'done'
    AND published = true
    AND inventory_status = 'in_stock'
    AND total_available_qty > 0
    AND inventory_last_synced_at > (now() - interval '24 hours')
  );
```

### 2e. Inventory Aggregation Function

```sql
CREATE OR REPLACE FUNCTION public.refresh_product_inventory_status(p_supplier_product_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_total_qty    integer;
  v_wh_count     integer;
  v_has_ca       boolean;
  v_last_synced  timestamptz;
  v_status       text;
BEGIN
  SELECT
    COALESCE(SUM(GREATEST(ic.quantity, 0)), 0),
    COUNT(*) FILTER (WHERE ic.quantity > 0),
    bool_or(ic.warehouse_state = 'CA' AND ic.quantity > 0 AND ic.supports_pickup),
    MAX(ic.last_synced_at)
  INTO v_total_qty, v_wh_count, v_has_ca, v_last_synced
  FROM inventory_cache ic
  WHERE ic.supplier_product_id = p_supplier_product_id
    AND ic.sync_status = 'ok'
    AND ic.source_type = 'website_scrape';  -- ONLY real scraped data

  IF v_last_synced IS NULL THEN
    v_status := 'unknown';
  ELSIF v_last_synced < now() - interval '24 hours' THEN
    v_status := 'stale';
  ELSIF v_total_qty = 0 THEN
    v_status := 'out_of_stock';
  ELSE
    v_status := 'in_stock';
  END IF;

  UPDATE public.standardized_products SET
    inventory_status          = v_status,
    total_available_qty       = v_total_qty,
    available_warehouse_count = v_wh_count,
    has_ca_pickup             = COALESCE(v_has_ca, false),
    inventory_last_synced_at  = v_last_synced,
    published                 = (v_status = 'in_stock'),
    updated_at                = now()
  WHERE supplier_product_id = p_supplier_product_id;
END;
$$;
```

### 2f. Staleness Sweep (pg_cron — hourly)

```sql
SELECT cron.schedule('mark-stale-inventory', '0 * * * *', $$
  UPDATE public.standardized_products
  SET inventory_status = 'stale', published = false
  WHERE inventory_status = 'in_stock'
    AND inventory_last_synced_at < now() - interval '24 hours';
$$);
```

---

## 3. Sellable Product Rules (enforced in DB, never in app)

| Rule | DB Column | Required Value |
|------|-----------|----------------|
| Normalized | `normalization_status` | `'done'` |
| Explicitly published | `published` | `true` |
| Has real inventory | `inventory_status` | `'in_stock'` |
| Non-zero total stock | `total_available_qty` | `> 0` |
| Fresh inventory | `inventory_last_synced_at` | `> now() - 24h` |
| Source is real | `inventory_cache.source_type` | `'website_scrape'` only |

Products with only `source_type = 'price_synthesis'` / `'api_availability_only'` are **never sellable**.

---

## 4. New Edge Functions

### 4a. `validate-checkout-inventory`

```
Input:  { items: { sku: string; productId: string; qty: number }[] }
Output: { valid: boolean; failures: { sku: string; reason: 'out_of_stock'|'stale'|'unknown'; available: number }[] }
```

Logic (server-side, no app involvement):
1. Query `inventory_cache` for all requested SKUs
2. Require `source_type = 'website_scrape'`, `sync_status = 'ok'`, `last_synced_at > now() - 24h`
3. For each SKU: `SUM(quantity WHERE quantity > 0) >= requested qty`
4. Return `valid: true` only if all items pass

### 4b. `plan-fulfillment` ← NEW

```
Input:
  {
    items: { sku: string; productId: string; name: string; price: number; qty: number }[];
    address: { line1: string; line2?: string; city: string; state: string; zip: string; country: string };
    preference?: 'pickup' | 'delivery'   // optional user preference
  }

Output:
  {
    status: 'ok' | 'invalid_address' | 'no_inventory' | 'partial_inventory';
    groups: FulfillmentGroup[];
    totalShipping: number;
    isSingleWarehouse: boolean;
    unfulfilledSkus: string[];           // empty when status = 'ok'
  }

FulfillmentGroup:
  {
    warehouseCode: string;
    warehouseLabel: string;
    warehouseAddress: string;
    distanceMiles: number;
    isPickup: boolean;
    shippingFee: number;                 // 0 for pickup, 99 for delivery
    items: { sku: string; name: string; qty: number }[];
    estimatedDelivery: string;
    pickupWindow?: { earliest: string; latest: string };  // ISO dates, pickup only
  }
```

**Server-side logic:**

```
1. Geocode customer address
   - Call Google Maps Geocoding API (key in Supabase secret GOOGLE_MAPS_API_KEY)
   - If geocoding fails → return { status: 'invalid_address' }

2. Load warehouse coordinates
   - SELECT code, label, address, lat, lng, supports_pickup, supports_shipping
     FROM warehouses
     WHERE active = true AND lat IS NOT NULL
   - No geocoding needed — coordinates pre-populated in table

3. Rank warehouses by Haversine distance to customer coords
   - Computed in Deno (same formula as current distance.ts)
   - Sort ascending

4. Load inventory from inventory_cache
   - SELECT supplier_product_id, warehouse_code, quantity
     FROM inventory_cache
     WHERE supplier_product_id = ANY(productIds)
       AND source_type = 'website_scrape'
       AND sync_status = 'ok'
       AND last_synced_at > now() - interval '24 hours'
       AND quantity > 0
   - Build: Map<sku → Map<warehouseCode → quantity>>

5. Strategy 1 — single warehouse (all items in one place)
   - Prefer CA pickup candidates (distance ≤ 30 mi, supports_pickup = true)
   - Then any warehouse for shipping
   - Pick nearest that has ALL items in sufficient quantity

6. Strategy 2 — multi-warehouse split
   - Assign each item to nearest warehouse with sufficient stock
   - If any item has NO stock anywhere → add to unfulfilledSkus

7. If unfulfilledSkus is non-empty → return { status: 'partial_inventory' }
   - App blocks checkout and shows which items are unavailable

8. Apply user preference (pickup/delivery) to override isPickup flags if preference = 'delivery'

9. Return complete FulfillmentGroup[] with fees, ETAs, pickup windows
```

**Key guarantee:** The edge function never assigns an item to a warehouse where `quantity = 0`. It never uses geography-only fallback as a valid fulfillment result. If inventory is insufficient, it returns `status: 'partial_inventory'` — not a fake plan.

---

## 5. Checkout Flow (revised — three server calls, strict order)

```
User enters address → address saved in form state (no local computation)
  │
  ▼
User taps "Review Order" or address is complete
  │
  ▼
[STEP 1] call validate-checkout-inventory
  │  Input: cart items + qtys
  │  ├─ FAIL → show "Items unavailable" — block entire checkout
  │  └─ PASS → proceed
  │
  ▼
[STEP 2] call plan-fulfillment
  │  Input: cart items + customer address + preference
  │  ├─ status: 'invalid_address'      → show "We couldn't verify your address"
  │  ├─ status: 'no_inventory'         → show "Items out of stock" — block
  │  ├─ status: 'partial_inventory'    → show which SKUs unavailable — block
  │  └─ status: 'ok'                   → display returned FulfillmentGroup[] in UI
  │
  ▼
User selects delivery or pickup (if both available)
  │  App re-calls plan-fulfillment with preference set
  │
  ▼
User taps "Place Order"
  │
  ▼
[STEP 3] createPendingOrder (existing)
  │  Uses fulfillment plan returned from server (not recalculated locally)
  │
  ▼
create-payment-intent → Stripe PaymentSheet → confirmOrder
```

**Payment never starts unless steps 1 and 2 both return success.** There is no local fallback. If `plan-fulfillment` fails, checkout is blocked — full stop.

---

## 6. Files to Remove from App

These files contain computation that moves entirely to the `plan-fulfillment` Edge Function:

| File | Action | Reason |
|------|--------|--------|
| `src/services/fulfillmentPlanner.ts` | **Delete** | All logic moves to `plan-fulfillment` edge function |
| `src/data/warehouses.ts` | **Delete** | Warehouse list moves to `warehouses` Supabase table |
| `src/utils/distance.ts` | **Delete** | Haversine calculation moves to edge function |
| `src/services/geocodingService.ts` | **Delete** | Geocoding moves to edge function (Google Maps key becomes a server secret) |
| `src/services/warehouseService.ts` | **Delete** | Nearest warehouse logic subsumed by `plan-fulfillment` |

### `src/screens/CheckoutScreen.tsx` — Significant simplification

Remove entirely:
- All imports of `fulfillmentPlanner`, `gigaInventoryService`, `geocodingService`, `warehouseService`
- `planFulfillment()` and `planFulfillmentFallback()` calls (lines ~233–290)
- `fetchSkuWarehouseStock()` call
- `planFingerprint()` and fingerprint comparison logic
- `FulfillmentPlan`, `FulfillmentGroup` local type usage (now received from server)
- `isFallback` guard (the server never returns a fallback plan)
- `overrideGroupsToDelivery()` call (server handles preference)
- `warehouseCoordCache` module-level cache reference

Replace with:
```typescript
// New: call plan-fulfillment edge function
const { data, error } = await supabase.functions.invoke('plan-fulfillment', {
  body: { items: orderItems, address: addressObject, preference: userPreference }
});
if (error || data.status !== 'ok') {
  // show appropriate error based on data.status
  return;
}
setActivePlan(data);  // data is the server-returned FulfillmentGroup[]
```

The display logic (rendering warehouse names, distances, ETAs, pickup windows, shipping fees) is **unchanged** — it reads the same fields, just sourced from the server response instead of a locally computed object.

---

## 7. Migration SQL (full run order)

```sql
-- ── Step 1: warehouses table ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.warehouses (
  code              text PRIMARY KEY,
  label             text NOT NULL,
  address           text NOT NULL,
  state             text NOT NULL,
  city              text,
  lat               numeric(9,6),
  lng               numeric(9,6),
  supports_pickup   boolean NOT NULL DEFAULT false,
  supports_shipping boolean NOT NULL DEFAULT true,
  active            boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.warehouses TO anon, authenticated;

-- Seed from src/data/warehouses.ts (35 rows — run separate INSERT script)

-- ── Step 2: Add columns to standardized_products ─────────────────────────────
ALTER TABLE public.standardized_products
  ADD COLUMN IF NOT EXISTS published                 boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inventory_status          text        NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS total_available_qty       integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS available_warehouse_count integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS has_ca_pickup             boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inventory_last_synced_at  timestamptz NULL;

-- ── Step 3: Index for sellable_products view ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sp_sellable
  ON public.standardized_products
  (normalization_status, published, inventory_status, total_available_qty, inventory_last_synced_at);

-- ── Step 4: Inventory aggregation function ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_product_inventory_status(p_supplier_product_id text)
-- (full body in section 2e above)

-- ── Step 5: sellable_products view ───────────────────────────────────────────
CREATE OR REPLACE VIEW public.sellable_products AS
SELECT * FROM public.standardized_products
WHERE normalization_status       = 'done'
  AND published                  = true
  AND inventory_status           = 'in_stock'
  AND total_available_qty        > 0
  AND inventory_last_synced_at   > (now() - interval '24 hours');
GRANT SELECT ON public.sellable_products TO anon, authenticated;

-- ── Step 6: Update RLS ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Public can read normalized products" ON public.standardized_products;
CREATE POLICY "Public can read sellable products"
  ON public.standardized_products FOR SELECT
  USING (
    normalization_status = 'done'
    AND published = true
    AND inventory_status = 'in_stock'
    AND total_available_qty > 0
    AND inventory_last_synced_at > (now() - interval '24 hours')
  );

-- ── Step 7: Initial backfill ──────────────────────────────────────────────────
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT supplier_product_id FROM inventory_cache
    WHERE source_type = 'website_scrape' AND sync_status = 'ok'
  LOOP
    PERFORM public.refresh_product_inventory_status(r.supplier_product_id);
  END LOOP;
END $$;

-- ── Step 8: pg_cron staleness sweep ──────────────────────────────────────────
SELECT cron.schedule('mark-stale-inventory', '0 * * * *', $$
  UPDATE public.standardized_products
  SET inventory_status = 'stale', published = false
  WHERE inventory_status = 'in_stock'
    AND inventory_last_synced_at < now() - interval '24 hours';
$$);
```

---

## 8. App Query Changes (exact)

```typescript
// BEFORE (5 occurrences in App.tsx + DiscoverScreen.tsx):
supabase.from('standardized_products').select('...').eq('normalization_status', 'done')

// AFTER:
supabase.from('sellable_products').select('...')
// Remove .eq('normalization_status', 'done') — view enforces all rules
// Add to select string: total_available_qty, has_ca_pickup, inventory_status
```

```typescript
// detailProductAdapter.ts — remove hardcoded stock
// BEFORE: stock: 999
// AFTER:  stock: (row.total_available_qty as number) ?? 0
```

---

## 9. No-Stock Hiding Strategy

| Surface | After Migration |
|---------|-----------------|
| Home screen | `sellable_products` view — zero/stale stock never returned |
| Discover/Browse | Same |
| Search results | Same |
| Image search | Same |
| Product detail | If product drops from `sellable_products`, query returns null → show "Unavailable" state, navigate back |
| Checkout | `validate-checkout-inventory` + `plan-fulfillment` both must pass before any order action |

---

## 10. Complete File Change Summary

### New Edge Functions
| File | Purpose |
|------|---------|
| `supabase/functions/validate-checkout-inventory/index.ts` | Pre-order inventory gate |
| `supabase/functions/plan-fulfillment/index.ts` | Server-side geocoding, distance ranking, warehouse assignment |

### Modified Edge Functions
| File | Change |
|------|--------|
| `supabase/functions/giga-warehouse-stock/index.ts` | Change `source_type: 'price_synthesis'` → `'api_availability_only'`; never blocks sellability |

### New SQL
| Object | Purpose |
|--------|---------|
| `warehouses` table | Replaces `src/data/warehouses.ts` |
| 6 columns on `standardized_products` | published, inventory_status, total_available_qty, etc. |
| `refresh_product_inventory_status()` | Aggregates scraper data per product |
| `sellable_products` view | App query target |
| Updated RLS policy | DB-level sellable enforcement |
| pg_cron job | Hourly staleness sweep |

### App Files — Deleted
| File | Why |
|------|-----|
| `src/services/fulfillmentPlanner.ts` | Replaced by `plan-fulfillment` Edge Function |
| `src/data/warehouses.ts` | Replaced by `warehouses` Supabase table |
| `src/utils/distance.ts` | Replaced by Deno Haversine in edge function |
| `src/services/geocodingService.ts` | Google Maps geocoding moves server-side |
| `src/services/warehouseService.ts` | Subsumed by `plan-fulfillment` |

### App Files — Modified
| File | Change |
|------|--------|
| `App.tsx` (4 sites) | `from('standardized_products')` → `from('sellable_products')` |
| `src/screens/DiscoverScreen.tsx` | Same query change |
| `src/screens/CheckoutScreen.tsx` | Remove all local fulfillment/geocoding/inventory code; replace with two edge function calls |
| `src/services/detailProductAdapter.ts` | `stock: 999` → `stock: total_available_qty ?? 0` |

### Scripts — Modified
| File | Change |
|------|--------|
| `scripts/syncGigaFurnitureInventory.ts` | Call `refresh_product_inventory_status` after each product write |

---

## 11. Rollback Plan

Each phase is independently reversible:

| Phase | Rollback |
|-------|---------|
| SQL columns added | Safe — defaults are `false`/`0`/`'unknown'`; existing queries unaffected |
| `sellable_products` view + RLS | `DROP VIEW sellable_products; DROP POLICY ...; CREATE POLICY "Public can read normalized products" USING (normalization_status='done')` |
| App query change (5 sites) | Revert `from('sellable_products')` → `from('standardized_products')` |
| New edge functions | Remove calls from CheckoutScreen; existing code path restored |
| Deleted app files | Restore from git |

---

## 12. Scraper Integration

```typescript
// scripts/syncGigaFurnitureInventory.ts — after each successful writeToSupabase:
await supabase.rpc('refresh_product_inventory_status', {
  p_supplier_product_id: result.productId
});
```

**Supabase secret required for `plan-fulfillment`:**
```
GOOGLE_MAPS_API_KEY=<move from EXPO_PUBLIC_GOOGLE_MAPS_API_KEY to server secret>
```

The Google Maps API key is currently exposed in the app bundle as `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`. Moving geocoding server-side removes this exposure.

---

## Final Answers

**1. What fulfillment logic will be removed from the app?**

Everything:
- Geocoding the customer's address (`geocodingService.ts`)
- Geocoding warehouse addresses (`warehouseService.ts`, `fulfillmentPlanner.ts`)
- Haversine distance calculation (`distance.ts`)
- Warehouse ranking by distance (`rankWarehousesByDistance`)
- Pickup eligibility decision (≤30 mi + CA warehouse check)
- Single-warehouse strategy (`warehouseHasAllStock` + ordered candidates loop)
- Multi-warehouse split strategy (per-item nearest-warehouse assignment)
- Fallback plan when inventory unavailable (`planFulfillmentFallback`)
- Fulfillment fingerprint comparison (pre-Stripe recheck)
- `overrideGroupsToDelivery` when user switches to delivery mode

**2. What will `plan-fulfillment` calculate server-side?**

1. Geocode customer address via Google Maps (key is a Supabase secret, never in app)
2. Load warehouse coordinates from `warehouses` table (pre-geocoded, no per-request Maps call)
3. Rank all active warehouses by Haversine distance to customer
4. Query `inventory_cache` for real scraped stock (`source_type='website_scrape'`, fresh ≤24h)
5. Strategy 1: find nearest single warehouse with all items in stock (prefer CA pickup ≤30 mi)
6. Strategy 2: multi-warehouse split assignment if no single warehouse qualifies
7. Block if any item has zero stock anywhere → return `status: 'partial_inventory'`
8. Apply user pickup/delivery preference
9. Return complete `FulfillmentGroup[]` with distances, fees, ETAs, pickup windows

**3. Which app files will be simplified?**

| File | Result |
|------|--------|
| `src/screens/CheckoutScreen.tsx` | Removes ~150 lines of inventory/geocoding/planning logic; replaces with 2 edge function calls |
| `src/services/fulfillmentPlanner.ts` | **Deleted entirely** |
| `src/data/warehouses.ts` | **Deleted entirely** |
| `src/utils/distance.ts` | **Deleted entirely** |
| `src/services/geocodingService.ts` | **Deleted entirely** |
| `src/services/warehouseService.ts` | **Deleted entirely** |
| `src/services/detailProductAdapter.ts` | 1-line change: `stock: 999` → real value |

**4. How will checkout flow change?**

Current: app fetches inventory → app plans fulfillment locally → app rechecks before payment → payment starts  
New (strict order):

```
1. validate-checkout-inventory   ← blocks if stale/missing/insufficient stock
2. plan-fulfillment              ← blocks if address invalid or any item unfulfillable
3. createPendingOrder            ← uses server-returned plan, not a locally computed one
4. create-payment-intent         ← Stripe
5. PaymentSheet confirmation
6. confirmOrder
```

Payment cannot start unless steps 1 and 2 both return success. There is no local fallback. The app displays whatever the server returns; it does not verify, re-rank, or re-assign any part of the plan.
