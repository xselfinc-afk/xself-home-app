/**
 * Supplier Favorites management tests (pure; no network, no database, no browser).
 *
 * The property everything else depends on: removing a Favorite is irreversible, so every unknown
 * must resolve to "keep". A failed read, an unresolved identity or a missing approval all protect
 * the item. "In Favorites but not currently live" is never, on its own, a reason to remove.
 *
 * Run: npx tsx src/__tests__/supplierFavoriteManagement.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  buildSupplierFavoritePlan,
  classifySupplierFavorite,
  resolveManualAction,
  FAVORITE_CHAIN_WRITABLE_TABLES,
  INVENTORY_CHAIN_TABLES,
  type SavedAssetState,
  type SupplierFavoriteInput,
} from '../services/supplierFavoriteCleanup';
import {
  executeRemoval,
  previewRemoval,
  removalEnabled,
  REMOVAL_ENDPOINT,
} from '../services/supplierFavoriteRemoval';
import { buildFactRows, type FavoriteObservation } from '../services/supplierFavoriteFacts';
import { buildInputs, resolveProductIdMapping } from '../../scripts/xoneSupplierFavoriteBridge';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }
async function itAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn(); passed++; console.log(`  ✓ ${name}`);
}

/** A SKU that clears every gate. Individual tests spoil exactly one field. */
const removable = (over: Partial<SupplierFavoriteInput> = {}): SupplierFavoriteInput => ({
  supplier_product_id: 'N999P100001',
  xself_sku: 'XH-XX-XX-100001',
  pickup_is_saved: true,
  dropship_is_saved: true,
  api_managed: false,
  published: false,
  restorable_delisted: false,
  asset_state: 'REMOVABLE',
  founder_status: 'approved',
  approved_at: '2026-08-06T00:00:00.000Z',
  approved_by: '你',
  identity_unique: true,
  ...over,
});

async function main(): Promise<void> {
  // ── 1 + 2: dual-account facts stay independent ──────────────────────────────

  it('1. pickup and dropship are read and recorded independently', () => {
    const obs = (account: 'pickup' | 'dropship', skus: string[], pages: number): FavoriteObservation => ({
      supplierAccount: account,
      sourceRunId: `run-${account}`,
      observedAt: '2026-08-06T00:00:00.000Z',
      syncStatus: 'ok',
      syncErrorCode: null,
      skus: new Set(skus),
      reportedTotal: skus.length,
      pagesFetched: pages,
    });
    const pickupRows = buildFactRows(obs('pickup', ['A', 'B'], 3), [], null);
    const dropshipRows = buildFactRows(obs('dropship', ['B', 'C'], 2), [], null);

    assert.ok(pickupRows.every(r => r.supplier_account === 'pickup'));
    assert.ok(dropshipRows.every(r => r.supplier_account === 'dropship'));
    // Neither run may emit a row stamped with the sibling account.
    assert.equal(pickupRows.some(r => r.supplier_account === 'dropship'), false);
    assert.equal(dropshipRows.some(r => r.supplier_account === 'pickup'), false);
  });

  it('2. one account failing records UNKNOWN and never overwrites the sibling', () => {
    const failedPickup: FavoriteObservation = {
      supplierAccount: 'pickup',
      sourceRunId: 'run-fail',
      observedAt: '2026-08-06T00:00:00.000Z',
      syncStatus: 'auth_failed',
      syncErrorCode: null,
      skus: new Set<string>(),
      reportedTotal: null,
      pagesFetched: 0,
    };
    const rows = buildFactRows(failedPickup, ['A', 'B'], null);
    for (const r of rows) {
      assert.equal(r.supplier_account, 'pickup', 'a failed pickup run may only write pickup rows');
      assert.equal(r.is_saved, null, 'a failed read is UNKNOWN, never false');
      assert.notEqual(r.is_saved, false, 'a failed read must never be recorded as "not saved"');
    }

    // And the plan treats that unknown as protective, whatever dropship saw.
    const d = classifySupplierFavorite(removable({ pickup_is_saved: null }));
    assert.equal(d.read_failed, true);
    assert.equal(d.disposition, 'retained');
    assert.ok(d.retain_reasons.includes('favorite_read_failed'));
  });

  it('3. is_saved = null never reaches the cleanup candidates', () => {
    for (const spoil of [{ pickup_is_saved: null }, { dropship_is_saved: null }] as const) {
      const d = classifySupplierFavorite(removable(spoil));
      assert.equal(d.disposition, 'retained');
      assert.equal(d.removal_preview_allowed, false);
    }
  });

  // ── 4–8: every protected class is untouchable ──────────────────────────────

  it('4/5/6. SAVED_CANDIDATE, HOLD and REVIEW_REQUIRED can never be removed', () => {
    for (const state of ['SAVED_CANDIDATE', 'HOLD', 'REVIEW_REQUIRED'] as SavedAssetState[]) {
      // Even with founder approval and a complete approval record.
      const d = classifySupplierFavorite(removable({ asset_state: state, founder_status: 'approved' }));
      assert.equal(d.disposition, 'retained', `${state} must be retained`);
      assert.ok(d.retain_reasons.includes('protected_asset_state'), `${state} must cite its protected state`);
      assert.equal(d.removal_preview_allowed, false);
    }
    // ACTIVE_ASSET and EVALUATING are protected too.
    for (const state of ['ACTIVE_ASSET', 'EVALUATING'] as SavedAssetState[]) {
      assert.equal(classifySupplierFavorite(removable({ asset_state: state })).disposition, 'retained');
    }
  });

  it('7. published = true can never be removed', () => {
    const d = classifySupplierFavorite(removable({ published: true }));
    assert.equal(d.disposition, 'retained');
    assert.ok(d.retain_reasons.includes('published'));
    assert.equal(d.removal_preview_allowed, false);
  });

  it('8. an API-managed product can never be removed', () => {
    const d = classifySupplierFavorite(removable({ api_managed: true }));
    assert.equal(d.disposition, 'retained');
    assert.ok(d.retain_reasons.includes('api_managed'));

    // Restorable delisted and unresolved identity are protective too.
    assert.equal(classifySupplierFavorite(removable({ restorable_delisted: true })).disposition, 'retained');
    const conflict = classifySupplierFavorite(removable({ identity_unique: false }));
    assert.equal(conflict.disposition, 'retained');
    assert.ok(conflict.retain_reasons.includes('identity_not_unique'));
  });

  it('8b. "in Favorites but not live" is NOT sufficient — the naive algorithm is rejected', () => {
    // Nothing live, nothing managed, but no approval either. Must NOT be eligible.
    const d = classifySupplierFavorite(removable({
      asset_state: 'RETIRE_CANDIDATE', founder_status: 'pending', approved_at: null, approved_by: null,
    }));
    assert.equal(d.disposition, 'cleanup_blocked');
    assert.deepEqual(d.blocked_reasons.sort(), ['approval_record_incomplete', 'founder_not_approved', 'not_removable_state']);
  });

  // ── 9: the only path to eligibility ────────────────────────────────────────

  it('9. only REMOVABLE + founder approved + complete approval record is eligible', () => {
    assert.equal(classifySupplierFavorite(removable()).disposition, 'cleanup_eligible');
    assert.equal(classifySupplierFavorite(removable()).removal_preview_allowed, true);

    for (const spoil of [
      { asset_state: 'RETIRE_CANDIDATE' as SavedAssetState },
      { founder_status: 'pending' },
      { approved_at: null },
      { approved_by: null },
    ]) {
      const d = classifySupplierFavorite(removable(spoil));
      assert.notEqual(d.disposition, 'cleanup_eligible', `${JSON.stringify(spoil)} must block eligibility`);
      assert.equal(d.removal_preview_allowed, false);
    }
  });

  // ── 10–12: the executor's own guards ───────────────────────────────────────

  const approval = { asset_state: 'REMOVABLE', founder_status: 'approved', approved_at: '2026-08-06T00:00:00.000Z', approved_by: '你' };
  const ON = { SUPPLIER_FAVORITE_REMOVAL_ENABLED: 'true' };

  it('10. a product_id whose SKU does not match is rejected', () => {
    const mismatch = previewRemoval({
      supplier_product_id: 'N999P100001',
      product_id: 667968,
      verified_sku_for_product_id: 'N999P100002',   // a DIFFERENT product
      approval, session_present: true,
    }, ON);
    assert.equal(mismatch.ok, false);
    assert.ok(mismatch.rejections.includes('identity_mismatch'));
    assert.equal(mismatch.would_send, false);
    assert.equal(mismatch.payload, null, 'a rejected preview must leave nothing replayable');

    // An unverified mapping is just as fatal as a wrong one.
    const unverified = previewRemoval({
      supplier_product_id: 'N999P100001', product_id: 667968,
      verified_sku_for_product_id: null, approval, session_present: true,
    }, ON);
    assert.ok(unverified.rejections.includes('identity_mismatch'));
  });

  it('11. arrays, comma lists and batch-shaped product_ids are rejected outright', () => {
    for (const batch of [[1, 2], '667968,667969', '667968 667969', '667968;667969', '667968|667969']) {
      const p = previewRemoval({
        supplier_product_id: 'N999P100001', product_id: batch,
        verified_sku_for_product_id: 'N999P100001', approval, session_present: true,
      }, ON);
      assert.ok(p.rejections.includes('batch_request_rejected'), `${JSON.stringify(batch)} must be rejected`);
      assert.equal(p.payload, null, 'no batch may ever be normalised into a payload');
      assert.equal(p.would_send, false);
    }
    // A single valid id is accepted, and the payload carries a NUMBER, not a list.
    const single = previewRemoval({
      supplier_product_id: 'N999P100001', product_id: '667968',
      verified_sku_for_product_id: 'N999P100001', approval, session_present: true,
    }, ON);
    assert.equal(single.ok, true);
    assert.deepEqual(single.payload, { product_ids: 667968 });
    assert.equal(typeof single.payload!.product_ids, 'number');
  });

  await itAsync('12. with the gate closed, no request is EVER sent', async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return { status: 200, json: async () => ({ code: 200 }) }; };
    const perfect = {
      supplier_product_id: 'N999P100001', product_id: 667968,
      verified_sku_for_product_id: 'N999P100001', approval, session_present: true,
    };

    // Default env: the switch is absent.
    assert.equal(removalEnabled({}), false);
    assert.equal(removalEnabled({ SUPPLIER_FAVORITE_REMOVAL_ENABLED: 'false' }), false);
    assert.equal(removalEnabled({ SUPPLIER_FAVORITE_REMOVAL_ENABLED: '1' }), false, 'only the exact string "true" enables');
    assert.equal(removalEnabled({ SUPPLIER_FAVORITE_REMOVAL_ENABLED: 'TRUE' }), false);

    for (const env of [{}, { SUPPLIER_FAVORITE_REMOVAL_ENABLED: 'false' }, { SUPPLIER_FAVORITE_REMOVAL_ENABLED: '1' }]) {
      const r = await executeRemoval(perfect, fetcher, env);
      assert.equal(r.attempted, false);
      assert.equal(r.succeeded, false);
      assert.equal(r.preview.removal_enabled, false);
      assert.ok(r.preview.rejections.includes('removal_disabled'));
    }
    assert.equal(calls, 0, 'the fetcher must never be invoked while the gate is closed');

    // Even with the switch ON, a missing approval still sends nothing.
    const unapproved = await executeRemoval(
      { ...perfect, approval: { ...approval, founder_status: 'pending' } }, fetcher, ON,
    );
    assert.equal(unapproved.attempted, false);
    assert.equal(calls, 0, 'two independent gates: the switch alone is not enough');

    // Both gates open → exactly one request, to the confirmed endpoint.
    const sent: string[] = [];
    const recording = async (url: string) => { sent.push(url); return { status: 200, json: async () => ({ code: 200 }) }; };
    const done = await executeRemoval(perfect, recording, ON);
    assert.equal(done.attempted, true);
    assert.equal(done.succeeded, true);
    assert.deepEqual(sent, [REMOVAL_ENDPOINT]);
  });

  // ── 13 + 14: the two chains cannot reach each other ────────────────────────

  it('13. the favorites chain cannot touch the inventory chain', () => {
    const favoriteChain = [
      'src/services/supplierFavoriteCleanup.ts',
      'src/services/supplierFavoriteRemoval.ts',
      'src/services/supplierFavoriteFacts.ts',
      'scripts/xoneSupplierFavoriteBridge.ts',
      'scripts/syncSupplierFavoriteFacts.ts',
    ];
    const forbiddenImports = [
      'standardizedInventoryProjection', 'availabilityPersistence', 'openApiAvailability',
      'inventoryStateMachine', 'inventoryAutomationConfig',
    ];
    for (const file of favoriteChain) {
      const src = fs.readFileSync(file, 'utf8');
      for (const mod of forbiddenImports) {
        assert.equal(
          new RegExp(`(import|require)[^\\n]*${mod}`).test(src), false,
          `${file} must not import ${mod}`,
        );
      }
      // Nor may it write any inventory-owned table.
      for (const table of INVENTORY_CHAIN_TABLES) {
        assert.equal(
          new RegExp(`from\\('${table}'\\)[\\s\\S]{0,120}?\\.(update|upsert|insert|delete)\\(`).test(src), false,
          `${file} must not write ${table}`,
        );
      }
      // Reading `published` / `delist_reason` is how protection is decided, so reads are fine.
      // What must not exist is a WRITE carrying them, or any route into the listing actions.
      for (const [pattern, label] of [
        [/\.(update|upsert)\(\s*\{[^}]*\bpublished\b/, 'a write carrying `published`'],
        [/\.(update|upsert)\(\s*\{[^}]*\bdelist_reason\b/, 'a write carrying `delist_reason`'],
        [/applyInventoryLifecycleActions|scanPublishedAvailability|--action=(relist|delist)/, 'the listing/scan actions'],
      ] as const) {
        assert.equal(pattern.test(src), false, `${file} must not contain ${label}`);
      }
    }
  });

  it('14. the inventory chain cannot remove favorites', () => {
    const inventoryChain = [
      'scripts/scanPublishedAvailability.ts',
      'scripts/xoneInventoryLifecycleBridge.ts',
      'src/services/standardizedInventoryProjection.ts',
      'src/services/openApiAvailability.ts',
    ];
    for (const file of inventoryChain) {
      const src = fs.readFileSync(file, 'utf8');
      for (const forbidden of [
        'delProductsFromWish', 'supplierFavoriteRemoval', 'supplierFavoriteCleanup',
        'addProductsToWish', 'wishlist',
      ]) {
        assert.equal(src.includes(forbidden), false, `${file} must not reference ${forbidden}`);
      }
      // Nor may it write the favorites chain's tables.
      for (const table of FAVORITE_CHAIN_WRITABLE_TABLES) {
        assert.equal(
          new RegExp(`from\\('${table}'\\)[\\s\\S]{0,120}?\\.(update|upsert|insert|delete)\\(`).test(src), false,
          `${file} must not write ${table}`,
        );
      }
    }
  });

  // ── Regression: the two defects that made the first production run unusable ──

  it('16. a missing row means "not saved" when that account was read authoritatively', () => {
    // Pickup and Dropship legitimately hold largely different Favorites, so most SKUs have a row
    // for one account only. Reading every gap as UNKNOWN made pickup_only / dropship_only
    // structurally impossible and inflated read_failed to almost everything.
    const rows = {
      memberships: [
        { supplier_product_id: 'P-ONLY', supplier_account: 'pickup', is_saved: true, sync_status: 'ok', observed_at: 'T' },
        { supplier_product_id: 'D-ONLY', supplier_account: 'dropship', is_saved: true, sync_status: 'ok', observed_at: 'T' },
        { supplier_product_id: 'BOTH', supplier_account: 'pickup', is_saved: true, sync_status: 'ok', observed_at: 'T' },
        { supplier_product_id: 'BOTH', supplier_account: 'dropship', is_saved: true, sync_status: 'ok', observed_at: 'T' },
      ],
      assets: [], products: [], supplierManaged: new Set<string>(),
    };
    const inputs = buildInputs(rows as never);
    const byId = new Map(inputs.map((i) => [i.supplier_product_id, i]));

    // P-ONLY has no dropship row, but dropship read cleanly → false, not null.
    assert.equal(byId.get('P-ONLY')!.dropship_is_saved, false);
    assert.equal(byId.get('D-ONLY')!.pickup_is_saved, false);
    assert.equal(byId.get('BOTH')!.pickup_is_saved, true);

    const plan = buildSupplierFavoritePlan(inputs, []);
    assert.equal(plan.counts.pickup_only, 1);
    assert.equal(plan.counts.dropship_only, 1);
    assert.equal(plan.counts.both_accounts, 1);
    assert.equal(plan.counts.read_failed, 0);
  });

  it('17. a failed account read still makes every gap UNKNOWN', () => {
    // The moment an account's sync is not clean, absence stops being evidence.
    const rows = {
      memberships: [
        { supplier_product_id: 'A', supplier_account: 'pickup', is_saved: true, sync_status: 'ok', observed_at: 'T' },
        { supplier_product_id: 'B', supplier_account: 'dropship', is_saved: null, sync_status: 'auth_failed', observed_at: 'T' },
      ],
      assets: [], products: [], supplierManaged: new Set<string>(),
    };
    const inputs = buildInputs(rows as never);
    const byId = new Map(inputs.map((i) => [i.supplier_product_id, i]));
    // Dropship failed → A's missing dropship row is unknown, never false.
    assert.equal(byId.get('A')!.dropship_is_saved, null);
    assert.notEqual(byId.get('A')!.dropship_is_saved, false);
    assert.equal(byId.get('B')!.dropship_is_saved, null);

    const plan = buildSupplierFavoritePlan(inputs, []);
    assert.equal(plan.counts.read_failed, 2);
    assert.equal(plan.counts.cleanup_candidates, 0, '读取失败时不得产生任何清理候选');
  });

  it('18. every bridge table read is paginated — no unbounded select survives', () => {
    // Supabase silently caps an unbounded select at 1000 rows. supplier_favorite_memberships
    // passed that mark in production and the node reported dropship 295 instead of 1497.
    const src = fs.readFileSync('scripts/xoneSupplierFavoriteBridge.ts', 'utf8');
    const loadRows = src.slice(src.indexOf('async function loadRows'), src.indexOf('function accountIsAuthoritative'));
    assert.equal(
      /\.from\([^)]*\)\s*\.select\([^)]*\)(?!\s*\.range)/.test(loadRows), false,
      'loadRows must not contain a select without .range()',
    );
    assert.ok(src.includes('.range(from, from + PAGE_SIZE - 1)'), 'the paginating reader must be used');
    for (const table of ['supplier_favorite_memberships', 'saved_assets', 'standardized_products', 'supplier_products']) {
      assert.ok(
        new RegExp(`readAll<[^>]*>\\(client, '${table}'`).test(src),
        `${table} must be read through the paginating reader`,
      );
    }
  });

  it('19. the SKU → product_id mapping is verified in reverse, and ambiguity fails closed', () => {
    const cache = [
      { supplier_product_id: 'CLEAN', product_id: 667968 },
      { supplier_product_id: 'CLEAN', product_id: 667968 },   // 同一映射的多行仓库记录
      { supplier_product_id: 'TWO-IDS', product_id: 111 },
      { supplier_product_id: 'TWO-IDS', product_id: 222 },
      { supplier_product_id: 'SHARES-A', product_id: 333 },
      { supplier_product_id: 'SHARES-B', product_id: 333 },
    ];
    const clean = resolveProductIdMapping('CLEAN', cache);
    assert.equal(clean.status, 'unique');
    assert.equal(clean.product_id, 667968);
    assert.equal(clean.verified_sku, 'CLEAN', 'product_id 必须反查回同一个 SKU');

    // 一个 SKU 对应多个 product_id → 不知道该删哪个。
    assert.equal(resolveProductIdMapping('TWO-IDS', cache).status, 'multiple_product_ids');
    assert.equal(resolveProductIdMapping('TWO-IDS', cache).product_id, null);

    // product_id 被两个 SKU 共用 → 删了会连累另一个。这正是反查存在的理由。
    assert.equal(resolveProductIdMapping('SHARES-A', cache).status, 'shared_product_id');
    assert.equal(resolveProductIdMapping('SHARES-A', cache).product_id, null);

    assert.equal(resolveProductIdMapping('UNKNOWN', cache).status, 'not_mapped');

    // 任何非 unique 的映射都必须让取消预览失败。
    for (const sku of ['TWO-IDS', 'SHARES-A', 'UNKNOWN']) {
      const m = resolveProductIdMapping(sku, cache);
      const p = previewRemoval({
        supplier_product_id: sku, product_id: m.product_id,
        verified_sku_for_product_id: m.verified_sku, approval, session_present: true,
      }, ON);
      assert.equal(p.ok, false, `${sku} 的映射不唯一，预览必须失败`);
      assert.equal(p.payload, null);
    }
  });

  // ── 15: the panel's numbers ────────────────────────────────────────────────

  it('15. the plan reports dual-account differences and the protection list', () => {
    const inputs: SupplierFavoriteInput[] = [
      removable({ supplier_product_id: 'BOTH-1' }),                                             // eligible
      removable({ supplier_product_id: 'PICKUP-1', dropship_is_saved: false, api_managed: true }),
      removable({ supplier_product_id: 'DROP-1', pickup_is_saved: false, published: true }),
      removable({ supplier_product_id: 'PENDING-1', asset_state: 'SAVED_CANDIDATE', founder_status: 'pending' }),
      removable({ supplier_product_id: 'FAILED-1', pickup_is_saved: null }),
      removable({ supplier_product_id: 'CONFLICT-1', identity_unique: false }),
    ];
    const accounts = [
      { account: 'pickup' as const, ok: true, total: 5, observed_at: '2026-08-06T00:00:00.000Z', error: null },
      { account: 'dropship' as const, ok: true, total: 4, observed_at: '2026-08-06T00:05:00.000Z', error: null },
    ];
    const plan = buildSupplierFavoritePlan(inputs, accounts);

    // BOTH-1, PENDING-1, CONFLICT-1 — the other three each miss one account or failed to read.
    assert.equal(plan.counts.both_accounts, 3);
    assert.equal(plan.counts.pickup_only, 1);
    assert.equal(plan.counts.dropship_only, 1);
    assert.equal(plan.counts.read_failed, 1);
    assert.equal(plan.counts.api_managed, 1);
    assert.equal(plan.counts.identity_conflicts, 1);
    assert.equal(plan.counts.pending_onboarding_protected, 1);
    assert.equal(plan.counts.cleanup_candidates, 1);
    assert.deepEqual(plan.cleanup_eligible.map(d => d.supplier_product_id), ['BOTH-1']);
    assert.deepEqual(plan.pending_onboarding.map(d => d.supplier_product_id), ['PENDING-1']);
    assert.deepEqual(plan.accounts, accounts);
  });

  it('manual actions cannot bypass pending-onboarding protection', () => {
    // Approving straight out of SAVED_CANDIDATE would defeat the whole protection.
    assert.equal(resolveManualAction('approve_for_cleanup', 'SAVED_CANDIDATE').allowed, false);
    assert.equal(resolveManualAction('approve_for_cleanup', 'HOLD').allowed, false);
    assert.equal(resolveManualAction('approve_for_cleanup', 'REVIEW_REQUIRED').allowed, false);

    const ok = resolveManualAction('approve_for_cleanup', 'RETIRE_CANDIDATE');
    assert.equal(ok.allowed, true);
    assert.equal(ok.next_asset_state, 'REMOVABLE');
    assert.equal(ok.next_founder_status, 'approved');

    // Protection and its release.
    assert.equal(resolveManualAction('protect_as_pending_onboarding', 'EVALUATING').next_asset_state, 'HOLD');
    assert.equal(resolveManualAction('release_protection', 'EVALUATING').allowed, false);
    assert.equal(resolveManualAction('release_protection', 'HOLD').next_asset_state, 'EVALUATING');

    // Revoking approval walks it back out of REMOVABLE.
    const revoked = resolveManualAction('revoke_cleanup_approval', 'REMOVABLE');
    assert.equal(revoked.next_asset_state, 'RETIRE_CANDIDATE');
    assert.equal(revoked.next_founder_status, 'pending');

    // Once removal is under way the panel is locked out.
    for (const state of ['AWAITING_REMOVAL_VERIFICATION', 'REMOVED'] as SavedAssetState[]) {
      assert.equal(resolveManualAction('approve_for_cleanup', state).allowed, false);
      assert.equal(resolveManualAction('protect_as_pending_onboarding', state).allowed, false);
    }
  });

  console.log(`\n${passed} passed`);
}

void main();
