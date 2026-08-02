# API-Only Inventory Monitor — Implementation & Dry-Run Report

**Date:** 2026-08-01 · **Repository:** `xself-home-app` · **Base:** `09bc7f17`
**Status:** Implemented, tested, dry-run complete. **No live writes. Automation disabled. Not pushed.**

---

## Headline

The first full API-only scan covered **all 353 published products with no browser**, and found
**39 products customers can see right now that the supplier says are unavailable.**

Failure rate **0.85%** — far below the 20% abort threshold. Zero database writes.

---

## 1. Existing capabilities reused (not rebuilt)

| Reused | Role |
| --- | --- |
| `src/services/gigaApiClient.ts` | Signed Open API client, 200-SKU batches |
| `src/services/inventoryResult.ts` | Failure taxonomy — already correct, untouched |
| `src/services/inventoryStateMachine.ts` | 6 states, two-confirmation delist **and** relist, P1–P4 |
| `src/services/inventoryAutomationConfig.ts` | Kill switches + caps (extended, not replaced) |
| `sellable_products` / `standardized_products` | Existing visibility contract |
| `inventory_workflow_states` | Existing lifecycle rows |
| `scripts/installInventoryWorkflowShadow.sh` | launchd pattern followed |

Only **two** genuinely new pieces were needed — exactly what the audit predicted: an Open API
adapter and a scanner.

## 2. Files changed — 12 files, **+1241 / −4**

| Commit | Files | LOC |
| --- | --- | ---: |
| `47b8f0a3` adapter | `src/services/openApiAvailability.ts`, its test | +414 |
| `a7d1ddfe` scanner | `scripts/scanPublishedAvailability.ts`, config, safety test, `package.json`, `.gitignore` | +353 / −4 |
| `7d206836` scheduler | `installAvailabilityScanScheduler.sh`, `runAvailabilityScan.sh`, test, `package.json` | +301 |
| `8c7f3b57` migrations | `20260802_open_api_availability.sql`, `20260803_sellable_requires_fresh_availability.sql` | +173 |

## 3. Full dry-run results

```
run_id=avail-2026-08-01T19:01:19.859Z   mode=dry_run   browser_used=false   database_rows_written=0
endpoint=/b2b-overseas-api/v1/buyer/product/price/v1

scanned                    353   (100% of published)
confirmed_available        311
confirmed_out_of_stock      39
failures                     3   (0.85%)
  malformed_response         3
first_strike                39
second_strike_delist         0
relist_pending / eligible    0 / 0
visibility_disagreements    39
```

**Transitions proposed:** 314 `published_in_stock → published_in_stock`, 39
`published_in_stock → pending_out_of_stock`. **Zero delists** — correct: this is the first scan, and
delist requires two consecutive confirmations. A second scan 48 hours later would promote those 39 to
`eligible_for_delist`.

**The 3 failures behaved exactly as designed** — `N710P206904C/E/K` returned `malformed_response`,
kept state `published_in_stock`, and raised an exception instead of counting as zero.

**39 disagreements** (first 12): `N707P186617W`, `N724P292070K`, `W2282P220585`, `W1445P256479`,
`W1321P413949`, `W5368P460474`, `W1162P190403`, `W1801P288508`, `W1767S00018`, `W5527P489260`,
`N710P323328C`, `W1321P307871` — full list in the gitignored report.

**All gates blocked, as intended:**
`scan allowed=false (automation_disabled, source_disabled)` ·
`delistBatch allowed=false (automation_disabled, auto_delist_disabled)` ·
`failureRate allowed=true (0.85% < 20%)`.

## 4. Migrations — authored, **NOT applied** (verified `PGRST205` absent)

**`20260802_open_api_availability.sql`** — additive. `product_availability_checks` +
`latest_product_availability`. A **separate table, not `inventory_cache`**: the Open API returns one
boolean and no warehouse/quantity/state, so writing it into a warehouse-shaped table would require
inventing a warehouse code and quantity that would flow into `total_available_qty` and California
pickup claims. A CHECK constraint makes `available` non-NULL **only** for the two confirmed statuses,
so no failure row can masquerade as a zero. The view **excludes failure rows** so a bad run cannot
displace the last good answer.
*Rollback:* `DROP VIEW latest_product_availability; DROP TABLE product_availability_checks;`

**`20260803_sellable_requires_fresh_availability.sql`** — ⚠️ **dangerous until gated.** Applied today
it takes `sellable_products` **353 → 0**, because no product has Open API evidence yet. Window is
**72h, not 48h**: the scan runs every 48h, so a 48h cutoff would hide the catalogue on any scheduler
delay. Alert at 48h, hide at 72h.
*Rollback:* one `CREATE OR REPLACE VIEW` restoring the current definition verbatim (included in the file).

## 5. Scheduler — installed? **No.**

`StartInterval=172800` (exactly 48 hours) · `RunAtLoad=false` · dry-run only (the runner never passes
`--live`) · self-healing lock · distinct exit codes (0/1/2/3/4) · credentials via dotenv into the
child only, never echoed.

```bash
npm run inventory:scan:scheduler install     # write + load
npm run inventory:scan:scheduler status
npm run inventory:scan:scheduler run-now
npm run inventory:scan:scheduler disable
npm run inventory:scan:scheduler uninstall
npm run inventory:scan:scheduler report
```

## 6. Tests — 12 suites green

`openApiAvailability` **18** · `availabilityScheduler` **12** · `inventorySafetyLimits` 11 ·
`inventoryStateMachine` 19 · `inventoryResult` 20 · `inventoryWorkflowRunner` 22 ·
`inventorySyncCacheOnly` 7 · `cartPriceRefresh` 12 · `productFamilyPilot` 5 · `commerceTaxonomy` 22 ·
`assortmentClassifier` 30 · `savedItemsAssortmentGate` 16 · `tsc` clean · `guard:prod` **18/18**.

The browser ban-list test strips comments first, so it checks **code** rather than the prose
documenting the absence of a browser.

## 7. Scope G (checkout revalidation) — **deferred, and why**

**Not implemented.** `validate-checkout-inventory` runs on Deno; adding a direct Open API call means
porting the HMAC signing into an edge function on the live payment path. More importantly it would
read `product_availability_checks`, **which does not exist yet** — so it could not be meaningfully
tested today.

The current behavior is already the safe one: checkout **fails closed** on evidence older than 24h
(`reason: 'stale' | 'unknown'`). It cannot sell a stale product; it is currently over-blocking, not
under-blocking.

Correct sequence: apply `20260802` → one live scan → *then* extend the validator to consult
`latest_product_availability`. Half-implementing it now against a missing table would be worse than
deferring it.

## 8. Direct answers

**Browser code absent from this path?** **Yes — proven, not asserted.** A test scans the installer,
runner, scanner and adapter for `playwright|puppeteer|chromium|chrome|storageState|.giga-session|
supplierBrowser|route=/product/info/price/warehouse` and fails on any hit.

**Automatic delist/relist disabled pending approval?** **Yes.** `automationEnabled`,
`apiScanEnabled`, `autoDelistEnabled`, `autoRelistEnabled` all default **false**; `--live` currently
exits 3 rather than mutating anything.

**Exact cadence:** `StartInterval = 172800` seconds (48 hours). *Superseded the original 3-day interval; see the 48-hour cadence adjustment.*

## 9. Next steps (each needs approval)

**First bounded live write** — apply persistence, then a capped scan:
```bash
supabase db query --linked -f supabase/migrations/20260802_open_api_availability.sql
```
```bash
npm run inventory:published:scan -- --live --limit=25
```
(Requires `inventory_automation_enabled` + `inventory_api_scan_enabled` rows; delist stays off.)

**Rollback at any point:** set the config rows false (instant, no deploy) → drop the two new objects →
`git revert 8c7f3b57 7d206836 a7d1ddfe 47b8f0a3`. Nothing in the existing pipeline was modified, so
reverting restores the exact prior behavior.

## 10. Confirmation

**Untouched:** XOne · `xself-seller-automation` · Saved Items/taxonomy/outdoor work · browser
sessions (none launched; no Chrome/Chromium/Playwright process started) · supplier Favorites · OTA ·
iOS/Android build · App Store · `git push`.

**Database unchanged:** published 353, sellable 353, `inventory_cache` 1225, `saved_assets` 689 — all
identical to before. `product_availability_checks` and `latest_product_availability` verified
**absent** (PGRST205). No `inventory_cache` write, no publish/unpublish/delist/relist.

Supplier calls were **read-only Open API GETs** (2 batches covering 353 SKUs). No credential values,
secrets, or raw response bodies appear in any report, log, or commit.
