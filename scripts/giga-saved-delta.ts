/**
 * giga-saved-delta.ts — Phase 1B: compare the CURRENT saved-items list against the saved baseline.
 *
 * This is the gate for the future automatic flow: it reports which SKUs were saved/favorited AFTER
 * the baseline (newly_saved_skus), which were unsaved (removed_saved_skus), and which are unchanged.
 * FUTURE AUTO-PUBLISH MUST CONSUME ONLY newly_saved_skus. The 538 historical/backlog SKUs live in
 * the baseline → classified unchanged → excluded from the automatic flow by construction.
 *
 * Reads:  reports/giga-auto-publish/saved-items-baseline.json (must exist — run giga:saved:baseline first)
 * Writes: reports/giga-auto-publish/latest-saved-delta.json + latest-saved-delta.md (local files only)
 *
 * Performs NO Supabase access, NO publishing, NO apply, NO image/blurhash/review/inventory work.
 * Comparison is purely current-saved-list vs baseline by `sku` (set membership, order-independent).
 *
 * Usage:
 *   npm run giga:saved:delta
 *   npx tsx scripts/giga-saved-delta.ts [--max-pages=N] [--default-creds] [--summary]
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fetchAllSavedItems, GigaSavedItemsError } from './lib/gigaSavedItems';

const argv = process.argv.slice(2);
const SUMMARY = argv.includes('--summary');
const FORCE_DEFAULT_CREDS = argv.includes('--default-creds') || process.env.GIGA_SAVED_USE_ALT_CREDS === '0';
const maxPagesArg = argv.find(a => a.startsWith('--max-pages='));
const MAX_PAGES = maxPagesArg ? Math.max(1, parseInt(maxPagesArg.split('=')[1], 10) || 0) : Infinity;

const REPORT_DIR = path.join(process.cwd(), 'reports', 'giga-auto-publish');
const BASELINE_FILE = path.join(REPORT_DIR, 'saved-items-baseline.json');
const DELTA_JSON = path.join(REPORT_DIR, 'latest-saved-delta.json');
const DELTA_MD = path.join(REPORT_DIR, 'latest-saved-delta.md');
const rel = (p: string) => path.relative(process.cwd(), p);

function die(msg: string, extra?: Record<string, unknown>): never {
  console.error('GIGA_SAVED_DELTA_ERROR');
  console.error(`error=${msg}`);
  if (extra) for (const [k, v] of Object.entries(extra)) console.error(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  process.exit(1);
}

(async () => {
  const RUN_ID = crypto.randomUUID();
  const TIMESTAMP = new Date().toISOString();

  // ── 1. Load baseline (must exist; never auto-create — that would hide genuinely-new items) ──
  if (!fs.existsSync(BASELINE_FILE)) {
    die('no baseline found; run `npm run giga:saved:baseline` first', { baseline_file: rel(BASELINE_FILE) });
  }
  let baseline: any;
  try { baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); }
  catch (e) { die(`baseline file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, { baseline_file: rel(BASELINE_FILE) }); }
  if (!Array.isArray(baseline?.skus)) {
    die('baseline file missing skus[] array (corrupt or wrong shape)', { baseline_file: rel(BASELINE_FILE), keys: baseline ? Object.keys(baseline) : 'null' });
  }

  // ── 2. Fetch current saved items via the shared helper (loud-fail; never partial) ──
  let fetched;
  try {
    fetched = await fetchAllSavedItems({ maxPages: MAX_PAGES, forceDefaultCreds: FORCE_DEFAULT_CREDS });
  } catch (e) {
    if (e instanceof GigaSavedItemsError) die(e.message, e.details);
    die(`saved-items fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Creds-drift guard: a different account = whole-list churn, not real saves/unsaves.
  const credsDrift = baseline.creds_source != null && baseline.creds_source !== fetched.credsSource;
  if (credsDrift) {
    console.error('GIGA_SAVED_DELTA_WARNING');
    console.error(`warning=creds_source differs from baseline (baseline=${baseline.creds_source} current=${fetched.credsSource}); delta reflects an account switch, not real saves`);
  }

  // ── 3. Compare by SKU (set membership) ──
  const baselineSkus = new Set<string>(baseline.skus.map((s: any) => String(s)));
  const currentItems = fetched.items;
  const currentSkus = new Set<string>(currentItems.map(i => i.sku));
  const currentTitle = new Map<string, string>(currentItems.map(i => [i.sku, i.title]));
  const baselineTitle = new Map<string, string>(
    (Array.isArray(baseline.items) ? baseline.items : []).map((it: any) => [String(it?.sku), String(it?.title ?? '')]),
  );

  const newly = currentItems.filter(i => !baselineSkus.has(i.sku)).map(i => i.sku);
  const removed = [...baselineSkus].filter(s => !currentSkus.has(s));
  const unchanged = currentItems.filter(i => baselineSkus.has(i.sku)).map(i => i.sku);

  const totals = {
    baseline_count: baselineSkus.size,
    current_count: currentSkus.size,
    newly_saved: newly.length,
    removed_saved: removed.length,
    unchanged_saved: unchanged.length,
  };

  // ── 4. Write reports (local files only) ──
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const fullJson = {
    run_id: RUN_ID,
    timestamp: TIMESTAMP,
    creds_source: fetched.credsSource,
    creds_drift_vs_baseline: credsDrift,
    endpoint_path: fetched.endpointPath,
    sku_field: fetched.skuField,
    baseline_ref: {
      baseline_run_id: baseline.baseline_run_id ?? null,
      captured_at: baseline.captured_at ?? null,
      creds_source: baseline.creds_source ?? null,
      count: baselineSkus.size,
    },
    totals,
    future_auto_publish_input: 'newly_saved_skus_only',
    newly_saved_skus: newly.map(sku => ({ sku, title: currentTitle.get(sku) ?? '' })),
    removed_saved_skus: removed.map(sku => ({ sku, title: baselineTitle.get(sku) ?? '' })),
    unchanged_saved_skus: unchanged,
  };
  fs.writeFileSync(DELTA_JSON, JSON.stringify(fullJson, null, 2));

  const md: string[] = [];
  md.push('# GIGA Saved-Items Delta (read-only, Phase 1B)', '');
  md.push(`- run_id: ${RUN_ID}`, `- timestamp: ${TIMESTAMP}`, `- creds_source: ${fetched.credsSource}`);
  if (credsDrift) md.push(`- ⚠️ creds_drift_vs_baseline: baseline=${baseline.creds_source} current=${fetched.credsSource} (account switch — not real saves)`);
  md.push(`- baseline_run_id: ${baseline.baseline_run_id ?? '(unknown)'} captured_at: ${baseline.captured_at ?? '(unknown)'}`);
  md.push('- future_auto_publish_input: newly_saved_skus only', '');
  md.push('## Totals',
    `- baseline_count: ${totals.baseline_count}`,
    `- current_count: ${totals.current_count}`,
    `- newly_saved: ${totals.newly_saved}`,
    `- removed_saved: ${totals.removed_saved}`,
    `- unchanged_saved: ${totals.unchanged_saved}`, '');
  md.push('## Newly saved (future auto-publish candidates)', '');
  if (newly.length === 0) {
    md.push('_(none)_', '');
  } else {
    md.push('| SKU | title |', '|---|---|');
    for (const sku of newly) md.push(`| ${sku} | ${(currentTitle.get(sku) ?? '').replace(/\|/g, '/').slice(0, 80)} |`);
    md.push('');
  }
  md.push('## Removed since baseline', '');
  if (removed.length === 0) {
    md.push('_(none)_', '');
  } else {
    md.push('| SKU | title |', '|---|---|');
    for (const sku of removed) md.push(`| ${sku} | ${(baselineTitle.get(sku) ?? '').replace(/\|/g, '/').slice(0, 80)} |`);
    md.push('');
  }
  md.push(`## Unchanged since baseline`, '', `${unchanged.length} SKUs (excluded from the automatic flow — historical/backlog handled separately).`);
  fs.writeFileSync(DELTA_MD, md.join('\n'));

  // ── 5. Output ──
  console.log('GIGA_SAVED_DELTA_SUMMARY');
  console.log(`run_id=${RUN_ID}`);
  console.log(`timestamp=${TIMESTAMP}`);
  console.log(`creds_source=${fetched.credsSource}`);
  console.log(`creds_drift_vs_baseline=${credsDrift}`);
  console.log(`baseline_run_id=${baseline.baseline_run_id ?? 'unknown'}`);
  console.log(`baseline_count=${totals.baseline_count}`);
  console.log(`current_count=${totals.current_count}`);
  console.log(`newly_saved=${totals.newly_saved}`);
  console.log(`removed_saved=${totals.removed_saved}`);
  console.log(`unchanged_saved=${totals.unchanged_saved}`);
  console.log(`future_auto_publish_input=newly_saved_skus_only`);
  console.log(`report_json=${rel(DELTA_JSON)}`);
  console.log(`report_md=${rel(DELTA_MD)}`);
  if (!SUMMARY) {
    console.log(`sample_newly_saved=${newly.slice(0, 5).join(',') || '(none)'}`);
    console.log(`sample_removed_saved=${removed.slice(0, 5).join(',') || '(none)'}`);
  }
})().catch(e => { console.error('GIGA_SAVED_DELTA_ERROR'); console.error(`error=${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
