import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  XONE_INVENTORY_LIFECYCLE_SCHEMA_VERSION,
  computeAvailabilityCoverage,
  deriveInventoryHealth,
  parseInventoryLifecycleBridgeRequest,
  readSchedulerFact,
  runTargetedRecheck,
} from '../../scripts/xoneInventoryLifecycleBridge';
import { SupplierTargetedReadError } from '../../scripts/lib/gigaAccountReadClient';

async function main() {

const summary = parseInventoryLifecycleBridgeRequest(JSON.stringify({
  schema_version: XONE_INVENTORY_LIFECYCLE_SCHEMA_VERSION,
  operation: 'summary',
}));
assert.equal(summary.operation, 'summary');

const items = parseInventoryLifecycleBridgeRequest(JSON.stringify({
  schema_version: '1.0',
  operation: 'items',
  bucket: 'eligible',
  limit: 100,
  cursor: 0,
  sku: 'XH-TEST_1',
}));
assert.equal(items.operation, 'items');

const targetedRecheck = parseInventoryLifecycleBridgeRequest(JSON.stringify({
  schema_version: '1.0',
  operation: 'recheck-item',
  sku: 'XH-GH-HM-86617W',
  operator: '你',
}));
assert.equal(targetedRecheck.operation, 'recheck-item');

for (const request of [
  { schema_version: '1.0', operation: 'items', bucket: 'unknown' },
  { schema_version: '1.0', operation: 'items', bucket: 'errors', limit: 101 },
  { schema_version: '1.0', operation: 'runs', command: 'rm -rf' },
  { schema_version: '1.0', operation: 'summary', path: '/tmp/anything' },
  { schema_version: '1.0', operation: 'summary', sql: 'select * from secrets' },
  { schema_version: '1.0', operation: 'summary', table: 'standardized_products' },
  { schema_version: '1.0', operation: 'recheck-item', sku: 'XH-GH-HM-86617W', operator: '你', script_path: '/tmp/unsafe.ts' },
  { schema_version: '1.0', operation: 'recheck-item', sku: 'XH-GH-HM-86617W', operator: '\nunsafe' },
  { schema_version: '1.0', operation: 'recheck-item', sku: '../unsafe', operator: '你' },
]) {
  assert.throws(() => parseInventoryLifecycleBridgeRequest(JSON.stringify(request)));
}

const scheduler = readSchedulerFact();
assert.equal(scheduler.label, 'com.xselfhome.inventory-availability-scan');
assert.equal(scheduler.interval_seconds, 172_800);
assert.equal(scheduler.cadence_label, '每 48 小时');
assert.equal(typeof scheduler.installed, 'boolean');
assert.equal(typeof scheduler.loaded, 'boolean');

const serialized = JSON.stringify(scheduler);
assert.equal(serialized.includes('SUPABASE_SERVICE_ROLE_KEY'), false);
assert.equal(serialized.includes('Authorization'), false);
assert.equal(serialized.includes('Cookie'), false);

// ===========================================================================
// Targeted recheck, driven entirely by fixtures. No supplier account is read.
// ===========================================================================

interface FixtureTables {
  standardized_products?: Record<string, unknown>[];
  supplier_products?: Record<string, unknown>[];
}

/** Minimal stand-in for the chained Supabase reads used by runTargetedRecheck. */
function fixtureClient(tables: FixtureTables) {
  const touched: string[] = [];
  const builder = (rows: Record<string, unknown>[]) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      limit: () => Promise.resolve({ data: rows, error: null }),
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        resolve({ data: rows, error: null }),
    };
    return chain;
  };
  return {
    touched,
    client: {
      from(table: string) {
        touched.push(table);
        return builder((tables as Record<string, Record<string, unknown>[]>)[table] ?? []);
      },
    } as never,
  };
}

const product = {
  supplier_product_id: 'N707P186617W',
  sku_custom: 'XH-GH-HM-86617W',
  product_title: '实木餐边柜',
  published: false,
  delist_reason: 'out_of_stock',
  primary_image: 'https://images.example.test/a.jpg',
  selling_price: 289,
  specifications_json: null,
  inventory_status: 'out_of_stock',
  total_available_qty: 0,
};
const relationship = {
  supplier_product_id: 'N707P186617W',
  raw_payload: { associateProductList: ['N707S186617W', 'N707S186617E', 'N707P186617E'] },
};
const secondProduct = { ...product, supplier_product_id: 'M312P940318437', sku_custom: 'XH-DR-BD-318437', product_title: '布艺床' };
const secondRelationship = {
  supplier_product_id: 'M312P940318437',
  raw_payload: { associateProductList: ['M312S940318437', 'M312P940318431'] },
};

const recheckRequest = (sku: string) => ({
  schema_version: '1.0' as const,
  operation: 'recheck-item' as const,
  sku,
  operator: '你',
});

const observedLookups: string[] = [];
const inStockFacts = (lookupIdentity: string, role: 'pickup' | 'dropship') => {
  observedLookups.push(lookupIdentity);
  return Promise.resolve({
    account: role,
    lookup_identity: lookupIdentity,
    favorite: true,
    detail_found: true,
    available: true,
    price: 185,
    total_available_qty: 12,
    warehouses: [{ warehouse_code: 'CA11', warehouse_name: null, available_qty_min: 12, state: 'CA' }],
    checked_at: new Date().toISOString(),
  } as never);
};

const allResponses: Record<string, unknown>[] = [];
const record = (response: Record<string, unknown>) => {
  allResponses.push(response);
  return response;
};

// --- Case 4: unknown SKU -> sku_not_found -------------------------------------
const notFound = record(await runTargetedRecheck(
  recheckRequest('XH-DOES-NOT-EXIST'),
  fixtureClient({ standardized_products: [] }).client,
  { readAccountFacts: () => { throw new Error('supplier must not be contacted'); } },
));
assert.equal(notFound.error_code, 'sku_not_found');
assert.equal((notFound.error as Record<string, unknown>).code, 'sku_not_found');
assert.equal((notFound.error as Record<string, unknown>).retryable, false);
assert.equal(notFound.targeted_recheck_result, 'failed');

// --- Case 5: duplicate SKU -> duplicate_sku -----------------------------------
const duplicate = record(await runTargetedRecheck(
  recheckRequest('XH-GH-HM-86617W'),
  fixtureClient({ standardized_products: [product, { ...product, supplier_product_id: 'OTHER' }] }).client,
  { readAccountFacts: () => { throw new Error('supplier must not be contacted'); } },
));
assert.equal(duplicate.error_code, 'duplicate_sku');
assert.equal((duplicate.error as Record<string, unknown>).code, 'duplicate_sku');

// --- Capability verification -------------------------------------------------
//
// Three real products (XH-CB-HM-06904C / E / K) were synced with a lean payload that has no
// associateProductList. Their own supplier_product_id is a legitimate identity — but only
// because it answers on every capability, not because of the letter it contains. It is queried
// like any candidate and accepted only when both accounts agree.

const leanProduct = {
  ...product,
  supplier_product_id: 'N710P206904K',
  sku_custom: 'XH-CB-HM-06904K',
  product_title: '30 英寸浴室柜',
  published: true,
  delist_reason: null,
  inventory_status: 'in_stock',
  total_available_qty: 72,
};
// The real payload shape: a `sku` field and no relation list at all.
const leanRelationship = {
  supplier_product_id: 'N710P206904K',
  raw_payload: { sku: 'N710P206904K', productName: '30 英寸浴室柜' },
};
const leanFixture = () => fixtureClient({
  standardized_products: [leanProduct],
  supplier_products: [leanRelationship],
}).client;

const capabilityLookups: string[] = [];
const capabilityVerified = record(await runTargetedRecheck(
  recheckRequest('XH-CB-HM-06904K'),
  leanFixture(),
  {
    readAccountFacts: (role, lookupIdentity) => {
      capabilityLookups.push(lookupIdentity);
      return inStockFacts(lookupIdentity, role);
    },
  },
));
assert.equal(capabilityVerified.error_code ?? null, null, '一个可真实查询的身份不应再报 identity_mapping_missing');
// Already published, so the outcome is a confirmation, not a restore proposal.
assert.equal(capabilityVerified.targeted_recheck_result, 'confirmed_in_stock');
assert.equal(capabilityVerified.production_write_attempted, false);
assert.deepEqual(capabilityLookups, ['N710P206904K', 'N710P206904K'], '两个账号都必须查询同一个候选身份');
assert.equal(
  capabilityLookups.includes('XH-CB-HM-06904K'),
  false,
  'XSelf SKU 永远不得用于查询供应商',
);
const verifiedIdentity = capabilityVerified.identity as Record<string, unknown>;
assert.equal(verifiedIdentity.lookup_identity, 'N710P206904K');
assert.equal(verifiedIdentity.identity_source, 'capability_verified_supplier_identity');
assert.equal(verifiedIdentity.identity_confidence, 'verified');

// Only one account can see it -> unproven. No promotion, no production write.
const singleAccountOnly = record(await runTargetedRecheck(
  recheckRequest('XH-CB-HM-06904K'),
  leanFixture(),
  {
    readAccountFacts: (role, lookupIdentity) => role === 'pickup'
      ? inStockFacts(lookupIdentity, role)
      : Promise.reject(new SupplierTargetedReadError('favorites_not_synchronized', 'Dropship Favorites 未同步', 'dropship', 'favorites')),
  },
));
assert.equal(singleAccountOnly.targeted_recheck_result, 'failed');
assert.equal(singleAccountOnly.error_code, 'dropship_favorites_read_error');
assert.equal(singleAccountOnly.inventory_status, 'unknown', '读取失败不得解释为缺货');
assert.equal(singleAccountOnly.restore_candidate, false);
assert.equal(singleAccountOnly.production_write_attempted, false);
assert.equal(singleAccountOnly.identity, null, '未通过验证的候选不得作为身份对外报告');
assert.equal(
  ((singleAccountOnly.error as Record<string, unknown>).details as Record<string, unknown>).identity_verification,
  'failed',
);

// Favorites hits but the detail capability fails -> unproven.
const detailFails = record(await runTargetedRecheck(
  recheckRequest('XH-CB-HM-06904K'),
  leanFixture(),
  {
    readAccountFacts: () => Promise.reject(
      new SupplierTargetedReadError('supplier_product_not_found', '商品详情未返回目标商品', 'pickup', 'product_detail'),
    ),
  },
));
assert.equal(detailFails.targeted_recheck_result, 'failed');
assert.equal(detailFails.error_code, 'product_detail_read_error');
assert.equal(detailFails.inventory_status, 'unknown');
assert.equal(detailFails.identity, null);

// The accounts answer about a different item -> conflict, never accepted.
const divergentIdentity = record(await runTargetedRecheck(
  recheckRequest('XH-CB-HM-06904K'),
  leanFixture(),
  {
    readAccountFacts: (role, lookupIdentity) => role === 'pickup'
      ? inStockFacts(lookupIdentity, role)
      : inStockFacts('N710P206904E', role),
  },
));
assert.equal(divergentIdentity.targeted_recheck_result, 'failed');
assert.equal(divergentIdentity.error_code, 'identity_mapping_conflict');
assert.equal(divergentIdentity.production_write_attempted, false);

// supplier_product_id disagrees with raw_payload.sku -> conflict before any supplier call.
const payloadSkuConflict = record(await runTargetedRecheck(
  recheckRequest('XH-CB-HM-06904K'),
  fixtureClient({
    standardized_products: [leanProduct],
    supplier_products: [{ supplier_product_id: 'N710P206904K', raw_payload: { sku: 'N710P206904W' } }],
  }).client,
  { readAccountFacts: () => { throw new Error('supplier must not be contacted'); } },
));
assert.equal(payloadSkuConflict.error_code, 'identity_mapping_conflict');
assert.equal((payloadSkuConflict.error as Record<string, unknown>).retryable, false);

// --- Case 7 via bridge: two siblings -> identity_mapping_conflict -------------
const identityConflict = record(await runTargetedRecheck(
  recheckRequest('XH-XX-XX-000001'),
  fixtureClient({
    standardized_products: [{ ...product, supplier_product_id: 'PP01', sku_custom: 'XH-XX-XX-000001' }],
    supplier_products: [{ supplier_product_id: 'PP01', raw_payload: { associateProductList: ['SP01', 'PS01'] } }],
  }).client,
  { readAccountFacts: () => { throw new Error('supplier must not be contacted'); } },
));
assert.equal(identityConflict.error_code, 'identity_mapping_conflict');

// --- Case 11: read failure is a read failure, never "out of stock" ------------
const favoritesFailure = record(await runTargetedRecheck(
  recheckRequest('XH-GH-HM-86617W'),
  fixtureClient({ standardized_products: [product], supplier_products: [relationship] }).client,
  {
    readAccountFacts: () => Promise.reject(
      new SupplierTargetedReadError('favorites_not_synchronized', 'Favorites 未同步', 'pickup', 'favorites'),
    ),
  },
));
assert.equal(favoritesFailure.error_code, 'pickup_favorites_read_error');
assert.equal(favoritesFailure.targeted_recheck_result, 'failed');
assert.notEqual(favoritesFailure.targeted_recheck_result, 'still_out_of_stock');
assert.equal(favoritesFailure.inventory_status, 'unknown');
assert.equal(favoritesFailure.restore_candidate, false);
assert.equal((favoritesFailure.error as Record<string, unknown>).retryable, true);

const dropshipFailure = record(await runTargetedRecheck(
  recheckRequest('XH-GH-HM-86617W'),
  fixtureClient({ standardized_products: [product], supplier_products: [relationship] }).client,
  {
    readAccountFacts: (role) => role === 'pickup'
      ? inStockFacts('N707S186617W', 'pickup')
      : Promise.reject(new SupplierTargetedReadError('dropship_account_read_error', 'Dropship 读取失败', 'dropship', 'favorites')),
  },
));
assert.equal(dropshipFailure.error_code, 'dropship_favorites_read_error');
assert.equal(dropshipFailure.inventory_status, 'unknown');

const inventoryFailure = record(await runTargetedRecheck(
  recheckRequest('XH-GH-HM-86617W'),
  fixtureClient({ standardized_products: [product], supplier_products: [relationship] }).client,
  {
    readAccountFacts: () => Promise.reject(
      new SupplierTargetedReadError('inventory_read_error', '库存结构不可确认', 'pickup', 'inventory'),
    ),
  },
));
assert.equal(inventoryFailure.error_code, 'inventory_read_error');
assert.equal(inventoryFailure.inventory_status, 'unknown');

// --- inventory_unknown: sellable but with no trustworthy quantity -------------
const quantityUnknown = record(await runTargetedRecheck(
  recheckRequest('XH-GH-HM-86617W'),
  fixtureClient({ standardized_products: [product], supplier_products: [relationship] }).client,
  {
    readAccountFacts: (role, lookupIdentity) => Promise.resolve({
      account: role,
      lookup_identity: lookupIdentity,
      favorite: true,
      detail_found: true,
      available: true,
      price: 185,
      total_available_qty: 0,
      warehouses: [],
      checked_at: new Date().toISOString(),
    } as never),
  },
));
assert.equal(quantityUnknown.error_code, 'inventory_unknown');
assert.equal(quantityUnknown.restore_candidate, false);

// --- confirmed_out_of_stock stays a distinct outcome --------------------------
const outOfStock = record(await runTargetedRecheck(
  recheckRequest('XH-GH-HM-86617W'),
  fixtureClient({ standardized_products: [product], supplier_products: [relationship] }).client,
  {
    readAccountFacts: (role, lookupIdentity) => Promise.resolve({
      account: role,
      lookup_identity: lookupIdentity,
      favorite: true,
      detail_found: true,
      available: false,
      price: 185,
      total_available_qty: 0,
      warehouses: [],
      checked_at: new Date().toISOString(),
    } as never),
  },
));
assert.equal(outOfStock.error_code, 'confirmed_out_of_stock');
assert.equal(outOfStock.targeted_recheck_result, 'still_out_of_stock');
assert.equal(outOfStock.restore_candidate, false);

// --- Case 12: confirmed_in_stock -> restore_candidate only, no write ----------
const firstSku = record(await runTargetedRecheck(
  recheckRequest('XH-GH-HM-86617W'),
  fixtureClient({ standardized_products: [product], supplier_products: [relationship] }).client,
  { readAccountFacts: (role, lookupIdentity) => inStockFacts(lookupIdentity, role) },
));
assert.equal(firstSku.targeted_recheck_result, 'confirmed_in_stock');
assert.equal(firstSku.restore_candidate, true);
assert.equal(firstSku.resulting_action, 'restore_candidate_recorded');
assert.equal(firstSku.restore_execution_enabled, false);
assert.equal(firstSku.production_write_attempted, false);
assert.equal(firstSku.error, null);

// --- Case 2 at bridge level: a second SKU works with no code change -----------
const secondSku = record(await runTargetedRecheck(
  recheckRequest('XH-DR-BD-318437'),
  fixtureClient({ standardized_products: [secondProduct], supplier_products: [secondRelationship] }).client,
  { readAccountFacts: (role, lookupIdentity) => inStockFacts(lookupIdentity, role) },
));
assert.equal(secondSku.targeted_recheck_result, 'confirmed_in_stock');
assert.equal(secondSku.restore_candidate, true);
assert.equal(
  (secondSku.identity as Record<string, unknown>).lookup_identity,
  'M312S940318437',
);

// --- Case 8/9: only the resolved identity ever reaches the supplier -----------
assert.equal(observedLookups.length > 0, true);
for (const lookup of observedLookups) {
  assert.equal(lookup.includes('XH-'), false, 'XSelf SKU must never be used as a supplier lookup');
  assert.notEqual(lookup, 'N707P186617W');
  assert.notEqual(lookup, 'M312P940318437');
}
// Two variant-relation identities plus the capability-verified ones. A capability-verified
// identity legitimately equals its supplier_product_id — that is what proving it is for.
assert.deepEqual(
  [...new Set(observedLookups)].sort(),
  ['M312S940318437', 'N707S186617W', 'N710P206904E', 'N710P206904K'],
);

// --- Cases 13/14: invariants hold on every single response --------------------
assert.equal(allResponses.length, 15);
for (const response of allResponses) {
  assert.equal(response.production_write_attempted, false, 'no fixture path may attempt a production write');
  assert.equal(response.other_items_scanned, 0, 'targeted recheck must never widen its scope');
  assert.equal(response.sku !== undefined, true);
  assert.equal(response.ok, true);
  assert.equal(JSON.stringify(response).includes('service_role'), false);
}

// ===========================================================================
// Source-level guarantees.
// ===========================================================================

const cli = spawnSync(
  path.join(process.cwd(), 'node_modules', '.bin', 'tsx'),
  [path.join(process.cwd(), 'scripts', 'xoneInventoryLifecycleBridge.ts')],
  {
    cwd: process.cwd(),
    encoding: 'utf8',
    input: JSON.stringify({ schema_version: '1.0', operation: 'summary', sql: 'select secret' }),
    env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' },
  },
);
assert.equal(cli.status, 0);
const stdoutLines = cli.stdout.trim().split('\n');
assert.equal(stdoutLines.length, 1, 'stdout must contain exactly one JSON envelope');
const invalidResponse = JSON.parse(stdoutLines[0]) as Record<string, any>;
assert.equal(invalidResponse.schema_version, '1.0');
assert.equal(invalidResponse.ok, false);
assert.equal(invalidResponse.error.code, 'INVALID_REQUEST');
assert.equal(invalidResponse.data_source, 'unavailable');
assert.equal(invalidResponse.is_stale, true);
assert.equal(invalidResponse.production_write_attempted, false);
assert.equal(cli.stdout.includes('service_role'), false);
assert.equal(cli.stdout.includes('SUPABASE'), false);

const scannerSource = fs.readFileSync(path.join(process.cwd(), 'scripts', 'scanPublishedAvailability.ts'), 'utf8');
assert.equal(scannerSource.includes("val('xone-targeted')"), true);
assert.equal(scannerSource.includes("`xone-targeted-${XONE_TARGETED_TOKEN}.json`"), true);
assert.equal(scannerSource.includes(".in('supplier_product_id', ONLY_SKUS)"), true);
// The detail fallback is targeted: only SKUs whose price row lacked a usable flag are re-read,
// and a failure there leaves them malformed_response rather than inventing an answer.
assert.equal(scannerSource.includes('classified.filter(NEEDS_DETAIL_FALLBACK)'), true);
assert.equal(scannerSource.includes('fetchDetailFallback(needsDetail)'), true);
assert.equal(scannerSource.includes('classifyBatch(batch, outcome, detailBySku)'), true);
assert.equal(scannerSource.includes('fetchProductDetails'), true);

const bridgeSource = fs.readFileSync(path.join(process.cwd(), 'scripts', 'xoneInventoryLifecycleBridge.ts'), 'utf8');
// Case 3: the single-SKU hardcode is gone and must not come back.
assert.equal(bridgeSource.includes('TARGETED_IDENTITY_REPAIR_SKU'), false);
assert.equal(bridgeSource.includes('XH-GH-HM-86617W'), false, 'no SKU may be hardcoded in the bridge');
assert.equal(bridgeSource.includes('target_scope_not_configured'), false);
assert.equal(bridgeSource.includes("readAccountFacts('pickup', lookupIdentity)"), true);
assert.equal(bridgeSource.includes("readAccountFacts('dropship', lookupIdentity)"), true);
// A candidate is only promoted after both accounts pass — never on the strength of its code.
assert.equal(bridgeSource.includes('acceptCapabilityVerifiedIdentity(pendingVerification)'), true);
assert.equal(bridgeSource.includes('supplierPayloadSku: relationshipRows[0].raw_payload?.sku'), true);
assert.equal(bridgeSource.includes('resolveInventoryLookupIdentity({'), true);
assert.equal(bridgeSource.includes("'corrected_lookup_identity'"), true);
assert.equal(bridgeSource.includes('other_items_scanned: 0'), true);
assert.equal(bridgeSource.includes('`--skus=${product.supplier_product_id}`'), false);
// The restore write stays behind an explicit switch.
assert.equal(bridgeSource.includes('RESTORE_EXECUTION_ENABLED'), true);
assert.equal(bridgeSource.includes("process.env.XONE_INVENTORY_RESTORE_ENABLED === 'true'"), true);

// ===========================================================================
// Coverage must measure evidence still inside the 72h grace window.
// Time is pinned so these never drift with the real clock.
// ===========================================================================

const NOW = new Date('2026-08-06T00:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
/** 证据行带上商品 id —— 覆盖率的分子必须能和「当前已发布」集合对上号。 */
const rows = (count: number, checkedAt: string | null, offset = 0) =>
  Array.from({ length: count }, (_unused, index) => ({
    supplier_product_id: `P${offset + index}`,
    checked_at: checkedAt,
  }));
/** 当前已发布集合。 */
const publishedSet = (count: number) => new Set(Array.from({ length: count }, (_u, i) => `P${i}`));

// 1. All evidence fresh -> full coverage.
const allFresh = computeAvailabilityCoverage(rows(10, hoursAgo(1)), publishedSet(10), NOW);
assert.deepEqual(allFresh, { published: 10, covered: 10, percent: 100 });

// 1b. 覆盖率永远不得超过 100%：证据表里留着早已下架商品的行时，它们不算进分子。
//     这正是概览显示 35200% 的形状 —— 分子来自实时证据，分母来自一次单件扫描的报告。
const withRetiredRows = computeAvailabilityCoverage(
  [...rows(352, hoursAgo(1)), ...rows(80, hoursAgo(1), 1_000)],
  publishedSet(353),
  NOW,
);
assert.equal(withRetiredRows.covered, 352, '已下架商品的证据行不得计入覆盖率分子');
assert.equal(withRetiredRows.published, 353);
assert.equal(withRetiredRows.percent, 99.7);
assert.ok(withRetiredRows.percent <= 100, '覆盖率永远不得超过 100%');

// 1c. 同一商品的多条证据行只算一次。
assert.equal(
  computeAvailabilityCoverage(
    [...rows(1, hoursAgo(1)), ...rows(1, hoursAgo(2))],
    publishedSet(2),
    NOW,
  ).covered,
  1,
  '重复行不得把覆盖率灌到分母之上',
);

// 2. Mostly expired -> coverage collapses to the true low value.
//    The 2026-08-05 incident shape: 350 rows, only 1 refreshed inside the window.
//    Ages are stated relative to the CURRENT 120h window, not the 72h one that caused it.
const incidentRows = [...rows(349, hoursAgo(130)), ...rows(1, hoursAgo(2), 349)];
const incident = computeAvailabilityCoverage(incidentRows, publishedSet(353), NOW);
assert.equal(incident.covered, 1);
assert.equal(incident.percent, 0.3);
// The old implementation counted any row that had ever been checked.
const oldStyleCovered = incidentRows.filter((row) => Boolean(row.checked_at)).length;
assert.equal(oldStyleCovered, 350, 'old algorithm reported 350/353 = 99.2% during the outage');

// 3. Everything expired -> coverage 0, and health must not be healthy.
const allExpired = computeAvailabilityCoverage(rows(353, hoursAgo(150)), publishedSet(353), NOW);
assert.deepEqual(allExpired, { published: 353, covered: 0, percent: 0 });
const expiredHealth = deriveInventoryHealth({
  runLockActive: false, schedulerLoaded: true, errors: 0,
  coverageBelowMinimum: allExpired.percent < 95,
});
assert.notEqual(expiredHealth, 'healthy', 'fully expired evidence must never report healthy');
assert.equal(expiredHealth, 'attention_required');

// 4. Missing or unparseable checked_at is never counted as covered.
assert.equal(computeAvailabilityCoverage(rows(5, null), publishedSet(5), NOW).covered, 0);
assert.equal(computeAvailabilityCoverage([{}, {}], publishedSet(2), NOW).covered, 0);
assert.equal(computeAvailabilityCoverage(rows(3, 'not-a-date'), publishedSet(3), NOW).covered, 0);

// 5. Grace boundary: exactly 120h still counts, past it does not.
assert.equal(computeAvailabilityCoverage(rows(1, hoursAgo(120)), publishedSet(1), NOW).covered, 1);
assert.equal(computeAvailabilityCoverage(rows(1, hoursAgo(120.5)), publishedSet(1), NOW).covered, 0);

// 5b. THE REGRESSION THAT CAUSED THE 2026-08-05 OUTAGE.
//     Cadence 48h, so one missed scan puts the next successful read at T+96h.
//     Under the old 72h window that evidence was already expired and the storefront emptied.
//     Under 120h it is still covered: a single failed scan must never hide the catalogue.
const oneMissedCycle = computeAvailabilityCoverage(rows(353, hoursAgo(96)), publishedSet(353), NOW);
assert.equal(oneMissedCycle.covered, 353, 'one missed 48h cycle must not expire the evidence');
assert.equal(oneMissedCycle.percent, 100);
assert.equal(
  deriveInventoryHealth({
    runLockActive: false, schedulerLoaded: true, errors: 0,
    coverageBelowMinimum: oneMissedCycle.percent < 95,
  }),
  'healthy',
  'a single missed cycle is not yet a risk state',
);
// Two missed cycles (T+144h) is beyond the window — that SHOULD surface as a risk.
const twoMissedCycles = computeAvailabilityCoverage(rows(353, hoursAgo(144)), publishedSet(353), NOW);
assert.equal(twoMissedCycles.covered, 0);
assert.notEqual(
  deriveInventoryHealth({
    runLockActive: false, schedulerLoaded: true, errors: 0,
    coverageBelowMinimum: twoMissedCycles.percent < 95,
  }),
  'healthy',
);

// 6. No published products -> 0 percent, no divide-by-zero.
assert.equal(computeAvailabilityCoverage([], publishedSet(0), NOW).percent, 0);

// 7. Health precedence is unchanged apart from the new coverage input.
assert.equal(deriveInventoryHealth({ runLockActive: true, schedulerLoaded: true, errors: 9, coverageBelowMinimum: true }), 'running');
assert.equal(deriveInventoryHealth({ runLockActive: false, schedulerLoaded: false, errors: 0, coverageBelowMinimum: false }), 'blocked');
assert.equal(deriveInventoryHealth({ runLockActive: false, schedulerLoaded: true, errors: 3, coverageBelowMinimum: false }), 'attention_required');
assert.equal(deriveInventoryHealth({ runLockActive: false, schedulerLoaded: true, errors: 0, coverageBelowMinimum: false }), 'healthy');

// 8. The bridge must measure coverage against the same window the storefront enforces.
//    A mismatch between these two numbers is what makes the monitor lie, so assert both ends.
assert.equal(bridgeSource.includes('AVAILABILITY_GRACE_HOURS = 120'), true);
assert.equal(bridgeSource.includes('AVAILABILITY_GRACE_HOURS = 72'), false);
const graceMigration = fs.readFileSync(
  path.join(process.cwd(), 'supabase', 'migrations', '20260808_availability_grace_120h.sql'),
  'utf8',
);
assert.equal(
  graceMigration.includes("(checked_at > now() - interval '120 hours') AS within_grace"),
  true,
  'the view and the bridge must use the same grace window',
);
assert.equal(bridgeSource.includes('sellable_now'), true);
assert.equal(
  bridgeSource.includes('availability.filter((row) => Boolean(row.checked_at)).length'),
  false,
  'the existence-only coverage count must not come back',
);

console.log('xoneInventoryLifecycleBridge tests passed');
}

void main();
