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
if ! command -v npx >/dev/null 2>&1; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
  fi
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
echo "  Node       : $(command -v node || echo 'not found')"
echo "  npx        : $(command -v npx || echo 'not found')"
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

SYNC_EXIT=0
PAGE_DELAY_MS="${PAGE_DELAY_MS:-1500}" \
INVENTORY_LIMIT="${INVENTORY_LIMIT:-}" \
DRY_RUN="${DRY_RUN:-0}" \
  npx tsx "$REPO_ROOT/scripts/syncGigaFurnitureInventory.ts" || SYNC_EXIT=$?

echo
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Sync exit=$SYNC_EXIT — running verification"

VERIFY_EXIT=0
npx tsx "$REPO_ROOT/scripts/verifyInventoryFreshness.ts" || VERIFY_EXIT=$?

TS_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
echo "════════════════════════════════════════════════════════════"
echo "[$TS_END] GIGA inventory sync — done   sync=$SYNC_EXIT verify=$VERIFY_EXIT"
echo "════════════════════════════════════════════════════════════"

if [ "$SYNC_EXIT" -ne 0 ] || [ "$VERIFY_EXIT" -ne 0 ]; then
  exit 1
fi
exit 0
