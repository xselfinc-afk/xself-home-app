/**
 * GIGA B2B → Supabase product sync runner
 *
 * Usage:
 *   npx ts-node scripts/syncPickup.ts
 *
 * Required env vars:
 *   SUPABASE_URL              — https://<id>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (bypasses RLS)
 *   SUPPLIER_CLIENT_ID        — GIGA Open API client ID
 *   SUPPLIER_CLIENT_SECRET    — GIGA Open API client secret
 *   SUPPLIER_API_BASE_URL     — GIGA API base URL
 */

import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

// GIGA Open API env: load .env.giga-alt.local first (correct openapi.gigab2b.com
// host + Production credentials), then .env.local as fallback — matching
// scripts/syncInventoryFromOfficialApi.ts. dotenv does not override already-set
// vars, so the alt file's SUPPLIER_* values win. This MUST run before
// supplierPickupService is imported (gigaApiClient reads SUPPLIER_* at module
// load), which is why that service is imported dynamically inside run().
loadEnv({ path: '.env.giga-alt.local' });
loadEnv({ path: '.env.local' });

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[syncPickup] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

if (
  !process.env.SUPPLIER_CLIENT_ID ||
  !process.env.SUPPLIER_CLIENT_SECRET ||
  !process.env.SUPPLIER_API_BASE_URL
) {
  console.error(
    '[syncPickup] Missing SUPPLIER_CLIENT_ID, SUPPLIER_CLIENT_SECRET, or SUPPLIER_API_BASE_URL',
  );
  process.exit(1);
}

// Service-role client — bypasses RLS, only used server-side
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function run() {
  console.log('[syncPickup] Starting GIGA Open API → Supabase product sync');

  // Imported here (not at top) so the env files above are loaded before
  // gigaApiClient reads SUPPLIER_* at module-evaluation time.
  const { syncPickupProducts } = await import('../src/services/supplierPickupService');
  const result = await syncPickupProducts(supabase);

  console.log(
    `[syncPickup] Done — fetched: ${result.fetched}, upserted: ${result.upserted}`,
  );
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[syncPickup] Failed:', err);
    process.exit(1);
  });