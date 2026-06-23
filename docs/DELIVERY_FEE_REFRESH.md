# Delivery (Drop Shipping Fulfillment) Fee Refresh — Operator Guide

The **fixed/production delivery-fee refresh** populates `public.giga_delivery_fee_cache`
with the per-SKU Drop Shipping Fulfillment Fee. Checkout reads **only** that cache — it
never calls GIGA live.

```
official price/v1 (shippingFee)  ──per SKU──► usable? ─yes─► official fee
                                                 └─no (any failure)─► portal price/list fallback
                                                       └─► giga_delivery_fee_cache.charged_fee_cents
plan-fulfillment → create-checkout-order → Stripe   (reads cache only — unchanged)
```

## Behavior (hybrid)
1. **Official GIGA OpenAPI `product/price/v1` first.** Raw fee = `shippingFee`
   (fallback `shippingFeeRange.maxAmount`; never-undercharge guard charges `maxAmount`
   if it exceeds `shippingFee`). `internationalFulfillmentFees` is not used.
2. **Per-SKU portal `price/list` fallback** when official returns no row / missing fee /
   non-USD / permission (B20003) / rate-limit / network error.
3. **8% buffer preserved:** `charged_fee_cents = ceil((fulfillment_fee_cents * 1.08) / 100) * 100`
   (customer display + Stripe charge basis). `fulfillment_fee_cents` = raw fee.
4. **Both sources fail → the existing cached fee is preserved** (only failure metadata is
   written; a valid `charged_fee_cents` is never nulled/zeroed/overwritten).
5. Source labels: `giga_openapi_price_v1` (official) / `giga_openapi_price_v1_fallback_portal` (portal).

## Fixed/production command
```bash
npm run fees:refresh:all          # hybrid: all sellable SKUs → giga_delivery_fee_cache
npm run fees:refresh -- --sku W409P327401          # single SKU
npm run fees:refresh -- --skus W409P327401,W409P327407   # specific SKUs
npm run fees:refresh:dry -- --sku W409P327401      # DRY-RUN: fetch + decide + print, NO DB write
```

## Rollback (old portal-only script — kept as manual fallback)
```bash
npm run fees:refresh:portal:all   # portal price/list scraping only (pre-hybrid behavior)
npm run fees:refresh:portal:dry   # dry-run of the portal-only path
```
(The hybrid does not change the DB schema or checkout, so rollback is just running the
portal command instead; both write the same `charged_fee_cents`.)

## Required runtime env vars (NEVER hardcode / never commit secrets)
| var | purpose | notes |
|---|---|---|
| `SUPPLIER_DELIVERY_PRODUCTION_CLIENT_ID` | official OpenAPI auth (dropship, Buyer 82482447) | runtime env only (e.g. `read -rs … ; export …`); never in a file |
| `SUPPLIER_DELIVERY_PRODUCTION_CLIENT_SECRET` | official OpenAPI auth | runtime env only; never printed/logged |
| `SUPPLIER_DELIVERY_API_BASE_URL` | official host | default `https://openapi.gigab2b.com` |
| `SUPABASE_URL` | cache write target | from `.env.local` |
| `SUPABASE_SERVICE_ROLE_KEY` | cache write auth | from `.env.local`; service-role only, scripts only |
| `GIGA_SESSION_FILE` | **portal fallback** session (dropship cookie) | default `scripts/.giga-session.json`; required only when the fallback path runs |
| `GIGA_DELIVERY_BUFFER_PCT` | buffer percent | default `8` |
| `DRY_RUN=1` | preview without writing | optional |

If the official creds are unset, the hybrid logs `official_creds_missing` and uses the
portal fallback for every SKU (so it degrades safely, not silently to zero fees).

## Safety
- Read-only GIGA endpoints only (`product/price/v1`, portal `price/list`). No order/dropship-sync.
- Writes only `giga_delivery_fee_cache`. Never touches catalog/inventory/checkout tables.
- Checkout/edge functions and DB schema are unchanged; checkout reads the cache only.
- Pickup (`SUPPLIER_CLIENT_*`) and Delivery (`SUPPLIER_DELIVERY_*`) credentials are never mixed.
