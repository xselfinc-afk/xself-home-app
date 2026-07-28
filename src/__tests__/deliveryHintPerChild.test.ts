/**
 * Per-child PDP delivery/pickup availability (Option B) — proves the PDP hint reflects
 * the SELECTED child SKU's real CA-pickup capability (sellable_products.has_ca_pickup) and
 * NEVER advertises pickup for a shipping-only child. Pure truth-table for the extracted
 * helper + source-structure guards on the data plumbing (repo has no React renderer).
 *
 * Run: npx tsx src/__tests__/deliveryHintPerChild.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAvailabilityHint } from '../utils/deliveryEligibility';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('per-child delivery/pickup hint (Option B)');

it('child with NO CA pickup can only ship — pickup is NEVER advertised, whatever the buyer location', () => {
  assert.equal(resolveAvailabilityHint(false, undefined), 'Shipping available');
  assert.equal(resolveAvailabilityHint(false, 'PICKUP'), 'Shipping available'); // even if buyer is near a warehouse
  assert.equal(resolveAvailabilityHint(false, 'SHIPPING'), 'Shipping available');
  assert.equal(resolveAvailabilityHint(false, 'UNKNOWN'), 'Shipping available');
});

it('child WITH CA pickup falls back to buyer-location eligibility', () => {
  assert.equal(resolveAvailabilityHint(true, 'PICKUP'), 'Pickup available');
  assert.equal(resolveAvailabilityHint(true, 'SHIPPING'), 'Shipping available');
  assert.equal(resolveAvailabilityHint(true, undefined), 'Pickup & shipping available'); // no ZIP entered
});

it('data plumbing: has_ca_pickup is fetched, typed, and adapted per child', () => {
  const svc = readFileSync(join(process.cwd(), 'src/services/productFamilyService.ts'), 'utf8');
  assert.ok(/FAMILY_SELECT[\s\S]*has_ca_pickup/.test(svc), 'FAMILY_SELECT fetches has_ca_pickup');
  const adapter = readFileSync(join(process.cwd(), 'src/services/detailProductAdapter.ts'), 'utf8');
  assert.ok(adapter.includes('hasCaPickup: r.has_ca_pickup'), 'adaptStandardizedRow maps has_ca_pickup per row');
  const products = readFileSync(join(process.cwd(), 'src/data/products.ts'), 'utf8');
  assert.ok(/hasCaPickup\?:\s*boolean/.test(products), 'Product type carries hasCaPickup');
});

it('PDP hint is now driven by the SERVER advisory for the selected child (supersedes has_ca_pickup)', () => {
  const app = readFileSync(join(process.cwd(), 'App.tsx'), 'utf8');
  assert.ok(app.includes('fetchFulfillmentAdvisory(selectedChildId'), 'PDP fetches advisory for the selected child');
  assert.ok(app.includes('FULFILLMENT_COPY[advisory.state]'), 'hint renders the server-resolved 4-state copy');
  assert.ok(/advisoryReqRef/.test(app), 'request-version guard prevents stale sibling results');
  // The old client-side hasCaPickup/resolveAvailabilityHint hint authority is retired from the PDP.
  assert.equal(app.includes('resolveAvailabilityHint(getCachedDelivery'), false, 'old client hint retired');
});

console.log(`\n${passed} per-child delivery hint assertions passed.`);
