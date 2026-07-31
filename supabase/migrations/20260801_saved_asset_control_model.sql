-- 20260801_saved_asset_control_model.sql
--
-- PURPOSE: the minimum additive shared-Supabase control model for the Supplier Favorite lifecycle,
-- exactly as frozen in docs/product-supply/SAVED_ASSET_XONE_CONTRACT.md and aligned in
-- docs/product-supply/SAVED_ASSET_STATE_MACHINE_V1.md (commit ed88b860).
--
--   supplier facts  →  XSelf-owned Saved Asset state  →  XOne read-only view  →  narrow Founder ack
--
-- SAFETY / SCOPE:
--   * ADDITIVE ONLY. Creates 3 tables, 1 view, 1 function. ALTERS NO EXISTING TABLE.
--   * NO trigger on standardized_products.published. NO trigger on inventory_cache. NO trigger at all.
--   * NO backfill, NO seed data, NO automatic state generation, NO scheduler.
--   * Writes NOTHING to standardized_products / supplier_products / inventory_cache.
--     refresh_product_inventory_status() remains the sole publication authority.
--   * Canonical tables are service-role only (RLS enabled, no policies granted).
--
-- OWNERSHIP (contract §5):
--   supplier_favorite_memberships  → written by seller-automation (supplier facts ONLY)
--   saved_assets                   → written by XSelf Home (business state) + the narrow RPC
--   saved_asset_transitions        → append-only audit, written alongside every transition
--   xone_supplier_favorite_actions → XOne READ-only projection
--
-- STATE MACHINE: 9 approved states. There is deliberately NO direct REMOVABLE → REMOVED edge —
-- it is blocked by a CHECK constraint on the history table (see §3) because Founder acknowledgement
-- is not proof of supplier removal.

-- ── 1. Supplier fact layer ───────────────────────────────────────────────────
-- FACTS ONLY. No decisions, no business state, no task fields.

CREATE TABLE IF NOT EXISTS public.supplier_favorite_memberships (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  supplier_product_id   text        NOT NULL,
  supplier_account      text        NOT NULL,

  -- NULLABLE ON PURPOSE. NULL = unknown. A failed observation must NEVER be recorded as false.
  is_saved              boolean,

  sync_status           text        NOT NULL DEFAULT 'ok',
  sync_error_code       text,

  observed_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_saved_at    timestamptz,
  last_seen_removed_at  timestamptz,

  source_run_id         text        NOT NULL,

  version               integer     NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sfm_identity_uniq UNIQUE (supplier_product_id, supplier_account),

  CONSTRAINT sfm_account_chk CHECK (supplier_account IN ('pickup','dropship')),

  CONSTRAINT sfm_sync_status_chk CHECK (sync_status IN (
    'ok','auth_failed','captcha_required','network_failed','parse_failed','permission_denied','rate_limited','supplier_unavailable'
  )),

  -- THE FAIL-CLOSED INVARIANT, ENFORCED BY THE DATABASE:
  -- any non-ok sync MUST leave is_saved NULL. Removal can never be inferred from a failure.
  CONSTRAINT sfm_failure_implies_unknown_chk CHECK (sync_status = 'ok' OR is_saved IS NULL),

  CONSTRAINT sfm_version_chk CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS idx_sfm_account_saved
  ON public.supplier_favorite_memberships (supplier_account, is_saved);

CREATE INDEX IF NOT EXISTS idx_sfm_observed_at
  ON public.supplier_favorite_memberships (observed_at DESC);

COMMENT ON TABLE public.supplier_favorite_memberships IS
  'Supplier Favorite membership FACTS (one row per SKU x account). Written by seller-automation only. is_saved NULL = unknown; a failed sync must never record false.';

-- ── 2. Canonical Saved Asset business state ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.saved_assets (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  supplier_product_id       text        NOT NULL,
  supplier_account          text        NOT NULL,

  asset_state               text        NOT NULL DEFAULT 'SAVED_CANDIDATE',
  state_reason_code         text,
  state_reason_text         text,
  previous_state            text,

  entered_state_at          timestamptz NOT NULL DEFAULT now(),
  review_due_at             timestamptz,

  -- Founder authorization to become REMOVABLE (state machine §4).
  approved_by               uuid REFERENCES public.admin_users(id),
  approved_at               timestamptz,

  -- Founder acknowledgement of the MANUAL removal. Intent record — NOT proof of removal.
  founder_status            text        NOT NULL DEFAULT 'pending',
  founder_marked_done_at    timestamptz,
  founder_actor_id          uuid REFERENCES public.admin_users(id),

  -- Verification outcome, derived by XSelf Home from supplier facts.
  verification_status       text        NOT NULL DEFAULT 'not_started',
  verification_attempts     integer     NOT NULL DEFAULT 0,
  last_verification_at      timestamptz,
  last_verification_failure_reason text,

  last_saved_verified_at    timestamptz,
  removed_at                timestamptz,

  -- Idempotency + provenance for the narrow Founder action.
  last_idempotency_key      text,
  source_event_id           text,

  version                   integer     NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  -- One asset per slot. Makes duplicate tasks structurally impossible, and guarantees that
  -- one account's row can never be confused with (or mutated by) the sibling account's row.
  CONSTRAINT sa_identity_uniq UNIQUE (supplier_product_id, supplier_account),

  CONSTRAINT sa_account_chk CHECK (supplier_account IN ('pickup','dropship')),

  -- The 9 approved states. CHECK (not ENUM) so the set can evolve in a plain migration.
  CONSTRAINT sa_state_chk CHECK (asset_state IN (
    'SAVED_CANDIDATE',
    'EVALUATING',
    'ACTIVE_ASSET',
    'HOLD',
    'REVIEW_REQUIRED',
    'RETIRE_CANDIDATE',
    'REMOVABLE',
    'AWAITING_REMOVAL_VERIFICATION',
    'REMOVED'
  )),

  CONSTRAINT sa_founder_status_chk CHECK (founder_status IN ('pending','marked_done','deferred')),

  CONSTRAINT sa_verification_status_chk CHECK (verification_status IN (
    'not_started','awaiting_verification','verified_removed','still_saved','blocked_by_auth','blocked_other'
  )),

  -- REMOVED is only legitimate with recorded verification evidence (contract §9, Rule 10).
  CONSTRAINT sa_removed_requires_evidence_chk CHECK (
    asset_state <> 'REMOVED'
    OR (removed_at IS NOT NULL AND last_saved_verified_at IS NOT NULL AND verification_status = 'verified_removed')
  ),

  -- HOLD always carries a reason and a review date (state machine invariant 10).
  CONSTRAINT sa_hold_requires_reason_chk CHECK (
    asset_state <> 'HOLD'
    OR (state_reason_code IS NOT NULL AND state_reason_text IS NOT NULL AND review_due_at IS NOT NULL)
  ),

  CONSTRAINT sa_counters_chk CHECK (verification_attempts >= 0),
  CONSTRAINT sa_version_chk CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS idx_sa_state ON public.saved_assets (asset_state);

-- The Operator Console queue: only the three action-relevant states.
CREATE INDEX IF NOT EXISTS idx_sa_action_queue
  ON public.saved_assets (asset_state, updated_at DESC)
  WHERE asset_state IN ('REMOVABLE','AWAITING_REMOVAL_VERIFICATION','REMOVED');

CREATE INDEX IF NOT EXISTS idx_sa_review_due
  ON public.saved_assets (review_due_at)
  WHERE review_due_at IS NOT NULL;

COMMENT ON TABLE public.saved_assets IS
  'Canonical Saved Asset business state (one row per SKU x account). XSelf Home is the sole state authority. XOne may reach only REMOVABLE -> AWAITING_REMOVAL_VERIFICATION via mark_saved_asset_manual_removal_done(). seller-automation may never write asset_state.';

-- ── 3. Append-only transition history ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.saved_asset_transitions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  saved_asset_id        uuid        NOT NULL REFERENCES public.saved_assets(id) ON DELETE RESTRICT,
  supplier_product_id   text        NOT NULL,
  supplier_account      text        NOT NULL,

  from_state            text        NOT NULL,
  to_state              text        NOT NULL,

  reason_code           text        NOT NULL,
  reason_text           text,

  actor_type            text        NOT NULL,
  actor_id              text,

  source_event_id       text,
  idempotency_key       text,

  evidence_at           timestamptz,
  transitioned_at       timestamptz NOT NULL DEFAULT now(),

  version_before        integer     NOT NULL,
  version_after         integer     NOT NULL,

  CONSTRAINT sat_from_chk CHECK (from_state IN (
    'SAVED_CANDIDATE','EVALUATING','ACTIVE_ASSET','HOLD','REVIEW_REQUIRED',
    'RETIRE_CANDIDATE','REMOVABLE','AWAITING_REMOVAL_VERIFICATION','REMOVED')),
  CONSTRAINT sat_to_chk CHECK (to_state IN (
    'SAVED_CANDIDATE','EVALUATING','ACTIVE_ASSET','HOLD','REVIEW_REQUIRED',
    'RETIRE_CANDIDATE','REMOVABLE','AWAITING_REMOVAL_VERIFICATION','REMOVED')),

  -- THE CORE SAFETY CONSTRAINT: the direct edge cannot be recorded, therefore it cannot happen
  -- through any code path that writes history. Founder acknowledgement is not proof of removal.
  CONSTRAINT sat_no_direct_removable_to_removed_chk CHECK (
    NOT (from_state = 'REMOVABLE' AND to_state = 'REMOVED')
  ),

  -- REMOVED may only ever be entered from AWAITING_REMOVAL_VERIFICATION.
  CONSTRAINT sat_removed_source_chk CHECK (
    to_state <> 'REMOVED' OR from_state = 'AWAITING_REMOVAL_VERIFICATION'
  ),

  -- AWAITING_REMOVAL_VERIFICATION may only ever be entered from REMOVABLE.
  CONSTRAINT sat_awaiting_source_chk CHECK (
    to_state <> 'AWAITING_REMOVAL_VERIFICATION' OR from_state = 'REMOVABLE'
  ),

  CONSTRAINT sat_actor_type_chk CHECK (actor_type IN ('xself_home','xone_operator','seller_automation','system')),

  -- Only XSelf Home may record a REMOVED transition; XOne may only record the acknowledgement.
  CONSTRAINT sat_removed_actor_chk CHECK (to_state <> 'REMOVED' OR actor_type = 'xself_home'),
  CONSTRAINT sat_ack_actor_chk CHECK (to_state <> 'AWAITING_REMOVAL_VERIFICATION' OR actor_type = 'xone_operator'),

  -- seller-automation may never author a state transition at all.
  CONSTRAINT sat_seller_automation_never_transitions_chk CHECK (actor_type <> 'seller_automation'),

  -- Replay protection: one transition per (asset, idempotency key).
  CONSTRAINT sat_idempotency_uniq UNIQUE (saved_asset_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_sat_asset ON public.saved_asset_transitions (saved_asset_id, transitioned_at DESC);
CREATE INDEX IF NOT EXISTS idx_sat_to_state ON public.saved_asset_transitions (to_state);

COMMENT ON TABLE public.saved_asset_transitions IS
  'Append-only Saved Asset transition history. Never updated, never deleted. CHECK constraints make the direct REMOVABLE->REMOVED edge unrecordable and forbid seller_automation from authoring transitions.';

-- ── 4. RLS: canonical tables are service-role only ───────────────────────────
-- RLS enabled with NO policies => only the service role (which bypasses RLS) can reach these.
-- XOne never receives credentials for them; it reads the view below via a trusted mediator.

ALTER TABLE public.supplier_favorite_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_assets                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_asset_transitions       ENABLE ROW LEVEL SECURITY;

-- ── 5. XOne read contract — display-safe projection ──────────────────────────
-- Exposes ONLY the three action-relevant states and ONLY display-safe columns.
-- No cost, no margin, no credentials, no raw payload, no supplier session data.

CREATE OR REPLACE VIEW public.xone_supplier_favorite_actions AS
SELECT
  sa.id                              AS saved_asset_id,
  sa.supplier_product_id,
  sa.supplier_account,
  sp.product_title,
  sp.primary_image,
  sa.asset_state,
  sa.state_reason_code               AS reason_code,
  sa.state_reason_text               AS reason_detail,
  sp.published                       AS app_published,
  sp.inventory_status,
  sp.total_available_qty,
  sp.has_ca_pickup,
  sfm.observed_at                    AS evidence_at,
  sfm.is_saved                       AS supplier_is_saved,
  sfm.sync_status                    AS supplier_sync_status,
  sa.review_due_at,
  sa.founder_status,
  sa.founder_marked_done_at          AS founder_marked_at,
  sa.verification_status,
  sa.verification_attempts,
  sa.last_verification_at,
  sa.last_verification_failure_reason,
  sa.removed_at,
  sa.updated_at,
  sa.version
FROM public.saved_assets sa
LEFT JOIN public.standardized_products sp
  ON sp.supplier_product_id = sa.supplier_product_id
LEFT JOIN public.supplier_favorite_memberships sfm
  ON sfm.supplier_product_id = sa.supplier_product_id
 AND sfm.supplier_account    = sa.supplier_account
WHERE sa.asset_state IN ('REMOVABLE','AWAITING_REMOVAL_VERIFICATION','REMOVED');

COMMENT ON VIEW public.xone_supplier_favorite_actions IS
  'Display-safe XOne projection. Only REMOVABLE / AWAITING_REMOVAL_VERIFICATION / REMOVED. No cost, margin, credential, session or raw-payload fields.';

-- ── 6. Narrow Founder action ─────────────────────────────────────────────────
-- The ONLY business write XOne may perform. Exactly one transition:
--     REMOVABLE -> AWAITING_REMOVAL_VERIFICATION
-- It cannot set REMOVED, cannot set REMOVABLE, cannot touch supplier facts, publication,
-- inventory, or a sibling account's row (it is addressed by a single saved_asset_id).

CREATE OR REPLACE FUNCTION public.mark_saved_asset_manual_removal_done(
  p_saved_asset_id  uuid,
  p_expected_version integer,
  p_idempotency_key  text,
  p_actor_id         uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row      public.saved_assets%ROWTYPE;
  v_new_ver  integer;
BEGIN
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'idempotency_key_required');
  END IF;

  SELECT * INTO v_row FROM public.saved_assets WHERE id = p_saved_asset_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  -- Idempotent replay: the same key on an already-acknowledged row is a success no-op.
  IF v_row.last_idempotency_key IS NOT DISTINCT FROM p_idempotency_key
     AND v_row.asset_state = 'AWAITING_REMOVAL_VERIFICATION' THEN
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'saved_asset_id', v_row.id, 'asset_state', v_row.asset_state, 'version', v_row.version
    );
  END IF;

  -- Only this one transition is permitted. Anything else (including REMOVED) is refused.
  IF v_row.asset_state <> 'REMOVABLE' THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'state_mismatch',
      'expected_state', 'REMOVABLE', 'actual_state', v_row.asset_state, 'version', v_row.version
    );
  END IF;

  IF v_row.version <> p_expected_version THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'version_conflict',
      'expected_version', p_expected_version, 'actual_version', v_row.version
    );
  END IF;

  v_new_ver := v_row.version + 1;

  UPDATE public.saved_assets SET
    asset_state            = 'AWAITING_REMOVAL_VERIFICATION',
    previous_state         = 'REMOVABLE',
    entered_state_at       = now(),
    founder_status         = 'marked_done',
    founder_marked_done_at = now(),
    founder_actor_id       = COALESCE(p_actor_id, founder_actor_id),
    verification_status    = 'awaiting_verification',
    last_idempotency_key   = p_idempotency_key,
    version                = v_new_ver,
    updated_at             = now()
  WHERE id = p_saved_asset_id
    AND version = p_expected_version;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'version_conflict_on_write');
  END IF;

  INSERT INTO public.saved_asset_transitions (
    saved_asset_id, supplier_product_id, supplier_account,
    from_state, to_state, reason_code, reason_text,
    actor_type, actor_id, idempotency_key,
    version_before, version_after
  ) VALUES (
    v_row.id, v_row.supplier_product_id, v_row.supplier_account,
    'REMOVABLE', 'AWAITING_REMOVAL_VERIFICATION',
    'founder_marked_manual_removal_done',
    'Founder acknowledged manual removal at the supplier. NOT yet verified.',
    'xone_operator', COALESCE(p_actor_id::text, 'unknown'), p_idempotency_key,
    v_row.version, v_new_ver
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'saved_asset_id', v_row.id,
    'asset_state', 'AWAITING_REMOVAL_VERIFICATION',
    'founder_status', 'marked_done',
    'verification_status', 'awaiting_verification',
    'version', v_new_ver
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mark_saved_asset_manual_removal_done(uuid, integer, text, uuid) FROM PUBLIC;

COMMENT ON FUNCTION public.mark_saved_asset_manual_removal_done(uuid, integer, text, uuid) IS
  'The ONLY business write available to the Operator Console. Performs exactly REMOVABLE -> AWAITING_REMOVAL_VERIFICATION with version checking, idempotent replay, and one appended transition row. Cannot set REMOVED or REMOVABLE, cannot touch publication, inventory, or supplier facts.';

-- ── 7. Explicitly NOT done here ──────────────────────────────────────────────
--   * No ALTER on any existing table.
--   * No trigger anywhere (especially not on standardized_products.published or inventory_cache).
--   * No backfill, no seed rows, no automatic state generation.
--   * No scheduler, no cron.
--   * No add/remove Saved Items capability.
--   * No write path to standardized_products / supplier_products / inventory_cache.
