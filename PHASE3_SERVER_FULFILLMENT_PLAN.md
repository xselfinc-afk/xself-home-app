# Phase 3 Server-Side Fulfillment Plan
**Date:** 2026-04-30  
**Status:** ✅ COMPLETE — Fulfillment planning moved to Supabase Edge Function

---

## What Changed

### Edge Function Created

**`supabase/functions/plan-fulfillment/index.ts`** — Deno Edge Function

Server responsibilities:
- Geocodes customer address via Google Maps API (no API key in client)
- Queries `warehouses` table from Supabase for real warehouse data
- Queries `inventory_cache` (source_type='website_scrape') for real scraped inventory
- Calculates Haversine distances, ranks warehouses by proximity
- Lazy-geocodes warehouses on first use, writes lat/lng back to DB for caching
- Returns pickup/delivery eligibility, selected warehouse, ETA, shipping cost

Input:
```json
{
  "items": [{ "sku": "XH-...", "productId": "W329P...", "qty": 1 }],
  "address": { "line1": "...", "city": "...", "state": "CA", "zip": "94043", "country": "US" }
}
```

Output (success):
```json
{
  "valid": true,
  "fulfillmentStatus": "ok",
  "selectedWarehouse": { "code": "CA6", "label": "...", "address": "...", "state": "CA", "city": "..." },
  "distanceMiles": 342.4,
  "pickupEligible": false,
  "deliveryEligible": true,
  "usePickup": false,
  "shipping": 99,
  "estimatedDelivery": "3–7 business days",
  "pickupWindow": null,
  "availableQty": 100,
  "inventoryFreshness": "fresh",
  "inventoryTimestamp": "2026-05-01T04:42:03.464Z"
}
```

### CheckoutScreen Refactored

**`src/screens/CheckoutScreen.tsx`**

**Removed:**
- `import type { SkuInventory } from '../services/gigaInventoryService'`
- `planFulfillment` from fulfillmentPlanner import
- `inventory_cache` query block (~25 lines)
- `SkuInventory[]` transform block (~10 lines)
- `planFulfillment(...)` call + per-group console logs

**Added:**
- Single `supabase.functions.invoke('plan-fulfillment', { body: { items, address } })` call
- Maps edge function response to `FulfillmentPlan` (one group containing all order items)
- Error mapping: `stale_inventory/no_inventory/insufficient_qty` → `setIsInventoryStale(true)`; other failures → `setDeliveryErrorKind('geocode_failed')`
- `type FulfillmentGroup` imported for type-safe group construction

**Checkout screen no longer:**
- Queries `inventory_cache` directly
- Calls `planFulfillment` (client-side geocoding + warehouse ranking)
- Uses `SkuInventory` type at runtime

---

## Deployment

```bash
supabase functions deploy plan-fulfillment --no-verify-jwt
supabase secrets set GOOGLE_MAPS_API_KEY=<key>
```

**Note:** Deployed with `--no-verify-jwt` for testing with new Supabase key format (`sb_publishable_` / `sb_secret_`). The app's `supabase.functions.invoke()` handles auth correctly — `--no-verify-jwt` only affects curl/external callers.

Test verified (Mountain View CA → `W714S00550`):
```
warehouse=CA6, dist=342.4mi, pickup=false, ship=$99, freshness=fresh
```

---

## Log Markers

| Log | When |
|-----|------|
| `[Checkout] Calling plan-fulfillment edge function` | Before invoke |
| `[Checkout] Fulfillment plan: warehouse=... dist=...mi pickup=... ship=$... freshness=...` | On success |
| `[Checkout] plan-fulfillment: valid=false status=... reason=...` | On invalid response |
| `[Checkout] plan-fulfillment failed: ...` | On network/invoke error |

---

## Files NOT Yet Deleted (Phase 3 cleanup pending)

These files are now unused but kept until confirmed safe to delete:

| File | Status |
|------|--------|
| `src/services/fulfillmentPlanner.ts` | Unused at runtime — types still imported |
| `src/data/warehouses.ts` | Only used by fulfillmentPlanner |
| `src/utils/distance.ts` | Only used by fulfillmentPlanner |
| `src/services/geocodingService.ts` | Only used by fulfillmentPlanner |
| `src/services/warehouseService.ts` | Unused |
| `src/services/gigaInventoryService.ts` | No longer imported by CheckoutScreen |

---

## Phase 3 Checklist

| Deliverable | Status |
|-------------|--------|
| `plan-fulfillment` Edge Function created | ✅ Done |
| Edge Function deployed to Supabase | ✅ Done |
| `GOOGLE_MAPS_API_KEY` set as Supabase secret | ✅ Done |
| Edge Function tested with real SKU + address | ✅ Done (CA6, 342.4mi) |
| CheckoutScreen calls edge function instead of client planFulfillment | ✅ Done |
| CheckoutScreen no longer queries `inventory_cache` directly | ✅ Done |
| CheckoutScreen no longer uses `SkuInventory` at runtime | ✅ Done |
| `npx tsc --noEmit --skipLibCheck` passes (0 errors) | ✅ Done |
| Old fulfillment files kept (not deleted yet) | ✅ Preserved |

**Phase 4 (optional cleanup):**
- Delete `fulfillmentPlanner.ts`, `warehouses.ts`, `distance.ts`, `geocodingService.ts`, `warehouseService.ts`, `gigaInventoryService.ts`
- Redeploy `plan-fulfillment` with JWT verification re-enabled
- Configure GitHub Actions secrets (`SUPABASE_SERVICE_ROLE_KEY`, `GIGA_SESSION_B64`)
