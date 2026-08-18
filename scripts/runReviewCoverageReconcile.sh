#!/bin/bash
# launchd entry point for review-coverage reconciliation.
#
# Exists because launchd starts with an empty environment: the reconciler needs SUPABASE_URL and
# SUPABASE_SERVICE_ROLE_KEY, which live in .env.local and are never committed. Sourcing them here
# keeps the secret out of the plist, where it would otherwise sit in plaintext in LaunchAgents.
set -euo pipefail
cd /Users/heliu/xself-home-app
set -a; [ -f .env.local ] && . ./.env.local; set +a
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
echo "=== $(date '+%F %T') review coverage reconcile ==="
exec npx tsx scripts/reconcileReviewCoverage.ts
