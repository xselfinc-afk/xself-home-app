#!/bin/bash
# Local GIGA inventory sync — runs the Playwright scraper against your saved
# session, then runs a freshness verifier. Designed to be invoked by launchd
# (~/Library/LaunchAgents/com.xselfhome.giga-inventory-sync.plist) but is also
# safe to run from a terminal.
#
# Manual run:
#   ./scripts/runGigaInventorySync.sh
#
# Exits non-zero if the scraper fails OR the verifier reports stale data,
# so launchd's StandardErrorPath captures actionable failures.

set -u
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LOG_DIR="$REPO_ROOT/logs"
mkdir -p "$LOG_DIR"

# launchd starts with a minimal PATH; make sure node / npx are findable.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

# Prefer nvm-managed Node when available — the project standardizes on
# Node 22 via nvm. Sourcing nvm prepends its active version to PATH so it
# wins over a (possibly broken) Homebrew Node install.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
fi

# Resolve the exact node + tsx binaries we will use for BOTH the sync and the
# verification step. Invoking tsx via `"$NODE_BIN" "$TSX_BIN"` bypasses tsx's
# `#!/usr/bin/env node` shebang, so verify cannot accidentally fall back to a
# different (potentially broken) Node install at startup. Respect an external
# $NODE_BIN override if the caller already chose one.
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "FATAL: node executable not found (NODE_BIN=$NODE_BIN). Install Node via nvm or Homebrew."
  exit 1
fi
if [ ! -x "$TSX_BIN" ]; then
  echo "FATAL: tsx binary not found at $TSX_BIN — run npm install."
  exit 1
fi

# Load Supabase credentials. `.env.local` is the canonical place for the
# service-role key; fall back to `.env` if the user has merged them.
if [ -f "$REPO_ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env.local"
  set +a
elif [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

TS_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "════════════════════════════════════════════════════════════"
echo "[$TS_START] GIGA inventory sync — start"
echo "  REPO_ROOT  : $REPO_ROOT"
echo "  PATH       : $PATH"
echo "  Node bin   : $NODE_BIN ($("$NODE_BIN" --version 2>/dev/null))"
echo "  tsx bin    : $TSX_BIN"
echo "  SESSION    : $REPO_ROOT/scripts/.giga-session.json"
echo "════════════════════════════════════════════════════════════"

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local"
  exit 1
fi

if [ ! -f "$REPO_ROOT/scripts/.giga-session.json" ]; then
  echo "FATAL: scripts/.giga-session.json missing — run npx tsx scripts/saveGigaSession.ts first."
  exit 1
fi

# ── Auto-healing orchestration ─────────────────────────────────────────────────
# Tee child output through tmpfiles so we can pattern-match "Session expired"
# after each step without losing it from launchd's StandardOutPath capture.
ALERT_LOG="$HOME/Library/Logs/xself-giga-inventory-sync.alert.log"
STATUS="OK"                 # OK | AUTO_RECOVERED | ACTION_REQUIRED
STATUS_REASON=""
AUTO_REFRESH_ATTEMPTED=0
AUTO_REFRESH_OK=0

run_sync_once() {
  local out_tmp="$1"
  PAGE_DELAY_MS="${PAGE_DELAY_MS:-1500}" \
  INVENTORY_LIMIT="${INVENTORY_LIMIT:-}" \
  INVENTORY_BATCH_SIZE="${INVENTORY_BATCH_SIZE:-}" \
  INVENTORY_FULL_SYNC="${INVENTORY_FULL_SYNC:-0}" \
  DRY_RUN="${DRY_RUN:-0}" \
    "$NODE_BIN" "$TSX_BIN" "$REPO_ROOT/scripts/syncGigaFurnitureInventory.ts" 2>&1 | tee "$out_tmp"
  return ${PIPESTATUS[0]}
}

session_expired_in() {
  grep -q -E "Session expired|FAILED: GIGA session expired" "$1"
}

# ── Attempt 1 ──────────────────────────────────────────────────────────────────
SYNC_TMP="$(mktemp -t giga-sync.XXXXXX)"
SYNC_EXIT=0
run_sync_once "$SYNC_TMP" || SYNC_EXIT=$?

# ── Auto-heal once if session expired ──────────────────────────────────────────
# Safety: at most one auto-refresh per run, at most one re-sync after it.
if [ "$SYNC_EXIT" -ne 0 ] && session_expired_in "$SYNC_TMP"; then
  echo
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Session expired — attempting auto-refresh (one shot)"
  AUTO_REFRESH_ATTEMPTED=1
  REFRESH_EXIT=0
  "$NODE_BIN" "$TSX_BIN" "$REPO_ROOT/scripts/autoRefreshGigaSession.ts" || REFRESH_EXIT=$?

  if [ "$REFRESH_EXIT" -eq 0 ]; then
    AUTO_REFRESH_OK=1
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Auto-refresh succeeded — re-running sync once"
    rm -f "$SYNC_TMP"
    SYNC_TMP="$(mktemp -t giga-sync.XXXXXX)"
    SYNC_EXIT=0
    run_sync_once "$SYNC_TMP" || SYNC_EXIT=$?

    if [ "$SYNC_EXIT" -ne 0 ] && session_expired_in "$SYNC_TMP"; then
      STATUS="ACTION_REQUIRED"
      STATUS_REASON="Sync still reports session_expired after auto-refresh — login/captcha required."
    else
      STATUS="AUTO_RECOVERED"
      STATUS_REASON="Session was auto-refreshed and the rerun sync completed."
    fi
  else
    STATUS="ACTION_REQUIRED"
    STATUS_REASON="Auto-refresh failed (exit=$REFRESH_EXIT) — login or captcha required."
  fi
fi

# Banner when human action is needed.
if [ "$STATUS" = "ACTION_REQUIRED" ]; then
  cat <<BANNER

════════════════ ACTION REQUIRED ════════════════
 ${STATUS_REASON}
 Run this from a terminal on this Mac:

   npm run giga:refresh-session

═════════════════════════════════════════════════
BANNER
fi
rm -f "$SYNC_TMP"

# ── Verification (always runs) ─────────────────────────────────────────────────
echo
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Sync exit=$SYNC_EXIT — running verification"
VERIFY_EXIT=0
"$NODE_BIN" "$TSX_BIN" "$REPO_ROOT/scripts/verifyInventoryFreshness.ts" || VERIFY_EXIT=$?

# If still OK after verify but verify or sync flagged problems, escalate.
if [ "$STATUS" = "OK" ] && { [ "$SYNC_EXIT" -ne 0 ] || [ "$VERIFY_EXIT" -ne 0 ]; }; then
  STATUS="ACTION_REQUIRED"
  STATUS_REASON="Sync exit=$SYNC_EXIT verify=$VERIFY_EXIT — non-session failure. Check log."
fi

# ── Final summary ──────────────────────────────────────────────────────────────
TS_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
echo "════════════════════════════════════════════════════════════"
echo "[$TS_END] GIGA inventory sync — done"
echo "  sync=$SYNC_EXIT verify=$VERIFY_EXIT"
echo "  auto_refresh_attempted=$AUTO_REFRESH_ATTEMPTED auto_refresh_ok=$AUTO_REFRESH_OK"
echo "  STATUS=$STATUS"
[ -n "$STATUS_REASON" ] && echo "  reason: $STATUS_REASON"
echo "════════════════════════════════════════════════════════════"

# ── Alert log on ACTION_REQUIRED ──────────────────────────────────────────────
if [ "$STATUS" = "ACTION_REQUIRED" ]; then
  mkdir -p "$(dirname "$ALERT_LOG")"
  printf '%s\tACTION_REQUIRED\tsync=%d\tverify=%d\tauto_refresh=%d/%d\treason="%s"\n' \
    "$TS_END" "$SYNC_EXIT" "$VERIFY_EXIT" "$AUTO_REFRESH_ATTEMPTED" "$AUTO_REFRESH_OK" "$STATUS_REASON" \
    >> "$ALERT_LOG"
  exit 1
fi

# OK or AUTO_RECOVERED both exit 0 — the run is healthy.
exit 0
