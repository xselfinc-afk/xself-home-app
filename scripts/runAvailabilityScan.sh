#!/bin/bash
# Scheduled runner for the API-ONLY availability scan.
#
# Invoked by launchd every 48 hours. Loads credentials from the existing env files, runs the scan in
# DRY-RUN mode, and exits. It NEVER launches a browser: no Chrome, Chromium, Playwright, puppeteer,
# or browser session file is referenced anywhere in this path.
#
# Credentials are loaded via dotenv into the child process only and are never echoed.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || { echo "FATAL cannot cd to repo"; exit 1; }

LOG_DIR="$REPO/logs"
mkdir -p "$LOG_DIR"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "[$STAMP] availability-scan starting (dry-run, API-only, no browser)"

# The alt account is the only one that can read the Open API product endpoints; .env.local supplies
# the Supabase service-role key. dotenv never overrides already-set vars, so alt must come first.
if [ ! -f "$REPO/.env.giga-alt.local" ]; then
  echo "[$STAMP] FATAL .env.giga-alt.local missing — cannot authenticate to the Open API"
  exit 1
fi
if [ ! -f "$REPO/.env.local" ]; then
  echo "[$STAMP] FATAL .env.local missing — no Supabase service-role key"
  exit 1
fi

NODE_PATH="$REPO/node_modules" npx dotenv -e .env.giga-alt.local -e .env.local -- \
  npx tsx scripts/scanPublishedAvailability.ts 2>&1 | grep -v '^\[GIGA\]'

code=${PIPESTATUS[0]}
case "$code" in
  0) echo "[$STAMP] availability-scan completed ok" ;;
  2) echo "[$STAMP] availability-scan ABORTED — failure rate exceeded; nothing applied" ;;
  3) echo "[$STAMP] availability-scan blocked by safety gates; nothing applied" ;;
  4) echo "[$STAMP] availability-scan skipped — another run holds the lock" ;;
  *) echo "[$STAMP] availability-scan failed with exit $code" ;;
esac
exit "$code"
