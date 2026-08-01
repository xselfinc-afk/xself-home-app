/**
 * Supplier Favorite fact-mapping tests (pure; no database, no supplier, no network).
 *
 * The central property: a failed, incomplete, or allowlist-scoped observation can NEVER produce
 * `is_saved = false`. Removal must never be inferred — losing Saved membership also destroys
 * supplier API access for that SKU.
 *
 * Run: npx tsx src/__tests__/supplierFavoriteFacts.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FORBIDDEN_WRITE_TABLES,
  WRITE_TABLE,
  buildFactRows,
  completenessReason,
  diffAgainstExisting,
  isAuthoritative,
  normaliseSkus,
  parseAllowlist,
  summarise,
  type FavoriteObservation,
} from '../services/supplierFavoriteFacts';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const AT = '2026-08-01T12:00:00Z';

function obs(over: Partial<FavoriteObservation> = {}): FavoriteObservation {
  return {
    supplierAccount: 'pickup',
    sourceRunId: 'run-1',
    observedAt: AT,
    syncStatus: 'ok',
    syncErrorCode: null,
    skus: new Set(['W1', 'W2']),
    reportedTotal: 2,
    pagesFetched: 1,
    ...over,
  };
}

function main() {
  // ── authoritative-ness ────────────────────────────────────────────────────
  it('1. authoritative requires ok + reported total + full count', () => {
    assert.equal(isAuthoritative(obs()), true);
    assert.equal(isAuthoritative(obs({ syncStatus: 'auth_failed' })), false);
    assert.equal(isAuthoritative(obs({ reportedTotal: null })), false, 'no reported total → unprovable');
    assert.equal(isAuthoritative(obs({ reportedTotal: 5 })), false, 'short walk → incomplete');
  });

  it('2. present in a complete list → true', () => {
    const rows = Object.fromEntries(buildFactRows(obs(), []).map(r => [r.supplier_product_id, r]));
    assert.equal(rows.W1.is_saved, true);
    assert.equal(rows.W1.sync_status, 'ok');
    assert.equal(rows.W1.last_seen_saved_at, AT);
    assert.equal(rows.W1.last_seen_removed_at, undefined);
  });

  it('3. known-but-absent in a complete list → false', () => {
    const o = obs({ skus: new Set(['W1']), reportedTotal: 1 });
    const rows = Object.fromEntries(buildFactRows(o, ['W1', 'W2']).map(r => [r.supplier_product_id, r]));
    assert.equal(rows.W1.is_saved, true);
    assert.equal(rows.W2.is_saved, false);
    assert.equal(rows.W2.last_seen_removed_at, AT);
  });

  it('4. auth/CAPTCHA/network/permission/parse failures → null, never false', () => {
    for (const s of ['auth_failed', 'captcha_required', 'network_failed', 'parse_failed', 'permission_denied', 'rate_limited', 'supplier_unavailable'] as const) {
      const rows = buildFactRows(obs({ syncStatus: s, skus: new Set(), reportedTotal: null }), ['W1', 'W2']);
      assert.equal(rows.length, 2, s);
      for (const r of rows) {
        assert.equal(r.is_saved, null, `${s} must never conclude removal`);
        assert.equal(r.sync_status, s);
        assert.equal(r.last_seen_removed_at, undefined);
      }
    }
  });

  it('5. incomplete pagination → null even when sync_status is ok', () => {
    const o = obs({ skus: new Set(['W1']), reportedTotal: 9 }); // 1 of 9 → pages missed
    const rows = Object.fromEntries(buildFactRows(o, ['W1', 'W2']).map(r => [r.supplier_product_id, r]));
    assert.equal(rows.W1.is_saved, null);
    assert.equal(rows.W2.is_saved, null, 'a partial list must NEVER mark a SKU removed');
  });

  it('5b. missing reported total → null (completeness unprovable)', () => {
    const rows = buildFactRows(obs({ reportedTotal: null }), ['W1', 'W2', 'W3']);
    assert.ok(rows.every(r => r.is_saved === null));
  });

  // ── rule 10: allowlist is a partial view ──────────────────────────────────
  it('6. RULE 10: absence within an allowlist NEVER implies removal', () => {
    const o = obs({ skus: new Set(['W1']), reportedTotal: 1 }); // authoritative
    const rows = Object.fromEntries(buildFactRows(o, ['W1', 'W2'], ['W1', 'W2']).map(r => [r.supplier_product_id, r]));
    assert.equal(rows.W1.is_saved, true, 'present → true');
    assert.equal(rows.W2.is_saved, null, 'absent under an allowlist → UNKNOWN, not false');
    assert.notEqual(rows.W2.is_saved, false);
  });

  it('6b. without an allowlist the same absence IS conclusive', () => {
    const o = obs({ skus: new Set(['W1']), reportedTotal: 1 });
    const rows = Object.fromEntries(buildFactRows(o, ['W1', 'W2']).map(r => [r.supplier_product_id, r]));
    assert.equal(rows.W2.is_saved, false);
  });

  it('7. allowlist restricts scope; empty never means "all"', () => {
    const rows = buildFactRows(obs({ skus: new Set(['W1', 'W2', 'W3']), reportedTotal: 3 }), ['W4'], ['W1', 'W4']);
    assert.deepEqual(rows.map(r => r.supplier_product_id).sort(), ['W1', 'W4']);
    assert.equal(parseAllowlist(''), null);
    assert.equal(parseAllowlist(undefined), null);
    assert.deepEqual(parseAllowlist(' W1 , W2 ,W1'), ['W1', 'W2']);
  });

  it('8. account scope: pickup observation only ever emits pickup rows', () => {
    const rows = buildFactRows(obs(), ['W1', 'W2']);
    assert.ok(rows.every(r => r.supplier_account === 'pickup'));
    const drop = buildFactRows(obs({ supplierAccount: 'dropship', skus: new Set(), reportedTotal: 0 }), ['W1']);
    assert.ok(drop.every(r => r.supplier_account === 'dropship'));
  });

  it('9. duplicates and whitespace are deduped', () => {
    assert.deepEqual([...normaliseSkus([' W1 ', 'W1', '', '   ', 'W2'])].sort(), ['W1', 'W2']);
    assert.equal(buildFactRows(obs({ skus: normaliseSkus(['W1', 'W1', ' W1 ']), reportedTotal: 1 }), []).length, 1);
  });

  it('10. identical repeated observation is unchanged (idempotent)', () => {
    const rows = buildFactRows(obs(), ['W1', 'W2']);
    const existing = { W1: { is_saved: true, sync_status: 'ok' }, W2: { is_saved: true, sync_status: 'ok' } };
    assert.deepEqual(summarise(diffAgainstExisting(rows, existing)), { insert: 0, update: 0, unchanged: 2 });
  });

  it('10b. a real change is an update; a new SKU is an insert', () => {
    const rows = buildFactRows(obs({ skus: new Set(['W1']), reportedTotal: 1 }), ['W1', 'W2']);
    const counts = summarise(diffAgainstExisting(rows, { W1: { is_saved: true, sync_status: 'ok' }, W2: { is_saved: true, sync_status: 'ok' } }));
    assert.equal(counts.update, 1);
    assert.equal(counts.unchanged, 1);
    assert.equal(summarise(diffAgainstExisting(rows, {})).insert, 2);
  });

  it('11. unknown-and-unseen SKUs are not invented', () => {
    const rows = buildFactRows(obs({ skus: new Set(['W1']), reportedTotal: 1 }), ['W1']);
    assert.deepEqual(rows.map(r => r.supplier_product_id), ['W1']);
  });

  // ── write-scope guarantees ────────────────────────────────────────────────
  it('12. the mapping layer is pure — it cannot write anything', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../services/supplierFavoriteFacts.ts'), 'utf8');
    for (const banned of ['supabase', 'createClient', 'fetch(', 'process.env']) {
      assert.ok(!src.includes(banned), `pure layer must not reference ${banned}`);
    }
  });

  it('13. only supplier_favorite_memberships is a write target', () => {
    assert.equal(WRITE_TABLE, 'supplier_favorite_memberships');
    const runner = fs.readFileSync(path.resolve(__dirname, '../../scripts/syncSupplierFavoriteFacts.ts'), 'utf8');
    const exec = runner.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    for (const t of FORBIDDEN_WRITE_TABLES) {
      assert.ok(!exec.includes(`.from('${t}')`), `runner must not touch ${t}`);
    }
    assert.ok(!/refresh_product_inventory_status/.test(exec), 'must never call the publication authority');
    assert.ok(!/\.rpc\(/.test(exec), 'no RPC calls');
  });

  it('14. runner reuses the existing pickup reader, not a new client', () => {
    const runner = fs.readFileSync(path.resolve(__dirname, '../../scripts/syncSupplierFavoriteFacts.ts'), 'utf8');
    assert.ok(runner.includes("import('./lib/gigaSavedItems')"), 'must reuse gigaSavedItems');
    assert.ok(!runner.includes('gigaApiClient'), 'must not construct a second supplier client');
    assert.ok(!/createHmac/.test(runner), 'must not re-implement signing');
  });

  it('15. fact rows carry only supplier-fact columns', () => {
    const row = buildFactRows(obs(), [])[0];
    const allowed = new Set(['supplier_product_id', 'supplier_account', 'is_saved', 'sync_status', 'sync_error_code', 'observed_at', 'source_run_id', 'last_seen_saved_at', 'last_seen_removed_at']);
    for (const k of Object.keys(row)) assert.ok(allowed.has(k), `unexpected column: ${k}`);
    for (const forbidden of ['asset_state', 'published', 'inventory_status', 'selling_price', 'version']) {
      assert.ok(!(forbidden in row), forbidden);
    }
  });

  it('16. completeness reason is explicit about why', () => {
    assert.match(completenessReason(obs()), /complete/);
    assert.match(completenessReason(obs({ reportedTotal: null })), /unprovable/);
    assert.match(completenessReason(obs({ reportedTotal: 9 })), /incomplete/);
    assert.match(completenessReason(obs({ syncStatus: 'auth_failed' })), /not authoritative/);
  });

  console.log(`\n${passed} passed`);
}
main();
