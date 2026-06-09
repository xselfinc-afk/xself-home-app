# GIGA Saved Items → App: Batch Onboarding Runbook

Status: **proven end-to-end on a 20-SKU pilot** (sellable_products 151 → 171, zero impact to the 151 existing live products). This runbook standardizes that proven manual sequence into a repeatable, gated batch workflow for the remaining staged products and future GIGA Saved Items.

> **Golden rule:** never process the full catalog. Every batch is an explicit, reviewed SKU set, run through PLAN → DRY_RUN → APPLY_PREP, and only then (separately approved) APPLY_INVENTORY.

---

## 0. One-time prerequisites (all currently satisfied)

| Prereq | State | Notes |
|---|---|---|
| `.env.giga-alt.local` with **openapi.gigab2b.com** host + Production creds | ✅ | GIGA Open API auth (`product/skus`, `inventory/quantity/v2`) |
| `.env.local` with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | ✅ | service-role for scripts |
| `sellable_products` view requires `selling_price > 0` (migration `20260609_…`) | ✅ applied | cost-exposure lock |
| `dynamic-pricing` edge fn deployed with `only_skus`/`dry_run` | ✅ deployed | project `erbimgfbztkzmpamzwky` |
| `product-images` Storage bucket (public) | ✅ exists | mirror target |
| Scoped scripts committed | ✅ | `syncPickup`, `normalizeProducts`, `generateOptimizedTitles`, `mirrorImagesToStorage`, `backfillBlurhash`, `seedPilotInventory` |

---

## 1. The pipeline (stages, scripts, gate semantics)

Order is **cost-safe by construction**: a product cannot appear in `sellable_products` until it has `selling_price > 0` AND `inventory_status='in_stock'`. Inventory is always last, so nothing is ever exposed at supplier cost.

| # | Stage | Tool | Scope flag | Writes | Visibility effect |
|---|---|---|---|---|---|
| 1 | Import staged SKUs | `scripts/syncPickup.ts` (`INSERT_NEW_ONLY=1`) | n/a (buyer list) | `supplier_products` (published=false) | none |
| 2 | Select & review candidates | PLAN query (below) | — | none | none |
| 3 | Publish (review gate) | `PATCH supplier_products.published=true` | `ONLY_SKUS` | `supplier_products.published` | none (still no standardized row) |
| 4 | Normalize | `scripts/normalizeProducts.ts` | `ONLY_SKUS` + `DRY_RUN` | `standardized_products` (price=cost) | none (no selling_price/inventory) |
| 5 | Optimized titles | `scripts/generateOptimizedTitles.ts` | `ONLY_SKUS` + `DRY_RUN` | `optimized_title` | none |
| 6 | Pricing | `dynamic-pricing` edge fn `{only_skus,dry_run}` | body | `selling_price`,`original_price`,… | none (inventory still missing) |
| 7 | Mirror images | `scripts/mirrorImagesToStorage.ts` | `ONLY_SKUS` + `DRY_RUN` | `primary_image_mirror_*` | none |
| 8 | Blurhash/dims | `scripts/backfillBlurhash.ts` | `ONLY_SKUS` + `DRY_RUN` | `primary_image_blurhash/_w/_h/_aspect` | none |
| 9 | **Inventory seed (EXPOSURE)** | `scripts/seedPilotInventory.ts` (`APPLY=1`) | `ONLY_SKUS` | `inventory_cache` (website_scrape) + `refresh_product_inventory_status()` per SKU | **flips published/in_stock → VISIBLE & purchasable** |
| 10 | Verify | read-only adapter + counts | `ONLY_SKUS` | none | confirm |

**Why stage 9 is the only exposure point:** `sellable_products` gates on `normalization_status='done'` ∧ `published=true` ∧ `inventory_status='in_stock'` ∧ `total_available_qty>0` ∧ `primary_image` ∧ **`selling_price>0`**. Stages 1–8 satisfy everything *except* the inventory gates, so the batch stays invisible until stage 9.

---

## 2. Orchestrator modes (design)

A single orchestrator (`scripts/runGigaSavedItemsBatch.ts`, **not yet built — design below**) runs the stages by `MODE`:

| MODE | Runs stages | Writes? | Exposes? |
|---|---|---|---|
| `PLAN` | 2 (select/validate) + print before-counts | no | no |
| `DRY_RUN` | 4–9 in dry-run/preview only | no | no |
| `APPLY_PREP` | 3,4,5,6,7,8 (publish → … → blurhash) | yes (non-exposure) | **no** (inventory gate still blocks) |
| `APPLY_INVENTORY` | 9 only — **requires `APPLY_INVENTORY=1`** | yes | **YES** |

After any mode it prints before/after counts and a non-pilot-untouched assertion.

### Required orchestrator safety (hard rules)
1. **Refuse to run without `ONLY_SKUS` or `BATCH_FILE`** (a reviewed newline/comma SKU list). No default → full catalog is impossible.
2. **Cap batch size** — refuse > `MAX_BATCH` (default 150) unless `FORCE_BIG=1`.
3. **`APPLY_INVENTORY` requires the explicit `APPLY_INVENTORY=1` flag** in addition to `MODE=APPLY_INVENTORY` (double-confirm for the exposure step).
4. Capture & print **before/after**: `sellable_products` total, sellable count for the batch, sellable count for **non-batch** (must be constant until stage 9), `supplier_products.published=true` total, `standardized_products` total.
5. **Assert non-batch invariants**: non-batch sellable count and standardized total unchanged across every mode except the deliberate deltas at APPLY_PREP (standardized +N) / APPLY_INVENTORY (sellable +N).
6. **Sellable count may change ONLY at `APPLY_INVENTORY`.** If it changes during PLAN/DRY_RUN/APPLY_PREP → abort and report.
7. Each sub-step keeps its own scoped+dry-run guard (defense in depth); orchestrator passes `ONLY_SKUS` to every call and never calls a script unscoped.
8. On any sub-step failure: **stop**, report the exact stage + mismatch, do not continue, surface rollback (§6).

### Orchestrator implementation sketch
- Reads `MODE`, `ONLY_SKUS`/`BATCH_FILE`, `MAX_BATCH`, `APPLY_INVENTORY`.
- Loads env (`.env.giga-alt.local` then `.env.local`).
- Validates each SKU in `standardized_products` for the stage it's about to run (e.g. before stage 9: normalized + selling_price>0 + image + mirror + blurhash).
- Drives sub-steps via `child_process` (env-scoped) for the Node scripts, and `fetch` for the deployed `dynamic-pricing` function. Reuses the *committed* scripts — no duplicated business logic.
- Emits a per-stage table + a final before/after summary + invariants check.

---

## 3. Batch sizing

| Phase | Batch size | Gate |
|---|---|---|
| Next batch (first standardized run) | **30–50 products** | full PLAN + DRY_RUN + manual review of the candidate list |
| After ≥1 clean batch | **100 products** | PLAN + DRY_RUN still required |
| Ever | **never the full remaining set in one shot** | always PLAN + DRY_RUN; split into ≤100 |

Rationale: image mirroring is the slowest stage (large supplier originals, ~1–40 MB each, fetched serially-ish); 30–50 keeps a batch under a few minutes and makes failures easy to retry (the mirror script is idempotent and re-selects `mirror_path IS NULL`).

---

## 4. Risk gates

- **Cost exposure** → handled by the `selling_price>0` clause in `sellable_products` (migration applied) **and** by ordering pricing (stage 6) before inventory (stage 9). A product can never display supplier cost.
- **Premature visibility** → inventory (stage 9) is the single exposure switch, behind `APPLY_INVENTORY=1`.
- **Touching live products** → every stage is `ONLY_SKUS`-scoped; orchestrator asserts non-batch counts are constant until the deliberate deltas.
- **Title/brand leakage** → `optimized_title` strips brands/marketing/codes (stage 5); PLAN excludes brand-prefixed/marketing/model-code titles up front.
- **Large images (future batches)** → today's proxy (Cloudinary fetch, ~200 KB delivered) shields the app; **but Cloudinary free plan rejects originals >10 MB (HTTP 400) → app falls back to the full multi-MB mirror.** Pilot max was 6.8 MB (safe). **Before a large future batch, add mirror-time compression** (`mirrorImagesToStorage.ts`: re-encode to ≤~1600px / WebP) so no stored original exceeds 10 MB. Add a PLAN check that flags supplier originals >10 MB.
- **Low stock** → e.g. pilot `N733S304513D` had qty 2. PLAN should surface batch SKUs with total qty < 5 for awareness (they go live but may flip out-of-stock quickly).

---

## 5. Candidate selection (PLAN query)

For each new batch, select from staged rows and filter (mirrors the proven pilot selection):
- staged: `supplier_products.published=false` AND recently imported.
- **exclude:** trash/garbage, pet/dog/cat/fish-tank, kids/toy/nursery/bunk/Murphy, patio/outdoor, brand-prefix titles (TREXM/VIBE HAUS/etc.), marketing phrases (Made in USA/5-Day/[Video]/Old SKU), model-code-prefixed titles, missing price, missing image, very low price (<$30).
- **prefer:** dresser/chest, TV/media, sideboard/cabinet, bathroom vanity/storage, bookcase/shelf, desk/table.
- **dedupe** near-identical titles; cap to the batch size; **human-review the list** before publishing.
- **variant clusters (REQUIRED):** before finalizing the batch, resolve each candidate's variant cluster from `raw_payload.associateProductList` (siblings sharing a ≥8-char SKU prefix — same rule as `scripts/syncGigaVariants.ts`). For every cluster, either **import the whole cluster together in the same batch** (so all siblings normalize in one pass and receive the same supplier-derived `product_family_key` → one card + working color selector) **or explicitly choose a single representative SKU** and drop the rest. **Never import a partial cluster** — that orphans colors as separate cards. Normalization now derives `product_family_key` via `resolveVariantGroupKey()` (see `docs/giga-variant-grouping-design.md`); importing a partial cluster would still split it, because the missing siblings simply don't exist to group with.

Produce a reviewed `ONLY_SKUS` string (or `BATCH_FILE`).

---

## 6. Rollback (per batch)

```sql
-- Undo the inventory exposure for a batch (drops them back out of sellable_products):
DELETE FROM public.inventory_cache
 WHERE source_type='website_scrape'
   AND raw_payload->>'source_note'='official_api_pilot_seed'   -- batch-tagged seed rows
   AND product_id = ANY (ARRAY[ '<sku1>', '<sku2>', ... ]);
SELECT public.refresh_product_inventory_status(sku)
  FROM unnest(ARRAY['<sku1>','<sku2>', ...]) AS sku;
-- Optional: un-publish at source
-- UPDATE public.supplier_products SET published=false WHERE supplier_product_id = ANY(ARRAY[...]);
```
(Pricing/title/normalize are non-exposure and can be left as-is; only the inventory rows + refresh control visibility.)

---

## 7. Exact next-batch command sequence (until the orchestrator exists)

Set the reviewed batch once:
```bash
export BATCH="sku1,sku2,...,skuN"     # 30–50 reviewed SKUs
```
Then:
```bash
# (1) IMPORT new staged SKUs (only if importing more from the buyer list)
DRY_RUN=1 INSERT_NEW_ONLY=1 npx tsx scripts/syncPickup.ts        # preview
INSERT_NEW_ONLY=1            npx tsx scripts/syncPickup.ts        # writes published=false rows

# (2) PLAN: review candidates → produce $BATCH (manual review)

# (3) PUBLISH the batch (supplier_products.published=true) — scoped PATCH (orchestrator/SQL)

# (4) NORMALIZE
DRY_RUN=1 ONLY_SKUS="$BATCH" npx tsx scripts/normalizeProducts.ts
          ONLY_SKUS="$BATCH" npx tsx scripts/normalizeProducts.ts

# (5) OPTIMIZED TITLES
DRY_RUN=1 ONLY_SKUS="$BATCH" npx tsx scripts/generateOptimizedTitles.ts
          ONLY_SKUS="$BATCH" npx tsx scripts/generateOptimizedTitles.ts

# (6) PRICING (deployed edge fn) — dry-run then apply
curl -s -X POST "$SUPABASE_URL/functions/v1/dynamic-pricing" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H 'Content-Type: application/json' -d "{\"dry_run\":true,\"only_skus\":[ ...batch... ]}"
curl -s -X POST "$SUPABASE_URL/functions/v1/dynamic-pricing" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H 'Content-Type: application/json' -d "{\"only_skus\":[ ...batch... ]}"

# (7) MIRROR
DRY_RUN=1 ONLY_SKUS="$BATCH" npx tsx scripts/mirrorImagesToStorage.ts
          ONLY_SKUS="$BATCH" npx tsx scripts/mirrorImagesToStorage.ts

# (8) BLURHASH / DIMS
DRY_RUN=1 ONLY_SKUS="$BATCH" npx tsx scripts/backfillBlurhash.ts
          ONLY_SKUS="$BATCH" npx tsx scripts/backfillBlurhash.ts

# (9) INVENTORY — dry-run (safe), then APPLY (EXPOSURE — separate approval)
DRY_RUN=1 ONLY_SKUS="$BATCH" npx tsx scripts/seedPilotInventory.ts
APPLY=1   ONLY_SKUS="$BATCH" npx tsx scripts/seedPilotInventory.ts     # <-- exposure

# (10) VERIFY: sellable += N; non-batch sellable unchanged; cards render selling_price + mirrored image.
```

Once `scripts/runGigaSavedItemsBatch.ts` exists, this collapses to:
```bash
MODE=PLAN            ONLY_SKUS="$BATCH" npx tsx scripts/runGigaSavedItemsBatch.ts
MODE=DRY_RUN         ONLY_SKUS="$BATCH" npx tsx scripts/runGigaSavedItemsBatch.ts
MODE=APPLY_PREP      ONLY_SKUS="$BATCH" npx tsx scripts/runGigaSavedItemsBatch.ts
MODE=APPLY_INVENTORY APPLY_INVENTORY=1 ONLY_SKUS="$BATCH" npx tsx scripts/runGigaSavedItemsBatch.ts
```

---

## 8. Verification queries (per batch)

```text
sellable_products total            → must be prev_total + N only after APPLY_INVENTORY
batch SKUs in sellable_products     → N (after exposure)
non-batch sellable count            → constant throughout
batch: inventory_status='in_stock'  → N
batch: published=true               → N
batch: selling_price>0              → N (after pricing)
batch primary price (adapter)       → equals selling_price, never standardized_products.price (cost)
batch image host                    → supabase storage (mirror), HTTP 200, proxy-resized ~200KB
```

---

## 9. Verified Live Variant Test 1 — Clean Color Variant Pair

First live, end-to-end validation of Phase 1 supplier-derived `product_family_key` grouping (see `docs/giga-variant-grouping-design.md`). Run as 8 gated stages, each with pre-check → dry-run → verify.

**Family:** `dr-vg-w409s00014`
**SKUs:** `W409S00014` = Black · `W409S00015` = White (both 9-drawer, 63", Particle Board, supplier cost $135)

**Result (verified):**
- Both SKUs normalized to `product_family_key='dr-vg-w409s00014'` (supplier-derived, contains `-vg-`).
- Both became live and sellable; `sellable_products` **191 → 193** (2 underlying rows).
- The App feed **deduped the 2 sellable rows into 1 product card** (dedupe by `product_family_key` in Home/Discover/Collection).
- The detail page loaded **Black / White** variants correctly via `loadProductFamily('dr-vg-w409s00014')` (2 variants).
- **User confirmed** the product appeared in the App after restarting/refetching (see cache note below).
- Pricing **identical for both variants**: `selling_price=$289`, `original_price=$399` (same cost → same price).
- Images mirrored (HTTP 206), blurhash + dims set, inventory seeded, reviews seeded — all for both rows.
- Each SKU received **5 generated reviews**; `product_reviews` **1060 → 1070**.
- **`W409S00028` intentionally excluded** — same series but a same-color, different-configuration variant (White, 47.2", 8 drawers, different supplier cost). Including it would put two "White" entries in the color-keyed selector; it needs **Phase 2** color + size/config labels first.

**Conclusions:**
- ✅ **Clean color-only variant clusters are safe to batch-onboard now** under Phase 1 supplier-derived `product_family_key`.
- ⏸ **Same-color, different-size/configuration clusters must be held until the Phase 2 selector upgrade** (color + size/config label — see `docs/giga-variant-grouping-design.md` §7 and the Phase-2 design).
- ⚠️ **App cache/refetch:** Home/Discover fetch `sellable_products` only on mount (Home also hydrates an AsyncStorage cache); newly exposed products may require an **app restart / screen remount** to appear. Future improvement: add **pull-to-refresh / refetch** to Home and Discover.

### Acceptance checklist — future clean color-variant batches
1. Same product family (supplier `associateProductList`, shared SKU prefix ≥ 8).
2. Same category.
3. Same dimensions / configuration (drawer count, width, etc.).
4. Same or compatible pricing (same supplier cost → identical selling price expected).
5. Distinct colors (one per variant).
6. Shared supplier-derived `product_family_key` containing `-vg-`.
7. No duplicate-color ambiguity (each color appears once → color selector unambiguous).
8. Feed shows **1 card** (dedupe by `product_family_key`).
9. Detail page shows **color variants** (Black / White swatches via `loadProductFamily`).
10. Inventory exposure increases **underlying sellable rows**, not card count (N rows → 1 card).

> If any of 3/4/7 fail (differing size/config or duplicate colors), **hold the cluster for Phase 2** — do not onboard it as a clean color batch.

---

## File list (this runbook + proposed)
- `docs/giga-saved-items-pipeline-runbook.md` — **this file (created)**.
- `scripts/runGigaSavedItemsBatch.ts` — **proposed orchestrator (design above; not yet built — pending approval)**.
- Reused (already committed): `scripts/syncPickup.ts`, `scripts/normalizeProducts.ts`, `scripts/generateOptimizedTitles.ts`, `scripts/mirrorImagesToStorage.ts`, `scripts/backfillBlurhash.ts`, `scripts/seedPilotInventory.ts`, `supabase/functions/dynamic-pricing/index.ts`, migration `supabase/migrations/20260609_sellable_products_require_selling_price.sql`.
</content>
