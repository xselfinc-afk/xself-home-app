/**
 * Delivery account-separation & safety guard tests (pure; no React, no network, no secrets).
 *
 * Run with: npx tsx src/__tests__/deliveryGuards.test.ts
 *
 * Locks the Delivery/Pickup credential separation and the discovery safety guard so a
 * Delivery redesign cannot mix accounts or accidentally allow a production dropship call.
 * See docs/delivery-architecture.md and docs/fulfillment-rules.md.
 */

import assert from 'node:assert/strict';

import {
  DELIVERY_ENV,
  PICKUP_ENV,
  GIGA_SANDBOX_HOST,
  GIGA_PRODUCTION_HOST,
  isProductionHost,
  isSandboxHost,
  isMoneyMovingPath,
  assertSafeDiscoveryRequest,
} from '../config/supplierAccounts';

let passed = 0;
function it(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('Delivery guard tests');

it('Delivery env names are all SUPPLIER_DELIVERY_* and distinct from Pickup', () => {
  for (const name of Object.values(DELIVERY_ENV)) {
    assert.ok(name.startsWith('SUPPLIER_DELIVERY_'), `${name} must be a SUPPLIER_DELIVERY_* name`);
  }
  const pickup = new Set<string>(Object.values(PICKUP_ENV));
  for (const name of Object.values(DELIVERY_ENV)) {
    assert.ok(!pickup.has(name), `Delivery name ${name} collides with a Pickup env name`);
  }
  // Pickup uses the original SUPPLIER_* (not the delivery ones).
  assert.equal(PICKUP_ENV.clientId, 'SUPPLIER_CLIENT_ID');
  assert.equal(PICKUP_ENV.clientSecret, 'SUPPLIER_CLIENT_SECRET');
});

it('host detectors classify sandbox vs production correctly', () => {
  assert.equal(isSandboxHost(`https://${GIGA_SANDBOX_HOST}`), true);
  assert.equal(isProductionHost(`https://${GIGA_PRODUCTION_HOST}`), true);
  assert.equal(isSandboxHost(`https://${GIGA_PRODUCTION_HOST}`), false);
  assert.equal(isProductionHost(`https://${GIGA_SANDBOX_HOST}`), false);
});

it('money-moving paths are flagged (dropShip-sync, pickUpSelfLabel-sync, create, submit, cancel)', () => {
  assert.equal(isMoneyMovingPath('/b2b-overseas-api/v1/buyer/order/dropShip-sync/v1'), true);
  assert.equal(isMoneyMovingPath('/b2b-overseas-api/v1/buyer/order/pickUpSelfLabel-sync/v1'), true);
  assert.equal(isMoneyMovingPath('/b2b-overseas-api/v1/buyer/product/price/v1'), false);
  assert.equal(isMoneyMovingPath('/b2b-overseas-api/v1/buyer/product/skus/v1'), false);
});

it('assertSafeDiscoveryRequest allows sandbox read-only', () => {
  assert.doesNotThrow(() =>
    assertSafeDiscoveryRequest(`https://${GIGA_SANDBOX_HOST}`, '/b2b-overseas-api/v1/buyer/product/price/v1'),
  );
});

it('assertSafeDiscoveryRequest BLOCKS production host', () => {
  assert.throws(
    () => assertSafeDiscoveryRequest(`https://${GIGA_PRODUCTION_HOST}`, '/b2b-overseas-api/v1/buyer/product/price/v1'),
    /production host/i,
  );
});

it('assertSafeDiscoveryRequest BLOCKS money-moving path even on sandbox', () => {
  assert.throws(
    () => assertSafeDiscoveryRequest(`https://${GIGA_SANDBOX_HOST}`, '/b2b-overseas-api/v1/buyer/order/dropShip-sync/v1'),
    /money-moving/i,
  );
});

console.log(`\n${passed} delivery-guard assertions passed.`);
