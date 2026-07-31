# Inventory Automation — Implementation Report (Sprint 1)

**Version:** `product-bible-v1.0-rc1`
**Date:** 2026-07-31
**Branch:** `fix/quoted-price-buynow-checkout`
**Status:** Code complete, tested, committed. **Migration authored but NOT applied — blocked, see §11.**

---

## 1. Executive summary

The known defect is fixed in code: the six-state inventory workflow machine can now accumulate
consecutive observations across runs, making `eligible_for_delist` and `eligible_for_relist`
reachable for the first time.

Nothing customer-visible was enabled. No scheduler was activated. No delist or relist was executed.
`refresh_product_inventory_status()` remains the sole publication authority, and no new code writes
`published` or `inventory_status`.

**One blocker stopped Phase 9 (migration application):** the local and remote migration histories
have diverged, and **12 local migrations are unapplied on remote**. `supabase db push` would replay
**11 unrelated migrations** against production. That is the sprint's declared stop condition, so the
migration was not applied. Exact safe instructions are in §11.

---

## 2. Architecture reused (not rewritten)

| Component | How it was used |
| --- | --- |
| `src/services/inventoryStateMachine.ts` | **Unchanged.** All six states and both confirmation thresholds are called as-is |
| `src/services/inventoryResult.ts` | **Unchanged.** `classifyInventoryResult` remains the fail-closed classifier |
| `src/services/inventoryPriority.ts` | **Unchanged.** P1–P4 via the existing `classifyPriority` |
| `inventory_cache` data model | **Unchanged.** Read-only evidence source |
| `refresh_product_inventory_status()` | **Unchanged.** Still the only publication writer; the action runner calls it rather than replacing it |
| `sellable_products` view | **Unchanged.** Used to scope scans |
| `scripts/inventoryDecisionDryRun.ts` | **Left intact.** Still works as the legacy stateless preview |
| Existing conventions | `--only=` allowlist, `DRY_RUN=1`, gitignored `reports/` artifacts, fail-loud error handling |

No existing file was modified except `package.json` (five new script entries).

---

## 3. Schema introduced

`supabase/migrations/20260731_inventory_workflow_states.sql` — **additive only**, two new tables.

**`inventory_workflow_states`** — one row per product (current state):
`supplier_product_id` (UNIQUE), `supplier_sku`, `workflow_state`, `consecutive_out_of_stock`,
`consecutive_in_stock`, `last_observed_inventory_status`, `last_observed_at`,
`last_observation_key`, `last_transition_at`, `transition_reason`, `version`, `created_at`,
`updated_at`.

- `CHECK` constraint (not `ENUM`) pins the six authoritative state names — cheaper to evolve.
- `UNIQUE (supplier_product_id)` makes duplicate workflow rows impossible.
- Counters constrained `>= 0`.
- Partial index on the two actionable states for the recommendation queue.

**`inventory_workflow_transitions`** — append-only history:
from/to state, observed status, observation timestamp, counters before **and** after, proposed
action, observed exception, reason, `run_id`, `runner`, `transitioned_at`, with
**`UNIQUE (supplier_product_id, observation_key)`** enforcing deduplication at the database level.

**Deliberately absent:** any Saved Asset lifecycle column, any duplicated commerce-pipeline fact, any
trigger, any grant to `anon`/`authenticated` (RLS enabled, service-role only), and any write path to
`standardized_products`.

---

## 4. State persistence behaviour

`src/services/inventoryWorkflowRunner.ts` is a pure, I/O-free planning layer:

- `buildSignalsFromCacheRows()` — mirrors the existing dry-run derivation, so both paths classify
  identically. No usable rows → signals that classify as `inventory_unknown`, **never** zero.
- `usableCacheRows()` — only `sync_status='ok'` and `source_type IN ('website_scrape','official_api')`.
- `observationClass()` — `advance` only for CONFIRMED results; `hold` for unknown/stale/failure;
  `no_evidence` when nothing usable exists.
- `planWorkflowUpdate()` — returns exactly what should be written, computing nothing itself about the
  machine (it delegates to `transitionInventoryState`).

Fail-closed guarantees, all test-covered: a failed query never counts as out-of-stock; stale evidence
never counts as confirmed zero; unknown never advances counters; only CONFIRMED observations move
state.

---

## 5. Idempotency strategy

Each observation gets a deterministic fingerprint:

```
observationKey = `${supplier_product_id}|${observedAtIso}|${status}|${totalQuantity}`
```

- Stored on the workflow row as `last_observation_key`.
- Re-processing identical evidence → `alreadyProcessed = true` → **no counter advance, no row write,
  no history append**.
- A genuinely new scrape produces a new timestamp and therefore a new key, so real observations still
  advance normally (test 3b).
- Defence in depth: `UNIQUE (supplier_product_id, observation_key)` on the history table means even a
  concurrent double-write cannot create a duplicate event; the runner treats `23505` as benign.

**Concurrency:** every update is `WHERE supplier_product_id = ? AND version = <value read>` with the
version incremented. Zero rows matched → another runner won the race → the SKU is skipped with a
loud `CONCURRENCY CONFLICT` message and no write.

---

## 6. Recommendation behaviour

`scripts/inventoryActionRecommendations.ts` — **read-only, mutates nothing.**

Buckets: `eligible_for_delist`, `eligible_for_relist`, `pending_confirmation`, `no_action`,
`blocked_unknown`. Per SKU it reports title, current published state, workflow state, latest evidence,
both counters, last observation time, exact reason, proposed action, and whether Founder approval is
required (true only for the two action buckets).

A critical safety property: if the latest evidence is non-authoritative, the bucket is forced to
`blocked_unknown` **regardless of workflow state** — a stale or failed read can never surface a
delist recommendation.

Outputs human-readable text plus JSON (default `reports/inventory-decisions/recommendations.json`,
gitignored).

---

## 7. Founder approval path

`scripts/inventoryActionApply.ts` — **default-off, manual, allowlist-only.**

Five guards, all fail-closed:
1. `--action=delist|relist` required.
2. `--only=SKU[,SKU]` required — the runner **never** operates on all products.
3. `--approve` required to act (dry-run is the default), plus `--approved-by=<name>`.
4. The SKU must currently be in the required eligible state.
5. The live observation key must still equal the one the recommendation was based on — otherwise
   `evidence_changed_since_recommendation` and the SKU is skipped.

Execution calls **only** `refresh_product_inventory_status(sku)`. It never writes `published`. The
runner re-reads publication state afterwards and records before/after plus the approval identity to a
gitignored JSON evidence file. Because the RPC derives publication from evidence, a "delist" that the
evidence does not support simply produces no change — and that is reported honestly rather than
forced.

---

## 8. Scheduler status

**Not scheduled. Nothing was activated.** No launchd plist, cron entry, or `pg_cron` job was created
or modified.

Intended shadow-mode command once the migration is applied (**leave disabled until approved**):

```bash
INVENTORY_CACHE_ONLY=1 PRODUCT_IDS="<scoped list>" npx tsx scripts/syncGigaInventoryXhr.ts
npx tsx scripts/inventoryWorkflowRun.ts --sellable --limit=100
npx tsx scripts/inventoryActionRecommendations.ts
```

The first step keeps observation separate from publication (`INVENTORY_CACHE_ONLY=1` writes only
`inventory_cache` and skips the refresh RPC). The second and third never touch publication at all.

---

## 9. Tests

New: `src/__tests__/inventoryWorkflowRunner.test.ts` — **22 passing**, pure, no database.

| # | Requirement | Covered |
| --- | --- | --- |
| 1 | first zero → `pending_out_of_stock` | ✅ |
| 2 | consecutive zeros → `eligible_for_delist` | ✅ (+ 2b regression proving the old behaviour could never reach it) |
| 3 | same observation twice → counters do not double | ✅ (+ 3b new scrape does advance) |
| 4 | unknown → no advance | ✅ |
| 5 | stale → no advance | ✅ |
| 6 | auth/captcha/parse/network failure → no advance, exception raised | ✅ |
| 7 | recovery before delist eligibility | ✅ |
| 8 | delisted + first positive → `relist_pending` | ✅ |
| 9 | second positive → `eligible_for_relist` | ✅ |
| 10 | allowlist enforcement (empty ≠ "all") | ✅ |
| 11 | planning is side-effect free | ✅ |
| 12 | optimistic-concurrency token surfaced | ✅ |
| 13 | history deduplication | ✅ |
| 14 | execution refuses non-eligible SKU | ✅ |
| 15 | execution detects evidence drift | ✅ (+ 15b positive case) |
| 16 | publication change only via the existing authority | ✅ (buckets + approval flags) |
| 17–19 | untrusted sources excluded; thin CA stock protection; fail-closed status map | ✅ |

Existing suites re-run, all passing: `inventoryResult` (20), `inventoryStateMachine` (19),
`inventorySafetyLimits` (9), `xhrFetcherClassify` (11), `inventorySyncCacheOnly` (7),
`inventorySyncSessionDetection` (12). `npx tsc --noEmit --skipLibCheck` — **no errors**.

---

## 10. Dry-run and live-safe validation

**Fail-closed verified against production.** Running the dry-run before the table exists aborts
loudly:

```
[invWorkflow] FATAL inventory_workflow_states: PGRST205 Could not find the table … in the schema cache
```

It does **not** treat a missing table as "no rows" — the exact failure mode this codebase has been
bitten by before.

**Logic validated against real evidence.** Because the table cannot be created, the planning layer was
exercised against live `inventory_cache` and `standardized_products` data for the five Stage 1 SKUs
via a disposable scratchpad harness (read-only, not committed):

| SKU | Evidence | Qty | Age | Workflow result | Bucket |
| --- | --- | --- | --- | --- | --- |
| W5881P505001 | `confirmed_in_stock_ca` | 80 | 11.0h | `published_in_stock`, in=1 | `no_action` |
| W2339P230587 | `confirmed_in_stock_ca` | 161 | 11.0h | `published_in_stock`, in=1 | `no_action` |
| W244P172637 | `confirmed_in_stock_ca` | 48 | 11.0h | `published_in_stock`, in=1 | `no_action` |
| GX001029AAE | `confirmed_in_stock_ca` | 52 | 11.0h | `published_in_stock`, in=1 | `no_action` |
| W2817S00021 | `confirmed_in_stock_ca` | 23 | 11.0h | `published_in_stock`, in=1 | `no_action` |

**Thin-inventory protection confirmed:** W244P172637 (3 CA units of 48 total) classifies
`confirmed_in_stock_ca` and produces `no_action`. Thin stock is never treated as out of stock, and
observation for it remains cache-only.

No shadow-mode state update was performed, because the table does not exist. No delist or relist was
executed.

**Naming observation (no change made):** W2817S00021 is unpublished (Founder HOLD) yet its workflow
state is `published_in_stock`. The state name refers to the inventory condition, not publication
status. The names are authoritative and were not altered; the two axes are simply independent, which
is the intended design.

---

## 11. Exact write set

**Committed to git (3 commits):**

| Commit | Files |
| --- | --- |
| `c5b36e5e` feat: persist inventory workflow state | migration SQL, `inventoryWorkflowRunner.ts`, test, `inventoryWorkflowRun.ts`, `package.json` — 5 files, +1000 |
| `3de5ae38` feat: add inventory action recommendations | `inventoryActionRecommendations.ts` — +172 |
| `132bf760` feat: add approved inventory action runner | `inventoryActionApply.ts` — +193 |

**Database writes performed: NONE.** No schema change, no row inserted or updated, no RPC called
against production. All database access this sprint was `SELECT`-only.

**Nothing pushed.**

### ⛔ Migration application — BLOCKED (stop condition)

`supabase migration list` shows local and remote histories have diverged, with **12 local migrations
unapplied on remote**:

```
20260609, 20260613 ×4, 20260620, 20260621, 20260622,
20260707, 20260711 ×2, 20260728, 20260731 (this sprint)
```

`supabase db push` applies **all pending migrations**, so running it would replay 11 unrelated
migrations — touching RLS policies, guards, ads config, and the OOS pickup allowlist — against a
production database whose real state does not match the recorded history. That is the sprint's
declared stop condition ("migration would destroy or overwrite production data").

Corroborating evidence that the history is unreliable: `20260622_product_reviews_user_insert_policy`
is listed as **unapplied**, yet a genuine user review exists in `product_reviews` — so that policy
*was* applied outside the migration history. Migrations here are evidently applied manually.

A targeted apply was also unavailable: `psql` is not installed and no database password is present in
the environment or in `supabase/.temp/pooler-url`.

**Safe application path (requires your action):** paste the contents of
`supabase/migrations/20260731_inventory_workflow_states.sql` into the Supabase SQL editor. The file is
idempotent (`CREATE TABLE IF NOT EXISTS`), additive only, and touches no existing object.

---

## 12. Remaining blockers before automatic execution

1. **Apply the migration** (§11) — nothing else can run until the tables exist.
2. **Accumulate real observation history.** `eligible_for_delist` requires two consecutive confirmed
   zeros from two *separate* scrapes. Until the runner has executed repeatedly on a schedule, no
   delist recommendation can legitimately appear.
3. **Enable scheduled observation** (still Founder-gated) so counters can accumulate.
4. **Resolve the `sweep_stale_inventory` defect** — it is unscheduled (344 rows overdue) and its
   comment (24h) contradicts its predicate (7 days). Automatic execution must not consume a staleness
   signal that is known to under-report.
5. **Demonstrated accuracy over time.** The Product Bible requires delist/relist to remain gated until
   evidence shows high accuracy; shadow mode must run long enough to prove it.
6. **Reconcile the divergent migration histories** so future schema work is not blocked the same way.

---

## 13. Confirmations

- **No automatic customer-visible action was enabled.** No delist, no relist, no publish, no OTA, no
  build.
- **No second writer to `published`.** Verified by trace: zero TypeScript writers exist, and the only
  SQL writer remains `refresh_product_inventory_status()` at `inventory_source_of_truth.sql:148`.
- **No Saved Items change, no supplier access, no Playwright, no session modification.**
- **No production data written** — every query this sprint was read-only.
- **No scheduler activated.**
- **Nothing pushed.**
- `/Users/heliu/XOne` and `/Users/heliu/xself-seller-automation` were never accessed.
