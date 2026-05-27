# Xself Home — Production Runbook

Operational playbook for the incidents that have already broken Xself Home in
production. Each section lists symptoms, the automatic behavior built into the
system, and the manual command to run if the auto-repair did not resolve it.

---

## Inventory scraper — old Playwright / Chromium package repair

### Symptoms

The GIGA inventory sync surfaces one or more of these failure modes:

- `browserType.launch: Timeout 180000ms exceeded`
- `chrome-headless-shell` timeout
- `Execution context was destroyed`
- `Target page, browser or context has been closed`
- `Cannot find module 'playwright'`
- `chromium executable doesn't exist` / `chromium executable not found`
- `browser has been closed`
- `Failed to launch`

Downstream effect: `inventory_cache` stops receiving fresh rows, the
`plan-fulfillment` Edge Function flips to its stale-inventory fallback, and
Checkout shows the `"Live inventory unavailable"` banner.

### Automatic behavior (no human required)

`scripts/runGigaInventorySync.sh` watches sync output for the patterns above.
On detection it runs **one** environment repair (`bash
scripts/repairInventorySyncEnvironment.sh`) followed by **one** sync retry —
no infinite loops, no escalating retries.

Repair script behavior (`scripts/repairInventorySyncEnvironment.sh`):

1. Kills any stale `ms-playwright`-tagged Chromium processes (regular Chrome
   is never touched — the match is anchored to `ms-playwright`).
2. Strips `com.apple.quarantine` off `~/Library/Caches/ms-playwright`.
3. Runs `npx playwright install --force chromium`.
4. Strips quarantine again (freshly extracted files often inherit it).
5. Runs a launch+close smoke test that resolves `playwright` from
   `$REPO_ROOT/node_modules` (not `/tmp`, which used to fail with
   "Cannot find module 'playwright'").

Final sync status after the repair window:

| Status              | Meaning                                                       |
|---------------------|---------------------------------------------------------------|
| `OK`                | First sync attempt succeeded — no repair needed.              |
| `AUTO_RECOVERED`    | Session was auto-refreshed; rerun succeeded.                  |
| `AUTO_REPAIRED`     | Browser/environment failure was repaired; rerun succeeded.    |
| `ACTION_REQUIRED`   | Auto-repair did not resolve the issue; human action required. |

`ACTION_REQUIRED` rows are appended to
`~/Library/Logs/xself-giga-inventory-sync.alert.log`.

### Manual repair

When the automatic repair fails (or to pre-empt a flaky environment):

```bash
npm run inventory:repair-env
```

Returns exit 0 with `REPAIR=PASS` on success. The latest result is written to
`~/Library/Logs/xself-giga-inventory-sync.repair.state` and surfaced by the
health report below.

### Health report

```bash
npm run inventory:health
```

Reports:

- Playwright npm package installed in repo `node_modules`?
- Chromium cache directory present + build count?
- `com.apple.quarantine` xattr count on the cache?
- Last automated repair result (PASS/FAIL + timestamp).
- Last sync alert (tail of `xself-giga-inventory-sync.alert.log`).

If anything looks broken, the script prints the exact next command
(`npm run inventory:repair-env`) and exits non-zero.

### Verification after repair

```bash
HEADED=1 INVENTORY_LIMIT=1 npm run inventory:sync:dry
```

Confirms that:

- Chromium actually launches in a visible window.
- A single SKU resolves end-to-end without writing to the database.
- The `__name is not defined` and Aliyun captcha guards still work.

Once that prints a `SUCCESS` row for the product, the full sync is safe to
run:

```bash
npm run inventory:sync
npm run inventory:verify
```

`inventory:verify` must report `PASS` before checkout will stop showing the
fallback banner.
