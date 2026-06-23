# Saved-to-Live Automation — Operator Guide

`scripts/gigaSavedToLiveOrchestrator.ts` is **one manual command** for the pickup-account
product lifecycle: detect newly saved SKUs → import → publish eligible → refresh delivery fee
for the published SKUs → write one report.

## Manual-triggered only
- There is **NO scheduler, launchd, GitHub Action, cron, or background polling** for this command.
  It runs **only** when you run it in a terminal.
- Default mode is **PLAN (read-only)**. The write path requires the explicit **`--apply`** alias.

## Uplist-only
- This command **only brings products UP** (import → publish → fee). It **never unpublishes,
  hides, or downlists** anything.
- **Downlisting is owned by the inventory system, NOT this command.** When a product goes out of
  stock, `refresh_product_inventory_status()` sets `published=false` / `inventory_status` away from
  `in_stock`, and the `sellable_products` view hides anything that is not `in_stock`. The hourly
  `sweep_stale_inventory()` handles staleness. See `supabase/inventory_source_of_truth.sql`.

## What makes a product visible in the app
The `sellable_products` view requires ALL of: `normalization_status='done'`, `published=true`,
`inventory_status='in_stock'`, `total_available_qty>0`, `product_title`, `primary_image`,
`price>0`, `selling_price>0`. **A delivery-fee cache row is NOT required for visibility.**

## Delivery fee rule
- **Missing delivery fee does NOT hide a product.** The product stays visible in the app.
- **Delivery checkout fails closed** if `giga_delivery_fee_cache.charged_fee_cents` is missing
  (`plan-fulfillment` → `delivery_fee_unavailable`).
- **Pickup checkout still works without a delivery fee** (pickup needs no delivery fee).
- APPLY refreshes the fee for just-published SKUs to shrink the delivery-blocked window; checkout
  remains fail-closed as the backstop.

## How to run

### PLAN (read-only — safe to run anytime)
```bash
npm run giga:saved-to-live:plan
# options: -- --max-skus=15  --summary  --default-creds  --max-pages=N
```
PLAN:
1. Reads the pickup saved list via the official-API helper only (`scripts/lib/gigaSavedItems.ts` → `product/skus/v1`). This is the only GIGA call (paginated, 400 ms/page).
2. Compares to the saved baseline (`reports/giga-auto-publish/saved-items-baseline.json`).
3. Detects newly saved SKUs, caps to `MAX_SKUS` (default **15**).
4. Reads (read-only) `supplier_products`, `standardized_products`, `sellable_products`,
   `inventory_cache`, `giga_delivery_fee_cache` scoped to the capped SKUs.
5. Writes `reports/giga-auto-publish/latest-saved-to-live-plan.{json,md}` classifying each SKU:
   `new` / `already_imported` / `already_published` / `missing_inventory` (out of stock / hidden by
   inventory) / `missing_fee` / `ready` / `blocked`, plus `would_import` / `would_publish` /
   `would_need_fee_refresh_after_publish` and a suggested next action.
6. **Writes NO database, does NOT import, publish, refresh fees, downlist, or advance the baseline.**

### APPLY (gated — drives the existing pipeline, scoped to the capped SKUs)
```bash
npm run giga:saved-to-live:apply
```
APPLY processes only the capped newly-saved SKUs and runs the existing, already-reviewed scripts
sequentially:
1. `giga-saved-delta.ts` → refresh delta vs baseline.
2. `planGigaNewlySavedCandidates.ts` → candidate report.
3. `syncGigaNewlySavedCandidates.ts --sync --only=<capped> --limit=15` → import missing → `supplier_products` (unpublished).
4. `planGigaAutoPublish.ts --only=<capped> --max-skus=15` → scoped publish plan.
5. `runGigaAutoPublish.ts --dry-run` then `--apply` → publish (the existing auto-publish/inventory
   gates decide eligibility; out-of-stock SKUs/families are held). Inventory is established via the
   **official quantity API** (`inventory/quantity/v2`) + `seedPilotInventory` — **no Playwright,
   no portal scrape**.
6. Collect successfully published SKUs from `latest-apply.json` / `latest-plan.json` (intersected
   with the capped set).
7. `refreshGigaDeliveryFeesHybrid.ts --skus <published>` — **SOFT-FAIL**: a fee failure is logged
   and recorded but **never rolls back the publish** and **never fails the run** (only a hard safety
   stop aborts).
8. Writes `reports/giga-auto-publish/latest-saved-to-live-apply.{json,md}`.

APPLY **never** downlists/unpublishes, never scrapes the portal for inventory, never calls
order/write/favorite APIs, and never advances the baseline.

## Safety limits
- **Max 15** newly-saved SKUs per run (`--max-skus` to change).
- **Strictly sequential** (`spawnSync`) — no parallel GIGA calls.
- **No aggressive retries** — the first hard step failure aborts the chain.
- **Hard safety STOP** (abort, write report, exit non-zero) on: captcha / login challenge,
  HTTP 401/403, B20003 permission, rate limit, or unknown/unexpected response shape.
- **Pickup creds** (`SUPPLIER_CLIENT_*` via the `.env.giga-alt.local` cascade) and **dropship creds**
  (`SUPPLIER_DELIVERY_*`, used only by the hybrid fee step) run in separate child processes and are
  never mixed.
- **Official API first**; the portal is touched only inside the existing hybrid fee refresh, only in
  APPLY, only after publish.
- **No secrets/cookies/tokens/signs/nonces/headers** are printed or persisted — reports store only
  step status, exit codes, and SUMMARY marker lines.

## Baseline
This command does **not** advance the saved baseline. After verifying a run, advance it manually:
```bash
npm run giga:saved:baseline -- --force
```

## Why it is not scheduled yet
Account safety is prioritized over speed. The command is kept manual-triggered for the first
iteration so each run is observed. A future schedule — **once daily first, then maybe twice daily
after it is stable** — can be added later (local launchd preferred over cloud CI for portal/session
consistency). The **full** delivery-fee refresh (`npm run fees:refresh:all`) should run **weekly or
every two weeks**, not daily.
