#!/bin/bash
# Scheduled runner for the API-ONLY availability scan.
#
# Invoked by launchd every 48 hours. Loads credentials from the existing env files, runs the scan in
# DRY-RUN mode, and exits. It NEVER launches a browser: no Chrome, Chromium, Playwright, puppeteer,
# or browser session file is referenced anywhere in this path.
#
# Credentials are loaded via dotenv into the child process only and are never echoed.

set -uo pipefail

# launchd does not source an interactive shell, so the inherited PATH has no Node
# toolchain and every `npx` below fails with exit 127. Set PATH explicitly instead of
# depending on the login environment. Homebrew comes first because that is the runtime
# the headless callers already pin (XOne's bridge uses /opt/homebrew/bin/node).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || { echo "FATAL cannot cd to repo"; exit 1; }

LOG_DIR="$REPO/logs"
mkdir -p "$LOG_DIR"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "[$STAMP] availability-scan starting (API-only, no browser)"

# Fail loudly and immediately if the toolchain is missing. Without this the failure
# surfaces as a bare `npx: command not found` from inside a pipeline, the scan exits 127,
# availability evidence stops being refreshed, and products silently age out of
# sellable_products when the 72h grace window closes.
for BIN in node npx; do
  command -v "$BIN" >/dev/null 2>&1 || {
    echo "[$STAMP] FATAL $BIN not found on PATH=$PATH — availability scan cannot start"
    exit 1
  }
done
echo "[$STAMP] runtime node $(node --version) ($(command -v node)), npx $(command -v npx)"

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

# ── 0. Cadence guard ──────────────────────────────────────────────────────────────────────────
#
# launchd's StartInterval counts from load, and agents are reloaded on every boot. With
# RunAtLoad=false a Mac that reboots more often than 48h restarts the countdown before it ever
# fires, so the job sits loaded at `runs = 0` forever — which is exactly what it was doing.
#
# The fix is RunAtLoad=true, and this guard is what makes that safe: firing at each boot no
# longer means scanning at each boot. If the last FULL scan finished less than the interval ago
# we exit 0 without touching the supplier or the database.
#
# Set AVAILABILITY_SCAN_FORCE=1 to bypass (a human asking for a scan now).
MIN_INTERVAL_HOURS="${AVAILABILITY_SCAN_MIN_INTERVAL_HOURS:-48}"
if [ "${AVAILABILITY_SCAN_FORCE:-0}" != "1" ]; then
  SINCE=$(node -e "
    const fs=require('fs');
    try{
      const r=JSON.parse(fs.readFileSync('$REPO/reports/inventory-availability/latest-availability-scan.json','utf8'));
      if(r.is_full_scan!==true){process.stdout.write('');process.exit(0);}
      const at=Date.parse(r.finished_at||'');
      process.stdout.write(Number.isFinite(at)?String((Date.now()-at)/3600000):'');
    }catch{process.stdout.write('');}" 2>/dev/null)
  if [ -n "$SINCE" ] && [ "$(printf '%.0f' "$SINCE")" -lt "$MIN_INTERVAL_HOURS" ]; then
    echo "[$STAMP] availability-scan skipped — last full scan was ${SINCE}h ago (< ${MIN_INTERVAL_HOURS}h)"
    exit 0
  fi
fi

# ── 1. Availability scan (LIVE): refresh evidence + advance the workflow ──────────────────────
# --live persists evidence and lifecycle state. It CANNOT change publication: the scanner has no
# publication write path, asserted by availabilityPersistence.test.ts. Every write remains gated by
# inventory_automation_enabled + inventory_api_scan_enabled.
NODE_PATH="$REPO/node_modules" npx dotenv -e .env.giga-alt.local -e .env.local -- \
  npx tsx scripts/scanPublishedAvailability.ts --limit=400 --live 2>&1 | grep -v '^\[GIGA\]'

code=${PIPESTATUS[0]}

# ── 1b. Warehouse inventory refresh (LIVE): official quantity/v2 → inventory_cache ───────────
#
# The only periodic writer of inventory_cache. Before this stage existed, the only rows being
# refreshed came from verify-inventory-live — that is, from a customer happening to reach
# checkout. Measured the day it landed: 67 of 1629 rows younger than 24h, median age 663h.
#
# It costs two HTTP requests: quantity/v2 takes 200 SKUs per call and the catalogue is ~385
# published products; a full refresh runs in about seven seconds. There was never a cost reason
# for warehouse quantities to be rarer than this.
#
# It deliberately does NOT call refresh_product_inventory_status(): that function judges
# staleness on its own 24-hour rule and writes `published` directly, so calling it from a 48h
# job would unpublish the catalogue for the second half of every cycle. Publication stays with
# the availability-evidence path. Asserted by warehouseRefreshSafety.test.ts.
#
# A failure here must not abort the run: availability evidence and the lifecycle stages below
# do not depend on warehouse quantities, and losing all three to one supplier hiccup is worse
# than losing one.
echo "[$STAMP] warehouse refresh — official quantity/v2 → inventory_cache"
NODE_PATH="$REPO/node_modules" npx dotenv -e .env.giga-alt.local -e .env.local -- \
  npx tsx scripts/refreshWarehouseInventory.ts --apply 2>&1 | grep -v '^\[GIGA\]'
wh_code=${PIPESTATUS[0]}
case "$wh_code" in
  0) echo "[$STAMP] warehouse refresh ok" ;;
  2) echo "[$STAMP] warehouse refresh WARN — coverage below threshold" ;;
  3) echo "[$STAMP] warehouse refresh WARN — failure rate exceeded; nothing written" ;;
  *) echo "[$STAMP] warehouse refresh FAILED with exit $wh_code" ;;
esac

# ── 2. Report what became eligible — PROPOSALS ONLY, never applied here ──────────────────────
#
# This stage used to run the publication executor with a hardcoded
# `--approve --approved-by=scheduler`. That forged the executor's one human-intent gate: the
# 48h scheduler and the XOne "刷新库存证据" button both reach this script, so publication could
# change with no person in the loop — while the UI told the user "资格变更等待批准".
#
# Scanning stays fully automatic. Deciding does not. The scan may refresh evidence, advance the
# workflow state and raise proposals; turning a proposal into a published change now requires a
# human to run the executor explicitly with --approve --approved-by=<name> --only=<SKUs>.
#
# The count caps (maxDelistPerRun etc.) are unchanged and still apply on top of that approval —
# they are a second layer, not a substitute for it.
if [ "$code" -eq 0 ]; then
  for ACTION in delist relist; do
    STATE=$([ "$ACTION" = "delist" ] && echo eligible_for_delist || echo eligible_for_relist)
    SKUS=$(NODE_PATH="$REPO/node_modules" npx dotenv -e .env.local -- node -e "
      const {createClient}=require('@supabase/supabase-js');
      const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
      (async()=>{const r=await sb.from('inventory_workflow_states').select('supplier_product_id').eq('workflow_state','$STATE').limit(50);
      process.stdout.write((r.data||[]).map(x=>x.supplier_product_id).join(','));})();" 2>/dev/null)
    if [ -n "$SKUS" ]; then
      COUNT=$(echo "$SKUS" | tr ',' '\n' | wc -l | tr -d ' ')
      echo "[$STAMP] $ACTION proposals ($STATE): $COUNT — awaiting human approval, nothing applied"
    else
      echo "[$STAMP] no $STATE candidates this cycle"
    fi
  done

  # ── 3. Commerce taxonomy backstop ───────────────────────────────────────────────────────────
  # normalizeProducts.ts classifies each product in the same upsert that writes it, so this
  # normally finds nothing. It exists for rows written by another path (manual upload, direct
  # edit): an unclassified row is invisible in website browse, and nothing else would notice.
  # Incremental by default — a caught-up catalogue costs one select and writes nothing.
  # After a classifier change, re-run the whole catalogue explicitly with FULL=1.
  NODE_PATH="$REPO/node_modules" npx dotenv -e .env.local -- \
    npx tsx scripts/syncCommerceTaxonomy.ts 2>&1 | grep -vE '^\[GIGA\]'
  TAX_CODE=${PIPESTATUS[0]}
  [ "$TAX_CODE" -eq 0 ] || echo "[$STAMP] WARN commerce taxonomy sync exited $TAX_CODE — new products may be missing from website browse"

  # ── 4. Status + alerts ──────────────────────────────────────────────────────────────────────
  NODE_PATH="$REPO/node_modules" npx dotenv -e .env.local -- \
    npx tsx scripts/inventoryLifecycleStatus.ts 2>&1 | grep -vE '^\[GIGA\]'
fi

case "$code" in
  0) echo "[$STAMP] availability-scan completed ok" ;;
  2) echo "[$STAMP] availability-scan ABORTED — failure rate exceeded; nothing applied" ;;
  3) echo "[$STAMP] availability-scan blocked by safety gates; nothing applied" ;;
  4) echo "[$STAMP] availability-scan skipped — another run holds the lock" ;;
  *) echo "[$STAMP] availability-scan failed with exit $code" ;;
esac
exit "$code"
