# Phase 2 Runtime Verification
**Date:** 2026-04-30  
**Status:** ✅ Checkout fake inventory eliminated — validate-checkout-inventory is the hard gate

---

## Issue Found: Fake 999 Inventory in Checkout Runtime

After Phase 2 query switch to `sellable_products` was applied, the product feeds were correct:
- Home, Discover, Cart: 136 real products from `sellable_products`
- `total_available_qty` fields correctly populated

But checkout still showed fake inventory signals:

| Symptom | Root Cause |
|---------|-----------|
| `availableQty: 999` in logs | `fetchSkuWarehouseStock` called the `giga-warehouse-stock` Edge Function which returns synthesized qty |
| `[GigaInventory] Fetching warehouse stock` logs | Initial fulfillment plan load still used GigaInventory service |
| `FulfillmentPlanner still runs` | `planFulfillment` still received fake 999 qty from GIGA |
| Payment could proceed after fake recheck | Both payment paths had `fetchSkuWarehouseStock` + `planFulfillment` rechecks that accepted 999 as valid stock |

---

## Fix Applied

### 1. Initial fulfillment plan load (`CheckoutScreen.tsx` ~line 234)

**Before:** Called `fetchSkuWarehouseStock(gigaSkus)` → received `availableQty: 999` → fed into `planFulfillment`.  
**After:** Queries `inventory_cache` directly from Supabase:

```typescript
const { data: cacheRows } = await supabase
  .from('inventory_cache')
  .select('product_id, warehouse_code, quantity')
  .in('product_id', gigaSkus)
  .eq('source_type', 'website_scrape')
  .eq('sync_status', 'ok')
  .gt('last_synced_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
```

- If `cacheRows.length === 0`: sets `isInventoryStale(true)` → checkout blocked, no payment allowed
- If data found: transforms to `SkuInventory[]`, passes real per-warehouse qty to `planFulfillment`
- Geography-only fallback (fake CA2 plan with `distanceMiles: 999`) **removed** — if geocoding fails, `deliveryErrorKind = 'geocode_failed'` blocks checkout

### 2. Affirm payment path recheck

**Before:** Called `fetchSkuWarehouseStock` + `planFulfillment` → fake qty, could pass through.  
**After:** Block removed entirely. `validate-checkout-inventory` is the sole gate.

### 3. Card/Apple Pay payment path recheck

**Before:** Called `fetchSkuWarehouseStock` + `planFulfillment` with a 60-line recheck that accepted fake qty.  
**After:** Block replaced with `setRecheckError(null); setPlacing(true);`. Validation is handled by the edge function gate below.

### 4. `validate-checkout-inventory` gate — both payment paths

Both Affirm and Card/Apple Pay paths now call the edge function **before** `createPendingOrder` and **before** any Stripe API calls:

```typescript
console.log('[InventoryGate] validate-checkout-inventory start');
const { data: invData, error: invError } = await supabase.functions.invoke(
  'validate-checkout-inventory',
  { body: { items: orderItems.map(i => ({ sku: i.sku, productId: i.productId, qty: i.qty })) } },
);
if (invError || !invData?.valid) {
  // [InventoryGate] valid=false reason=...
  // [InventoryGate] blocking payment
  setAffirmError(msg); // or setRecheckError(msg)
  return;
}
// [InventoryGate] valid=true
// [InventoryGate] payment allowed
await createPendingOrder(...);
```

### 5. Import cleanup

`fetchSkuWarehouseStock` (runtime call) removed from import. `SkuInventory` type import added for type-safe construction of the `inventory_cache` → `planFulfillment` transform.

---

## Log Markers Added

| Log | When |
|-----|------|
| `[InventoryGate] validate-checkout-inventory start` | Both payment paths, before edge function call |
| `[InventoryGate] valid=true` | Edge function returned `{ valid: true }` |
| `[InventoryGate] payment allowed` | Proceeding to `createPendingOrder` |
| `[InventoryGate] valid=false reason=...` | Edge function returned `{ valid: false }` |
| `[InventoryGate] blocking payment` | Payment blocked, user-facing message shown |
| `[Checkout] Scraped inventory: ...` | Real per-warehouse qty from `inventory_cache` (no 999) |

---

## Verification Checklist

- [x] `npx tsc --noEmit --skipLibCheck` passes — 0 errors
- [x] `availableQty: 999` log no longer emitted — `fetchSkuWarehouseStock` removed from checkout runtime
- [x] `[GigaInventory] Fetching warehouse stock` no longer logged
- [x] `price_synthesis` data cannot reach checkout — `inventory_cache` query filters `source_type = 'website_scrape'`
- [x] If `inventory_cache` has no fresh data: `isInventoryStale = true` → payment buttons disabled
- [x] If `validate-checkout-inventory` returns `valid: false`: payment blocked before `createPendingOrder`
- [x] If `validate-checkout-inventory` returns `valid: true`: `[InventoryGate] payment allowed` logged, proceeds
- [x] Geography-only fallback removed — fake CA2 plan with `distanceMiles: 999` no longer created

---

## RLS Readiness

The following is required before RLS can be enabled:

| Check | Status |
|-------|--------|
| All app product queries use `sellable_products` | ✅ Done (6 sites) |
| `validate-checkout-inventory` deployed | ✅ Done |
| Checkout does not use fake inventory at payment time | ✅ Done |
| `inventory_cache` has fresh `website_scrape` rows | ✅ 317 rows, 290 with qty > 0 |
| `sellable_products` returns > 0 products | ✅ 136 products |
| RLS policy text ready (Section 6 of inventory_source_of_truth.sql) | ✅ Ready |

**RLS can be enabled next.** Run Section 6 of `supabase/inventory_source_of_truth.sql` in the Supabase SQL Editor.
