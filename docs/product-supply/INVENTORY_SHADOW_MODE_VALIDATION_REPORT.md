# Inventory Automation — Post-Migration Shadow-Mode Validation

**Version:** `product-bible-v1.0-rc1`
**Date:** 2026-07-31
**Branch:** `fix/quoted-price-buynow-checkout`
**Status:** ✅ Shadow mode validated in production. No delist, no relist, no publication change.

Migration `20260731_inventory_workflow_states.sql` was applied by the Founder via the Supabase SQL
Editor. It was **not** re-run. This report covers activation from Phase 2 onward.

---

## 1. Executive summary

The persisted inventory workflow is **live and working in production**. The defect that made
multi-confirmation impossible is now fixed end to end: workflow state and consecutive-observation
counters survive across runs, and re-processing the same evidence is a proven no-op.

Five Stage 1 SKUs were initialised conservatively. Every safety property held:

| Property | Result |
| --- | --- |
| Schema present with all columns | ✅ 14 + 18 columns verified |
| CHECK constraints enforce | ✅ invalid state and negative counter both rejected (`23514`) |
| Dry-run writes nothing | ✅ 0 rows after dry-run |
| Shadow update persists state | ✅ 5 state rows + 5 history rows |
| Idempotent re-run | ✅ 5 skipped, 0 writes — twice |
| History deduplication | ✅ 0 duplicates across 3 total runs |
| Counters initialised conservatively | ✅ max value 1 |
| Publication unchanged | ✅ 353 → 353, zero per-SKU drift |
| Execution refuses non-eligible SKUs | ✅ 4 fail-closed guards verified |

---

## 2. Schema verification (read-only)

```
inventory_workflow_states       EXISTS  rows=0
inventory_workflow_transitions  EXISTS  rows=0
states columns   : all 14 present ✓
transitions cols : all 18 present ✓
```

**Constraint enforcement proven by attempted invalid writes** (both rejected, table left empty):

| Attempt | Result |
| --- | --- |
| `workflow_state = 'not_a_real_state'` | **REJECTED** `23514` ✅ |
| `consecutive_out_of_stock = -1` | **REJECTED** `23514` ✅ |
| Rows after both attempts | **0** ✅ |

The six-state CHECK and the non-negative-counter CHECK are both live.

---

## 3. Conservative initialisation

No historical assumptions were injected. Products with no persisted row start from the initial
snapshot `{ published_in_stock, 0, 0 }`, and only the first real observation moves them — so the
maximum any counter could reach on initialisation is **1**.

Verified after initialisation:

```
rows=5   ALL counters <= 1 : true
```

No counter was seeded from `inventory_status`, publication history, or any inferred past state.

---

## 4. Allowlisted dry-run (zero writes)

```
Mode   : DRY RUN (no DB writes)
Scope  : ONLY 5 SKU(s)
scanned=5  rowsWritten=0  historyAppended=0  duplicateSkipped=0  conflicts=0  exceptions=0
buckets: {"no_action":5}
```

Post-check: `states=0  transitions=0` — **confirmed zero writes**.

---

## 5. Shadow-mode update (one run)

```
scanned=5  rowsWritten=5  historyAppended=5  duplicateSkipped=0  conflicts=0  exceptions=0
buckets: {"no_action":5}
```

Persisted state:

| SKU | Workflow state | oos | in | version | Last observed |
| --- | --- | --- | --- | --- | --- |
| GX001029AAE | `published_in_stock` | 0 | 1 | 1 | `confirmed_in_stock_ca` |
| W2339P230587 | `published_in_stock` | 0 | 1 | 1 | `confirmed_in_stock_ca` |
| W244P172637 | `published_in_stock` | 0 | 1 | 1 | `confirmed_in_stock_ca` |
| W2817S00021 | `published_in_stock` | 0 | 1 | 1 | `confirmed_in_stock_ca` |
| W5881P505001 | `published_in_stock` | 0 | 1 | 1 | `confirmed_in_stock_ca` |

`version = 1` is correct: each row was inserted once, and the subsequent re-runs skipped without
updating, so nothing incremented it.

Transition history — exactly 5 rows, one per SKU:

```
<SKU>  published_in_stock → published_in_stock  before(oos=0,in=0) after(oos=0,in=1)  action=none
```

Counters before **and** after are recorded, satisfying the audit requirement.

**Thin-inventory protection confirmed in production:** W244P172637 (3 CA units of 48 total)
observed as `confirmed_in_stock_ca` → `no_action`. Thin stock was not treated as out of stock.

---

## 6. Idempotency verification

The runner was executed **twice more** against unchanged evidence:

| Run | rowsWritten | historyAppended | duplicateSkipped |
| --- | --- | --- | --- |
| Shadow update | 5 | 5 | 0 |
| Re-run #1 | **0** | **0** | **5** |
| Re-run #2 | **0** | **0** | **5** |

Database confirmation after all three runs:

```
transition rows        = 5   (not 15)
duplicate history rows = 0
distinct run_ids in history = 1
```

Counters did not double. Only the shadow run wrote history. This is the behaviour that was
structurally impossible before the migration.

---

## 7. Recommendation output

`scripts/inventoryActionRecommendations.ts` — read-only, `mutated_anything: false`.

```
scanned=5  no_action=5
── NO_ACTION (5) — none
   GX001029AAE   pub=true  wf=published_in_stock  evi=confirmed_in_stock_ca  oos=0 in=1  approval=no
   … (5 total)
```

Entries requiring Founder approval: **0** — correct, since nothing is eligible for action after a
single in-stock observation. JSON artifact: `reports/inventory-decisions/shadow-reco.json`
(gitignored).

---

## 8. Execution-path safety (no action executed)

The approved-action runner was exercised in refusal scenarios only:

| Scenario | Result |
| --- | --- |
| Delist a SKU in `published_in_stock` | **REFUSED** — `state_mismatch:expected=eligible_for_delist,actual=published_in_stock` |
| No `--only` allowlist | **FAIL-CLOSED** — "This runner NEVER operates on all products" |
| No `--action` | **FAIL-CLOSED** — action required |
| `--approve` without `--approved-by` | **FAIL-CLOSED** — approver identity required |

Published count after every refusal: **353** (unchanged).

**No delist or relist was executed. `--approve` was never used successfully.**

---

## 9. Exact write set

**Written (operational tables only):**

| Table | Change |
| --- | --- |
| `inventory_workflow_states` | 0 → **5 rows** (the allowlisted Stage 1 SKUs) |
| `inventory_workflow_transitions` | 0 → **5 rows** (append-only) |

**Verified unchanged:**

| Table / metric | Before → After |
| --- | --- |
| `standardized_products.published = true` | 353 → **353** ✅ |
| `sellable_products` | 353 → **353** ✅ |
| `inventory_cache` | 1225 → **1225** ✅ |
| Per-SKU `published` / `inventory_status` / `selling_price` | **0 drift across all 5** ✅ |

`refresh_product_inventory_status()` was **never called**. No supplier access, no Playwright, no
Saved Items change, no pricing or review change.

---

## 10. Remaining steps before automatic execution

1. **Accumulate real observation history.** Counters advance only on genuinely new scrapes. A
   delist recommendation requires two consecutive confirmed zeros from two separate observations —
   none exists yet, by design.
2. **Enable scheduled observation** (still Founder-gated and currently not scheduled):
   ```bash
   INVENTORY_CACHE_ONLY=1 PRODUCT_IDS="<scoped list>" npx tsx scripts/syncGigaInventoryXhr.ts
   npx tsx scripts/inventoryWorkflowRun.ts --sellable --limit=100
   npx tsx scripts/inventoryActionRecommendations.ts
   ```
3. **Broaden initialisation** beyond the 5 validated SKUs once the cadence is approved.
4. **Fix `sweep_stale_inventory`** — unscheduled, 344 rows overdue, and its comment (24h)
   contradicts its predicate (7 days). Automatic execution must not consume a staleness signal
   known to under-report.
5. **Demonstrate accuracy over time** before any automatic delist/relist, per the Product Bible.
6. **Reconcile the divergent migration histories** (11 other local migrations still show unapplied).

---

## 11. Confirmations

- **No delist, no relist, no publication change.** Published and sellable counts identical to
  baseline; per-SKU drift zero.
- **No second writer to `published`** — the RPC was not called at all during this validation.
- **No supplier access, no Playwright, no Saved Items change, no pricing/review change.**
- **No scheduler activated.** No launchd, cron, or `pg_cron` entry created or modified.
- **Migration not re-run.**
- **Nothing pushed.**
- `/Users/heliu/XOne` and `/Users/heliu/xself-seller-automation` were never accessed.
