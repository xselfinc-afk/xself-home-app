import assert from 'node:assert/strict';
import {
  isResolvedInventoryLookupIdentity,
  resolveInventoryLookupIdentity,
} from '../services/supplierInventoryLookupIdentity';
import {
  extractSupplierRows,
  normalizeInventoryPayload,
  readSupplierAccountProductFacts,
  SupplierTargetedReadError,
} from '../../scripts/lib/gigaAccountReadClient';

async function main() {

// ---------------------------------------------------------------------------
// Case 1 — the original SKU still resolves, and now through the result API.
// ---------------------------------------------------------------------------
const original = resolveInventoryLookupIdentity({
  xselfSku: 'XH-GH-HM-86617W',
  legacySupplierProductId: 'N707P186617W',
  associateProductList: ['N707S186617W', 'N707S186617E', 'N707S186617B', 'N707P186617B', 'N707P186617E'],
});
assert.equal(isResolvedInventoryLookupIdentity(original), true);
assert.deepEqual(original, {
  xself_sku: 'XH-GH-HM-86617W',
  legacy_supplier_product_id: 'N707P186617W',
  lookup_identity: 'N707S186617W',
  identity_source: 'supplier_products.raw_payload.associateProductList',
  identity_confidence: 'verified_variant_relation',
  identity_error: null,
});

// ---------------------------------------------------------------------------
// Case 2 — a second, unrelated XSelf SKU resolves with no code change.
// ---------------------------------------------------------------------------
const second = resolveInventoryLookupIdentity({
  xselfSku: 'XH-DR-BD-318437',
  legacySupplierProductId: 'M312P940318437',
  associateProductList: ['M312S940318437', 'M312S940318431', 'M312P940318431'],
});
assert.equal(isResolvedInventoryLookupIdentity(second), true);
assert.equal(second.lookup_identity, 'M312S940318437');
assert.equal(second.identity_confidence, 'verified_variant_relation');
assert.equal(second.identity_error, null);

// A third family, to prove the rule is not tied to any one prefix or length.
const third = resolveInventoryLookupIdentity({
  xselfSku: 'XH-CB-LR-183068',
  legacySupplierProductId: 'K90P77183068',
  associateProductList: ['K90S77183068', 'K90P77183069'],
});
assert.equal(third.lookup_identity, 'K90S77183068');

// ---------------------------------------------------------------------------
// Case 9 — the legacy supplier_product_id is never returned as the identity.
// ---------------------------------------------------------------------------
for (const resolved of [original, second, third]) {
  assert.notEqual(resolved.lookup_identity, resolved.legacy_supplier_product_id);
  assert.notEqual(resolved.lookup_identity, resolved.xself_sku);
}

// ---------------------------------------------------------------------------
// Case 6 — no usable sibling code -> identity_mapping_missing, never a guess.
// ---------------------------------------------------------------------------
const missing = resolveInventoryLookupIdentity({
  xselfSku: 'XH-GH-HM-86617W',
  legacySupplierProductId: 'N707P186617W',
  associateProductList: [],
});
assert.equal(isResolvedInventoryLookupIdentity(missing), false);
assert.equal(missing.lookup_identity, null);
assert.equal(missing.identity_error?.code, 'identity_mapping_missing');
assert.equal(missing.identity_error?.retryable, false);
assert.equal(missing.identity_error?.details.candidate_count, 0);

// ---------------------------------------------------------------------------
// Case 10 — the identity is selected, never constructed. The expected S code is
// absent from the supplier list, so resolution fails instead of rewriting P->S.
// ---------------------------------------------------------------------------
const notSynthesized = resolveInventoryLookupIdentity({
  xselfSku: 'XH-GH-HM-86617W',
  legacySupplierProductId: 'N707P186617W',
  associateProductList: ['N707S186617E', 'N707S186617B'],
});
assert.equal(notSynthesized.lookup_identity, null);
assert.equal(notSynthesized.identity_error?.code, 'identity_mapping_missing');
assert.equal(
  notSynthesized.identity_error?.details.candidates.includes('N707S186617W'),
  false,
  'the resolver must not invent the sibling code the supplier did not provide',
);

// ---------------------------------------------------------------------------
// Case 7 — more than one structurally valid sibling -> identity_mapping_conflict.
// ---------------------------------------------------------------------------
const conflict = resolveInventoryLookupIdentity({
  xselfSku: 'XH-XX-XX-000001',
  legacySupplierProductId: 'PP01',
  associateProductList: ['SP01', 'PS01'],
});
assert.equal(conflict.lookup_identity, null);
assert.equal(conflict.identity_error?.code, 'identity_mapping_conflict');
assert.equal(conflict.identity_error?.details.candidate_count, 2);

// Invalid input is its own code, not silently treated as "missing mapping".
const invalid = resolveInventoryLookupIdentity({
  xselfSku: '   ',
  legacySupplierProductId: 'N707P186617W',
  associateProductList: ['N707S186617W'],
});
assert.equal(invalid.identity_error?.code, 'identity_input_invalid');

// Duplicated entries in supplier data still count as one relationship.
const deduped = resolveInventoryLookupIdentity({
  xselfSku: 'XH-GH-HM-86617W',
  legacySupplierProductId: 'N707P186617W',
  associateProductList: ['N707S186617W', 'N707S186617W'],
});
assert.equal(deduped.lookup_identity, 'N707S186617W');

// ---------------------------------------------------------------------------
// Existing supplier read-client behaviour must stay intact.
// ---------------------------------------------------------------------------
assert.deepEqual(extractSupplierRows({ data: { records: [{ sku: 'S1' }] } }), [{ sku: 'S1' }]);
const inventory = normalizeInventoryPayload({ data: [{
  sku: 'N707S186617W',
  sellerInventoryInfo: { sellerInventoryDistribution: [
    { warehouseCode: 'CA11', availableQtyMin: 10 },
    { warehouseCode: 'AT4', availableQtyMin: 50 },
    { warehouseCode: 'CAN2', availableQtyMin: 50 },
  ] },
}] }, 'N707S186617W');
assert.equal(inventory?.total_available_qty, 110);
assert.equal(inventory?.warehouses[0]?.state, 'CA');
assert.equal(inventory?.warehouses[2]?.state, null, 'CAN warehouse is not a California warehouse');
assert.equal(normalizeInventoryPayload({ data: [] }, 'N707S186617W'), null);
assert.equal(normalizeInventoryPayload({ data: [{
  sku: 'N707S186617W',
  sellerInventoryInfo: { sellerAvailableInventory: 169, sellerInventoryDistribution: [] },
}] }, 'N707S186617W')?.total_available_qty, 169);

// ---------------------------------------------------------------------------
// Case 8 — supplier calls carry the resolved identity only.
// ---------------------------------------------------------------------------
const expectedIdentity = 'N707S186617W';
const forbiddenIdentities = ['N707P186617W', 'XH-GH-HM-86617W'];
const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
const accountConfig = {
  role: 'pickup' as const,
  source: '.env.giga-alt.local' as const,
  baseUrl: 'https://supplier.example.test',
  clientId: 'test-client',
  clientSecret: 'test-secret',
};
const mockFetch = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  requests.push({ url, body });
  const payload = url.endsWith('/skus/v1')
    ? { success: true, code: 200, data: { records: [{ sku: expectedIdentity }], pageInfo: { totalPage: 1 } } }
    : url.endsWith('/detailInfo/v1')
      ? { success: true, code: 200, data: [{ sku: expectedIdentity, skuAvailable: true }] }
      : url.endsWith('/price/v1')
        ? { success: true, code: 200, data: [{ sku: expectedIdentity, skuAvailable: true, price: 185 }] }
        : { success: true, code: 200, data: [{ sku: expectedIdentity, sellerInventoryInfo: { sellerInventoryDistribution: [{ warehouseCode: 'CA11', availableQtyMin: 10 }] } }] };
  return new Response(JSON.stringify(payload), { status: 200 });
};

const facts = await readSupplierAccountProductFacts('pickup', expectedIdentity, {
  config: accountConfig,
  fetcher: mockFetch,
});
assert.equal(facts.lookup_identity, expectedIdentity);
assert.equal(facts.favorite, true);
assert.equal(facts.available, true);
assert.equal(facts.price, 185);
assert.equal(facts.total_available_qty, 10);
assert.equal(requests.length, 4);
for (const request of requests) {
  const serializedRequest = JSON.stringify(request.body);
  for (const forbidden of forbiddenIdentities) assert.equal(serializedRequest.includes(forbidden), false);
  if ('skus' in request.body) assert.deepEqual(request.body.skus, [expectedIdentity]);
}

await assert.rejects(
  () => readSupplierAccountProductFacts('pickup', expectedIdentity, {
    config: accountConfig,
    fetcher: async () => new Response(JSON.stringify({ success: true, code: 200, data: { records: [], pageInfo: { totalPage: 1 } } }), { status: 200 }),
  }),
  (error: unknown) => error instanceof SupplierTargetedReadError && error.code === 'favorites_not_synchronized',
);

let missingDetailCalls = 0;
await assert.rejects(
  () => readSupplierAccountProductFacts('pickup', expectedIdentity, {
    config: accountConfig,
    fetcher: async (input) => {
      missingDetailCalls += 1;
      const url = String(input);
      const payload = url.endsWith('/skus/v1')
        ? { success: true, code: 200, data: { records: [{ sku: expectedIdentity }], pageInfo: { totalPage: 1 } } }
        : { success: true, code: 200, data: [] };
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  }),
  (error: unknown) => error instanceof SupplierTargetedReadError && error.code === 'supplier_product_not_found',
);
assert.equal(missingDetailCalls, 2, 'missing detail must stop before availability/inventory and must not become out-of-stock');

console.log('supplier inventory lookup identity tests passed');
}

void main();
