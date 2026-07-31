# Saved Asset ⇄ XOne — Frozen Cross-System Contract

**Status:** FROZEN CONTRACT — v1. Nothing implemented.
**Date:** 2026-07-31
**Owner repository:** `xself-home-app` (Product Supply System of Record)
**Supersedes for the removal path:** the `REMOVABLE → REMOVED` edge in `SAVED_ASSET_STATE_MACHINE_V1.md`

Evidence base: `SHARED_SUPABASE_XONE_FAVORITES_ARCHITECTURE_AUDIT.md`,
`SAVED_ASSET_STATE_MACHINE_V1.md`, `SAVED_STATE_IMPLEMENTATION_AUDIT.md`,
`Stage2_PHASE1_EVIDENCE.md`.

> **Contract change vs. the approved V1 state machine — read this first.**
> `SAVED_ASSET_STATE_MACHINE_V1.md` defined **8** states with a direct `REMOVABLE → REMOVED` edge.
> This contract defines **9**, inserting **`AWAITING_REMOVAL_VERIFICATION`** between them. The extra
> state is required because the Founder's removal is performed *outside* our systems, so "approved
> and acted upon" and "verified released at the supplier" are genuinely different facts. V1's Rule 10
> — *"REMOVED means the supplier Saved slot has actually been released, not merely approved for
> release"* — is preserved and strengthened, not weakened. When implemented, V1 §4/§5 must be updated
> to match.

---

## 1. System context

| System | Role | Boundary |
|---|---|---|
| **Shared Supabase** (`erbimgfbztkzmpamzwky`) | Canonical data store | Single shared business state |
| **XSelf Home** (`xself-home-app`) | **Product Supply System of Record** | Owns Saved Asset business state and every transition |
| **xself-seller-automation** | **Supplier Integration Adapter** | Reads supplier facts; writes **only** supplier evidence |
| **XOne** | **Operator Console** | Displays actions; records Founder input through one narrow interface |

Audit facts this contract is built on:

- XOne has **no Supabase client today** (zero deps, zero `.env` files, local SQLite only).
- seller-automation is a **Flask service with service-role access** — a trusted local backend.
- `refresh_product_inventory_status()` is the **sole writer** of `standardized_products.published`
  and `inventory_status`.
- `saved_assets` is **confirmed absent** from production; `admin_users` **exists** (1 row).
- Supplier API access is **gated on Saved membership** — removal is a one-way door that destroys
  detail/price/inventory access for that SKU.

---

## 2. Canonical ownership

| Concern | Owner | Never owned by |
|---|---|---|
| Canonical storage | Shared Supabase | — |
| Saved Asset business state + transitions | **XSelf Home** | seller-automation, XOne |
| Supplier Favorite membership facts | **seller-automation** | XSelf Home, XOne |
| App publication / inventory status | **XSelf Home** via `refresh_product_inventory_status()` | everyone else |
| Founder acknowledgement input | **XOne** (one RPC only) | — |
| Removal verification decision | **XSelf Home**, derived from latest supplier fact | seller-automation, XOne |
| Audit trail | **XSelf Home** (append-only) | — |
| Display | **XOne** | — |

**One shared business state.** XOne holds no business state; seller-automation holds no Saved Asset
state. Both are prohibited (§14).

---

## 3. Data entities

### 3.1 Supplier fact layer — `supplier_favorite_facts` (facts only)

Grain: **one row per `supplier_product_id` × `supplier_account`.**

| Field | Type | Meaning |
|---|---|---|
| `supplier_product_id` | text | Supplier SKU |
| `supplier_account` | text | `pickup` \| `dropship` |
| `is_saved` | boolean **nullable** | Membership at `observed_at`. **NULL = unknown, never false** |
| `last_seen_saved_at` | timestamptz | Last observation with `is_saved = true` |
| `last_seen_removed_at` | timestamptz | Last observation with `is_saved = false` |
| `sync_status` | text | `ok` \| `auth_failed` \| `network_failed` \| `parse_failed` \| `rate_limited` |
| `sync_error_code` | text null | Supplier code (e.g. `B20003`) |
| `observed_at` | timestamptz | When observed |
| `source_run_id` | text | Sync run identity — dedupe + audit |
| `updated_at` | timestamptz | Row touch |

**Constraints:** `UNIQUE (supplier_product_id, supplier_account)`.
**Rule:** this layer records *what was seen*. It contains **no decisions, no state, no task fields.**
`sync_status <> 'ok'` ⇒ `is_saved` **must** be written as NULL, never `false`.

### 3.2 Saved Asset business layer — `saved_assets`

Grain: **one row per `supplier_product_id` × `supplier_account`** (same grain — an asset is a slot in
one account).

Carries the V1 fields (`asset_state`, `state_reason_code`, `state_reason_text`, `entered_state_at`,
`review_due_at`, `previous_state`, `approved_by`, `approved_at`, `last_saved_verified_at`,
`removed_at`, `version`, `created_at`, `updated_at`) plus the acknowledgement fields in §5.
`approved_by` references `admin_users` (which already exists).

**Constraints:** `UNIQUE (supplier_product_id, supplier_account)`;
`CHECK (asset_state IN (…9 states…))`; `version` for optimistic concurrency.

### 3.3 XOne action view — `supplier_favorite_tasks_v` (read-only)

Exposes **only**: `saved_asset_id`, `supplier_product_id`, `supplier_account`, `product_title`,
`asset_state`, `state_reason_code`, `state_reason_text`, `recommended_at`, `founder_status`,
`verification_status`, `verification_attempts`, `last_verification_at`,
`last_verification_failure_reason`, `last_saved_verified_at`, `removed_at`, `version`.

Filtered to `asset_state IN ('REMOVABLE','AWAITING_REMOVAL_VERIFICATION','REMOVED')`.

**Never exposed:** pricing, cost, margin, credentials, supplier session data, `published`,
`inventory_status`, or any field XOne must not act on.

---

## 4. Exact state machine (9 states)

| State | Meaning | Transition owner |
|---|---|---|
| `SAVED_CANDIDATE` | In Saved Items, not yet commercially evaluated | XSelf Home |
| `EVALUATING` | Collecting price/inventory/spec/category/margin evidence | XSelf Home |
| `ACTIVE_ASSET` | Current evidence of value; slot earns its place | XSelf Home |
| `HOLD` | Explicit temporary blocker; requires reason + `review_due_at` | XSelf Home (Founder-initiated) |
| `REVIEW_REQUIRED` | Evidence stale, contradictory, incomplete, or declining | XSelf Home |
| `RETIRE_CANDIDATE` | Probably release the slot; **removal not yet approved** | XSelf Home (Founder approval) |
| `REMOVABLE` | All preconditions passed + Founder authorization recorded. **Slot still occupied.** This is what XOne shows as an actionable task | XSelf Home |
| **`AWAITING_REMOVAL_VERIFICATION`** | **Founder states they removed it at the supplier; not yet verified.** Slot presumed occupied until proven otherwise | **XOne** (the single allowed action) |
| `REMOVED` | Supplier fact confirms `is_saved = false`. Slot actually released | **XSelf Home only** |

### Allowed transitions

| From → To | Owner | Trigger |
|---|---|---|
| ∅ → `SAVED_CANDIDATE` | XSelf Home | Observed in saved list |
| `SAVED_CANDIDATE` → `EVALUATING` / `HOLD` / `REVIEW_REQUIRED` | XSelf Home | Evidence / blocker / deadline |
| `EVALUATING` → `ACTIVE_ASSET` / `HOLD` / `REVIEW_REQUIRED` | XSelf Home | Evidence |
| `ACTIVE_ASSET` → `REVIEW_REQUIRED` / `HOLD` / `RETIRE_CANDIDATE` | XSelf Home | Founder approval for `RETIRE_CANDIDATE` |
| `HOLD` → `EVALUATING` / `ACTIVE_ASSET` / `REVIEW_REQUIRED` (expiry) / `RETIRE_CANDIDATE` | XSelf Home | Expiry routes to `REVIEW_REQUIRED`, **never** to retirement |
| `REVIEW_REQUIRED` → `ACTIVE_ASSET` / `EVALUATING` / `HOLD` / `RETIRE_CANDIDATE` | XSelf Home | Founder approval for `RETIRE_CANDIDATE` |
| `RETIRE_CANDIDATE` → `ACTIVE_ASSET` / `HOLD` / `REMOVABLE` | XSelf Home | **Founder authorization required for `REMOVABLE`** |
| **`REMOVABLE` → `AWAITING_REMOVAL_VERIFICATION`** | **XOne** | `mark_manual_removal_done()` — the only XOne write |
| `AWAITING_REMOVAL_VERIFICATION` → `REMOVED` | XSelf Home | Supplier fact `is_saved = false` |
| `AWAITING_REMOVAL_VERIFICATION` → `REMOVABLE` | XSelf Home | Founder revokes / task reopened |
| `REMOVABLE` / `AWAITING_REMOVAL_VERIFICATION` → `ACTIVE_ASSET` | XSelf Home | Product republished or value reconfirmed → task cancelled |

### Prohibited transitions

- Any → `REMOVED` except from `AWAITING_REMOVAL_VERIFICATION` **with a verifying supplier fact**.
- Any → `REMOVABLE` except from `RETIRE_CANDIDATE` with recorded Founder authorization.
- XOne → any state other than `AWAITING_REMOVAL_VERIFICATION`.
- `HOLD` → `RETIRE_CANDIDATE` by deadline expiry (expiry routes to `REVIEW_REQUIRED`).
- Any transition triggered solely by `junk_category = true`.
- Any automated transition into `RETIRE_CANDIDATE`, `REMOVABLE`, or `REMOVED`.
- `REMOVED` → any (terminal; re-saving creates a new asset row).

---

## 5. Field-level write matrix

| Field | XSelf Home | seller-automation | XOne | Notes |
|---|---|---|---|---|
| `supplier_favorite_facts.*` | ❌ | ✅ **only** | ❌ | Facts only |
| `saved_assets.asset_state` | ✅ **only** | ❌ | ⚠️ **one transition** via RPC | `REMOVABLE → AWAITING_REMOVAL_VERIFICATION` |
| `state_reason_code` / `_text` | ✅ | ❌ | ❌ | |
| `entered_state_at`, `previous_state` | ✅ | ❌ | ❌ | Set by the transition writer |
| `review_due_at` | ✅ | ❌ | ❌ | |
| `approved_by`, `approved_at` | ✅ | ❌ | ❌ | FK → `admin_users` |
| **`founder_status`** | ✅ (reset/cancel) | ❌ | ✅ **via RPC only** | `pending` \| `marked_done` \| `deferred` |
| **`founder_marked_done_at`** | ❌ | ❌ | ✅ **via RPC only** | Set by the RPC |
| **`verification_status`** | ✅ **only** | ❌ | ❌ | Derived from supplier facts |
| `verification_attempts`, `last_verification_at`, `last_verification_failure_reason` | ✅ **only** | ❌ | ❌ | |
| `last_saved_verified_at` | ✅ **only** | ❌ | ❌ | Copied from the fact layer |
| `removed_at` | ✅ **only** | ❌ | ❌ | Set with `REMOVED` |
| `version` | ✅ | ❌ | ✅ via RPC (increment) | Optimistic concurrency |
| `standardized_products.published` / `inventory_status` | ✅ **via `refresh_product_inventory_status()` only** | ❌ | ❌ | Unchanged authority |
| `inventory_cache`, `inventory_workflow_*` | ✅ | ❌ | ❌ | |
| `channel_listings` | ❌ | ✅ | ❌ | Existing seller-automation ownership |

**Rule:** any field not explicitly granted to a system is forbidden to that system.

---

## 6. End-to-end event flow

| # | Step | Owner | Resource | R/W | Idempotency key | Security boundary | Failure behaviour |
|---|---|---|---|---|---|---|---|
| 1 | App product delisted | XSelf Home | `refresh_product_inventory_status()` | W | `supplier_product_id` | service-role script | Evidence-driven; no forced change |
| 2 | Temporary OOS vs true release candidate | XSelf Home | `inventory_workflow_states` + `saved_assets` | R | `observation_key` | service-role | Stale/unknown ⇒ **no task created** |
| 3 | Task becomes actionable | XSelf Home | `saved_assets` → `REMOVABLE` | W | `(sku, account)` | service-role + Founder approval | Preconditions unmet ⇒ stays `RETIRE_CANDIDATE` |
| 4 | XOne displays task | XOne ← mediator | `supplier_favorite_tasks_v` | R | — | **no DB creds in XOne** | Show cached data with staleness banner |
| 5 | Founder removes Favorite at supplier | Founder (manual) | supplier portal | — | — | human | None — outside our systems |
| 6 | Founder marks done | XOne → mediator | `mark_manual_removal_done()` | W | `idempotency_key` + `expected_version` | RPC validates | Version mismatch ⇒ reject, no write |
| 7 | Awaiting verification | XSelf Home | `asset_state = AWAITING_REMOVAL_VERIFICATION` | W | `saved_asset_id` | RPC | — |
| 8 | Favorite-list sync | seller-automation | `supplier_favorite_facts` | W | `source_run_id` | service-role, local | Failure ⇒ `is_saved = NULL` |
| 9 | Verification evaluated | XSelf Home | `saved_assets.verification_status` | W | `(saved_asset_id, source_run_id)` | service-role | **Fail-closed** — see §9 |
| 10 | Audit | XSelf Home | `saved_asset_transitions` (append-only) | W | `(saved_asset_id, transition_key)` | service-role | Unique constraint dedupes |

---

## 7. XOne read contract

- **Source:** `supplier_favorite_tasks_v` only, reached via the trusted local service
  (`GET /api/supplier-favorites/tasks`). XOne holds no Supabase credentials.
- **Scope:** `REMOVABLE`, `AWAITING_REMOVAL_VERIFICATION`, and `REMOVED` history.
- **Caching:** XOne may cache locally for offline display, but **must** show `evidence_at`/staleness
  rather than presenting cached rows as current. A cached row is never a basis for a second action.
- **No derivation:** XOne must not compute eligibility, re-derive state, or infer removal. It renders
  what the view says.

## 8. XOne write contract

Exactly **one** business action in this phase:

```
mark_manual_removal_done(saved_asset_id, expected_version, idempotency_key)
```

| Aspect | Rule |
|---|---|
| Allowed transition | `REMOVABLE → AWAITING_REMOVAL_VERIFICATION` — **only** |
| Fields written | `asset_state`, `founder_status = 'marked_done'`, `founder_marked_done_at`, `version + 1` |
| Preconditions | Row exists; `asset_state = 'REMOVABLE'`; `version = expected_version` |
| Rejections | `state_mismatch`, `version_conflict`, `not_found`, `unauthorized` — each a no-op |
| Return | New `version` + resulting `asset_state` |

**XOne must never set:** `REMOVED`, `REMOVABLE`, `published`, `inventory_status`, supplier membership
facts, `verification_status`, `approved_by`, or any pricing field.

---

## 9. Verification contract

After `AWAITING_REMOVAL_VERIFICATION`, the **next normal** Favorite-list sync applies. No special
verification job, no extra supplier call, no polling.

| Latest fact | Result | State |
|---|---|---|
| `sync_status='ok'` **and** `is_saved = false` | Verified | → **`REMOVED`**, set `removed_at`, `last_saved_verified_at` |
| `sync_status='ok'` **and** `is_saved = true` | Not removed | **stay** `AWAITING_REMOVAL_VERIFICATION`; `verification_status='still_saved'`; increment `verification_attempts`; record `last_verification_failure_reason` |
| `sync_status <> 'ok'` (auth/network/parse/rate-limit) | Unknown | **preserve state and all counters**; `verification_status='blocked_by_auth'` (or the matching code). **Never infer removal** |
| No fact newer than `founder_marked_done_at` | Not yet observed | stay `AWAITING_REMOVAL_VERIFICATION`, `verification_status='awaiting_verification'` |

**Hard rule:** absence of evidence is never evidence of removal. Only an affirmative
`is_saved = false` from a successful sync may produce `REMOVED`.

**Consequence to respect (Phase 1 evidence):** once `REMOVED` is real, supplier detail, price,
inventory, and variant access for that SKU are lost, and there is no proven re-add capability. A full
evidence snapshot must be retained **before** the state is entered.

---

## 10. Security model

| Rule | Rationale |
|---|---|
| XOne holds **no** service-role credentials | A distributed desktop binary cannot protect a secret |
| XOne does **not** write canonical tables directly | Single narrow RPC only |
| XOne reads a **display-safe view** via the trusted local service | Matches today's architecture (XOne has no Supabase client) |
| seller-automation's service-role stays **server/local-backend only** | Never shipped to a client |
| The RPC validates state, version, and identity server-side | Client input is untrusted |
| `approved_by` resolves against `admin_users` | Existing identity table |
| No table grants to `anon` on `saved_assets` / `supplier_favorite_facts` | Service-role only, as with `inventory_workflow_*` |

**Future option (not this phase):** if XOne ever gains an authenticated Supabase identity, the same
view + RPC can be exposed directly under RLS without changing this contract.

---

## 11. Idempotency and concurrency

| Concern | Mechanism |
|---|---|
| Unique identity | `UNIQUE (supplier_product_id, supplier_account)` on both layers |
| Optimistic concurrency | `version`; every write asserts `expected_version`, zero rows matched ⇒ reject |
| Fact ingestion dedupe | `source_run_id` + `observed_at`; an older `observed_at` never overwrites a newer fact |
| Verification dedupe | `(saved_asset_id, source_run_id)` — one verification per run |
| Founder action idempotency | `idempotency_key` supplied by XOne; replay returns the original result |
| **Repeated Founder click** | First click transitions and returns new version. Subsequent clicks with the same key ⇒ **success, no-op**. A different key on an already-`AWAITING_REMOVAL_VERIFICATION` row ⇒ **`state_mismatch`, no-op** |
| Duplicate task prevention | Task is a *state*, not a row — the unique constraint makes duplicates impossible |
| Stale-write rejection | Version conflict ⇒ reject with the current version so XOne can refresh |
| Audit dedupe | `UNIQUE (saved_asset_id, transition_key)` on the append-only trail |

---

## 12. Failure handling

| Failure | Behaviour |
|---|---|
| Supplier auth/CAPTCHA during sync | `sync_status='auth_failed'`, `is_saved = NULL`, asset state preserved |
| Network/parse/rate-limit | Same fail-closed pattern with the matching `sync_status` |
| Verification says still saved | Stay in `AWAITING_REMOVAL_VERIFICATION`, count the attempt, surface to the Founder |
| Version conflict on the RPC | Reject; return current version; XOne refreshes and may retry |
| Product republished while a task is open | XSelf Home moves the asset to `ACTIVE_ASSET` and **cancels** the task |
| Mediator unreachable | XOne shows cached data marked stale; **no local state change** |
| Repeated verification failures | Escalate for Founder review; **never** auto-resolve to `REMOVED` |
| Same SKU saved in both accounts | Separate asset rows; removing one never affects the other |

---

## 13. Repository responsibilities

| Repository | Responsibilities | Explicitly not allowed |
|---|---|---|
| **xself-home-app** | Owns both schemas + the state machine; creates `REMOVABLE` tasks; evaluates verification; writes `REMOVED`; maintains the audit trail; owns publication via the existing RPC | Must not write `supplier_favorite_facts`; must not bypass the publication authority |
| **xself-seller-automation** | Favorite-list sync → writes `supplier_favorite_facts`; hosts the mediator endpoints (`GET tasks`, `POST ack`) | Must not decide `REMOVABLE`; must not write `asset_state` (except passing the RPC through); must not hold Saved Asset business state |
| **XOne** | Displays tasks under 商品运营 AI → Supplier Favorites; calls `mark_manual_removal_done` | Must not hold business state, Supabase credentials, or control publish/delist/relist |

---

## 14. Explicit non-goals

- ❌ No second task state machine anywhere.
- ❌ No XOne-owned business state (local cache is display-only).
- ❌ No seller-automation decision about `REMOVABLE`.
- ❌ No direct XOne control of App publish/delist/relist.
- ❌ No automatic supplier Favorite **removal** — the Founder acts manually at the supplier.
- ❌ No automatic supplier Favorite **addition** in this phase.
- ❌ No second writer to `standardized_products.published` / `inventory_status`.
- ❌ No inference of removal from missing, stale, or failed evidence.

---

## 15. Acceptance examples

**A. Happy path.** Asset in `REMOVABLE` v4. XOne calls `mark_manual_removal_done(id, 4, key-1)` →
`AWAITING_REMOVAL_VERIFICATION`, `founder_status='marked_done'`, v5. Next sync writes
`is_saved=false, sync_status='ok'` → XSelf sets `REMOVED`, `removed_at`, `last_saved_verified_at`;
audit row appended. ✅

**B. Founder double-click.** Same call repeated with `key-1` → success, no-op, v5 unchanged, **no
second audit row**. ✅

**C. Stale client.** XOne holds v4 but the row is v6. Call rejected `version_conflict`; **no write**;
XOne refreshes. ✅

**D. Founder forgot to actually remove it.** Marked done, but sync reports `is_saved=true, ok` →
stays `AWAITING_REMOVAL_VERIFICATION`, `verification_status='still_saved'`, attempts = 1, surfaced
for review. **Not** `REMOVED`. ✅

**E. Supplier auth failure.** Sync returns `auth_failed`, `is_saved=NULL` → state and counters
preserved, `verification_status='blocked_by_auth'`. **No removal inferred.** ✅

**F. XOne tries to set REMOVED.** No such action exists; the RPC accepts only one transition.
Rejected. ✅

**G. XOne tries to publish.** No interface exists; `published` is writable only by
`refresh_product_inventory_status()`. Rejected. ✅

**H. Product restocks mid-task.** Inventory workflow republishes; XSelf moves the asset to
`ACTIVE_ASSET` and cancels the task; XOne's next read shows it gone. ✅

**I. Dual-account SKU.** SKU saved in both pickup and dropship = two asset rows. Removing the
dropship slot leaves the pickup row untouched. ✅

**J. seller-automation attempts a state write.** Contract and grants forbid it; only
`supplier_favorite_facts` is writable by that system. Rejected. ✅

**K. Mediator offline.** XOne shows the last cached list marked stale; no action is possible; no local
state changes. ✅

**L. Task created from stale evidence.** Step 2 requires authoritative evidence; stale/unknown
produces **no** `REMOVABLE`. ✅

**M. Verification arrives before the Founder acts.** Fact `is_saved=true` while state is `REMOVABLE`
⇒ nothing happens; the task stays actionable. ✅

**N. Fact arrives out of order.** A fact with an older `observed_at` than the stored one is ignored. ✅

**O. Audit replay.** Re-running verification for the same `source_run_id` produces no duplicate audit
row (unique constraint). ✅

---

## Validation

Documentation only. No code, schema, migration, Supabase, supplier session, Saved Items, or product
lifecycle change. `xself-seller-automation` and `XOne` were **not modified**. No commit, no push.
This document is the only artifact produced.
