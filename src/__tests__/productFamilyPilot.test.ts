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

it('every approved -vg- family key is enabled (all 8 READY families)', () => {
  for (const k of [
    'dr-vg-w409p266778-2door2drawer-w32',
    'dr-vg-n733p307938b',
    'cb-vg-w409p327399-4door-w63',
    'cb-vg-w331s00057-6door1drawer-w39',
    'dr-vg-w1445s00002',
    'dr-vg-w1820s00068',
    'dr-vg-w409p387577',
    'dr-vg-w409s00014',
  ]) assert.equal(isPilotFamily(k), true, `${k} should be enabled`);
});

it('unknown / held / null / empty keys are NOT enabled (default single-SKU)', () => {
  assert.equal(isPilotFamily('dr-9-drawer-dresser-63-large-deep'), false); // title-derived
  assert.equal(isPilotFamily('dr-vg-xw000032aaa-5drawer-wmissing'), false); // HELD: unresolved width axis
  assert.equal(isPilotFamily('sb-vg-sp000075aac-cfgmissing-wmissing'), false); // HELD: unresolved config/width
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

it('allowlist is the full verified READY set (exactly 8 families)', () => {
  assert.equal(PRODUCT_FAMILY_PILOT_KEYS.size, 8);
});

console.log(`\n${passed} pilot gate assertions passed.`);
