# Xself Home — Rollback Baseline (pre Commerce-Taxonomy Phase 1)

**Date:** 2026-07-21 · **Purpose:** Restore the current app, source, DB schema, and category behavior exactly if Phase 1 fails.
**Status:** Capture COMPLETE. Git commit + tag **NOT YET CREATED** — held pending a decision on pre-existing uncommitted work (see §11 + §12).

---

## 1. Current branch and commit
- **Branch:** `fix/quoted-price-buynow-checkout`
- **HEAD:** `f9ae006f56a075c5e2ace1081fdbf8553e96d06f` — `feat(ads): implement low-density Native Ads V1 placements`
- **Upstream:** `origin/fix/quoted-price-buynow-checkout` — **in sync** (0 ahead / 0 behind)
- Recent history: f9ae006f → 66aca726 → 73dd2bf8 → 9adf7f1f → 7a6e3b8e
- Existing tags: `backup-checkout-inventory-working-20260423`, `safety-backup-20260502-2021`, `stable-v1`, `v1.0` (planned Phase-1 tag name is free — no collision)

## 2. Working-tree status — NOT CLEAN
- **Staged:** none
- **Tracked-modified (1):** `src/components/NativeProductAdCard.tsx` (+70 / −45) — the AdMob Native Validator fix from a prior task that was explicitly **"do not commit"**. Full diff saved: `tracked-unstaged.patch` / `UNSTAGED_NativeProductAdCard.diff`.
- **Untracked (102 files, unrelated to taxonomy):**
  | Group | Files | Nature |
  |---|---:|---|
  | `wiki/` | 42 | ops/architecture wiki |
  | `dist/` | 41 | Expo export build output (**not gitignored — hygiene issue**) |
  | `scripts/` | 10 | GIGA / inventory / probe scripts + `scripts/lib/portalSafetyGuard.ts` |
  | `supabase/functions/` | 2 | `admin-upload-pickup-document`, `get-pickup-document-url` |
  | `supabase/migrations/` | 3 | `20260528_phase1a_pickup_documents.sql`, `20260604_admin_approval_supplier_sync.sql`, `20260622_giga_warehouse_directory.sql` |
  | `docs/` | 3 | GIGA API / price-synthesis docs |
  | `src/__tests__/` | 1 | `manualProductCommand.test.ts` |
- **Untracked (baseline artifacts, 20 files):** `rollback-baseline-2026-07-21/` (this package — intended for the checkpoint)
- Full records: `worktree-status.txt`, `untracked-files.txt`

**None of the 102 untracked files or the 1 modified file is Commerce-Taxonomy Phase 1 work** (Phase 1 has not started). Per instruction, no commit/tag was created; a decision is requested (§12).

## 3. Baseline test results — NOT fully green (1 pre-existing, unrelated failure)
- **Type-check:** `npx tsc --noEmit --skipLibCheck` → **EXIT 0 (clean)**. (`typecheck.txt`)
- **Test suites:** `npx tsx src/__tests__/*.test.ts` → **17 of 18 files pass**. (`test-results.txt`)
  - ✅ Passing incl.: `discoverAdInsertion` (feed/category insertion), `normalization`, `manualProductUpload`, `manualProductCommand`, `reviewCoverage`, `savedToLiveApply`, delivery/pickup suites, `appOpenAdEligibility`, `iosReleaseGates`, `iosReleaseSubmit`.
  - ❌ **`iosReleaseBuild.test.ts` FAILS** — `AssertionError: '1.0.12' !== '1.0.10'` at line 78. The test hardcodes an expected app version of `1.0.10`; `app.json` is now `1.0.12`. All 8 build-logic assertions pass; only the stale version literal fails. **Pre-existing, unrelated to category/product/taxonomy. Not introduced by this baseline.**
- **Category behavior checks (no E2E harness exists):** verified structurally by executing the app's real `inferCategoryPath()` over all 349 live sellable rows (see §5). Home navigation / Discover filtering / Search are **not** covered by any automated device test in this repo; they are verified via the pure classification logic + code inspection, **[Needs Verification: on-device E2E]**.

## 4. App version / build / runtime
- **App version:** `1.0.12` (app.json) · **npm package version:** `1.0.0` (package.json)
- **iOS build number:** `34` · **bundleIdentifier:** `com.xself.home`
- **Android:** `package com.xself.home`; **no explicit `android.versionCode` in app.json** — Expo default **[Needs Verification]**
- **Expo runtimeVersion:** `1.0.12`
- **EAS Update URL:** `https://u.expo.dev/3d5a36de-d144-4e6c-ac40-c336e8a8aac2`
- **EAS production:** channel `production`, `autoIncrement: false`, `appVersionSource: local`
- **Stable production build:** iOS 1.0.12 / build 34 (submitted to App Store Connect in a prior task). Full config: `app-version.txt`.
- No new deployment or submission was triggered.

## 5. Current category behavior + catalog counts
- **Total sellable:** **349** (of 453 standardized_products; 104 gated out).
- **Home circles** (`CATEGORY_CIRCLES`, App.tsx:75-84, order): Storage · Living Room · Bedroom · Dining & Kitchen · Office · Outdoor & Garden · Bathroom · Pet Furniture.
- **Discover pills** (`PRODUCT_CATEGORIES`, categories.ts:8-18, order): All · Storage · Living Room · Bedroom · Dining & Kitchen · Office · Outdoor & Garden · Bathroom · Pet Furniture.
- **Mapping:** single-valued — `product.categoryPath.level1 === selectedLevel1` (fallback `categoryLabel`/`category`), DiscoverScreen.tsx:271-277; `categoryPath` runtime-inferred by `inferCategoryPath` in `adaptStandardizedRow` (detailProductAdapter.ts:351), `category = specifications_json['Category'] || category_code`.
- **Per-pill counts (exact, real `inferCategoryPath`):** Storage 205 · Living Room 53 · Bathroom 44 · Bedroom 22 · Dining & Kitchen 11 · Office 8 · Outdoor & Garden 1 · Pet Furniture 1 · **Other (no pill) 4**.
- **Reachable via multiple categories:** none (single-valued mapping).
- **Unreachable via any pill (4):** `W2987P289172`, `W3258P293190`, `W2987P288952`, `W2987P289196` (`level1='Other'`, only under "All").
- Full machine-readable per-category product-ID lists: `category-baseline.json`; human-readable: `category-baseline.md`.

## 6. Database objects captured (read-only)
- **View:** `sellable_products` — full DDL (`db/schema/sellable_products_viewdef.sql`); 8-predicate gate: `normalization_status='done' AND published=true AND inventory_status='in_stock' AND total_available_qty>0 AND product_title IS NOT NULL AND primary_image IS NOT NULL/≠'' AND price>0 AND selling_price IS NOT NULL/>0`. Category cols exposed: `category_display, category_code, scene_code, category_label, category_priority`.
- **All public views:** `admin_order_detail`, `admin_orders_summary`, `sellable_products` (`db/schema/views_list.txt`).
- **Columns** of `supplier_products`, `standardized_products`, `inventory_cache`, `sellable_products` (`db/schema/columns.txt`).
- **Indexes** on the 3 base tables (`db/schema/indexes.txt`).
- **Triggers:** none for category assignment; `standardized_products` has no category trigger. (`db/schema/triggers.txt`)
- **Functions** (list + args, `db/schema/functions_list.txt`); category/inventory-relevant: `normalize_supplier_products`, `refresh_product_inventory_status`, `refresh_all_inventory_status`, `sweep_stale_inventory`, `guard_onsite_merchant_inventory`. (Category *classification* is done in the TS pipeline, not the DB.)
- **RLS policies** (`db/schema/rls_policies.txt`): `standardized_products` → "Public can read sellable products" (SELECT/public, inventory-fresh predicate); `supplier_products` → "Public can read published supplier products" (SELECT/public, `published=true`); `inventory_cache` → no public policy.
- **Enums / lookup types:** none exist (`db/schema/enums.txt` empty).
- **Per-product category fields** (all 453 rows: id, sku_custom, category_code, category_label, scene_code, supplier spec category, sellable flag): `db/products_category_fields.csv`.
- **Recompute inputs** (349 sellable): `db/sellable_category_inputs.json`. **Distributions:** `db/distributions.txt`.
- *Note:* DB was not modified. This is a logical export; it does not replace Supabase PITR/automatic backups — it complements them.

## 7. Backup file locations (all under `rollback-baseline-2026-07-21/`)
```
ROLLBACK.md                      ← this report (deliverables 1–11)
git-state.txt                    ← branch/HEAD/upstream/porcelain/diff summary
worktree-status.txt              ← porcelain working-tree status
untracked-files.txt              ← 122 untracked paths (incl. baseline)
tracked-unstaged.patch           ← full tracked diff (restorable via git apply)
UNSTAGED_NativeProductAdCard.diff← same diff, named copy
typecheck.txt                    ← tsc --noEmit result (EXIT 0)
test-results.txt                 ← all 18 test-file runs (1 failure documented)
app-version.txt                  ← app.json / package.json / eas.json version keys
category-baseline.json           ← machine-readable category behavior + per-category IDs
category-baseline.md             ← human-readable category behavior
db/products_category_fields.csv  ← 453 rows, per-product category fields + sellable flag
db/sellable_category_inputs.json ← 349 sellable rows (recompute inputs)
db/distributions.txt             ← code/scene/label distributions + totals
db/schema/sellable_products_viewdef.sql
db/schema/columns.txt  indexes.txt  triggers.txt  functions_list.txt  rls_policies.txt  enums.txt  views_list.txt
```

## 8. New baseline commit hash
**PENDING** — not created (held per §12). When approved, will be the checkpoint commit on `fix/quoted-price-buynow-checkout`.

## 9. Git tag
**PENDING** — planned annotated tag `xself-home-pre-commerce-taxonomy-phase1-2026-07-21` (name confirmed free). Target TBD by the §12 decision.

## 10. Exact rollback procedure

> Effects are labeled. **Destructive** = discards uncommitted work or moves refs. Non-destructive procedures are preferred.

### 10A. Code rollback
- **Return to the baseline (read-only inspect):** `git checkout <BASELINE_TAG>` *(detached HEAD; non-destructive to history)*.
- **Recovery branch from the tag (recommended):**
  `git switch -c recovery/pre-taxonomy <BASELINE_TAG>` *(new branch at the baseline; non-destructive)*.
- **Revert Phase-1 commits without rewriting history (preferred):**
  `git revert --no-edit <phase1_first_sha>^..<phase1_last_sha>` *(creates inverse commits; safe on shared branches)*, then `git push`.
- **Hard reset a local-only branch to the baseline** *(DESTRUCTIVE — discards all commits & uncommitted changes after the tag; only on a private branch, never force-push shared):*
  `git reset --hard <BASELINE_TAG>`.
- **Restore the captured uncommitted work** (e.g., the NativeProductAdCard edit) if needed: `git apply rollback-baseline-2026-07-21/tracked-unstaged.patch`.

### 10B. Database rollback
- **Reverse only newly-added Phase-1 objects** (additive-only migrations): run the paired down-migration that drops *only* the Phase-1-added columns/objects, e.g. `alter table standardized_products drop column if exists <phase1_col>;`, `drop view if exists <phase1_view>;` *(DESTRUCTIVE to those new objects only — never touch legacy `category_code`/`category_label`/`scene_code`/`sku_custom`)*.
- **Restore backed-up definitions:** re-apply `db/schema/sellable_products_viewdef.sql` via `create or replace view public.sellable_products as <captured DDL>;` to restore the exact pre-Phase-1 view; RLS via `db/schema/rls_policies.txt`.
- **Confirm legacy fields/data unchanged:** re-export with the §4 query and `diff` against `db/products_category_fields.csv` — expect **zero** changes to legacy category columns and a sellable count of **349**.
- Supabase PITR remains available as an independent safety net (do not rely on it alone).

### 10C. Feature rollback
- **Disable new taxonomy feature flag(s):** set the Phase-1 flag(s) to off in remote config (`home_content_config`, screen matching the flag) — the app dual-reads and **falls back to legacy `inferCategoryPath`** automatically. Ship via **EAS Update** (channel `production`) — no rebuild needed.
- **Force legacy Home/Discover:** with the flag off, `CATEGORY_CIRCLES` (App.tsx:75-84) + `PRODUCT_CATEGORIES` (categories.ts:8-18) + `inferCategoryPath` drive navigation exactly as captured in §5.
- **Fastest revert:** re-publish the previous OTA JS bundle to `production` (runtimeVersion `1.0.12`) — restores the pre-Phase-1 experience on installed build 34 without an App Store submission.

## 11. Unresolved risks
1. **Uncommitted work not yet checkpointed** — 1 modified file (`NativeProductAdCard.tsx`, "do not commit") + 102 unrelated untracked files. The git recovery point cannot be finalized until scope is decided (§12).
2. **`dist/` is not gitignored** — 41 build-output files show as untracked; they should not enter the checkpoint. Recommend adding `dist/` to `.gitignore` (separate hygiene fix, not part of this baseline).
3. **Baseline is not fully green** — `iosReleaseBuild.test.ts` fails on a stale version literal (1.0.10 vs 1.0.12). Unrelated to taxonomy, but the suite is not 100% passing; fixing it is out of scope here.
4. **No on-device E2E** — Home/Discover/Search behavior is verified via pure logic + code, not an automated device test. **[Needs Verification]**
5. **DB export is logical, not a physical snapshot** — pairs with Supabase PITR; ensure PITR window covers the Phase-1 work period.
6. **`normalize_supplier_products` DB function exists** — relationship to the TS `scripts/normalizeProducts.ts` pipeline is unconfirmed **[Needs Verification]**; confirm which is authoritative before Phase-1 DB changes.

## 12. Decision required before creating the checkpoint (§5 of the task)
The worktree contains unrelated/ambiguous uncommitted work. Choose how to establish the recovery point (see chat). Nothing will be committed, tagged, reset, or stashed until you decide.
