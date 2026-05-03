# GIGA B2B API — Warehouse Stock Capability Investigation
**Date:** 2026-04-30  
**Method:** Code audit + live API response samples (scripts/debug-output/)  
**No credentials printed in this file.**

---

## 1. Current Implementation Summary

The app fetches inventory via the Supabase Edge Function `giga-warehouse-stock`, which runs a
3-tier strategy:

| Tier | Source | When Used |
|------|--------|-----------|
| 1 | Supabase `inventory_cache` (fresh ≤60 min) | Always tried first |
| 2 | Live GIGA price API | Cache miss |
| 3 | Supabase `inventory_cache` (stale ≤24 hr) | Live API failed |

**Tier 2** calls:
```
POST /b2b-overseas-api/v1/buyer/product/price/v1
Body: { skus: ["N725S412541K", ...] }
```

It reads `skuAvailable` (boolean) from the response and **synthesizes** stock as:
- `skuAvailable: true` → `availableQty = 999` at **all 35 warehouse codes**
- `skuAvailable: false` → `availableQty = 0` at **all 35 warehouse codes**

This is not real inventory. It is a binary signal replicated uniformly across every warehouse.

---

## 2. Endpoints Currently Used

| Endpoint | Path | Purpose in App |
|----------|------|----------------|
| Price | `/b2b-overseas-api/v1/buyer/product/price/v1` | **Only live inventory source** — returns `skuAvailable` binary |
| Detail Info | `/b2b-overseas-api/v1/buyer/product/detailInfo/v1` | Product sync (catalog, not inventory) |
| SKU List | `/b2b-overseas-api/v1/buyer/product/skus/v1` | New arrivals sync |

No inventory-specific or warehouse-specific endpoint is used anywhere in the codebase.

---

## 3. Confirmed API Response Fields (from scripts/debug-output/)

### Price Endpoint — `price-first-sku.json` (SKU: N725S412541K)

```json
{
  "sku": "N725S412541K",
  "currency": "USD",
  "price": 199,
  "shippingFee": 9.95,
  "shippingFeeRange": { "minAmount": 9.95, "maxAmount": 9.95 },
  "internationalFulfillmentFees": [],
  "exclusivePrice": null,
  "discountedPrice": null,
  "promotionFrom": null,
  "promotionTo": null,
  "purchaseLimit": null,
  "mapPrice": 0,
  "srpPrice": null,
  "sellerInfo": { "sellerStore": "BY", "gigaIndex": "82.55", ... },
  "spotPrice": [],
  "rebatesPrice": [],
  "marginPrice": [],
  "skuAvailable": true,
  "futurePrice": []
}
```

**Fields present:** price, availability flag, seller info, promotion info  
**Fields absent:** warehouse codes, warehouse quantities, warehouse names, warehouse addresses, stock counts

### Detail Endpoint — `detail-first-sku.json` (SKU: N725S412541K)

**Fields present:** productName, description, dimensions, images, category, characteristics, comboInfo, `skuAvailable: true`  
**Fields absent:** warehouse codes, warehouse quantities, warehouse names, stock counts

### SKU List Endpoint — `sku-list-page1-100.json`

**Fields per record:** `sku`, `productName`, `updateTime`, `firstArrivalDate`, `addedTime`  
**Total SKUs in catalog:** 170 (2 pages)  
**Fields absent:** any inventory or warehouse data

---

## 4. Evidence Summary

| Question | Answer | Evidence |
|----------|--------|----------|
| Does the price API return per-warehouse stock? | **No** | `price-first-sku.json` — zero warehouse fields |
| Does the detail API return per-warehouse stock? | **No** | `detail-first-sku.json` — zero warehouse fields |
| Does any GIGA API endpoint return warehouse codes? | **Not found** | All 3 confirmed endpoints lack warehouse data |
| Does any GIGA API endpoint return per-warehouse quantity? | **Not found** | Binary `skuAvailable` is the only stock signal |
| Does any GIGA API endpoint return warehouse addresses? | **Not found** | Absent from all responses |
| Were any undiscovered endpoints tested? | No | `debugGigaApi.ts` tested category paths; no stock endpoint found |

The GIGA API response itself points to documentation at:  
`https://www.gigab2b.com/index.php?route=information/open_api/index&doc_id=7` (price)  
`https://www.gigab2b.com/index.php?route=information/open_api/index&doc_id=6` (detail)  
No warehouse stock endpoint has been found or documented in this repo.

---

## 5. The Existing Scraper (Already Built)

The codebase already contains a complete Playwright-based scraper that **does** retrieve real per-warehouse stock:

### `scripts/scrapeGigaInventory.ts` — Single product
- Opens an authenticated session on `https://www.gigab2b.com`
- Navigates to a product page by numeric `product_id` URL
- Clicks the **"Specified Warehouse"** radio button on the product page
- Waits for the **"Warehouse Quantity"** table to render
- Extracts rows: `warehouseCode`, `quantity`, `quantityRaw`, `quantityExact`, `quantityFloor`
- Parses quantities: exact integers (`8`) vs floor values (`10+`, `100+`)
- Single-warehouse override: if only one warehouse, uses `totalAvailable` count for exactness
- Writes to `inventory_cache` with `source_type: 'website_scrape'`

**Data the scraper provides:**
- Real warehouse codes per product (e.g., CA4, NJ2, AT1)
- Real stock quantities (exact or floor)
- Pickup and shipping support flags per warehouse
- `totalAvailable` total across all warehouses

### `scripts/syncGigaFurnitureInventory.ts` — Batch across all Furniture products
- Reads all Furniture products from `giga_products` table
- Runs the same scrape loop for each product URL
- Supports `DRY_RUN=1`, `INVENTORY_LIMIT=N`, `HEADED=1`
- Writes results to `inventory_cache` with real per-warehouse rows

### `scripts/saveGigaSession.ts` — Session prerequisite
- Opens a real browser, lets you log in manually to `gigab2b.com`
- Saves the authenticated session to `scripts/.giga-session.json`
- Required before running either scraper

---

## 6. How inventory_cache Is Populated (Current State)

The `inventory_cache` table can contain rows from two sources:

| `source_type` | Origin | Quality |
|---------------|--------|---------|
| `price_synthesis` | Edge function synthesizing from `skuAvailable` flag | Binary (999 or 0), not per-warehouse |
| `website_scrape` | Playwright scraper from product page DOM | Real per-warehouse quantities |

The edge function's **Tier 1 cache** serves whichever data was written most recently. If the scraper has run for a product, it gets real data. If only the price synthesis has run, it gets fabricated 999/0.

There is **no scheduled sync** — the scraper must be run manually. Real data decays after 60 minutes (fresh cache TTL) and is served as stale for up to 24 hours after that.

---

## 7. Direct Answers

**1. Can GIGA API return per-warehouse stock for a single SKU?**  
**No.** Confirmed from actual API responses. The price endpoint returns only `skuAvailable: true/false`. No warehouse breakdown exists in any known endpoint.

**2. Can it return warehouse names or warehouse codes?**  
**No.** Zero warehouse-related fields in price, detail, or SKU list responses.

**3. Can it return available quantity per warehouse?**  
**No.** The only quantity signal is the binary `skuAvailable` flag.

**4. Can it return warehouse address/location?**  
**No.** Not present in any endpoint response.

**5. If API cannot do it, is webpage scraping still required?**  
**Yes — and the scraper already exists and works.** `syncGigaFurnitureInventory.ts` is the correct path to real per-warehouse stock data. It requires a valid Playwright session (`saveGigaSession.ts`) and must be run on a schedule to keep `inventory_cache` current.

**6. What exact endpoint or missing documentation proves this?**  
`scripts/debug-output/price-first-sku.json` — a live response from the price endpoint for SKU `N725S412541K` — contains no warehouse fields whatsoever. The GIGA API recommendation link (`doc_id=7`) suggests no undocumented warehouse stock endpoint was found or referenced in the repo.

---

## 8. Recommended Next Step

**Option B — Keep website scraping (the existing Playwright scraper)** is the correct approach.

The infrastructure is already built. The missing piece is a **scheduled sync**:

| Step | Action | Tool |
|------|--------|------|
| 1 | Ensure `scripts/.giga-session.json` is current | Run `saveGigaSession.ts` (one-time per session expiry) |
| 2 | Run batch inventory sync | `INVENTORY_LIMIT=50 npx tsx scripts/syncGigaFurnitureInventory.ts` |
| 3 | Schedule recurring sync | Cron job, GitHub Action, or Supabase pg_cron — run daily or every 4–8 hours |
| 4 | Update edge function TTL | Consider reducing `CACHE_TTL_MINUTES` from 60 to match sync frequency |

**Option D (Ask GIGA for endpoint access)** is a secondary path worth pursuing in parallel. There may be a dedicated inventory/stock API endpoint that requires account-level activation. Contact GIGA support referencing `doc_id=7` and ask specifically for: per-warehouse stock quantity by SKU, warehouse list with codes and locations, and real-time inventory webhook if available.

**Option C (Hybrid)** applies only if GIGA provides a stock endpoint in the future: use API as the primary source and fall back to scraper for products not covered.

---

## 9. Risk of Current State

The current `price_synthesis` approach means:

- Every available product appears to have qty=999 at all 35 warehouses
- `fulfillmentPlanner.ts` will always find "stock" for available items — single-warehouse strategy always succeeds with qty=999
- The 30-mile pickup threshold and warehouse selection logic works correctly on distance, but the stock check is meaningless (always passes for available SKUs)
- Out-of-stock products (`skuAvailable: false`) correctly show qty=0 and are excluded

**Production risk:** Orders can be placed for items that physically have 0 units at the selected warehouse, even though `skuAvailable: true` (the product exists but the specific warehouse may be empty). The scraper is the only path to real warehouse-level truth.
