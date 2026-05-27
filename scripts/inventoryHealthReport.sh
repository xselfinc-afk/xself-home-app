#!/bin/bash
# inventoryHealthReport.sh — read-only diagnostics for the GIGA inventory sync.
#
# Reports the state of the things that have actually broken in production:
#   - Playwright npm package installed in repo node_modules?
#   - Playwright Chromium cache directory present?
#   - macOS quarantine flag on the Chromium cache?
#   - Last automated repair attempt result (from the repair script's state file)
#   - Last ACTION_REQUIRED alert (from the sync's alert log)
#
# Exit codes:
#   0 — every check OK
#   1 — at least one check looks broken; the report prints the exact fix command
#
# Manual run:
#   npm run inventory:health

set -u
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PW_PKG_DIR="$REPO_ROOT/node_modules/playwright"
PW_PKG_JSON="$PW_PKG_DIR/package.json"
PW_CACHE="$HOME/Library/Caches/ms-playwright"
ALERT_LOG="$HOME/Library/Logs/xself-giga-inventory-sync.alert.log"
REPAIR_STATE="$HOME/Library/Logs/xself-giga-inventory-sync.repair.state"

PROBLEMS=0
SUSPECT_BROKEN_PW=0

print_kv() { printf '  %-32s %s\n' "$1" "$2"; }

echo "════════════════════════════════════════════════════════════"
echo " GIGA inventory sync — health report"
echo " $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "════════════════════════════════════════════════════════════"

# ── Playwright package installed? ─────────────────────────────────────────────
if [ -f "$PW_PKG_JSON" ]; then
  PW_VERSION="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$PW_PKG_JSON" \
                | head -1 | grep -oE '"[0-9][^"]+"' | tr -d '"')"
  print_kv "Playwright package installed?" "yes (version ${PW_VERSION:-unknown})"
else
  print_kv "Playwright package installed?" "NO — node_modules/playwright missing"
  PROBLEMS=$((PROBLEMS + 1))
  SUSPECT_BROKEN_PW=1
fi

# ── Chromium cache exists? ────────────────────────────────────────────────────
if [ -d "$PW_CACHE" ]; then
  CHROMIUM_COUNT="$(find "$PW_CACHE" -maxdepth 1 -type d -name 'chromium-*' 2>/dev/null | wc -l | tr -d ' ')"
  HEADLESS_COUNT="$(find "$PW_CACHE" -maxdepth 1 -type d -name 'chromium_headless_shell-*' 2>/dev/null | wc -l | tr -d ' ')"
  print_kv "Chromium cache exists?" "yes ($PW_CACHE)"
  print_kv "  chromium-* builds"             "$CHROMIUM_COUNT"
  print_kv "  chromium_headless_shell-* builds" "$HEADLESS_COUNT"
  if [ "$CHROMIUM_COUNT" -eq 0 ] && [ "$HEADLESS_COUNT" -eq 0 ]; then
    print_kv "  status" "EMPTY — no Chromium builds present"
    PROBLEMS=$((PROBLEMS + 1))
    SUSPECT_BROKEN_PW=1
  fi
  # macOS quarantine flag check — Gatekeeper will refuse to launch a binary
  # that's tagged com.apple.quarantine.
  QUARANTINED="$(xattr -lr "$PW_CACHE" 2>/dev/null | grep -c 'com.apple.quarantine' || true)"
  if [ "${QUARANTINED:-0}" -gt 0 ]; then
    print_kv "  com.apple.quarantine present?" "YES ($QUARANTINED files)"
    PROBLEMS=$((PROBLEMS + 1))
    SUSPECT_BROKEN_PW=1
  else
    print_kv "  com.apple.quarantine present?" "no"
  fi
else
  print_kv "Chromium cache exists?" "NO — $PW_CACHE missing"
  PROBLEMS=$((PROBLEMS + 1))
  SUSPECT_BROKEN_PW=1
fi

# ── Last repair result ────────────────────────────────────────────────────────
if [ -f "$REPAIR_STATE" ]; then
  LAST_REPAIR="$(cat "$REPAIR_STATE" 2>/dev/null | head -1)"
  print_kv "Last repair attempt" "${LAST_REPAIR:-unknown}"
  if echo "$LAST_REPAIR" | grep -q FAIL; then
    PROBLEMS=$((PROBLEMS + 1))
    SUSPECT_BROKEN_PW=1
  fi
else
  print_kv "Last repair attempt" "none recorded ($REPAIR_STATE)"
fi

# ── Last ACTION_REQUIRED alert ────────────────────────────────────────────────
if [ -f "$ALERT_LOG" ]; then
  LAST_ALERT="$(tail -1 "$ALERT_LOG" 2>/dev/null)"
  if [ -n "$LAST_ALERT" ]; then
    print_kv "Last sync alert (tail -1)" "$LAST_ALERT"
  else
    print_kv "Last sync alert" "no alerts logged"
  fi
else
  print_kv "Sync alert log" "absent ($ALERT_LOG)"
fi

# ── Saved GIGA session ────────────────────────────────────────────────────────
if [ -f "$REPO_ROOT/scripts/.giga-session.json" ]; then
  print_kv "GIGA session file" "present"
else
  print_kv "GIGA session file" "MISSING — run npm run inventory:save-session"
  PROBLEMS=$((PROBLEMS + 1))
fi

echo "════════════════════════════════════════════════════════════"
if [ "$SUSPECT_BROKEN_PW" -ne 0 ]; then
  cat <<HINT
 SUSPECTED OLD/BROKEN PLAYWRIGHT PACKAGE OR CACHE.
 Run the automated repair:

     npm run inventory:repair-env

 Then verify Chromium launches end-to-end with:

     HEADED=1 INVENTORY_LIMIT=1 npm run inventory:sync:dry

HINT
fi

if [ "$PROBLEMS" -eq 0 ]; then
  echo " STATUS: ✓ healthy"
  exit 0
fi
echo " STATUS: ✗ $PROBLEMS check(s) flagged — see above"
exit 1
