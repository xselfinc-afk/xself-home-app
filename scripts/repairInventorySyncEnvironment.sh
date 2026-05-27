#!/bin/bash
# Self-healing repair tool for the GIGA Playwright inventory sync.
#
# Recovers from Playwright/Chromium environment failures by:
#   1. Killing stale Playwright-managed chrome-headless-shell processes.
#      Matched ONLY by "ms-playwright" in the command line — the user's real
#      Google Chrome lives in /Applications and never matches this pattern.
#   2. Stripping the macOS quarantine xattr off ~/Library/Caches/ms-playwright.
#      Gatekeeper will refuse to launch a headless binary that was synced
#      from iCloud / Time Machine / a tar archive and inherited the flag.
#   3. Reinstalling the Chromium build the pinned Playwright version expects
#      (`npx playwright install --force chromium`).
#   4. Running a tiny launch+close smoke test to confirm Chromium actually
#      boots before we report PASS.
#
# Exit 0 = PASS (chromium launched and closed). Exit 1 = FAIL.
# Manual run:  npm run inventory:repair-env

set -u
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# launchd starts with a minimal PATH — mirror the sync script.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
NPX_BIN="${NPX_BIN:-$(command -v npx || true)}"
PW_CACHE="$HOME/Library/Caches/ms-playwright"

TS() { date -u +%Y-%m-%dT%H:%M:%SZ; }

echo "════════════════════════════════════════════════════════════"
echo "[$(TS)] GIGA inventory sync — environment repair"
echo "  REPO_ROOT : $REPO_ROOT"
echo "  Node bin  : $NODE_BIN"
echo "  npx bin   : $NPX_BIN"
echo "  PW cache  : $PW_CACHE"
echo "════════════════════════════════════════════════════════════"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "REPAIR=FAIL  reason: node not found on PATH"
  exit 1
fi
if [ -z "$NPX_BIN" ] || [ ! -x "$NPX_BIN" ]; then
  echo "REPAIR=FAIL  reason: npx not found on PATH"
  exit 1
fi

# ── 1. Kill stale Playwright-managed Chromium processes ────────────────────────
# pgrep -f matches the full command line. "ms-playwright" only appears in the
# argv of binaries living under ~/Library/Caches/ms-playwright — so the user's
# regular Chrome.app is never touched.
echo
echo "[$(TS)] Step 1/4 — killing stale Playwright-managed Chromium processes"
STALE_PIDS="$(pgrep -f ms-playwright 2>/dev/null || true)"
if [ -n "$STALE_PIDS" ]; then
  for pid in $STALE_PIDS; do
    CMD="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$CMD" in
      *ms-playwright*)
        echo "  killing pid=$pid"
        kill "$pid" 2>/dev/null || true
        ;;
    esac
  done
  sleep 2
  # Force-kill anything still alive after a SIGTERM.
  STILL="$(pgrep -f ms-playwright 2>/dev/null || true)"
  if [ -n "$STILL" ]; then
    for pid in $STILL; do
      CMD="$(ps -o command= -p "$pid" 2>/dev/null || true)"
      case "$CMD" in
        *ms-playwright*)
          echo "  force-killing pid=$pid"
          kill -9 "$pid" 2>/dev/null || true
          ;;
      esac
    done
  fi
else
  echo "  no stale Playwright processes."
fi

# ── 2. Strip macOS quarantine off the Playwright cache ─────────────────────────
echo
echo "[$(TS)] Step 2/4 — stripping com.apple.quarantine off $PW_CACHE"
if [ -d "$PW_CACHE" ]; then
  xattr -dr com.apple.quarantine "$PW_CACHE" 2>/dev/null || true
  echo "  done."
else
  echo "  cache directory absent — will be created by playwright install."
fi

# ── 3. Reinstall Chromium for the pinned Playwright version ────────────────────
echo
echo "[$(TS)] Step 3/4 — reinstalling Playwright Chromium (force)"
INSTALL_EXIT=0
"$NPX_BIN" playwright install --force chromium || INSTALL_EXIT=$?
if [ "$INSTALL_EXIT" -ne 0 ]; then
  echo
  echo "REPAIR=FAIL  reason: 'npx playwright install --force chromium' exit=$INSTALL_EXIT"
  exit 1
fi
# Strip quarantine again — freshly-extracted files often inherit it.
xattr -dr com.apple.quarantine "$PW_CACHE" 2>/dev/null || true

# ── 4. Smoke test: launch + close Chromium ─────────────────────────────────────
# IMPORTANT: Node's `require()` resolves relative to the script's own location,
# not the process CWD. Earlier versions of this repair script wrote the smoke
# file under /tmp, which caused `require('playwright')` to fail with
# "Cannot find module 'playwright'" because /tmp has no node_modules tree.
# We now write the smoke file INSIDE the repo and ALSO set NODE_PATH so the
# resolver finds the project's node_modules regardless of where Node walks.
echo
echo "[$(TS)] Step 4/4 — Chromium launch smoke test"
SMOKE_SCRIPT="$REPO_ROOT/.pw-smoke.cjs"
cat > "$SMOKE_SCRIPT" <<EOF
const { chromium } = require('$REPO_ROOT/node_modules/playwright');
const hardTimeout = setTimeout(() => {
  console.error('SMOKE_FAIL: launch+close exceeded 90s');
  process.exit(1);
}, 90_000);
(async () => {
  const browser = await chromium.launch({ headless: true, timeout: 60_000 });
  const ver = browser.version();
  await browser.close();
  clearTimeout(hardTimeout);
  console.log('SMOKE_OK chromium=' + ver);
})().catch((err) => {
  clearTimeout(hardTimeout);
  const msg = err && err.message ? err.message : String(err);
  console.error('SMOKE_FAIL: ' + msg);
  process.exit(1);
});
EOF

SMOKE_EXIT=0
( cd "$REPO_ROOT" && NODE_PATH="$REPO_ROOT/node_modules" "$NODE_BIN" "$SMOKE_SCRIPT" ) || SMOKE_EXIT=$?
rm -f "$SMOKE_SCRIPT"

# Persist the latest repair result so inventoryHealthReport.sh can surface it
# without having to grep through the alert log.
REPAIR_STATE="$HOME/Library/Logs/xself-giga-inventory-sync.repair.state"
mkdir -p "$(dirname "$REPAIR_STATE")"

echo
if [ "$SMOKE_EXIT" -eq 0 ]; then
  printf '%s\tPASS\n' "$(TS)" > "$REPAIR_STATE"
  echo "REPAIR=PASS"
  exit 0
fi

printf '%s\tFAIL\tsmoke_exit=%d\n' "$(TS)" "$SMOKE_EXIT" > "$REPAIR_STATE"
echo "REPAIR=FAIL  reason: chromium smoke test exit=$SMOKE_EXIT"
exit 1
