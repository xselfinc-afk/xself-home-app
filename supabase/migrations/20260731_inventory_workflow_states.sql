-- 20260731_inventory_workflow_states.sql
--
-- PURPOSE: persist the ALREADY-EXISTING six-state inventory workflow machine
-- (src/services/inventoryStateMachine.ts) plus its consecutive-observation counters.
--
-- KNOWN DEFECT THIS FIXES: scripts/inventoryDecisionDryRun.ts reconstructs every product as
-- { state: 'published_in_stock', consecutiveOutOfStock: 0, consecutiveInStock: 0 } on every run
-- because there is no persisted workflow state. Multi-confirmation therefore never accumulates and
-- `eligible_for_delist` / `eligible_for_relist` are unreachable across runs. This migration adds the
-- storage; it changes NO state-machine logic.
--
-- SAFETY / SCOPE:
--   * ADDITIVE ONLY. Creates two new tables. Alters no existing table, view, function or policy.
--   * Writes NOTHING to standardized_products. `published` and `inventory_status` remain owned
--     solely by public.refresh_product_inventory_status() — this migration introduces no second
--     publication writer and no trigger.
--   * Holds NO Saved Asset lifecycle state (that is a separate axis) and duplicates NO commerce
--     pipeline facts (imported/normalized/priced/published are derived from existing tables).
--   * Service-role only. No anon/authenticated grants: this is operational data, never customer data.
--
-- IDEMPOTENCY: last_observation_key stores a fingerprint of the observation that produced the
-- current row. Re-processing the same observation is a no-op (counters do not advance twice and no
-- duplicate history row is appended).
--
-- CONCURRENCY: `version` is an optimistic-concurrency token. Writers update WHERE version = <read>
-- and must fail loudly when zero rows match (another runner won the race).

-- ── 1. Current workflow state (one row per product) ──────────────────────────

CREATE TABLE IF NOT EXISTS public.inventory_workflow_states (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Canonical identity. Matches standardized_products.supplier_product_id and
  -- inventory_cache.product_id (both hold the supplier SKU string, e.g. 'W5881P505001').
  supplier_product_id         text        NOT NULL,
  -- Human-facing internal SKU (standardized_products.sku_custom, e.g. 'XH-DK-HM-505001').
  -- Denormalised for report readability only; never used as an identity key.
  supplier_sku                text,

  workflow_state              text        NOT NULL DEFAULT 'published_in_stock',

  consecutive_out_of_stock    integer     NOT NULL DEFAULT 0,
  consecutive_in_stock        integer     NOT NULL DEFAULT 0,

  -- Last observation that was actually PROCESSED (may be non-authoritative).
  last_observed_inventory_status text,
  last_observed_at            timestamptz,
  -- Fingerprint of that observation; drives idempotent re-processing.
  last_observation_key        text,

  last_transition_at          timestamptz,
  transition_reason           text,

  version                     integer     NOT NULL DEFAULT 1,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  -- Exactly one row per product: makes duplicate workflow rows impossible.
  CONSTRAINT inventory_workflow_states_product_uniq UNIQUE (supplier_product_id),

  -- The six authoritative states. CHECK (not ENUM) so the set can be evolved in a plain migration.
  CONSTRAINT inventory_workflow_states_state_chk CHECK (workflow_state IN (
    'published_in_stock',
    'pending_out_of_stock',
    'eligible_for_delist',
    'delisted_out_of_stock',
    'relist_pending',
    'eligible_for_relist'
  )),

  CONSTRAINT inventory_workflow_states_counters_chk
    CHECK (consecutive_out_of_stock >= 0 AND consecutive_in_stock >= 0)
);

CREATE INDEX IF NOT EXISTS idx_inv_workflow_state
  ON public.inventory_workflow_states (workflow_state);

-- Partial index for the recommendation queue (the only states that propose an action).
CREATE INDEX IF NOT EXISTS idx_inv_workflow_actionable
  ON public.inventory_workflow_states (workflow_state)
  WHERE workflow_state IN ('eligible_for_delist', 'eligible_for_relist');

-- ── 2. Append-only transition history ────────────────────────────────────────
-- Written ONLY when the committed state or counters actually change. Never updated, never deleted.

CREATE TABLE IF NOT EXISTS public.inventory_workflow_transitions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  supplier_product_id         text        NOT NULL,
  supplier_sku                text,

  from_state                  text        NOT NULL,
  to_state                    text        NOT NULL,

  observed_inventory_status   text        NOT NULL,
  observed_at                 timestamptz,
  observation_key             text        NOT NULL,

  consecutive_out_of_stock_before integer NOT NULL,
  consecutive_in_stock_before     integer NOT NULL,
  consecutive_out_of_stock_after  integer NOT NULL,
  consecutive_in_stock_after      integer NOT NULL,

  proposed_action             text,
  observed_exception          text,
  reason                      text        NOT NULL,

  run_id                      text        NOT NULL,
  runner                      text        NOT NULL,

  transitioned_at             timestamptz NOT NULL DEFAULT now(),

  -- Deduplication: the same observation for the same product can only ever be recorded once,
  -- even if two runners process it concurrently.
  CONSTRAINT inv_workflow_transitions_dedup_uniq
    UNIQUE (supplier_product_id, observation_key),

  CONSTRAINT inv_workflow_transitions_from_chk CHECK (from_state IN (
    'published_in_stock','pending_out_of_stock','eligible_for_delist',
    'delisted_out_of_stock','relist_pending','eligible_for_relist')),
  CONSTRAINT inv_workflow_transitions_to_chk CHECK (to_state IN (
    'published_in_stock','pending_out_of_stock','eligible_for_delist',
    'delisted_out_of_stock','relist_pending','eligible_for_relist'))
);

CREATE INDEX IF NOT EXISTS idx_inv_workflow_tr_product
  ON public.inventory_workflow_transitions (supplier_product_id, transitioned_at DESC);

CREATE INDEX IF NOT EXISTS idx_inv_workflow_tr_run
  ON public.inventory_workflow_transitions (run_id);

-- ── 3. RLS: service-role only ────────────────────────────────────────────────
-- Operational data. No anon/authenticated grants are issued, so with RLS enabled and no policy
-- these tables are reachable only by the service role (which bypasses RLS).

ALTER TABLE public.inventory_workflow_states      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_workflow_transitions ENABLE ROW LEVEL SECURITY;

-- ── 4. Explicitly NOT done here ──────────────────────────────────────────────
--   * No change to standardized_products (published / inventory_status untouched).
--   * No trigger reacting to publication or inventory changes.
--   * No delist/relist execution. These tables record and propose; execution stays manual,
--     allowlisted, and routed through refresh_product_inventory_status().
