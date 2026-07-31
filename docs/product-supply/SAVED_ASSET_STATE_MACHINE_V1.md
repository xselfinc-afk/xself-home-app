# Saved Asset State Machine — V1 Implementation Architecture

**Version:** `product-bible-v1.0-rc1`
**Date:** 2026-07-31
**Status:** Proposed implementation architecture. Nothing implemented. No schema, no migration, no data written.

**Product model authority:** The three-axis model and the eight Saved Asset state names were
approved by the Product Architect. This document does not redesign, rename, or merge them. It
proposes *how to implement* that model against the repository as it actually exists.

**Evidence base:** `SAVED_STATE_IMPLEMENTATION_AUDIT.md`, `Stage2_PHASE3_SAVED_RESOURCE_ANALYSIS.md`,
`Stage2_PHASE1_EVIDENCE.md`, `Stage2_GAP_ANALYSIS.md`, `STAGE1_COMPLETION_REPORT.md`, and direct
read-only inspection of the repository and database.

---

## 1. Executive summary

The three-axis model is implementable, and the separation it mandates is not merely tidy — it is
required for correctness. The audit established that the repository already contains two of the
three axes in some form:

- **Axis 2 (Commerce Pipeline)** is fully persisted today across `supplier_products`,
  `standardized_products`, `inventory_cache`, `product_reviews`, and the `sellable_products` view.
  It needs **no new storage** — only derivation.
- **Axis 3 (Inventory Workflow)** exists as complete, tested logic in
  `src/services/inventoryStateMachine.ts` with **zero persistence**, which makes its
  multi-confirmation safety mechanism structurally unreachable.
- **Axis 1 (Saved Asset Lifecycle)** does not exist in any form. There is no `saved_items` table, no
  `held`/`retired`/`removed_at` column, and no record of *why* any of the ~688 occupied Saved slots
  is occupied.

Axis 1 is therefore net-new storage; Axis 2 is derivation over existing fields; Axis 3 is persistence
of already-written logic.

Three constraints dominate the design:

1. **`refresh_product_inventory_status()` writes `published` unconditionally** on every call. Any
   second writer will be silently overwritten. Axis 1 must never write `published` — this is
   Architectural Rule 2, and the RPC's implementation is why it matters.
2. **`REMOVABLE` and `REMOVED` are architecturally valid but operationally gated.** Both are full
   members of the approved lifecycle. Transition *into* `REMOVABLE`, and execution of
   `REMOVABLE → REMOVED`, remain **default-off** until every required dependency check, approval
   record, and supplier-write verification capability exists (Phase 1 and Phase 2 established that
   no remove-from-Saved capability exists today). This is a gate, not a permanent absence.
3. **Saved membership gates all supplier API access** (Phase 1, proven). Releasing a slot forfeits
   the ability to read that product's detail, price, and inventory. Removal is therefore not merely
   irreversible bookkeeping — it destroys the evidence needed to reconsider the decision.

The recommended sequence keeps every phase default-off and read-only for as long as possible, and
places the irreversible capability (removal) second-to-last, after the observability that would
justify using it.

---

## 2. Why one monolithic state machine is unsafe

A single lifecycle column covering "what is happening to this product" would collide on four
independent axes that change at different rates, for different reasons, under different authority.

**Collision 1 — Saved resource ownership vs commerce pipeline facts.**
Saved slot occupancy answers *"why should the supplier keep reserving this for us?"* Pipeline facts
answer *"how far through our processing is it?"* These are orthogonal. A product can be
`ACTIVE_ASSET` while normalized-but-unpublished (102 products today), or a `RETIRE_CANDIDATE` while
fully published (a live product with collapsing margin). Encoding both in one column forces a false
ordering and produces states like "published but retire-candidate" that a linear machine cannot
express.

**Collision 2 — Inventory workflow vs Saved ownership.**
Inventory workflow oscillates with supplier stock, potentially many times per week. Saved ownership
should change rarely and deliberately. Merging them means every transient stock fluctuation rewrites
the ownership record, destroying the stability that makes slot decisions auditable — and burning
through review deadlines that were meant to bound *ownership* decisions, not stock noise.

**Collision 3 — Publication authority.**
`refresh_product_inventory_status()` executes
`published = (v_status = 'in_stock')` unconditionally for the SKU passed to it. It does not read,
merge, or respect any other state. A monolithic machine that also wrote `published` would be
overwritten on the next inventory refresh, producing non-deterministic customer visibility — the
worst possible failure mode, because it is intermittent and silent.

**Collision 4 — Write cadence and blast radius.**
Axis 2 is written by five different subsystems (import, normalization, pricing, inventory,
reviews). Axis 3 would be written by a scheduled inventory job. Axis 1 should be written
predominantly by founder decision. A single column merges three write cadences into one contention
point, where an automated inventory job could overwrite a founder's explicit HOLD.

**The concrete precedent.** Stage 1 already demonstrated this class of failure in miniature:
publishing via the direct RPC path preserved manual content corrections but silently skipped the
review-seeding stage, breaking `guard:prod`. Bundled state carries implicit couplings that surface
only when one path is taken instead of another.

---

## 3. Three-axis architecture

| | Axis 1 — Saved Asset | Axis 2 — Commerce Pipeline | Axis 3 — Inventory Workflow |
| --- | --- | --- | --- |
| **Question answered** | Why should this slot stay occupied? | How far through processing is it? | What is stock doing over time? |
| **Storage** | **New** — proposed `saved_assets` | **Existing** — derive, do not copy | **New** — proposed `inventory_workflow` |
| **Values** | 8 approved states | Derived booleans/facts | 6 existing states |
| **Primary writer** | Founder decision + evidence jobs | Existing pipeline subsystems | Scheduled inventory job |
| **Cadence** | Rare, deliberate | Per pipeline run | Per inventory observation |
| **May write `published`?** | **Never** | Only via the RPC | **Never** directly |
| **Status today** | Missing entirely | Fully implemented | Logic implemented, unpersisted |

**Interaction rule.** Axes read each other; they do not write each other. Axis 1 *consumes* Axis 2
facts and Axis 3 state as evidence for its transitions, and never mutates them. Axis 3 *proposes*
publication changes that flow only through the existing RPC.

**Axis 2 is derived, never duplicated** (Architectural Rule 5). Proposed derivations, all from
existing fields:

| Fact | Derivation |
| --- | --- |
| imported | `supplier_products` row exists |
| admitted | `supplier_products.published = true` |
| normalized | `standardized_products.normalization_status = 'done'` |
| priced | `standardized_products.selling_price IS NOT NULL` (and `last_priced_at`) |
| inventory observed | `inventory_cache` rows exist with `sync_status='ok'` |
| published | `standardized_products.published = true` |
| review seeded | ≥1 `product_reviews` row with `status='active'` |
| sellable | membership in the `sellable_products` view |

---

## 4. Saved Asset state definitions

Common to all states: `asset_state`, `entered_state_at`, `previous_state`, and a
`state_reason_code` are always required. "Occupies a slot" describes whether the slot is *expected*
to remain occupied in that state — every state except `REMOVED` physically occupies one until
removal actually executes.

### SAVED_CANDIDATE

- **Purpose:** In Saved Items, not yet commercially evaluated.
- **Entry:** Item observed in the supplier saved list with no prior asset record; or newly added via a future controlled addition capability.
- **Exit:** Evaluation begins, or a deadline elapses.
- **Allowed next:** `EVALUATING`, `HOLD`, `REVIEW_REQUIRED`.
- **Occupies slot:** Yes.
- **Deadline:** **Required** (Rule 7).
- **Founder approval:** No, to enter or to progress to `EVALUATING`.
- **May coexist with `published=true`:** Should not in steady state. If observed, it indicates a backfill or classification error and should route to `REVIEW_REQUIRED` rather than be silently corrected.
- **Required fields:** `state_reason_code`, `entered_state_at`, `review_due_at`, `last_saved_verified_at`.

### EVALUATING

- **Purpose:** Actively collecting price, inventory, specification, category, and margin evidence.
- **Entry:** From `SAVED_CANDIDATE` when evidence gathering starts; from `HOLD` when a blocker clears; re-entry from `REVIEW_REQUIRED`.
- **Exit:** Evidence sufficient (→ `ACTIVE_ASSET`), blocker found (→ `HOLD`), evidence contradictory (→ `REVIEW_REQUIRED`), or deadline elapsed.
- **Allowed next:** `ACTIVE_ASSET`, `HOLD`, `REVIEW_REQUIRED`.
- **Occupies slot:** Yes.
- **Deadline:** **Required** (Rule 7). Evaluation must not become an indefinite parking state.
- **Founder approval:** No.
- **May coexist with `published=true`:** Yes — a live product may be re-evaluated.
- **Required fields:** `state_reason_code`, `review_due_at`, plus a record of which evidence classes are outstanding.

### ACTIVE_ASSET

- **Purpose:** Current evidence of commercial, operational, or strategic value; the slot is earning its place.
- **Entry:** From `EVALUATING` when evidence supports value; from `REVIEW_REQUIRED` or `RETIRE_CANDIDATE` when value is reconfirmed.
- **Exit:** Evidence goes stale, contradicts, or declines.
- **Allowed next:** `REVIEW_REQUIRED`, `HOLD`, `RETIRE_CANDIDATE` (**Founder approval required**).
- **Occupies slot:** Yes — **indefinitely permitted** (Rule 6).
- **Deadline:** Not required. A periodic revalidation cadence is proposed in §11, but expiry must not auto-demote to a removal-adjacent state.
- **Founder approval:** Not to enter.
- **May coexist with `published=true`:** Yes — this is the expected state for the 317 live products.
- **Required fields:** `state_reason_code` recording *which* value basis applies (revenue, strategic, operational).

### HOLD

- **Purpose:** Explicit temporary blocker or founder-approved reason to wait.
- **Entry:** Founder decision, or a defined blocker (e.g. missing evidence that prevents publication).
- **Exit:** Blocker resolved, or review date reached.
- **Allowed next:** `EVALUATING`, `ACTIVE_ASSET`, `REVIEW_REQUIRED` (**mandatory route on deadline expiry**), `RETIRE_CANDIDATE` (**Founder approval required; never automatic**).
- **Occupies slot:** Yes — **indefinitely permitted only when justified and time-bounded** (Rule 6).
- **Deadline:** **Mandatory.** **No HOLD may exist without a `review_due_at` value.** This is the state most prone to becoming permanent by neglect.
- **Founder approval:** **Not required** for `EVALUATING → HOLD` when a valid reason and review deadline exist (Founder approval policy). An initiating authority must still be recorded. Founder approval **is** required for `HOLD → RETIRE_CANDIDATE`.
- **May coexist with `published=true`:** Yes — a live product may be held from further change.
- **Required fields (all mandatory):** `state_reason_code`, `state_reason_text`, `review_due_at`, `approved_by` **or** initiating authority, `entered_state_at`.
- **Deadline expiry behaviour:** on expiry, `HOLD → REVIEW_REQUIRED`. **Never** `HOLD → RETIRE_CANDIDATE` automatically. A review deadline is not a removal deadline.

*Real example:* `W2817S00021` — held for missing sectional dimensions. Today that intent exists only in a gitignored report; in the database it is indistinguishable from a product that merely failed to publish.

### REVIEW_REQUIRED

- **Purpose:** Evidence is stale, contradictory, incomplete, or indicates declining value.
- **Entry:** Evidence staleness threshold crossed; contradiction detected; value signal declines; deadline elapsed in a bounded state.
- **Exit:** Reassessment completed.
- **Allowed next:** `ACTIVE_ASSET`, `HOLD`, `RETIRE_CANDIDATE`, `EVALUATING`.
- **Occupies slot:** Yes.
- **Deadline:** **Required** (Rule 7).
- **Founder approval:** Not to enter; required to exit toward `RETIRE_CANDIDATE`.
- **May coexist with `published=true`:** Yes — and this is an important case, since a live product with stale evidence is exactly what should be reviewed without disturbing its publication.
- **Required fields:** `state_reason_code` identifying the trigger, `review_due_at`.

### RETIRE_CANDIDATE

- **Purpose:** Evidence suggests the slot should probably be released; removal **not** yet approved.
- **Entry:** From `REVIEW_REQUIRED` or `HOLD` when evidence indicates low value.
- **Exit:** Value reconfirmed, blocker re-established, or removal authorized.
- **Allowed next:** `ACTIVE_ASSET`, `HOLD`, `REMOVABLE`.
- **Occupies slot:** Yes.
- **Deadline:** **Required** (Rule 7) — must not become a permanent limbo.
- **Founder approval:** **Required** to progress to `REMOVABLE`.
- **May coexist with `published=true`:** **Yes, but it must never by itself cause unpublication.** A published retire-candidate must resolve its publication dependency before `REMOVABLE` (§6).
- **Required fields:** `state_reason_code`, `state_reason_text`, `review_due_at`.

**Rule 8 applies here specifically:** `junk_category = true` may contribute evidence toward
`RETIRE_CANDIDATE` but must **never** directly authorize removal. Phase 3 established why: it is a
title-keyword regex (`HARD_JUNK`, `planGigaSavedItems.ts:62`) with demonstrated false positives —
a 6-Drawer Double Dresser and a Glass Curio Cabinet are both flagged, and 13 flagged products are
currently live.

### REMOVABLE

- **Purpose:** All dependency, publication, inventory, and approval checks have passed.
- **Entry:** From `RETIRE_CANDIDATE` **only**, and only when every precondition in §6 is satisfied and Founder authorization is recorded.
- **Exit:** Removal executed and verified, or a precondition regresses.
- **Allowed next:** `REMOVED`, and back to `RETIRE_CANDIDATE`/`HOLD`/`ACTIVE_ASSET` if a precondition regresses before execution.
- **Occupies slot:** Yes — the slot is still occupied. `REMOVABLE` is permission, not release.
- **Deadline:** **Required** (Rule 7) — stale authorization must expire rather than remain executable indefinitely.
- **Founder approval:** **Required and recorded** (`approved_by`, `approved_at`).
- **May coexist with `published=true`:** **No — hard invariant.** A product with `published = true` **must not enter `REMOVABLE`** under any circumstance. A published product may enter `REVIEW_REQUIRED` or `RETIRE_CANDIDATE` for planning purposes, but publication must be safely disabled through the publication authority, and every precondition in §6 and §6a satisfied, before `REMOVABLE` is permitted.
- **Required fields:** all approval fields, plus the recorded precondition evidence snapshot.
- **Operational gating:** architecturally valid, but **default-off**. Transition into `REMOVABLE` is disabled until the dependency checks, approval records, and supplier-write verification capability exist (Phase F).

### REMOVED

- **Purpose:** The supplier has confirmed the item is no longer in Saved Items — the slot is actually released.
- **Entry:** Only after **verified** removal at the supplier (Rule 10). Approval alone is insufficient.
- **Exit:** Terminal for this asset record. Re-saving the product later should create a new record, preserving history.
- **Allowed next:** None (terminal).
- **Occupies slot:** **No** — this is the only state that does not.
- **Deadline:** Not applicable.
- **Founder approval:** Already recorded at `REMOVABLE`.
- **May coexist with `published=true`:** **No.**
- **Required fields:** `removed_at`, `last_saved_verified_at` (post-removal verification), retained approval fields.
- **Operational gating:** execution of `REMOVABLE → REMOVED` is **default-off**. **No scheduled or autonomous process may execute a supplier Saved Items removal during the initial implementation stages** — execution is manual and Founder-authorized only.

> **Operational gate (not a permanent limitation):** `REMOVED` is a fully valid lifecycle state. It
> is not currently *executable* because no verified remove-from-Saved capability exists (Phase 1,
> Phase 2). The state is modelled now and enabled in Phase F, once dependency checks, approval
> records, and supplier-write verification are in place.

---

## 5. Transition table

### Allowed transitions

Approval column reflects the **authoritative Founder approval policy**. "Approval: No" means the
transition may proceed without individual Founder sign-off; an initiating authority is still
recorded in history.

| From | To | Trigger | Founder approval | Automatable |
| --- | --- | --- | --- | --- |
| ∅ | `SAVED_CANDIDATE` | Item observed in saved list without an asset record | No | Yes |
| `SAVED_CANDIDATE` | `EVALUATING` | Evidence gathering begins | **No** | Yes |
| `SAVED_CANDIDATE` | `HOLD` | Blocker identified before evaluation — **valid reason + `review_due_at` required** | **No** | No (reason must be authored) |
| `SAVED_CANDIDATE` | `REVIEW_REQUIRED` | Deadline elapsed without evaluation | No | Yes |
| `EVALUATING` | `ACTIVE_ASSET` | Evidence supports value | **No** | Yes |
| `EVALUATING` | `HOLD` | Blocker found — **valid reason + `review_due_at` required** | **No** | No (reason must be authored) |
| `EVALUATING` | `REVIEW_REQUIRED` | Evidence contradictory/incomplete, or deadline elapsed | No | Yes |
| `ACTIVE_ASSET` | `REVIEW_REQUIRED` | Evidence stale/declining | No | Yes |
| `ACTIVE_ASSET` | `HOLD` | New blocker — **valid reason + `review_due_at` required** | **No** | No (reason must be authored) |
| `ACTIVE_ASSET` | `RETIRE_CANDIDATE` | Value no longer evidenced | **Yes** | **No** |
| `HOLD` | `EVALUATING` | Blocker cleared, re-evaluation needed | **No** | Yes |
| `HOLD` | `ACTIVE_ASSET` | Blocker cleared, value already evidenced | **No** | Yes |
| `HOLD` | `REVIEW_REQUIRED` | **`review_due_at` expired** — mandatory expiry route | No | Yes |
| `HOLD` | `RETIRE_CANDIDATE` | Value not established after review | **Yes** | **No** |
| `REVIEW_REQUIRED` | `ACTIVE_ASSET` | Value reconfirmed | **No** | Yes |
| `REVIEW_REQUIRED` | `EVALUATING` | Fresh evidence needed | No | Yes |
| `REVIEW_REQUIRED` | `HOLD` | Blocker identified — **valid reason + `review_due_at` required** | **No** | No (reason must be authored) |
| `REVIEW_REQUIRED` | `RETIRE_CANDIDATE` | Evidence indicates low value | **Yes** | **No** |
| `RETIRE_CANDIDATE` | `ACTIVE_ASSET` | Value reconfirmed | No | Yes |
| `RETIRE_CANDIDATE` | `HOLD` | New blocker or Founder defers | No | No (reason must be authored) |
| `RETIRE_CANDIDATE` | `REMOVABLE` | **All §6 + §6a preconditions pass** + authorization | **Yes** | **No — default-off** |
| `REMOVABLE` | `REMOVED` | Removal executed **and verified** at supplier | **Yes** | **No — default-off; never scheduled or autonomous** |
| `REMOVABLE` | `RETIRE_CANDIDATE` / `HOLD` / `ACTIVE_ASSET` | Precondition regressed before execution | No | Yes |

### Prohibited transitions

| Prohibited | Why |
| --- | --- |
| **Any product with `published = true` → `REMOVABLE`** | **Hard invariant (§6a).** Publication must be safely disabled through the publication authority first |
| Any → `REMOVED` except from `REMOVABLE` | Rule 10 — removal must pass dependency checks and be verified |
| Any → `REMOVABLE` except from `RETIRE_CANDIDATE` | Rule 9 — `REMOVABLE` is the authorization gate, not a shortcut |
| `SAVED_CANDIDATE` / `EVALUATING` → `RETIRE_CANDIDATE` | Must pass through `REVIEW_REQUIRED` or `HOLD`; never retire without an explicit review step |
| `SAVED_CANDIDATE` / `EVALUATING` / `ACTIVE_ASSET` → `REMOVABLE` | Skips both review and retire evaluation |
| **`HOLD` → `RETIRE_CANDIDATE` triggered by deadline expiry** | **Expiry routes to `REVIEW_REQUIRED` only.** A review deadline is never a removal deadline |
| Any HOLD without `review_due_at` | No HOLD may exist without a review deadline |
| `REMOVED` → any | Terminal; re-saving creates a new record |
| Any transition writing `published` | Rule 2 — Axis 1 never writes publication |
| Any transition writing `inventory_status` | Rule 4 — Axis 3 and the RPC own inventory state |
| Any automated transition into `RETIRE_CANDIDATE` | Founder approval required from every source state |
| Any automated transition into `REMOVABLE` or `REMOVED` | Irreversible; Founder approval must be explicit |
| **Any scheduled or autonomous supplier Saved Items removal** | Prohibited outright during the initial implementation stages |
| Any transition authorized solely by `junk_category = true` | Rule 8 — regex-based flag with proven false positives |

**Note on `ACTIVE_ASSET → RETIRE_CANDIDATE`:** the approved Founder policy makes this a **permitted**
transition subject to Founder approval. An earlier draft of this document routed it through
`REVIEW_REQUIRED`; the Founder policy supersedes that, and the direct transition is now allowed with
approval.

---

## 6. Removal preconditions

All must be satisfied and **recorded as an evidence snapshot** before `RETIRE_CANDIDATE → REMOVABLE`.
Implementation status is stated honestly — several cannot be checked today.

| # | Precondition | Can it be checked today? | Basis |
| --- | --- | --- | --- |
| 1 | Not required for a live sellable product | ✅ **Yes** | Membership in `sellable_products`; `standardized_products.published` |
| 2 | Publication/delisting dependencies resolved | ⚠️ **Partially** | `published` is readable, but there is no delist executor, no delist audit record, and the delist path exists only as a side effect of the RPC |
| 3 | No pending order or operational dependency | ✅ **Yes, implementable** | **Verified:** `orders` (with `status`, `payment_status`) and `order_items` (with `product_id`, `supplier_sku`) both exist. No such check is currently written, but the data supports one |
| 3b | No active cart dependency | ❌ **No** | **Verified:** `cart_items` does not exist (`PGRST205`). Cart state is client-side; this dependency cannot be evaluated server-side today |
| 4 | No protected Founder HOLD | ❌ **Not today** | No `held` column exists anywhere in the schema. Becomes checkable only once Axis 1 is persisted |
| 5 | Variant-family effects understood | ⚠️ **Partially** | `standardized_products.product_family_key` exists and is populated; **`product_families` does not exist** (`PGRST205`). Family membership is derivable but has no dedicated table, and family-level slot cost is not modelled |
| 6 | Correct supplier account identified | ⚠️ **Partially** | Two accounts exist (pickup via `SUPPLIER_*`, dropship via `SUPPLIER_DELIVERY_*`); `giga_delivery_fee_cache.dropship_giga_product_id` exists. There is **no per-asset field recording which account holds the slot** |
| 7 | Removal verification is possible | ❌ **No** | No removal capability exists; Phase 2 did not verify removal. Verification would require re-reading the saved list and confirming absence |
| 8 | Authorization recorded | ❌ **Not today** | No approval fields exist. Requires the proposed `approved_by` / `approved_at` |

**Consequence:** on today's schema, preconditions 4, 7, 8 and 3b cannot yet be satisfied, and 2, 5, 6
only partially. `REMOVABLE` is **architecturally valid but operationally gated** — the state exists
in the model and is entered only once its preconditions become checkable (Phases B–F). This is the
desirable outcome for a first version: the lifecycle can be populated and observed long before it can
release anything.

**Additional constraint from Phase 1.** Removing a product from Saved Items forfeits API access to
its detail, price, and inventory (`B20003 — "The SKU is not added to Saved Items List or has no
stockpiled inventory"`). Removal therefore destroys the evidence required to re-evaluate the
decision. Any removal precondition set should treat this as a one-way door and capture a full
evidence snapshot *before* execution.

---

## 6a. Published product protection (HIGH-SEVERITY INVARIANT)

> **A product with `published = true` must not enter `REMOVABLE`.**

A published product **may** enter `REVIEW_REQUIRED` or `RETIRE_CANDIDATE` for planning purposes.
Neither of those states unpublishes anything, and neither may cause unpublication as a side effect.
But `REMOVABLE` is barred until every publication dependency is resolved.

Before any **published or previously published** product may become `REMOVABLE`, all nine of the
following must be satisfied and recorded:

| # | Requirement | Checkable today? |
| --- | --- | --- |
| 1 | Customer-visible publication has been **safely disabled through the publication authority** (`refresh_product_inventory_status()`) — never by Axis 1 | ⚠️ Partially — `published` is readable and the RPC can unpublish, but there is no delist executor or delist audit record |
| 2 | No open or operationally relevant order dependency exists | ✅ Implementable — `orders` and `order_items` exist (verified) |
| 3 | Inventory monitoring behaviour has been stopped, transferred, or explicitly accepted | ❌ Not today — Axis 3 is unpersisted; no monitoring registry exists |
| 4 | Required historical product, pricing, and inventory evidence is **retained** before access is lost | ⚠️ Partially — `pricing_audit_log` retains pricing; no product/inventory evidence snapshot mechanism exists |
| 5 | Variant-family impact has been evaluated | ⚠️ Partially — `product_family_key` exists; `product_families` table does not |
| 6 | Supplier account identity is known (pickup vs dropship) | ⚠️ Partially — two accounts exist; no per-asset account field until Axis 1 is persisted |
| 7 | Removal can be verified | ❌ Not today — no removal capability, and Phase 2 did not verify removal |
| 8 | **Re-acquisition risk is understood** | ❌ Not today — no add-to-Saved capability exists, so re-acquisition may be impossible |
| 9 | Explicit Founder authorization is recorded | ❌ Not today — requires the proposed approval fields |

### Why this is high-severity

Supplier API access is gated on Saved membership (Phase 1, proven by controlled experiment).
Removing a **live** product may therefore permanently destroy:

- **detail access** — title, specifications, dimensions;
- **price access** — cost, discount, shipping fee;
- **inventory access** — stock levels and warehouse/CA-pickup evidence;
- **variant access** — family and associated-product data;
- **relisting capability** — the ability to restore the product if the decision was wrong.

Combined with requirement 8, this makes removal of a published product a **one-way door with no
guaranteed return path**: no add-to-Saved capability exists, so a mistaken removal may not be
recoverable at all. This is why publication must be disabled first, evidence retained first, and
authorization recorded first — in that order.

---

## 7. Data model proposal (conceptual — no migration)

### Persisted — proposed `saved_assets`

One row per (supplier SKU × supplier account). Account is part of identity because the same SKU may
occupy a slot in both accounts, at independent cost.

| Field | Type | Purpose | Notes |
| --- | --- | --- | --- |
| `supplier_product_id` | text | SKU identity | Matches the key used across `supplier_products`, `standardized_products`, `inventory_cache` |
| `supplier_account` | text | Which account holds the slot | `pickup` / `dropship`. Closes precondition 6 |
| `asset_state` | text | Axis 1 state | Constrained to the 8 approved names |
| `state_reason_code` | text | Machine-readable reason | Enables aggregation and queue-building |
| `state_reason_text` | text | Human explanation | **Mandatory for `HOLD` and `RETIRE_CANDIDATE`** |
| `entered_state_at` | timestamptz | When the current state began | Drives deadline computation |
| `review_due_at` | timestamptz | Deadline | Mandatory for the five bounded states (Rule 7) |
| `previous_state` | text | Prior state | Convenience for the common "what changed" query; history table is authoritative |
| `founder_approval_required` | boolean | Whether this state/transition needs approval | Explicit rather than inferred |
| `approved_by` | text | Who authorized | Required for `HOLD`, `REMOVABLE`, `REMOVED` |
| `approved_at` | timestamptz | When authorized | Enables authorization staleness expiry |
| `slot_cost` | integer | Slots consumed by this row | See note below |
| `product_family_key` | text | Family identity | Mirrors `standardized_products.product_family_key`; enables family-level reasoning without a new table |
| `last_saved_verified_at` | timestamptz | When membership was last confirmed | Critical — membership drifts silently (689 → 688 observed) |
| `removed_at` | timestamptz | When removal was verified | Null until `REMOVED` |
| `version` | integer | Optimistic concurrency | Prevents lost updates between founder action and scheduled jobs |
| `created_at` / `updated_at` | timestamptz | Standard audit | |

**Note on `slot_cost`.** Phase 3 established that variants occupy independent slots and that the
existing `slotCost: 1 | 2` model (`stage1CandidateScore.ts`) conflates account duplication with
family size. With one row per (SKU × account), `slot_cost` is naturally **1 per row**, and both
account duplication and family size become *emergent* from row counts rather than encoded in a
scalar. Retaining the column is still useful if a future supplier rule makes a single SKU cost more
than one slot; if not, it should default to 1 and be treated as an escape hatch, not a model.

### Derived — never stored in `saved_assets`

Computed on read from existing sources (Rule 5):

| Derived value | Source |
| --- | --- |
| imported / admitted | `supplier_products` row, `.published` |
| normalized | `standardized_products.normalization_status` |
| priced / margin | `selling_price`, `estimated_net_margin`, `last_priced_at` |
| inventory observed | `inventory_cache` |
| inventory status | `standardized_products.inventory_status` |
| published / sellable | `standardized_products.published`, `sellable_products` view |
| review seeded | `product_reviews` |
| junk-category flag | `HARD_JUNK` regex over title — **evidence only, never authorization** |
| family size / variant overlap | Aggregate over `product_family_key` |
| CA priority (P1–P4) | Existing `classifyPriority` over `inventory_cache` |

---

## 8. Inventory workflow persistence proposal (Axis 3 — not implemented)

The logic already exists and is tested; only storage is missing. Proposed `inventory_workflow`, one
row per `supplier_product_id`, written **only** by the inventory observation job:

| Field | Purpose |
| --- | --- |
| `supplier_product_id` | Identity |
| `workflow_state` | One of the six existing states — names reused verbatim from `inventoryStateMachine.ts` |
| `consecutive_out_of_stock` | Zero-observation counter — the field whose absence currently breaks multi-confirmation |
| `consecutive_in_stock` | Positive-observation counter |
| `last_observation_status` | The most recent `InventoryResultStatus` |
| `last_observation_at` | When it was observed |
| `last_transition_at` | When the state last changed |
| `last_proposed_action` | Most recent `ProposedAction` — proposal only, never executed automatically |
| `observed_exception` | `blocked_auth` / `blocked_parse` / `inventory_unknown` / null |
| `version` | Optimistic concurrency — the inventory job and any manual action must not clobber each other |

**Why this matters concretely.** `inventoryDecisionDryRun.ts:117-118` hardcodes
`prior = { state: 'published_in_stock', consecutiveOutOfStock: 0, consecutiveInStock: 0 }` on every
run. Persisting these three fields is the entire fix — it makes `eligible_for_delist` reachable and
turns a written-but-inert safety mechanism into a functioning one. **No logic changes are required.**

**Constraint:** this table must never write `published`. It records observations and *proposes*
actions; execution remains manual and founder-approved until accuracy is demonstrated (Bible,
Stage 3).

---

## 9. Publication-authority conflict analysis

**The hazard, precisely.** `refresh_product_inventory_status(p_supplier_product_id)` executes a
single unconditional `UPDATE` setting `inventory_status`, `total_available_qty`,
`available_warehouse_count`, `has_ca_pickup`, `has_valid_inventory`, **`published`**,
`inventory_last_synced_at`, `updated_at`. It reads only `inventory_cache`. It does not consult, merge
with, or defer to any other state.

Therefore any other writer of `published` is not merely a second opinion — it is **silently
reverted** the next time that RPC runs for that SKU. The corruption is intermittent (only on
refresh), silent (no error), and customer-visible (storefront membership).

**Rules to avoid the conflict:**

1. **Single writer, unchanged.** `refresh_product_inventory_status()` remains the sole writer of
   `published` and `inventory_status` (Rule 3). Neither `saved_assets` nor `inventory_workflow`
   writes either column, under any state, ever.
2. **Axis 1 reads publication; it never sets it.** Publication is a *precondition* for `REMOVABLE`,
   not an effect of it. A `RETIRE_CANDIDATE` that is still published does not become unpublished by
   virtue of its Axis 1 state — the publication dependency must be resolved through the normal
   publication path first. **A Saved Asset transition may *request* or *wait for* a publication
   change, but it may never perform that change directly.** The request is recorded; the execution
   belongs to the publication authority.
2b. **No second uncontrolled writer to `published` may be introduced** — by Axis 1, Axis 3, a
   trigger, a view, or a scheduled job.
3. **Axis 3 proposes; the RPC disposes.** `last_proposed_action` records what the state machine
   *would* do. Execution routes through the existing RPC, under founder approval.
4. **No database trigger on `published`.** A trigger that reacted to publication changes by mutating
   Axis 1 would create a write cycle between an automated RPC and a deliberation record. Axis 1
   should be updated by explicit jobs and decisions, not by side effects.
5. **Ordering discipline for any future removal flow.** Unpublish (via the RPC) → verify → then
   remove the Saved slot. Never remove first: Phase 1 proved that losing Saved membership forfeits
   the API access needed to verify anything afterward.
6. **If a future decision ever requires Axis 1 to influence publication,** it must be a recorded
   architecture decision that changes the authority explicitly — not an additional writer added
   quietly (Rule 3).

---

## 10. Mapping current Saved Items (rules only — nothing written)

Deterministic mapping proposals for a **read-only backfill preview** (Phase A). No state is assigned
to live data by this document. Counts are from `Stage2_PHASE3_SAVED_RESOURCE_ANALYSIS.md`
(689-item snapshot; live occupancy 688).

| Current condition | Count | Proposed initial state | Rationale |
| --- | --- | --- | --- |
| Published / live | 317 | `ACTIVE_ASSET` | Live and purchasable — demonstrated revenue value |
| Normalized, unpublished | 102 | `EVALUATING` | Pipeline investment made; publication evidence incomplete |
| Imported, not normalized | 39 | `EVALUATING` | Partially processed; evidence gathering incomplete |
| Never imported (all `new_candidate`) | 117 | `SAVED_CANDIDATE` | In Saved Items, no commercial evaluation performed |
| Founder-held (`W2817S00021`) | 1 | `HOLD` | Explicit founder decision; requires `state_reason_text` ("missing sectional dimensions") and a `review_due_at` |
| Stale evidence | see note | `REVIEW_REQUIRED` | Evidence aged past threshold |
| Junk-category, **unpublished** | 113 | `REVIEW_REQUIRED` | **Not** `RETIRE_CANDIDATE` — Rule 8. The flag is evidence, not authorization |
| Junk-category, **published** | 13 | `ACTIVE_ASSET` + review flag | Live products; several are proven regex false positives. Must not be demoted by the flag alone |
| Variant overlap (excess slots) | 23 (6 published) | Inherit from own condition | Family overlap is *evidence* for later review, never an initial state. The 6 published ones map to `ACTIVE_ASSET` |

**Mapping rules that must hold:**

1. **Published ⇒ never an initial removal-adjacent state.** No live product may be backfilled to
   `RETIRE_CANDIDATE`, `REMOVABLE`, or `REMOVED`, regardless of any other flag.
2. **`junk_category` maps at most to `REVIEW_REQUIRED`** (Rule 8), never to `RETIRE_CANDIDATE`.
3. **No initial state may be `REMOVABLE` or `REMOVED`.** Both require authorization that has never
   been given, and `REMOVED` additionally requires verified supplier release.
4. **Stale-evidence mapping needs care.** The staleness sweep is not running (344 rows are `in_stock`
   with sync data older than 7 days) and two thresholds disagree (the function comment says 24 hours;
   its predicate uses 7 days). Backfilling `REVIEW_REQUIRED` from `inventory_status = 'stale'` would
   currently capture only 4 rows and miss the real population. **The staleness defect should be
   resolved before it is used as a mapping input**, or the backfill will encode a known-wrong signal.
5. **The snapshot is stale by construction.** It predates the Stage 1 batch, and live occupancy has
   already drifted (689 → 688). Any backfill must re-read membership at execution time and record
   `last_saved_verified_at`, rather than trusting a stored snapshot.
6. **Unmappable rows go to `REVIEW_REQUIRED`, never to a default.** A row that matches no rule is a
   classification failure and must surface for human attention — consistent with the project's
   "unknown is not zero" law.

---

## 11. Timeout and review policy

### HOLD review periods — **Founder-approved initial policy values (configurable later)**

These are **review deadlines, not automatic removal deadlines.** They are approved for initial
implementation and are expected to be tuned with experience.

| HOLD reason class | Review period | Example |
| --- | --- | --- |
| Content, dimensions, or category issue | **7 days** | `W2817S00021` — missing sectional dimensions |
| Supplier inventory, session, or API issue | **14 days** | `B20003` fee-permission failure; saved-list endpoint outage |
| Explicit Founder hold | **30 days** | Strategic deferral |

**Mandatory expiry behaviour:** on expiry, `HOLD → REVIEW_REQUIRED`. **Never**
`HOLD → RETIRE_CANDIDATE` automatically. No HOLD may exist without a `review_due_at` value.

### Other state windows — **proposals still requiring Founder approval**

Unlike the HOLD periods above, these remain undecided and are not encoded anywhere.

| State | Proposed window | Reasoning |
| --- | --- | --- |
| `SAVED_CANDIDATE` | ~30 days | A slot held for a month without evaluation is unmanaged inventory |
| `EVALUATING` | ~14 days | Evidence gathering is mostly automatable; a longer window suggests a blocker (→ `HOLD`) |
| `ACTIVE_ASSET` | No deadline; ~90-day revalidation | Rule 6 permits indefinite occupancy. Revalidation routes to `REVIEW_REQUIRED`, **never** toward removal |
| `REVIEW_REQUIRED` | ~21 days | Long enough to gather evidence, short enough to prevent a permanent queue |
| `RETIRE_CANDIDATE` | ~30 days | Bounded limbo; expiry routes back to `REVIEW_REQUIRED`, not forward to removal |
| `REMOVABLE` | ~7 days | Authorization should expire quickly — the preconditions that justified it decay |

**Two invariant policy properties:** deadline expiry always routes *away* from removal (toward
review), never *toward* it; and no deadline may ever trigger an irreversible action automatically.

---

## 12. Event and transition history

A `saved_asset_transitions` append-only table is recommended, since current state alone cannot
answer "why is this slot occupied?" — the question Axis 1 exists to answer.

Proposed fields: `supplier_product_id`, `supplier_account`, `from_state`, `to_state`,
`reason_code`, `reason_text`, `evidence_snapshot` (the facts as of the transition),
`actor` (job name or founder), `approved_by`, `occurred_at`.

**Precedent:** `pricing_audit_log` (679 rows) already demonstrates this pattern working in this
codebase — append-only, never mutated, written alongside the state change.

Rationale specific to this domain: removal is irreversible *and* destroys the supplier evidence that
would justify it (Phase 1). The transition record may become the only surviving explanation of why a
slot was released. It should capture the evidence snapshot, not merely the state names.

---

## 13. Implementation phases

Each phase is independently testable, default-off, and adds no behaviour to existing systems until
explicitly enabled.

**Phase A — Schema + read-only backfill preview.** Define `saved_assets` conceptually and produce a
gitignored report showing what each row *would* receive under §10, with unmappable rows listed. No
table created, no data written. Deliverable: a founder-reviewable preview and a count per proposed
state. *Testable:* mapping rules are pure functions over existing data.

**Phase B — Persist Saved Asset state.** Create the table and backfill from the approved preview.
**No supplier behaviour, no publication behaviour, no automated transitions.** The table is
descriptive only. *Testable:* row counts reconcile with the snapshot; no other table changes.

**Phase C — Persist inventory workflow counters.** Create `inventory_workflow` and have the existing
observation job write state and counters. Actions remain proposals; nothing executes. This is the
phase that makes multi-confirmation actually function. *Testable:* counters accumulate across runs —
the property that provably fails today.

**Phase D — Read-only capacity dashboard and review queue.** Surface occupancy by state, items past
`review_due_at`, and family/account slot consumption. Still no writes to supplier or publication.
*Testable:* report output only. **This is the first phase that produces founder value**, and it does
so without any irreversible capability existing.

**Phase E — Founder-approved manual transitions.** Allow recorded, authorized state changes with
history. Still no supplier writes; `REMOVABLE` reachable, `REMOVED` still not. *Testable:* transition
validation rejects prohibited transitions; history rows are written.

**Phase F — Controlled Saved removal.** Only after a removal capability exists and is verified.
Requires: **per-item Founder approval**, all §6 and §6a preconditions checkable, evidence snapshot
captured pre-execution, post-removal verification, and a strict blast-radius limit (a small number of
items per batch, as Stage 1 did with 5 SKUs). **No scheduled or autonomous process may execute a
removal — execution is manual and Founder-authorized only, for the entirety of the initial
implementation stages.** *Testable:* dry-run parity before any live removal.

Until Phase F is explicitly enabled, transition into `REMOVABLE` and execution of
`REMOVABLE → REMOVED` are **default-off**. Phases A–E populate and observe the lifecycle without any
capacity to release a slot.

**Phase G — Controlled Saved addition and Discovery integration.** Depends on an addition capability
that does not exist today. Closes the loop from discovery to acquisition.

**Ordering rationale:** observability (D) precedes irreversibility (F) by two phases. The capability
to release slots should not exist before the ability to see what is occupying them and why.

---

## 14. Risks and invariants

### Invariants — must hold at all times

1. **A product with `published = true` never enters `REMOVABLE`. (HIGH SEVERITY — §6a.)**
2. Axis 1 never writes `published` or `inventory_status`. A transition may *request* or *wait for* a publication change; it may never perform one.
3. `refresh_product_inventory_status()` remains the single publication authority. No second uncontrolled writer to `published` is introduced.
4. Axis 3 state is never embedded in Axis 1.
5. Axis 2 facts are derived, never copied into `saved_assets`.
6. `REMOVED` is entered only after **verified** supplier release.
7. `REMOVABLE` is entered only from `RETIRE_CANDIDATE`, only with recorded Founder authorization.
8. `junk_category` never authorizes removal.
9. Every transition is recorded in append-only history.
10. **No `HOLD` exists without `review_due_at`**, plus `state_reason_code`, `state_reason_text`, initiating authority, and `entered_state_at`.
11. **`HOLD` expiry routes to `REVIEW_REQUIRED` — never to `RETIRE_CANDIDATE`.**
12. Only `ACTIVE_ASSET` and justified `HOLD` may occupy a slot indefinitely.
13. No automated transition may enter `RETIRE_CANDIDATE`, `REMOVABLE`, or `REMOVED`.
14. **No scheduled or autonomous process executes a supplier Saved Items removal during the initial implementation stages.**
15. Deadline expiry never routes toward removal.

### Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **A published product reaches `REMOVABLE`** | **Critical** | Invariant 1; §6a nine-point precondition set; publication disabled through the authority first |
| **Mistaken removal is unrecoverable** — no add-to-Saved capability exists, so re-acquisition may be impossible | **Critical** | §6a requirement 8; evidence snapshot retained pre-execution; Phase F blast-radius limit |
| A second writer to `published` | **Critical** | Invariant 2 and 3; no triggers on `published` |
| A `HOLD` silently becomes a retirement path | **High** | Invariant 11 — expiry routes only to `REVIEW_REQUIRED` |
| Backfill assigns a wrong initial state to a live product | **High** | Mapping rule 1; Phase A preview reviewed before Phase B |
| Removal executed on a product with an unseen dependency | **Critical** | §6 preconditions; `cart_items` absence acknowledged as an uncheckable gap |
| Removal destroys the evidence needed to re-evaluate | **High** | Evidence snapshot captured before execution (Phase 1 finding) |
| Stale-evidence signal is itself broken | **Medium** | Fix the sweep before using `stale` as a mapping input (rule 4) |
| `HOLD` becomes permanent by neglect | **Medium** | Mandatory `review_due_at`; expiry surfaces in the Phase D queue |
| Saved membership drifts silently | **Medium** | `last_saved_verified_at`; re-read at execution time |
| Axis 1 and Axis 3 disagree about the same product | **Medium** | Different questions, both recorded; disagreement is data, not error |
| Two staleness thresholds (24h vs 7d) | **Low–Medium** | Resolve before Phase C |
| Family/account identity mismodelled | **Medium** | One row per SKU × account; `product_families` absence acknowledged |

---

## 15. Open Founder decisions

Only items genuinely requiring business judgement.

**Now decided by Founder Review and removed from this list:** the state count (eight, preserved);
which transitions require Founder approval (§5); initial HOLD review windows (§11: 7 / 14 / 30 days);
whether `REMOVABLE → REMOVED` requires Founder approval (yes); and the treatment of published
products (§6a hard invariant).

1. **Non-HOLD review windows (§11).** `SAVED_CANDIDATE`, `EVALUATING`, `ACTIVE_ASSET` revalidation,
   `REVIEW_REQUIRED`, `RETIRE_CANDIDATE`, and `REMOVABLE` windows remain proposals. HOLD windows are
   decided.
2. **What qualifies as `ACTIVE_ASSET` value.** Revenue is clear; strategic and operational value need
   a business definition, or the state becomes a default.
3. **Whether unpublished junk-category items (113 slots) should be reviewed as a class** rather than
   individually — a workload decision, given the demonstrated false-positive rate.
4. **Whether the 13 published junk-flagged items should remain live.** Some are regex false positives
   (a dresser, a curio cabinet); others are genuinely out-of-assortment (kids' bicycles, a basketball
   hoop, garden statues). This is assortment policy, not engineering.
5. **Whether `HOLD` may be extended indefinitely with repeated approvals,** or must convert to
   `ACTIVE_ASSET` or `RETIRE_CANDIDATE` after a maximum total duration. (The per-hold review periods
   are decided; a maximum *cumulative* duration is not.)
6. **Blast-radius limit for Phase F removal** — how many slots may be released in one approved batch.
7. **Whether the true account Favorite limit should be established** before or after Phase D. The
   limit remains unknown; occupancy alone cannot yield headroom.
8. **Whether variants should be acquired as families or as single representatives** — affects
   `slot_cost` semantics and the scorer's decision unit (Phase 3 §6).

---

## Validation

- **Only** `docs/product-supply/SAVED_ASSET_STATE_MACHINE_V1.md` was created.
- The Product Bible was **not** modified.
- **No code, schema, or migration** was created or changed.
- **No supplier access, no Playwright, no writes to Supabase.** The only database access was
  read-only verification of table existence for §6 (`orders`, `order_items`, `cart_items`,
  `product_families`, `giga_delivery_fee_cache`), with `data` and `error` inspected on every query.
- **No publication, inventory, pricing, review, or Saved Items state changed.**
- No state was assigned or written to live data; §10 defines rules only.
- No commit, no push.
- The approved state names, the three axes, and the ten architectural rules were preserved without
  alteration or merging.
