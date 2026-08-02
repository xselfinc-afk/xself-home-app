#!/bin/bash
# Availability-scan scheduler — installs a launchd agent that runs the API-ONLY availability scan
# once every 48 hours (172800 seconds).
#
# NO BROWSER. The scan calls the credential-signed GIGA Open API only; it never launches Chrome,
# Chromium or Playwright and never reads a browser session file. Runs independently of XOne.
#
# The agent runs the COMPLETE lifecycle: live availability scan (evidence + workflow state), then
# delist/relist for SKUs the state machine already marked eligible, then a status report. The scan
# itself has no publication write path; publication changes go only through the guarded executor and
# remain gated by the inventory automation switches.
#
# Usage:
#   scripts/installAvailabilityScanScheduler.sh install     # write + load the agent
#   scripts/installAvailabilityScanScheduler.sh status      # is it loaded, when did it last run
#   scripts/installAvailabilityScanScheduler.sh run-now     # trigger one run immediately
#   scripts/installAvailabilityScanScheduler.sh disable     # unload, keep the plist
#   scripts/installAvailabilityScanScheduler.sh enable      # load again
#   scripts/installAvailabilityScanScheduler.sh uninstall   # unload + remove the plist
#   scripts/installAvailabilityScanScheduler.sh report      # print the latest redacted report

set -euo pipefail

LABEL="com.xselfhome.inventory-availability-scan"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$REPO/scripts/runAvailabilityScan.sh"
LOG_DIR="$REPO/logs"
REPORT="$REPO/reports/inventory-availability/latest-availability-scan.json"
INTERVAL=172800   # exactly 48 hours

cmd="${1:-status}"

write_plist() {
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${RUNNER}</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <!-- Every 48 hours. StartInterval is the established safe pattern in this repo: it survives
       sleep/wake and does not depend on the machine being awake at an exact calendar time. -->
  <key>StartInterval</key><integer>${INTERVAL}</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${LOG_DIR}/availability-scan.out.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/availability-scan.err.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLISTEOF
  chmod 600 "$PLIST"
}

case "$cmd" in
  install)
    write_plist
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    launchctl unload "$PLIST" 2>/dev/null || true
    # bootstrap is the modern API; load is kept as a fallback for older macOS.
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
    launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    echo "installed  label=${LABEL}"
    echo "interval   ${INTERVAL}s (48 hours)"
    echo "plist      ${PLIST}"
    echo "mode       FULL LIFECYCLE (live scan -> eligible delist/relist -> status)"
    echo "gates      publication changes still require inventory_auto_delist_enabled / inventory_auto_relist_enabled"
    ;;
  enable)
    [ -f "$PLIST" ] || { echo "not installed — run: $0 install"; exit 1; }
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null || true
    launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    echo "enabled ${LABEL}"
    ;;
  disable)
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    echo "disabled ${LABEL} (plist kept at ${PLIST})"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "uninstalled ${LABEL}"
    ;;
  run-now)
    [ -f "$PLIST" ] || { echo "not installed — run: $0 install"; exit 1; }
    launchctl start "${LABEL}"
    echo "triggered one run — watch ${LOG_DIR}/availability-scan.out.log"
    ;;
  report)
    [ -f "$REPORT" ] || { echo "no report yet at ${REPORT}"; exit 1; }
    /usr/bin/python3 -c "
import json,sys
r=json.load(open('${REPORT}'))
print('run_id      :', r['run_id'])
print('mode        :', r['mode'], ' browser_used:', r['browser_used'], ' db_writes:', r['database_rows_written'])
print('scanned     :', r['totals']['total'])
print('available   :', r['totals']['confirmedAvailable'])
print('out_of_stock:', r['totals']['confirmedOutOfStock'])
print('failures    :', r['totals']['failures'], '(%s%%)' % r['totals']['failurePercent'])
for k,v in r['counts'].items(): print('  %-26s %s' % (k, v))
for k,v in r['gates'].items(): print('  gate %-12s allowed=%s blocks=%s' % (k, v['allowed'], ','.join(v['blocks']) or 'none'))
"
    ;;
  status)
    if [ -f "$PLIST" ]; then echo "plist      present  ${PLIST}"; else echo "plist      ABSENT (not installed)"; fi
    if launchctl list 2>/dev/null | grep -q "${LABEL}"; then
      echo "loaded     yes  → $(launchctl list | grep "${LABEL}")"
    else
      echo "loaded     no"
    fi
    echo "interval   ${INTERVAL}s (48 hours)"
    if [ -f "$REPORT" ]; then
      echo "last run   $(/usr/bin/python3 -c "import json;print(json.load(open('${REPORT}'))['finished_at'])" 2>/dev/null || echo unknown)"
    else
      echo "last run   never"
    fi
    ;;
  *)
    echo "usage: $0 {install|enable|disable|uninstall|run-now|report|status}"; exit 1;;
esac
