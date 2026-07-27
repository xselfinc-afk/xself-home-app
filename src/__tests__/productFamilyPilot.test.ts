/**
 * Product Family pilot gate (Phase 2/6) — pure logic test of the allowlist that
 * decides which families render the multi-SKU PDP selector. Run:
 *   npx tsx src/__tests__/productFamilyPilot.test.ts
 */
import assert from 'node:assert/strict';
import {
  isPilotFamily,
  PRODUCT_FAMILY_PILOT_KEYS,
  PRODUCT_FAMILY_PILOT_ENABLED,
} from '../config/productFamilyPilot';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('product family pilot gate');

it('kill-switch flag is a boolean and pilot is currently ON', () => {
  assert.equal(typeof PRODUCT_FAMILY_PILOT_ENABLED, 'boolean');
  assert.equal(PRODUCT_FAMILY_PILOT_ENABLED, true);
});

it('an approved -vg- family key is enabled', () => {
  assert.equal(isPilotFamily('dr-vg-w409p266778-2door2drawer-w32'), true);
  assert.equal(isPilotFamily('dr-vg-n733p307938b'), true);
  assert.equal(isPilotFamily('cb-vg-w409p327399-4door-w63'), true);
});

it('unknown / null / empty keys are NOT enabled (default single-SKU)', () => {
  assert.equal(isPilotFamily('dr-9-drawer-dresser-63-large-deep'), false); // title-derived
  assert.equal(isPilotFamily('cb-vg-w331s00057-6door1drawer-w39'), false); // READY but not in initial allowlist
  assert.equal(isPilotFamily(null), false);
  assert.equal(isPilotFamily(undefined), false);
  assert.equal(isPilotFamily(''), false);
});

it('NO title-derived family is auto-enabled — every allowlisted key is authoritative -vg-', () => {
  for (const k of PRODUCT_FAMILY_PILOT_KEYS) {
    assert.ok(k.includes('-vg-'), `${k} must be an authoritative -vg- key`);
    assert.ok(!/cfgmissing|wmissing/.test(k), `${k} must not carry an unresolved config/width sentinel`);
  }
});

it('allowlist is the small verified initial set (exactly 3 families)', () => {
  assert.equal(PRODUCT_FAMILY_PILOT_KEYS.size, 3);
});

console.log(`\n${passed} pilot gate assertions passed.`);
