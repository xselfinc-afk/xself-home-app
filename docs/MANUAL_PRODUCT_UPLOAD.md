# Manual Emergency Product Upload (GIGA-outage fallback)

A single-SKU, operator-supplied upload path for when the **GIGA saved-list / detail APIs are down**
and the normal saved-to-live import cannot fetch product data. It is an **emergency fallback only** —
not the default path. When GIGA is healthy, use the normal `giga:saved-to-live` / `giga:newly-saved`
flow instead.

Script: `scripts/gigaManualProductUpload.ts` · Reuses the canonical `normalizeProduct()` engine
(`src/services/normalizationPipeline.ts`) — it does **not** reimplement normalization.

## Commands

```bash
# FOLDER workflow (recommended): reads <dir>/manual.json + auto-detects images
npm run giga:manual-product:plan  -- --sku W80870283 --folder tmp/manual-products/W80870283
npm run giga:manual-product:apply -- --sku W80870283 --folder tmp/manual-products/W80870283 --confirm

# INPUT workflow (explicit JSON with image URLs already in it)
npm run giga:manual-product:plan  -- --sku W80870283 --input scripts/manual-inputs/W80870283.json
```

Flags: `--sku <SKU>` (required, must equal the JSON `supplier_product_id`); `--folder <dir>` (folder
workflow) **or** `--input <path>`; `--confirm` (perform writes — without it the tool always behaves as
PLAN); `--update-existing` (allow overwriting a SKU that already exists; refused otherwise).

### Folder workflow — `tmp/manual-products/<SKU>/`
`--folder <dir>` reads `<dir>/manual.json` (must be **plain JSON**, not RTF — the tool rejects RTF with a
clear message) and **auto-detects images** in the folder: `main.png` → primary, `gallery-NN.png` → gallery
(sorted). It builds the public URLs at the **deny-safe** storage prefix and references them — it does **not**
upload. Upload the images first (same bucket, deny-safe prefix):
`product-images/operator-uploads/<SKU>/{main,gallery-01..NN}.png`.

> **Storage prefix is `operator-uploads/`, NOT `manual-products/`.** The shared image deny-list
> (`src/utils/productImageRules.ts`) flags the substring **`manual`**, so a `manual-products/` *storage path*
> drops every image at normalize time. The local folder may still be `tmp/manual-products/<SKU>/`; only the
> uploaded storage prefix must avoid `manual`. Constant: `MANUAL_STORAGE_PREFIX`.

### Auto pricing
If `manual.json` has `"selling_price_mode": "auto"`, `selling_price` is **computed from `cost_price`** using
the dynamic-pricing base-retail rule (`cost × markup + buffer`, grossed for the payment fee, psychological
rounding, 25% gross-margin floor) — no manual `selling_price` needed. The formula mirrors
`supabase/functions/dynamic-pricing/index.ts` (`calculateBaseRetail`), which remains the live source of truth
and re-prices over time; the computed value is the **starting** price (locked by a test). Otherwise supply an
explicit `selling_price > 0`.

## Input JSON

See `scripts/manual-inputs/W80870283.json` for a working example. Schema:

| Field | Req | Notes |
|---|---|---|
| `supplier_product_id` | ✅ | must equal `--sku` |
| `title` | ✅ | → `product_title` (run through the engine) |
| `images.primary` | ✅* | required in `--input` mode; in `--folder` mode images are auto-detected from disk |
| `selling_price_mode` | ➖ | `"auto"` → compute `selling_price` from `cost_price`; else `"manual"` (default) |
| `selling_price` | ✅† | **> 0**; required unless `selling_price_mode="auto"`; `normalizeProduct` does NOT set it |
| `cost_price` | ⚠️ | required (> 0) when `selling_price_mode="auto"`; if absent in manual mode, `price` = 0 → not sellable (`price > 0` gate) |
| `warehouse_inventory[]` | ✅ | `{warehouse_code, quantity}`; total **> 0** |
| `description`, `category`, `color`, `material`, `key_features`, `assembled_*`, `original_price`, `images.gallery`, `giga_numeric_product_id` | ➖ | optional |
| `manual_upload_reason`, `operator` | ➖ | recorded in `raw_payload.manual_upload` |

**Warehouse codes:** mirror the DB guard (`20260621_guard_onsite_merchant_inventory.sql`). Merchant
On-Site codes matching `^.+-[A-Z]{2}[0-9]+$` (e.g. `B062-FL1`) that are **not** in `public.warehouses`
are **refused** (they would be quarantined and never counted). Bare codes (e.g. `CA6`, `NJ5`) are fine
and are counted even if not seeded in `public.warehouses` (you'll get a warning for unseeded ones).

## Validation gates
- SKU present and equal to `--sku`; refuse existing SKU unless `--update-existing`.
- `title` required; `images.primary` required; `selling_price > 0`; `cost_price > 0` if provided.
- `warehouse_inventory` total `> 0`; no merchant-prefixed-non-canonical codes.
- **Warnings** (non-blocking): missing `cost_price` (price-gate), missing delivery fee (delivery blocked,
  pickup unaffected), bare warehouse code not seeded in `public.warehouses`.

## What APPLY writes (scoped to the one SKU only)
1. `supplier_products` — upsert (insert unless `--update-existing`); `raw_payload.manual_upload` tag.
2. `standardized_products` — `normalizeProduct()` output + explicit `selling_price`; `normalization_status='done'`.
3. `inventory_cache` — one `source_type='website_scrape'`, `sync_status='ok'` row per warehouse.
4. `refresh_product_inventory_status(sku)` — sets `inventory_status`/`published` (→ live when in_stock).
5. `giga_delivery_fee_cache` — **never written**; an existing cached fee is preserved.

## Differences from saved-to-live
- Emergency fallback only; used **only** when the GIGA API is down. Not wired to any cron/launchd.
- Operator is the data source (skips `giga:saved:delta` / `giga:newly-saved:plan` / GIGA detail).
- **Reconciliation is manual and not yet automated:** when GIGA recovers, re-import/re-normalize the SKU
  from authoritative GIGA data. Manual rows are tagged `raw_payload.manual_upload` so they can be found.

## Notes
- `selling_price` gotcha: the engine does not emit it; this tool writes it explicitly. Without a positive
  `selling_price` (and `cost_price`/`price`), the product normalizes but never enters `sellable_products`.
- Operator input files under `scripts/manual-inputs/` contain product data (not secrets); you may choose
  to gitignore that directory locally.
- Limitations: single SKU per run; no bulk mode; arbitrary `specifications` beyond color/material/
  dimensions/weight are not yet mapped into `specifications_json` (the engine builds that set).
