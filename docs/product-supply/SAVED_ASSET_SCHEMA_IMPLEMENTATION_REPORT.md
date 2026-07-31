# Saved Asset Control Model — Schema Implementation Report

**Date:** 2026-08-01
**Status:** Code + migration complete and tested. **Migration NOT applied — blocked, see §9/§10.**
**Contract:** `SAVED_ASSET_XONE_CONTRACT.md` · **State machine:** `SAVED_ASSET_STATE_MACHINE_V1.md` (`ed88b860`)

---

## 1. Existing-First audit result

Live schema census (PostgREST, `error` inspected on every probe):

| Present | Rows |
|---|---|
| `supplier_products` | 597 |
| `standardized_products` | 463 |
| `inventory_cache` | 1225 |
| `inventory_workflow_states` | 124 |
| `inventory_workflow_transitions` | 106 |
| `orders` / `order_items` | 61 / 52 |
| `admin_users` | 1 |
| `channel_listings` | 665 |
| `home_content_config` | 22 |
| `product_reviews` | 2301 |
| `pricing_audit_log` | 679 |
| `giga_delivery_fee_cache` | 419 |

| Absent — confirmed |
|---|
| `supplier_favorite_memberships` |
| `saved_assets` |
| `saved_asset_transitions` |
| `xone_supplier_favorite_actions` |

**No existing resource can serve these purposes** (re-confirming the prior audit):

- `home_content_config` — a `screen`/`key`/`value` **config** store: no per-SKU grain, no lifecycle, no audit. Rejected.
- `channel_listings` — seller-automation-owned, per product×channel: different grain and domain. Rejected.
- `inventory_workflow_states` — **Axis 3** (stock over time), not Axis 1 (slot ownership). Merging them is prohibited by the three-axis rule.
- `admin_users` — **reused**, as the FK target for `approved_by` and `founder_actor_id`.
- `inventory_workflow_transitions` — **reused as the pattern** for the append-only audit table.

Three new tables, one view, one function — the minimum the contract requires.

---

## 2. Exact schema

**`supplier_favorite_memberships`** (supplier facts, one row per SKU × account)
`id`, `supplier_product_id`, `supplier_account`, `is_saved` **(nullable)**, `sync_status`,
`sync_error_code`, `observed_at`, `last_seen_saved_at`, `last_seen_removed_at`, `source_run_id`,
`version`, `created_at`, `updated_at`.

Constraints: `UNIQUE (supplier_product_id, supplier_account)`; account `CHECK IN ('pickup','dropship')`;
`sync_status` CHECK over 8 values; and the fail-closed invariant —

```sql
CONSTRAINT sfm_failure_implies_unknown_chk CHECK (sync_status = 'ok' OR is_saved IS NULL)
```

**`saved_assets`** (canonical business state, one row per SKU × account)
State + reason + `previous_state` + `entered_state_at` + `review_due_at`; authorization
(`approved_by` → `admin_users`, `approved_at`); acknowledgement (`founder_status`,
`founder_marked_done_at`, `founder_actor_id` → `admin_users`); verification
(`verification_status`, `verification_attempts`, `last_verification_at`,
`last_verification_failure_reason`); evidence (`last_saved_verified_at`, `removed_at`);
idempotency (`last_idempotency_key`, `source_event_id`); `version`, timestamps.

Constraints: `UNIQUE (supplier_product_id, supplier_account)`; **9-state CHECK**;
`founder_status` and `verification_status` CHECKs; plus

```sql
CONSTRAINT sa_removed_requires_evidence_chk CHECK (
  asset_state <> 'REMOVED'
  OR (removed_at IS NOT NULL AND last_saved_verified_at IS NOT NULL
      AND verification_status = 'verified_removed'))
CONSTRAINT sa_hold_requires_reason_chk CHECK (
  asset_state <> 'HOLD'
  OR (state_reason_code IS NOT NULL AND state_reason_text IS NOT NULL AND review_due_at IS NOT NULL))
```

**`saved_asset_transitions`** (append-only) — identity, `from_state`/`to_state`, reason,
`actor_type`/`actor_id`, `source_event_id`, `idempotency_key`, `evidence_at`, `transitioned_at`,
`version_before`/`version_after`.

The safety constraints live here, so the forbidden edges are **unrecordable**:

```sql
sat_no_direct_removable_to_removed_chk  CHECK (NOT (from_state='REMOVABLE' AND to_state='REMOVED'))
sat_removed_source_chk                  CHECK (to_state<>'REMOVED' OR from_state='AWAITING_REMOVAL_VERIFICATION')
sat_awaiting_source_chk                 CHECK (to_state<>'AWAITING_REMOVAL_VERIFICATION' OR from_state='REMOVABLE')
sat_removed_actor_chk                   CHECK (to_state<>'REMOVED' OR actor_type='xself_home')
sat_ack_actor_chk                       CHECK (to_state<>'AWAITING_REMOVAL_VERIFICATION' OR actor_type='xone_operator')
sat_seller_automation_never_transitions_chk CHECK (actor_type <> 'seller_automation')
sat_idempotency_uniq                    UNIQUE (saved_asset_id, idempotency_key)
```

---

## 3. Field ownership

| Field group | XSelf Home | seller-automation | XOne |
|---|---|---|---|
| `supplier_favorite_memberships.*` | ❌ | ✅ **only** | ❌ |
| `saved_assets.asset_state` | ✅ | ❌ (CHECK-blocked in history) | ⚠️ one transition via RPC |
| reason / approval / review fields | ✅ | ❌ | ❌ |
| `founder_status`, `founder_marked_done_at`, `founder_actor_id` | reset/cancel | ❌ | ✅ **via RPC only** |
| `verification_*`, `last_saved_verified_at`, `removed_at` | ✅ **only** | ❌ | ❌ |
| `standardized_products.published` / `inventory_status` | ✅ via `refresh_product_inventory_status()` | ❌ | ❌ |

RLS is enabled on all three tables with **no policies**, so only the service role reaches them. XOne
receives no credentials and reads the view through the trusted local mediator.

---

## 4. Migration file

`supabase/migrations/20260801_saved_asset_control_model.sql` — **additive only**:
3 tables, 1 view, 1 function, 7 indexes, 3 `ENABLE ROW LEVEL SECURITY`.

Statically verified by test 16: **no** `ALTER` on any pre-existing table, **no** trigger anywhere,
**no** write to `standardized_products` / `supplier_products` / `inventory_cache`, **no** call to
`refresh_product_inventory_status()`, **no** backfill, **no** seed rows, **no** scheduler.

---

## 5. XOne view

`xone_supplier_favorite_actions` — filtered to
`asset_state IN ('REMOVABLE','AWAITING_REMOVAL_VERIFICATION','REMOVED')`.

Exposes: `saved_asset_id`, SKU, account, `product_title`, `primary_image`, `asset_state`,
`reason_code`, `reason_detail`, `app_published`, `inventory_status`, `total_available_qty`,
`has_ca_pickup`, `evidence_at`, `supplier_is_saved`, `supplier_sync_status`, `review_due_at`,
`founder_status`, `founder_marked_at`, verification fields, `removed_at`, `updated_at`, `version`.

Test 14 asserts it leaks no `raw_payload`, price, cost, margin, credential, session, cookie, token
or signature field.

---

## 6. Narrow Founder action

`mark_saved_asset_manual_removal_done(p_saved_asset_id, p_expected_version, p_idempotency_key, p_actor_id)`
— `SECURITY DEFINER`, `search_path` pinned, `REVOKE ALL ... FROM PUBLIC`.

Performs exactly `REMOVABLE → AWAITING_REMOVAL_VERIFICATION`: `SELECT … FOR UPDATE`, idempotent
replay on a matching key, `state_mismatch` if not `REMOVABLE`, `version_conflict` on mismatch, a
version-guarded `UPDATE`, one appended transition row, and a public-safe JSON result. The target
state is hardcoded — no caller-supplied state is accepted.

---

## 7. Verification service

`src/services/savedAssetVerification.ts` — **pure, no I/O**, so the safety rules are testable before
any orchestration exists.

- `classifyMembershipFact()` → `confirmed_removed` | `confirmed_still_saved` | `unknown`.
  A non-`ok` sync returns `unknown` **regardless of `is_saved`** — belt and braces with the DB CHECK.
- `planVerification()` → `{nextState, verificationStatus, attemptsDelta, failureReason, transitions,
  needsWrite, removedAt, lastSavedVerifiedAt, reason}`.
- `canMarkRemovalDone()` mirrors the SQL guards.
- `isTransitionAllowed()` returns **false** for `REMOVABLE → REMOVED`.

Two rules worth calling out:

1. **A fact observed at or before `founder_marked_done_at` cannot verify the acknowledgement**
   (`fact_predates_founder_acknowledgement`) — otherwise a pre-existing "still saved" reading could
   resolve an action it never observed.
2. **A blocked read is not a failed attempt** (`attemptsDelta = 0`). Only a conclusive
   `is_saved = true` increments the counter, so supplier outages cannot inflate failure counts.

---

## 8. Tests

`src/__tests__/savedAssetVerification.test.ts` — **20 passing**, pure + static. `tsc` exit 0.

| # | Requirement | Result |
|---|---|---|
| 1 | unique SKU × account identity | ✅ |
| 2 | pickup/dropship independent | ✅ |
| 3 | failed sync ⇒ `is_saved` NULL | ✅ (CHECK + classifier) |
| 4 | no direct `REMOVABLE → REMOVED` | ✅ (pure + 2 CHECKs) |
| 5 | RPC allows only the one transition | ✅ (refused from all 8 other states) |
| 6 | stale `expected_version` rejected | ✅ |
| 7 | same idempotency key ⇒ no-op success | ✅ |
| 8 | different key after transition ⇒ rejected | ✅ |
| 9 | `is_saved=false` + ok ⇒ `REMOVED` | ✅ |
| 10 | `is_saved=true` preserves waiting state | ✅ |
| 11 | all 7 failure modes preserve state | ✅ |
| 12 | seller-automation cannot write state | ✅ |
| 13 | view excludes non-action states | ✅ |
| 14 | view exposes no secret fields | ✅ |
| 15 | one account cannot mutate its sibling | ✅ |
| 16 | no publication/inventory resource written | ✅ |
| 17–19 | 9 states, evidence CHECK, no seed/scheduler | ✅ |

*Note:* test 16 initially failed because it matched `refresh_product_inventory_status()` inside a
**comment**. The test was corrected to assert against executable SQL only — the migration itself was
never at fault and was not weakened.

---

## 9. Migration application status

> **NOT APPLIED. No production DDL was executed.**

Verified post-hoc via PostgREST — all four resources still return `PGRST205`, and the RPC returns
`PGRST202`:

```
supplier_favorite_memberships        NOT APPLIED
saved_assets                         NOT APPLIED
saved_asset_transitions              NOT APPLIED
xone_supplier_favorite_actions       NOT APPLIED
mark_saved_asset_manual_removal_done NOT APPLIED
```

---

## 10. Blockers

**Blocker 1 — `supabase db push` remains unsafe.** The local and remote migration histories are
diverged; at last successful enumeration **12 local migrations were unapplied on remote**, so a push
would replay ~11 unrelated migrations (RLS policies, guards, ads config, OOS allowlist) against a
database whose real state does not match the recorded history. This is the same declared stop
condition as the previous sprint.

**Blocker 2 — the history cannot currently be re-enumerated.** `supabase migration list` now fails
with `failed to connect to postgres … context deadline exceeded` (direct 5432 connection). PostgREST
works; the CLI's direct connection does not. `psql` is not installed and no DB password is present.

**Safe path (as used for `20260731`):** paste
`supabase/migrations/20260801_saved_asset_control_model.sql` into the Supabase SQL Editor. It is
additive and uses `CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE`, so it is safe to run once and
re-runnable.

---

## 11. Exact next step for seller-automation

**One narrow addition only** — the Favorite-list sync must upsert supplier facts:

```
UPSERT supplier_favorite_memberships (supplier_product_id, supplier_account)
SET is_saved, sync_status, sync_error_code, observed_at,
    last_seen_saved_at / last_seen_removed_at, source_run_id, version+1
```

Rules it must honour:
1. **A failed sync writes `is_saved = NULL`** — the DB CHECK will reject `false` with a non-`ok`
   status, so violating this fails loudly rather than silently.
2. It must **never** write `saved_assets` or `saved_asset_transitions` (`actor_type='seller_automation'`
   is CHECK-rejected).
3. Its service-role key stays server/local-backend only.

The mediator endpoints (`GET /api/supplier-favorites/tasks`, `POST …/ack`) come **after** the
migration is applied — they read the view and proxy the RPC.

---

## 12. Confirmations

- **No production data write.** Every database interaction was `SELECT`/probe; the DDL was not executed.
- **No Saved Items change**, no supplier access, no supplier session change.
- **No product lifecycle change** — no import, normalize, price, publish, delist, or relist.
- **No XOne UI** and **no supplier Favorite automation** built, as instructed.
- **No backfill, no seed rows, no scheduler.**
- `xself-seller-automation` and `XOne` were **not modified**.
- **No push.**
