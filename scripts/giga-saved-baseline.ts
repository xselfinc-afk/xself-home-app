/**
 * giga-saved-baseline.ts — Phase 1B: write/refresh the GIGA saved-items BASELINE (local file only).
 *
 * Captures the current "My Saved Items" list as the baseline that future delta runs compare against.
 * The baseline freezes the current state (incl. the 538 already-known SKUs) so that only items saved
 * AFTER this snapshot are later treated as newly_saved_skus. Historical backlog stays in the baseline
 * and is therefore excluded from the future automatic flow by construction.
 *
 * Writes ONLY: reports/giga-auto-publish/saved-items-baseline.json (local file).
 * Performs NO Supabase access, NO publishing, NO apply, NO image/blurhash/review/inventory work.
 *
 * Safety: refuses to overwrite an existing baseline unless --force. With --force, the prior baseline
 * is archived to saved-items-baseline.<previous_run_id>.json BEFORE the new one is written. The fetch
 * runs before any archive/overwrite, so a failed/empty fetch (helper throws) leaves the baseline intact.
 *
 * Usage:
 *   npm run giga:saved:baseline                 # first time, or fails if baseline exists
 *   npx tsx scripts/giga-saved-baseline.ts --force        # refresh (archives prior first)
 *   npx tsx scripts/giga-saved-baseline.ts [--max-pages=N] [--default-creds] [--summary]
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fetchAllSavedItems, GigaSavedItemsError } from './lib/gigaSavedItems';

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const FORCE_DEFAULT_CREDS = argv.includes('--default-creds') || process.env.GIGA_SAVED_USE_ALT_CREDS === '0';
const maxPagesArg = argv.find(a => a.startsWith('--max-pages='));
const MAX_PAGES = maxPagesArg ? Math.max(1, parseInt(maxPagesArg.split('=')[1], 10) || 0) : Infinity;

const REPORT_DIR = path.join(process.cwd(), 'reports', 'giga-auto-publish');
const BASELINE_FILE = path.join(REPORT_DIR, 'saved-items-baseline.json');
const rel = (p: string) => path.relative(process.cwd(), p);

function die(msg: string, extra?: Record<string, unknown>): never {
  console.error('GIGA_SAVED_BASELINE_ERROR');
  console.error(`error=${msg}`);
  if (extra) for (const [k, v] of Object.entries(extra)) console.error(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  process.exit(1);
}

(async () => {
  const RUN_ID = crypto.randomUUID();
  const TIMESTAMP = new Date().toISOString();

  const baselineExists = fs.existsSync(BASELINE_FILE);
  // Fail fast BEFORE making any API call if a baseline already exists and --force wasn't given.
  if (baselineExists && !FORCE) {
    die('baseline already exists; pass --force to overwrite (prior baseline is archived first)', {
      baseline_file: rel(BASELINE_FILE),
    });
  }

  // Fetch first — if this throws (API error / empty / bad shape), we never touch the existing baseline.
  let fetched;
  try {
    fetched = await fetchAllSavedItems({ maxPages: MAX_PAGES, forceDefaultCreds: FORCE_DEFAULT_CREDS });
  } catch (e) {
    if (e instanceof GigaSavedItemsError) die(e.message, e.details);
    die(`saved-items fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Archive the prior baseline (only reached when --force AND it exists AND the fetch succeeded).
  let archivedTo: string | null = null;
  if (baselineExists && FORCE) {
    let priorRunId = 'unknown';
    try { priorRunId = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))?.baseline_run_id ?? 'unknown'; } catch { /* keep 'unknown' */ }
    archivedTo = path.join(REPORT_DIR, `saved-items-baseline.${priorRunId}.json`);
    fs.copyFileSync(BASELINE_FILE, archivedTo);
  }

  const baseline = {
    baseline_run_id: RUN_ID,
    captured_at: TIMESTAMP,
    creds_source: fetched.credsSource,
    endpoint_path: fetched.endpointPath,
    sku_field: fetched.skuField,
    count: fetched.items.length,
    reported_total_num: fetched.reportedTotal,
    pages_fetched: fetched.pagesFetched,
    skus: fetched.items.map(i => i.sku),
    items: fetched.items.map(i => ({ sku: i.sku, title: i.title, addedTime: i.addedTime })),
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2));

  console.log('GIGA_SAVED_BASELINE_SUMMARY');
  console.log(`baseline_run_id=${RUN_ID}`);
  console.log(`captured_at=${TIMESTAMP}`);
  console.log(`creds_source=${fetched.credsSource}`);
  console.log(`endpoint_path=${fetched.endpointPath}`);
  console.log(`sku_field=${fetched.skuField}`);
  console.log(`baseline_count=${baseline.count}`);
  console.log(`reported_total_num=${fetched.reportedTotal ?? 'unknown'}`);
  console.log(`overwrote_existing=${baselineExists}`);
  console.log(`archived_prior_to=${archivedTo ? rel(archivedTo) : '(none)'}`);
  console.log(`baseline_file=${rel(BASELINE_FILE)}`);
})().catch(e => { console.error('GIGA_SAVED_BASELINE_ERROR'); console.error(`error=${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
