# Saved-to-Live Automation — Checkpoint / Runbook (2026-06-23)

Checkpoint of the completed GIGA saved-to-live automation hardening. This is the operator
reference for running the workflow going forward and interpreting its output. See also
`docs/SAVED_TO_LIVE_AUTOMATION.md` (full behavior) and `docs/DELIVERY_FEE_REFRESH.md` (fees).

## 1. Commit chain (this work)
On branch `fix/quoted-price-buynow-checkout`:
- `1e72bccc` — persistent dropship delivery creds (`.env.giga-delivery.local`) + APPLY partial-success detection / actual-live collection / soft-fail fee refresh / richer reporting.
- `8f77a508` — import-scope fix (import only `would_import` SKUs; skip when none) + exclude `missing_inventory` from publish scope.
- `10e1d425` — empty-publish-batch **soft-skip** (when the planner holds every candidate) + planner hold reasons merged into the report.

(Earlier in the chain: `c62d7579` hybrid fee refresh, `fd6798bd` wired as the fixed fee updater, `6bfd32ab` the original saved-to-live orchestrator.)

## 2. Final normal operator flow
```bash
cd /Users/heliu/xself-home-app
npm run giga:saved-to-live:plan      # read-only report: what would import / publish / need fees
npm run giga:saved-to-live:apply     # gated: import new → publish eligible → fee-refresh live (soft-fail) → report
```
Manual-triggered only. No scheduler/launchd/cron/GitHub Action is installed for this command.

## 3. Credential files (never commit or print secrets)
| file | account | used for |
|---|---|---|
| `.env.giga-alt.local` | **pickup / saved-list** (`SUPPLIER_CLIENT_*`) | reading the pickup saved list (`product/skus/v1`) |
| `.env.giga-delivery.local` | **dropship delivery-fee** (`SUPPLIER_DELIVERY_*`) | official `price/v1` delivery-fee refresh |
- `.env.giga-delivery.local` is **git-ignored** (the tracked placeholder is `.env.giga-delivery.local.example`).
- Both load automatically; a fresh terminal needs no re-exports. Loading never overrides an already-exported env var, and the two accounts are never mixed.
- Secrets are never committed or printed; the tools log only a masked client-id (e.g. `35db…`) or a missing-creds recovery hint.

## 4. Confirmed working behavior
- **Import skip:** when `would_import=0`, APPLY skips the import step (soft success `nothing_new_to_import`) instead of sending already-imported SKUs to the import script (which fatally rejects non-`ready_for_sync` `--only`).
- **Publish scope:** `missing_inventory` SKUs are excluded from the publish scope and pre-held (not sent to auto-publish).
- **Publish soft-skip:** when `planGigaAutoPublish` produces an **empty** `proposed_batch` (it held every candidate), APPLY soft-skips `publish_dry_run`/`publish_apply` (`nothing_publishable_after_planner_holds`) and exits normally instead of aborting on `runGigaAutoPublish`'s "no proposed_batch.skus" exit 1.
- **Held reporting:** the apply report lists each held SKU with a reason (planner bucket+reasons, or `missing_inventory`).
- **Partial-success:** a non-zero auto-publish exit that still produced live SKUs is treated as partial success — `published_in_scope` reflects the **actual** `sellable_products` membership (never 0 when live SKUs exist).
- **Delivery fee:** the hybrid refresh uses dropship **official `price/v1` first** when creds are loaded, then portal fallback; it runs only for actually-live SKUs and is **soft-fail** (never rolls back publish).
- **No detective work:** SKUs the official API can't price are reported as `needs_dropship_favorite_or_mapping_skus` with exact recovery commands, instead of a silent gap.
- **Checkout unchanged:** reads `giga_delivery_fee_cache` only; missing fee → delivery fails-closed, pickup still works.

## 5. Resolved production gap
The 9 SKUs that went live in an earlier partial run now have delivery-fee cache rows (official `price/v1`, verified `charged_fee_cents` present, exact match):
`W409P266778, W409P266780, W5767P505607, W2700P268307, W409P167477, W3137P270232, N759P433572B, W5221P421223, W999S00522`.
Delivery checkout is no longer fail-closed for these.

## 6. Current held SKUs and reasons
| SKU | bucket | reason |
|---|---|---|
| SJ000159AAN | HOLD_PHASE2 | `cfgmissing_fragmented` |
| N721S000044K-1 | HOLD_PHASE2 | `cfgmissing_fragmented` |
| N721S000064K | HOLD_PHASE2 | `cfgmissing_fragmented` |
| N711P410389B | HOLD_PHASE2 | `fragmented_cluster` |
| N711P345166B | HOLD_INVENTORY | `no_live_sibling_standalone, no_current_stock` |
| B062P331054 | (saved-to-live) | `missing_inventory / inventory_status=unknown qty=0` |

## 7. Meaning of the current result
- **No new SKU was published in the latest run — and that is expected.** The auto-publish planner held all candidates.
- It is **not** an import failure (import correctly skipped — nothing new).
- It is **not** a delivery-credential failure (creds loaded fine: `dropship delivery creds loaded (client-id 35db…)`).
- It is **not** a script crash (APPLY now exits normally and reports the holds).
- APPLY now finishes cleanly (`aborted=false`), reporting `import_skipped=nothing_new_to_import`, `publish_skipped=nothing_publishable_after_planner_holds`, and the held SKUs above.

## 8. Next real business work (separate from this automation)
- **Fragmented family/config holds (`HOLD_PHASE2`):** investigate and fix the variant-family / configuration issues for `SJ000159AAN, N721S000044K-1, N721S000064K, N711P410389B` so the planner can propose them.
- **No-stock hold (`HOLD_INVENTORY`):** wait for or refresh inventory for `N711P345166B` (and `B062P331054`) — they need current stock before they can go live.
- **Dropship favoriting:** ensure any new SKU is also favorited/accessible in the **dropship** account before expecting official `price/v1` to return its delivery fee (otherwise it falls to the portal path or is reported as `needs_dropship_favorite`).

## 9. Safety notes (carry forward)
- **Do not** build/automate a GIGA portal SKU→`product_id` resolver — the SPA search route is deliberately blocked.
- **Do not** loosen `scripts/lib/portalSafetyGuard.ts` (portal allowlist = `price/list` only).
- Keep the portal fallback **low-risk and mapping-based only** (existing `dropship_giga_product_id` / seed CSV).
- **Official dropship `price/v1` is the preferred delivery-fee source**; portal is fallback, behind dropship favoriting / manual seed mapping.
- Saved-to-live remains **uplist-only** — downlisting/hiding out-of-stock is owned by the inventory system + the `sellable_products` view, not this command.
