# Phase 1 Scraper Activation Report
**Date:** 2026-04-30  
**Scope:** Activate and productionize the GIGA inventory scraper pipeline

---

## Changes Made

### 1. `scripts/syncGigaFurnitureInventory.ts` — patched

| Change | Detail |
|--------|--------|
| `refresh_product_inventory_status()` RPC call | Added after each successful DB write — `standardized_products` inventory columns update in real time as each product is scraped |
| Run timestamps | `runStartedAt` / `runFinishedAt` logged in summary |
| Structured failure tracking | `failedSkus[]` records `productId`, `url`, and `reason` for each failure (was just URL list) |
| Failure reasons | `session_expired`, `no_warehouse_radio`, `no_rows_extracted`, `db_write: <msg>`, `error: <msg>` |

### 2. `.github/workflows/sync-inventory.yml` — created

Daily cron: **06:00 UTC** (10 PM PST / 11 PM PDT)  
Manual trigger: `workflow_dispatch` with optional `inventory_limit` and `dry_run` inputs  
Post-sync verification step: queries `inventory_cache` and `standardized_products` — fails the workflow if 0 rows found

Required GitHub Secrets:

| Secret | Value |
|--------|-------|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key from Supabase Dashboard → Settings → API |
| `GIGA_SESSION_B64` | Base64-encoded `scripts/.giga-session.json` (see below) |

---

## Prerequisites Before First Run

### Step 1 — Verify / refresh the GIGA session

The session file at `scripts/.giga-session.json` was last saved **2026-04-23**. GIGA sessions typically last 7–30 days. If the session has expired, the scraper will abort on the first product with `session_expired`.

To refresh:
```bash
npx tsx scripts/saveGigaSession.ts
# A browser window opens → log in manually → session saved automatically
```

### Step 2 — Run a dry-run validation (5 products)

```bash
DRY_RUN=1 INVENTORY_LIMIT=5 HEADED=1 npx tsx scripts/syncGigaFurnitureInventory.ts
```

Expected output per product:
```
[1/5] 1304302 — Ivory Finish Modern Dresser
  URL: https://www.gigab2b.com/...
  totalAvailable: 47
  CA4        state=CA  qty=12  exact=true   raw="12"
  NJ2        state=NJ  qty=8   exact=true   raw="8"
  AT1        state=GA  qty=10+ exact=false  raw="10+"
  [DRY_RUN] Would upsert 3 row(s) — skipping DB write
```

If `totalAvailable` is null and no warehouse rows are found, the session has likely expired — re-run `saveGigaSession.ts`.

### Step 3 — Run initial full sync

```bash
npx tsx scripts/syncGigaFurnitureInventory.ts
```

No `INVENTORY_LIMIT` = all Furniture products in `giga_products`.  
Estimated time: ~3–4 minutes for 170 products at 1.5s delay.

### Step 4 — Encode session for GitHub Actions

```bash
base64 -i scripts/.giga-session.json | pbcopy
# Paste as GIGA_SESSION_B64 in: GitHub → Repo Settings → Secrets → Actions
```

---

## First Sync Results

*Fill in after running the full sync.*

| Metric | Value |
|--------|-------|
| Run started | |
| Run finished | |
| Products in giga_products | |
| Products attempted | |
| Products succeeded | |
| Products failed | |
| inventory_cache rows written | |
| Products with in_stock status | |
| Products with out_of_stock status | |
| Products with unknown status (no rows found) | |

### Sample inventory_cache rows

*Run in Supabase SQL Editor after sync:*

```sql
SELECT
  ic.product_id,
  sp.product_title,
  ic.warehouse_code,
  ic.warehouse_state,
  ic.quantity,
  ic.quantity_raw,
  ic.quantity_exact,
  ic.source_type,
  ic.last_synced_at
FROM inventory_cache ic
JOIN standardized_products sp ON sp.supplier_product_id = ic.product_id
WHERE ic.source_type = 'website_scrape'
  AND ic.sync_status = 'ok'
ORDER BY ic.last_synced_at DESC
LIMIT 20;
```

### Aggregation check

```sql
SELECT
  inventory_status,
  COUNT(*)                          AS product_count,
  SUM(total_available_qty)          AS total_units,
  SUM(available_warehouse_count)    AS total_warehouse_slots
FROM standardized_products
WHERE normalization_status = 'done'
GROUP BY inventory_status
ORDER BY product_count DESC;
```

### Products with inventory > 0

```sql
SELECT
  supplier_product_id,
  product_title,
  total_available_qty,
  available_warehouse_count,
  has_ca_pickup,
  inventory_last_synced_at
FROM standardized_products
WHERE inventory_status = 'in_stock'
ORDER BY total_available_qty DESC
LIMIT 20;
```

---

## Failure Analysis

*Fill in after sync — list products where warehouse rows could not be extracted.*

| Product ID | URL | Failure reason |
|------------|-----|----------------|
| | | |

Common failure patterns:

| Reason | Cause | Fix |
|--------|-------|-----|
| `session_expired` | GIGA login session timed out | Re-run `saveGigaSession.ts` |
| `no_warehouse_radio` | Product page has no "Specified Warehouse" radio | Product may not support per-warehouse fulfillment |
| `no_rows_extracted` | Radio clicked but DOM parser found no codes | DOM structure differs — inspect manually with `HEADED=1` |

---

## GitHub Actions Setup

After the first manual sync confirms the scraper works:

1. Push `.github/workflows/sync-inventory.yml` to the repository
2. Add the three secrets in GitHub → Repo → Settings → Secrets → Actions:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `GIGA_SESSION_B64`
3. Trigger a manual run: GitHub → Actions → "Sync GIGA Inventory" → Run workflow

**Session refresh cadence:** GitHub Actions cannot save a new session — it only uses the encoded session. When the GIGA session expires (typically 7–30 days), manually run `saveGigaSession.ts`, re-encode, and update the `GIGA_SESSION_B64` secret.

---

## Phase 2 Readiness Checklist

Before switching the app to `sellable_products`:

- [ ] Full sync completed without session_expired abort
- [ ] `inventory_cache` has rows with `source_type = 'website_scrape'`
- [ ] `SELECT COUNT(*) FROM sellable_products` returns > 0
- [ ] Sample products verified: `total_available_qty > 0`, `inventory_last_synced_at` is recent
- [ ] `refresh_product_inventory_status()` confirmed to work (check `inventory_status = 'in_stock'` rows)
- [ ] GitHub Actions workflow triggered at least once manually and passed
- [ ] RLS policy change (Section 6 of `inventory_source_of_truth.sql`) ready to apply

When all boxes are checked, Phase 2 (app query switch + RLS activation) can begin safely.
