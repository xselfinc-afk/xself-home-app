# GIGA Variant Grouping — Supplier-Derived `product_family_key`

**Status:** Phase 1 implemented (code only — no normalization run, no DB writes, not committed at time of writing).
**Scope:** `src/services/familyKeyGenerator.ts` (+ one call site in `src/services/normalizationPipeline.ts`). No schema change, no UI change, no `productFamilyService` change.

---

## 1. Background

The app already supports product variants entirely through `standardized_products.product_family_key`:

- **Feed / list** dedupes by `product_family_key` (App.tsx, CollectionScreen) — one representative card per family.
- **Detail page** merges same-`product_family_key` rows into a color/finish variant selector via `loadProductFamily()` (`productFamilyService`).

The storage model is correct: **one row per `supplier_product_id`**. Only the *grouping key* was weak.

## 2. Problem

`product_family_key` was title-derived: `computeFamilyKey(title, cc)` — lowercases the title, strips color words, keeps the first 6 meaningful words. GIGA siblings often carry **different model names per color**, so they produced **different keys → duplicate cards, no variant selector**.

GIGA exposes authoritative sibling data in `raw_payload.associateProductList` (the complete sibling-SKU list per row, plus cross-sells). `scripts/syncGigaVariants.ts` already encodes the rule that distinguishes true variants from cross-sells: **a shared SKU prefix of ≥ 8 characters** (`PREFIX_MIN_MATCH = 8`).

Scale in the remaining ~359 staged products: **~42 variant clusters / ~101 SKUs**.

## 3. Phase 1 solution

A pure helper, `resolveVariantGroupKey()`, derives the family key from supplier data when available and falls back to the existing title-based key otherwise.

```
siblings = raw_payload.associateProductList
         |> keep strings, trim, drop empties, drop self
         |> keep only those sharing a ≥ 8-char prefix with self   // syncGigaVariants rule
cluster  = { self } ∪ siblings
if cluster.size > 1:
    groupRoot = lexicographically smallest SKU in cluster
    product_family_key = `${cc}-vg-${groupRoot}`   (lowercased)
else:
    product_family_key = computeFamilyKey(title, cc)   // unchanged title-derived behavior
```

**Why min-SKU root is stable:** `associateProductList` is complete per row (each sibling lists the others), so every member of a cluster computes the *same* `min(cluster)` → the *same* key → they group. No global state, no ordering dependency, no I/O — pure and deterministic, unit-testable.

**Why the ≥8 prefix filter:** it is the project's existing variant definition. It screens out the cross-sell SKUs that `associateProductList` also contains, and — combined with `cc` (category code) in the key — prevents cross-category merges.

### Integration point

`normalizeProduct()` previously set:

```ts
product_family_key: computeFamilyKey(productTitle, cc),
```

now:

```ts
product_family_key: resolveVariantGroupKey(raw, supplierProductId, cc, productTitle),
```

The read side is untouched — feed dedupe, `loadProductFamily`, and the variant selector already key off `product_family_key`. **No migration, no new column, no UI change.**

## 4. Blast radius — deliberately narrow

- The new key is only produced **when a row is (re-)normalized.** No existing row changes on its own. Phase 1 runs no normalization and writes nothing — every live row keeps its current key.
- The **20 live pilot products**: a read-only simulation (`scripts/simulateVariantGrouping.ts`) shows **12 of 20 would adopt a `-vg-` key if re-normalized** (they carry `associateProductList` siblings ≥8-prefix). Their siblings are **not yet imported**, so today each renders correctly as its own single card with a distinct title-derived key — there are no duplicates to collapse yet. They are **unchanged by Phase 1**; merging them would be a deliberate Phase 2 step (import the siblings, then scoped re-normalize). The other 8 keep their title-derived key.
- The **151 pre-existing live products** keep their current title-derived keys until/unless deliberately re-normalized (Phase 2, optional).
- Going forward, **new batches group correctly from first normalize** — provided whole clusters are imported together (see §6).

### Phase 1 simulation findings (read-only, 364 staged + 20 pilot)

- 364 staged rows: **227 would receive a `-vg-` key**, 137 keep the title-derived key.
- **27 realized clusters** (≥2 siblings co-present in the staged set) → **29 duplicate cards eliminated** if those clusters import together (364 → 335 cards).
- **171 staged rows reference variant siblings that are *not* co-present** in the staged set — they would land as single cards until their siblings are imported. Because the key is anchored on the cluster's lexicographically-smallest SKU (`groupRoot`), a later-imported sibling computes the **same** root and **auto-merges** — *provided `associateProductList` is symmetric*. The whole-cluster import rule (§6) removes the dependency on that assumption.
- **False-merge risk: none observed.** No oversized clusters; the algorithm errs toward *splitting*, never combining distinct products.
- **1 mixed-category non-merge** (`W331S00076` → `cb-vg-…` vs `W331S00080` → `dr-vg-…`): a true ≥8-prefix sibling pair that does **not** merge because the two rows derive different category codes. Conservative (no wrong merge), but a known limitation — a cluster spanning two derived categories will stay split. Phase 2 could reconcile category per cluster if desired.

## 5. Edge cases & false-grouping safeguards

| Case | Handling |
|---|---|
| Cross-sells inside `associateProductList` | excluded by the ≥8-char shared-prefix filter |
| Cross-category associate (e.g. a desk listing a chair) | prefix filter + `cc` in the key prevents the merge |
| Siblings sharing < 8 chars (e.g. `B062P374…` vs `B062P378…`) | treated as **separate products** — conservative; matches today's behavior; no false merge |
| Single-SKU "family" | falls back to title key → renders as a normal single product (no selector) |
| `associateProductList` absent / non-array / non-string entries | filtered out → title-derived fallback |
| Cross-batch siblings (one already live, one in a new batch) | won't group (different key regimes) → mitigated by the whole-cluster import rule (§6) |

## 6. Operational rule for future batches (REQUIRED)

When composing a batch, resolve each candidate's cluster (siblings sharing a ≥8-char SKU prefix in `associateProductList`) and then **either**:

1. **import the whole cluster together** in the same batch (all siblings normalize in one pass → same supplier-derived key → one card + working color selector), **or**
2. **explicitly choose one representative SKU** and drop the rest.

**Never import a partial cluster** — the missing siblings don't exist to group with, so colors orphan into separate cards. This rule is also recorded in `docs/giga-saved-items-pipeline-runbook.md` §5.

## 7. Phase 2 (optional, not in scope here)

> **Status:** Phase 1 grouping is **verified live** for clean color-only pairs — see *Verified Live Variant Test 1* (`docs/giga-saved-items-pipeline-runbook.md` §9): family `dr-vg-w409s00014` (Black `W409S00014` / White `W409S00015`) deduped to 1 feed card with a working Black/White selector. The **trigger** for the Phase 2 selector upgrade is the held same-color/different-config sibling `W409S00028` (White, 47.2", 8 drawers), which needs a color + size/config label to disambiguate the duplicate "White".

- **Variant selector upgrade (color + size/config label)** for duplicate-color / different-configuration families — the primary Phase 2 item.
- Card price = family **minimum** `selling_price` ("from $X") for multi-price families.
- Disable out-of-stock variants in the selector (per-SKU inventory already available).
- Family-aggregated review display (storage stays per-`supplier_product_id`).
- Controlled re-normalize of the 151 existing products to adopt supplier-derived keys, reviewed against a before/after grouping diff before APPLY.

## 8. Files

- `src/services/familyKeyGenerator.ts` — new `resolveVariantGroupKey()` + `sharedPrefixLength()` helper + `VARIANT_PREFIX_MIN_MATCH = 8` (kept in sync with `scripts/syncGigaVariants.ts`). `computeFamilyKey()` unchanged.
- `src/services/normalizationPipeline.ts` — import swap + one call-site line.
- `docs/giga-saved-items-pipeline-runbook.md` — §5 whole-cluster rule; §9 *Verified Live Variant Test 1* result + clean color-variant acceptance checklist.
