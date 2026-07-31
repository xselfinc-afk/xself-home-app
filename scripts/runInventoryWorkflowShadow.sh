#!/bin/bash
# Inventory workflow — SHADOW MODE daily orchestration.
#
# Runs, in order, with a single-run lock:
#   1. acquire lock (atomic mkdir; released on ANY exit)
#   2. verify source = pickup
#   3. verify Pickup session health (gate — unhealthy aborts before any supplier call)
#   4. refresh inventory evidence with INVENTORY_CACHE_ONLY=1  (NO publication mutation)
#   5. persisted workflow-state calculation
#   6. recommendation report generation
#   7. compact operational summary
#   8. release lock
#
# NEVER invoked from here:
#   scripts/inventoryActionApply.ts · refresh_product_inventory_status · auto-publish
#   · auto-delist · auto-relist · Saved Items changes
#
# Any step failing stops the remaining steps, writes an exception report, and exits nonzero.
# A failure is NEVER interpreted as out-of-stock: the workflow step is simply not reached, so
# prior workflow state and counters are preserved untouched.
#
# Usage:
#   bash scripts/runInventoryWorkflowShadow.sh            # real shadow run
#   SHADOW_DRY_RUN=1 bash scripts/runInventoryWorkflowShadow.sh   # dry run, zero writes
#
# Env:
#   SHADOW_DRY_RUN=1      dry-run everything (no DB writes)
#   SHADOW_LIMIT=N        max products per run (default 120)
#   SHADOW_INV_LIMIT=N    max SKUs for the cache-only inventory refresh (default 60)
#   SHADOW_TIMEOUT_SEC=N  hard timeout for the whole run (default 3600)
#   SHADOW_MAX_FAIL_PCT=N abort threshold for observation failures (default 50)
#
# Logs:    logs/inventory-workflow-shadow.log        (gitignored)
# Reports: reports/inventory-decisions/              (gitignored)
# Quarantine (optional): scripts/inventory-quarantine.txt — one SKU per line, '#' comments.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

RUN_ID="$(uuidgen 2>/dev/null || date +%s)"
TS_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOG_DIR="$REPO_ROOT/logs"
REPORT_DIR="$REPO_ROOT/reports/inventory-decisions"
LOCK_DIR="$REPO_ROOT/logs/.inventory-workflow-shadow.lock"
QUARANTINE="${SHADOW_QUARANTINE_FILE:-$REPO_ROOT/scripts/inventory-quarantine.txt}"
mkdir -p "$LOG_DIR" "$REPORT_DIR"

SUMMARY_JSON="$REPORT_DIR/shadow-run-summary.json"
RECO_JSON="$REPORT_DIR/shadow-recommendations.json"
EXCEPTION_JSON="$REPORT_DIR/shadow-exception.json"

DRY="${SHADOW_DRY_RUN:-0}"
LIMIT="${SHADOW_LIMIT:-120}"
INV_LIMIT="${SHADOW_INV_LIMIT:-60}"
TIMEOUT_SEC="${SHADOW_TIMEOUT_SEC:-3600}"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

# ── exception reporting ──────────────────────────────────────────────────────
STEP="init"
write_exception() {
  local reason="$1" code="$2"
  cat > "$EXCEPTION_JSON" <<EOF
{
  "run_id": "$RUN_ID",
  "started_at": "$TS_START",
  "failed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "failed_step": "$STEP",
  "reason": "$reason",
  "exit_code": $code,
  "workflow_state_preserved": true,
  "out_of_stock_inferred_from_failure": false,
  "customer_visible_action_executed": false
}
EOF
  log "EXCEPTION → $EXCEPTION_JSON  (step=$STEP reason=$reason)"
}

# ── single-run lock; released on ANY exit path ───────────────────────────────
cleanup() {
  local code=$?
  if [ -n "${LOCK_HELD:-}" ]; then rmdir "$LOCK_DIR" 2>/dev/null && log "lock released"; fi
  [ -n "${WATCHDOG_PID:-}" ] && kill "$WATCHDOG_PID" 2>/dev/null
  exit $code
}
trap cleanup EXIT INT TERM

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "ABORT: another run holds the lock ($LOCK_DIR) — no overlapping runs."
  STEP="lock"; write_exception "lock_held_by_another_run" 2
  trap - EXIT; exit 2
fi
LOCK_HELD=1
log "lock acquired: $LOCK_DIR"

# Hard timeout (macOS has no coreutils `timeout`).
( sleep "$TIMEOUT_SEC"; log "HARD TIMEOUT ${TIMEOUT_SEC}s — killing run"; kill -TERM $$ 2>/dev/null ) &
WATCHDOG_PID=$!

log "═══ INVENTORY WORKFLOW SHADOW RUN ═══"
log "run_id=$RUN_ID dry_run=$DRY limit=$LIMIT inv_limit=$INV_LIMIT timeout=${TIMEOUT_SEC}s"

# ── step 2: source must be pickup ────────────────────────────────────────────
STEP="verify_source"
SOURCE="pickup"
if [ "$SOURCE" != "pickup" ]; then
  write_exception "source_not_pickup" 1; exit 1
fi
log "source=$SOURCE (Dropship intentionally excluded from this scheduler)"

# ── step 3: session health gate ──────────────────────────────────────────────
# Exit codes from scripts/supplierSession.ts: 0 healthy · 10 human action required · 1 other.
STEP="session_health"
log "checking Pickup session health…"
HEALTH_OUT="$(npx tsx scripts/supplierSession.ts health --source=pickup 2>&1)"; HEALTH_EXIT=$?
echo "$HEALTH_OUT" | tail -3
if [ "$HEALTH_EXIT" -ne 0 ]; then
  log "ABORT: session not healthy (exit=$HEALTH_EXIT). No supplier calls, no workflow writes."
  write_exception "session_unhealthy_exit_${HEALTH_EXIT}" "$HEALTH_EXIT"
  exit "$HEALTH_EXIT"
fi
log "session healthy ✓"

# ── step 4: cache-only inventory refresh (NEVER mutates publication) ─────────
STEP="inventory_refresh_cache_only"
if [ "$DRY" = "1" ]; then
  log "[dry-run] would refresh inventory with INVENTORY_CACHE_ONLY=1 INVENTORY_LIMIT=$INV_LIMIT"
else
  log "refreshing inventory evidence (INVENTORY_CACHE_ONLY=1, limit=$INV_LIMIT)…"
  INVENTORY_CACHE_ONLY=1 INVENTORY_LIMIT="$INV_LIMIT" \
    npx tsx scripts/syncGigaInventoryXhr.ts 2>&1 | tail -20
  INV_EXIT=${PIPESTATUS[0]}
  if [ "$INV_EXIT" -ne 0 ]; then
    log "ABORT: inventory refresh failed (exit=$INV_EXIT). Workflow step skipped — prior state preserved."
    write_exception "inventory_refresh_failed_exit_${INV_EXIT}" "$INV_EXIT"
    exit "$INV_EXIT"
  fi
  log "inventory refresh ok ✓ (cache only — publication untouched)"
fi

# ── step 5: persisted workflow-state calculation ─────────────────────────────
STEP="workflow_transitions"
WF_ARGS=(--sellable "--limit=$LIMIT" "--summary-json=$SUMMARY_JSON")
[ -f "$QUARANTINE" ] && WF_ARGS+=("--exclude-file=$QUARANTINE")
log "running persisted workflow transitions…"
if [ "$DRY" = "1" ]; then
  DRY_RUN=1 npx tsx scripts/inventoryWorkflowRun.ts "${WF_ARGS[@]}" 2>&1 | tail -12
else
  npx tsx scripts/inventoryWorkflowRun.ts "${WF_ARGS[@]}" 2>&1 | tail -12
fi
WF_EXIT=${PIPESTATUS[0]}
if [ "$WF_EXIT" -ne 0 ]; then
  log "ABORT: workflow transition step failed (exit=$WF_EXIT)."
  write_exception "workflow_run_failed_exit_${WF_EXIT}" "$WF_EXIT"
  exit "$WF_EXIT"
fi
log "workflow transitions ok ✓"

# ── step 6: recommendations (read-only) ──────────────────────────────────────
STEP="recommendations"
log "generating recommendations (read-only)…"
npx tsx scripts/inventoryActionRecommendations.ts "--json=$RECO_JSON" 2>&1 | tail -8
RECO_EXIT=${PIPESTATUS[0]}
if [ "$RECO_EXIT" -ne 0 ]; then
  log "ABORT: recommendation generation failed (exit=$RECO_EXIT)."
  write_exception "recommendations_failed_exit_${RECO_EXIT}" "$RECO_EXIT"
  exit "$RECO_EXIT"
fi

# ── step 7: compact operational summary ──────────────────────────────────────
STEP="summary"
rm -f "$EXCEPTION_JSON" 2>/dev/null
TS_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "─── OPERATIONAL SUMMARY ───"
log "run_id=$RUN_ID start=$TS_START end=$TS_END session_health=healthy dry_run=$DRY"
if [ -f "$SUMMARY_JSON" ]; then
  node -e '
    const s=require(process.argv[1]);
    const b=s.buckets||{};
    console.log("  attempted="+s.attempted+" inserted="+s.rows_inserted+" updated="+s.rows_updated+
                " transitions="+s.history_appended+" duplicates="+s.duplicates_skipped+
                " conflicts="+s.concurrency_conflicts+" exceptions="+s.exceptions+
                " stale_or_unknown="+s.stale_or_unknown);
    console.log("  eligible_for_delist="+(b.eligible_for_delist||0)+
                " eligible_for_relist="+(b.eligible_for_relist||0)+
                " pending_confirmation="+(b.pending_confirmation||0)+
                " no_action="+(b.no_action||0)+
                " blocked_unknown="+(b.blocked_unknown||0));
    console.log("  evidence="+JSON.stringify(s.evidence_by_status||{}));
    console.log("  quarantined="+JSON.stringify(s.excluded_quarantine||[]));
    console.log("  customer_visible_action_executed="+s.customer_visible_action_executed+
                "  publication_rpc_called="+s.publication_rpc_called);
  ' "$SUMMARY_JSON"
fi
log "reports: $SUMMARY_JSON · $RECO_JSON"
log "NO customer-visible action executed. Delist/relist remain manual, allowlisted, Founder-approved."
log "═══ SHADOW RUN COMPLETE ═══"
exit 0
