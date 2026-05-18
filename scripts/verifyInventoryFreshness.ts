/**
 * Post-sync freshness guard for inventory_cache.
 *
 * Exits 1 if the newest `website_scrape` row is older than STALE_HOURS
 * (default 36h) or if no such rows exist at all. Designed to be the final
 * step of runGigaInventorySync.sh so a silently-failing scraper surfaces as
 * a launchd error within hours instead of a week.
 *
 * Run:
 *   npx tsx scripts/verifyInventoryFreshness.ts
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — required
 *   FRESHNESS_STALE_HOURS                  — optional, default 36
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const STALE_HOURS  = Number(process.env.FRESHNESS_STALE_HOURS ?? 36);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[verifyInventoryFreshness] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

async function run() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: newest, error: newestErr } = await supabase
    .from('inventory_cache')
    .select('last_synced_at, product_id, warehouse_code')
    .eq('source_type', 'website_scrape')
    .eq('sync_status', 'ok')
    .order('last_synced_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (newestErr) {
    console.error('[verifyInventoryFreshness] DB error:', newestErr.message);
    process.exit(1);
  }

  if (!newest) {
    console.error('[verifyInventoryFreshness] FAIL — inventory_cache has zero website_scrape rows.');
    process.exit(1);
  }

  const newestMs = new Date(newest.last_synced_at as string).getTime();
  const ageHours = (Date.now() - newestMs) / 3_600_000;

  const since24h = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { count: recent24h } = await supabase
    .from('inventory_cache')
    .select('*', { count: 'exact', head: true })
    .eq('source_type', 'website_scrape')
    .eq('sync_status', 'ok')
    .gte('last_synced_at', since24h);

  const { count: totalScrape } = await supabase
    .from('inventory_cache')
    .select('*', { count: 'exact', head: true })
    .eq('source_type', 'website_scrape')
    .eq('sync_status', 'ok');

  console.log(`[verifyInventoryFreshness] newest website_scrape row : ${newest.last_synced_at} (${ageHours.toFixed(1)}h ago)`);
  console.log(`[verifyInventoryFreshness]   product_id=${newest.product_id}  warehouse_code=${newest.warehouse_code}`);
  console.log(`[verifyInventoryFreshness] rows updated in last 24h  : ${recent24h ?? 0}`);
  console.log(`[verifyInventoryFreshness] website_scrape rows total : ${totalScrape ?? 0}`);
  console.log(`[verifyInventoryFreshness] stale threshold           : ${STALE_HOURS}h`);

  if (ageHours > STALE_HOURS) {
    console.error(`[verifyInventoryFreshness] FAIL — newest row is ${ageHours.toFixed(1)}h old (> ${STALE_HOURS}h).`);
    process.exit(1);
  }

  console.log('[verifyInventoryFreshness] PASS');
}

run().catch(err => {
  console.error('[verifyInventoryFreshness] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
