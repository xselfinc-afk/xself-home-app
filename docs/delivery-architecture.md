# Delivery (GIGA one-click dropship) — Architecture & Discovery Notes

**Status: scaffold only.** Server-side client + types + guards are added but **not wired** into
checkout/order flow, **not deployed**, and **no production order endpoint is ever called**.

## Accounts (never mix)
| Fulfillment | GIGA Buyer | Credentials (env names) | Status |
|---|---|---|---|
| **Pickup** | 76938981 | `SUPPLIER_CLIENT_ID` / `SUPPLIER_CLIENT_SECRET` / `SUPPLIER_API_BASE_URL` | existing; 🔒 **LOCKED** (see `docs/fulfillment-rules.md`) |
| **Delivery** (dropship) | 82482447 | `SUPPLIER_DELIVERY_SANDBOX_CLIENT_ID/SECRET`, `SUPPLIER_DELIVERY_PRODUCTION_CLIENT_ID/SECRET`, `SUPPLIER_DELIVERY_API_BASE_URL` | API client **Active / Full connection**; sandbox **and** production credentials exist (verified in portal 2026-06-19; secrets never copied) |

The GIGA buyer account is **implicit in the credentials** (the `client-id`), not a request
field — so "Delivery" = using the Delivery account's own client-id/secret. Docs are
**platform-generic**; permissions are per-API-client.

## Endpoints (GIGA Open API 2.0; HMAC-SHA256 signing, identical to the Pickup client)
- Hosts: sandbox `https://openapi-sandbox.gigab2b.com`, production `https://openapi.gigab2b.com`.
- **Dropship create (money-moving):** `POST /b2b-overseas-api/v1/buyer/order/dropShip-sync/v1`
  — creates a supplier order. **After payment + admin approval only.** Sandbox-only until explicitly approved for production.
- **Order Status Query (read):** `/b2b-overseas-api/v1/buyer/order/status/v1` (exact path TBD — under "Interfaces for Buyers › Shipment Related › Order Status Query") — source of `supplier_order_id`, `supplier_order_status`, carrier, tracking.
- **Read-only (reusable for auth verification):** `/buyer/product/price/v1`, `/buyer/product/detailInfo/v1`, `/buyer/product/skus/v1`, `/buyer/inventory/quantity/v2`.

## dropShip-sync/v1 request fields (from live docs, doc_id=8)
Required: `orderDate`, `orderNo` (our shipment id; `[A-Za-z0-9_-]`, unique), `shipName`,
`shipPhone` (6–15 digits), `shipAddress1` (≤35), `shipCity`, `shipCountry` (US),
`shipState` (US required), `shipZipCode`, `orderLines[]` (`itemPrice` in dollars, `qty`, `sku`).
Optional: `shipEmail`, `shipAddress2`, `currencyCode` (USD), `deliveryService`
(US: `DSR` small-parcel / `NSR`,`TRHD`,`ROC`,`WG` LTL), `orderFrom`, `salesChannel`,
`customerComments`, `orderTotal`, tax/discount per line.
Response: `{ success, code:"200", data:null, requestId, msg }` — **no order id returned**;
fetch ids/tracking via Order Status Query.

## Have vs missing (Xself → dropship)
| dropship field | Xself source | Status |
|---|---|---|
| `sku` | `order_items.product_id` (GIGA SKU) | ✅ have |
| `qty` | `order_items.qty` | ✅ have |
| `itemPrice` | `order_items.unit_price_cents/100` | ✅ have (÷100) |
| warehouse code | `orders.fulfillment_plan.selectedWarehouse.code` | ✅ have (note: dropship body has no warehouseCode field — supplier routes) |
| `shipName` | address first+last | ✅ have |
| `shipPhone` | address phone | ✅ have |
| `shipEmail` | verified contact email | ✅ have |
| `shipAddress1/2`,`shipCity`,`shipState`,`shipZipCode`,`shipCountry` | address | ✅ have |
| `orderNo` | our order number | ✅ have |
| **`deliveryService` (shipServiceLevel)** | — | ❌ **missing** — must derive (DSR vs LTL) per product type |
| **delivery quote id / delivery fee** | — | ❌ **missing** — confirm if GIGA exposes a quote endpoint; today our delivery fee is the flat `SHIPPING_FEE` |
| **`supplier_order_id`** | — | ❌ **missing** — from Order Status Query |
| **`supplier_order_status`** | `orders.supplier_sync_status` scaffold exists | ⚠️ partial |
| **`carrier`, `tracking_number`** | — | ❌ **missing** — from Order Status Query; add columns |

## Future fulfillment flow (not implemented here)
1. Customer picks **Delivery** at checkout (label stays "Delivery", **never "Shipping"**).
2. Payment succeeds → order `supplier_sync_status='not_submitted'` (existing).
3. **Admin approval** → a server-side function (using `submitDropshipOrderSandbox` first,
   production only after explicit approval) calls `dropShip-sync/v1` with the ship-to + lines.
4. Persist `DeliverySupplierRecord` (supplier_order_id/status/carrier/tracking) via Order Status Query polling.
5. Pickup orders are untouched (separate account + locked rules).

## Safety rules enforced
- **No production order call** during discovery: `assertSafeDiscoveryRequest` + the client's
  hard block (production money-moving paths throw).
- **Account separation:** Delivery client reads only `SUPPLIER_DELIVERY_*`; Pickup client reads only `SUPPLIER_CLIENT_*`.
- **No secrets in frontend / bundle:** Delivery secrets are read only by `supabase/functions/_shared/gigaDeliveryClient.ts` (Deno, server-side).
- Guarded by `scripts/productionGuardrails.ts` (Check 14) + `src/__tests__/deliveryGuards.test.ts`.

## Commands
```bash
npx tsx src/__tests__/deliveryGuards.test.ts   # account-separation + safety-guard tests
npm run guard:prod                              # Check 14 = "Delivery account separation"
```

## Still unknown / to confirm
- Exact Order Status Query path + tracking response fields (read-only crawl).
- Valid `deliveryService` selection logic (DSR vs LTL) per product.
- Whether GIGA exposes a delivery quote/fee endpoint (vs our flat fee).
- Sandbox auth must be verified with a read-only call once the Delivery sandbox creds are
  provided at runtime (env-only; never committed/printed).

## Pickup eligibility (dual-radius, approved 2026-07)
- Pickup vs shipping is resolved for the **selected child SKU** by the shared, pure resolver
  `supabase/functions/_shared/fulfillmentEligibility.ts` (`resolveFulfillmentEligibility` +
  `pickupRadiusMiles(state)`). Radius is per warehouse state: CA = 100 mi, approved out-of-state
  = 50 mi. Pickup requires positive evidence (SKU stocked qty>0 at an active, `supports_pickup`,
  geocoded warehouse within its radius). Shipping is the existing authoritative delivery-fee
  validator's `available` flag — never inferred from the absence of pickup, never `cents>0`.
- `plan-fulfillment` (checkout, authoritative) consumes `pickupRadiusMiles(state)`. The advisory
  edge function `fulfillment-eligibility` reuses the SAME resolver to give PDP/Cart a non-binding
  `{canPickup, canShip, state, qualifyingWarehouse, distance, radius, evaluatedAt}` result;
  checkout/order creation revalidates authoritatively. There is ONE distance/warehouse/radius
  authority — the client never recomputes it.
- Out-of-state pickup is enabled only for the audited 18-warehouse allowlist (see
  `docs/fulfillment-rules.md`). `has_ca_pickup` is legacy/coarse, not the eligibility authority.
