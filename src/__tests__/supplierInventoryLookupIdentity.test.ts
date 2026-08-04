import assert from 'node:assert/strict';
import { resolveInventoryLookupIdentity } from '../services/supplierInventoryLookupIdentity';
import {
  extractSupplierRows,
  normalizeInventoryPayload,
  readSupplierAccountProductFacts,
  SupplierTargetedReadError,
} from '../../scripts/lib/gigaAccountReadClient';

async function main() {

const resolved = resolveInventoryLookupIdentity({
  xselfSku: 'XH-GH-HM-86617W',
  legacySupplierProductId: 'N707P186617W',
  associateProductList: ['N707S186617W', 'N707S186617E', 'N707S186617B', 'N707P186617B', 'N707P186617E'],
});
assert.deepEqual(resolved, {
  xself_sku: 'XH-GH-HM-86617W',
  lookup_identity: 'N707S186617W',
  source: 'supplier_products.raw_payload.associateProductList',
  confidence: 'verified_variant_relation',
  legacy_supplier_product_id: 'N707P186617W',
});
assert.notEqual(resolved.lookup_identity, resolved.legacy_supplier_product_id);
assert.notEqual(resolved.lookup_identity, resolved.xself_sku);

assert.throws(() => resolveInventoryLookupIdentity({
  xselfSku: 'XH-GH-HM-86617W',
  legacySupplierProductId: 'N707P186617W',
  associateProductList: [],
}), /Supplier Item Code/);

assert.doesNotThrow(() => resolveInventoryLookupIdentity({
  xselfSku: 'XH-GH-HM-86617W',
  legacySupplierProductId: 'N707P186617W',
  associateProductList: ['N707S186617W', 'N707S186617W'],
}), 'deduped exact relationship remains valid');

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
