/**
 * INVENTORY_CACHE_ONLY safety-guard tests (pure; injected spies — no Supabase, no network).
 * Proves cache-only mode writes inventory_cache but NEVER calls refresh_product_inventory_status
 * (the only mutator of standardized_products.published / inventory_status), that the default
 * behavior is unchanged, and that failures write nothing (fail-closed).
 * Run: npx tsx src/__tests__/inventorySyncCacheOnly.test.ts
 */
import assert from 'node:assert/strict';
import { isCacheOnlyMode, applyProductWrites, type WriteDeps } from '../../scripts/syncGigaInventoryXhr';
import type { NormalizedRow } from '../../scripts/fetchGigaWarehouseInventoryFromXhr';

let passed = 0;
function it(name: string, fn: () => Promise<void> | void): Promise<void> { return Promise.resolve(fn()).then(() => { passed++; console.log(`  ✓ ${name}`); }); }

const row = (over: Partial<NormalizedRow> = {}): NormalizedRow => ({
  product_id: 'W1445P360668', supplier_product_id: 'W1445P360668', warehouse_code: 'CA3', warehouse_state: 'CA',
  quantity: 48, quantity_raw: '48', quantity_exact: true, is_available: true, supports_pickup: true,
  supports_shipping: false, source_type: 'website_scrape', sync_status: 'ok', last_synced_at: '2026-07-30T20:00:00.000Z',
  total_available: 48, ...over,
});

/** Spy deps recording upsert + refresh calls. */
function makeDeps(over: { upsertError?: string | null } = {}): { deps: WriteDeps; calls: { upsert: number; refresh: number; refreshedIds: string[] } } {
  const calls = { upsert: 0, refresh: 0, refreshedIds: [] as string[] };
  const deps: WriteDeps = {
    upsertRows: async (rows) => { calls.upsert++; return { written: rows.length, error: over.upsertError ?? null }; },
    refreshStatus: async (id) => { calls.refresh++; calls.refreshedIds.push(id); },
  };
  return { deps, calls };
}

async function main() {
  // ── isCacheOnlyMode: exact '1' only ──
  it('isCacheOnlyMode activates ONLY on exact "1"', () => {
    assert.equal(isCacheOnlyMode({ INVENTORY_CACHE_ONLY: '1' } as any), true);
    assert.equal(isCacheOnlyMode({ INVENTORY_CACHE_ONLY: '0' } as any), false);
    assert.equal(isCacheOnlyMode({ INVENTORY_CACHE_ONLY: 'true' } as any), false);
    assert.equal(isCacheOnlyMode({ INVENTORY_CACHE_ONLY: 'yes' } as any), false);
    assert.equal(isCacheOnlyMode({ INVENTORY_CACHE_ONLY: ' 1' } as any), false); // no fuzzy/whitespace match
    assert.equal(isCacheOnlyMode({ INVENTORY_CACHE_ONLY: '1 ' } as any), false);
    assert.equal(isCacheOnlyMode({} as any), false);                              // absent
  });

  // ── 1. cache-only: cache written, refresh NEVER called ──
  await it('cache-only: upserts inventory_cache but NEVER calls refresh_product_inventory_status', async () => {
    const { deps, calls } = makeDeps();
    const r = await applyProductWrites(deps, [row()], 'W1445P360668', { dryRun: false, cacheOnly: true });
    assert.equal(calls.upsert, 1);                 // inventory_cache write path stays enabled
    assert.equal(calls.refresh, 0);                // NO publication-side RPC → published/inventory_status unchanged
    assert.equal(r.written, 1);
    assert.equal(r.refreshed, false);
    assert.equal(r.error, null);
  });

  // ── 2. absent / default: existing refresh behavior unchanged ──
  await it('default (cacheOnly=false): upserts AND calls refresh_product_inventory_status (unchanged)', async () => {
    const { deps, calls } = makeDeps();
    const r = await applyProductWrites(deps, [row()], 'W1445P360668', { dryRun: false, cacheOnly: false });
    assert.equal(calls.upsert, 1);
    assert.equal(calls.refresh, 1);                // existing behavior preserved exactly
    assert.deepEqual(calls.refreshedIds, ['W1445P360668']);
    assert.equal(r.refreshed, true);
  });

  // ── 4. failures write nothing; existing rows untouched (fail-closed) ──
  await it('fail-closed: empty rows[] (auth/captcha/parse/network/supplier/resolve) writes NOTHING', async () => {
    for (const cacheOnly of [true, false]) {
      const { deps, calls } = makeDeps();
      const r = await applyProductWrites(deps, [], 'W1445P360668', { dryRun: false, cacheOnly });
      assert.equal(calls.upsert, 0, `cacheOnly=${cacheOnly}`);   // no upsert → existing valid rows untouched
      assert.equal(calls.refresh, 0, `cacheOnly=${cacheOnly}`);  // no publication mutation
      assert.equal(r.written, 0);
      assert.equal(r.refreshed, false);
    }
  });

  await it('upsert error short-circuits: refresh NOT called, error surfaced (both modes)', async () => {
    for (const cacheOnly of [true, false]) {
      const { deps, calls } = makeDeps({ upsertError: 'boom' });
      const r = await applyProductWrites(deps, [row()], 'W1445P360668', { dryRun: false, cacheOnly });
      assert.equal(calls.upsert, 1);
      assert.equal(calls.refresh, 0);              // never refresh after a failed write
      assert.equal(r.error, 'boom');
      assert.equal(r.refreshed, false);
    }
  });

  await it('dry-run: no upsert, no refresh, count-only (both modes)', async () => {
    for (const cacheOnly of [true, false]) {
      const { deps, calls } = makeDeps();
      const r = await applyProductWrites(deps, [row(), row()], 'W1445P360668', { dryRun: true, cacheOnly });
      assert.equal(calls.upsert, 0);
      assert.equal(calls.refresh, 0);
      assert.equal(r.written, 2);                  // reported, not written
    }
  });

  // ── 5. confirmed empty all-zero distributions → still no publication mutation in cache-only ──
  await it('cache-only: confirmed all-zero (out_of_stock) rows upsert but trigger NO publication refresh', async () => {
    const zeroRows = [row({ quantity: 0, quantity_raw: '0', is_available: false, total_available: 0 })];
    const { deps, calls } = makeDeps();
    const r = await applyProductWrites(deps, zeroRows, 'W1445P360668', { dryRun: false, cacheOnly: true });
    assert.equal(calls.upsert, 1);                 // affirmative per-warehouse zero is a real reading → cache it
    assert.equal(calls.refresh, 0);                // but do NOT let it delist via refresh in cache-only mode
    assert.equal(r.written, 1);
    assert.equal(r.refreshed, false);
  });

  console.log(`\n${passed} passed`);
}
main();
