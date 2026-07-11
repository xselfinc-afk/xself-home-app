/**
 * App Open ad eligibility tests — pure; no I/O, no SDK, no clock, no secrets.
 * Covers computeEligibility (the gate the manager uses) + isSuppressedRoute.
 * Run: npx tsx src/__tests__/appOpenAdEligibility.test.ts
 */
import assert from 'node:assert/strict';
import {
  computeEligibility,
  isSuppressedRoute,
  type EligibilityState,
} from '../services/appOpenAdEligibility';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const NOW = 1_000_000_000;
const EXPIRY = 4 * 60 * 60 * 1000; // 4h
const MIN_INTERVAL = 14400;        // 4h

/** All-green baseline: enabled, loaded (fresh), on Home, never shown. */
function base(over: Partial<EligibilityState> = {}): EligibilityState {
  return {
    adsEnabled: true,
    appOpenEnabled: true,
    adLoaded: true,
    currentRoute: 'Home',
    nowMs: NOW,
    lastShownMs: 0,
    loadedAtMs: NOW - 1000,
    minIntervalSec: MIN_INTERVAL,
    expiryMs: EXPIRY,
    isShowing: false,
    ...over,
  };
}

console.log('app open ad eligibility tests');

it('eligible when everything is green', () => {
  const r = computeEligibility(base());
  assert.equal(r.eligible, true);
  assert.equal(r.reason, 'ok');
});

it('blocked when master adsEnabled is false', () => {
  assert.deepEqual(computeEligibility(base({ adsEnabled: false })), { eligible: false, reason: 'ads_disabled' });
});

it('blocked when appOpenEnabled is false (default OFF)', () => {
  assert.deepEqual(computeEligibility(base({ appOpenEnabled: false })), { eligible: false, reason: 'app_open_disabled' });
});

it('blocked when already showing', () => {
  assert.equal(computeEligibility(base({ isShowing: true })).reason, 'already_showing');
});

it('blocked when no ad is loaded', () => {
  assert.equal(computeEligibility(base({ adLoaded: false })).reason, 'not_loaded');
});

it('blocked on every transaction route', () => {
  for (const route of ['Checkout', 'OrderSuccess', 'Cart', 'CartMain']) {
    assert.equal(computeEligibility(base({ currentRoute: route })).reason, 'suppressed_route', route);
  }
});

it('allowed on non-transaction routes (Home, Discover)', () => {
  assert.equal(computeEligibility(base({ currentRoute: 'Home' })).eligible, true);
  assert.equal(computeEligibility(base({ currentRoute: 'Discover' })).eligible, true);
});

it('blocked when the loaded ad has expired', () => {
  assert.equal(computeEligibility(base({ loadedAtMs: NOW - EXPIRY })).reason, 'expired');
});

it('fresh ad just inside the expiry window is allowed', () => {
  assert.equal(computeEligibility(base({ loadedAtMs: NOW - (EXPIRY - 1) })).eligible, true);
});

it('blocked by the frequency cap (shown too recently)', () => {
  assert.equal(computeEligibility(base({ lastShownMs: NOW - 1000 })).reason, 'frequency_capped');
});

it('allowed once the frequency-cap interval has elapsed', () => {
  assert.equal(computeEligibility(base({ lastShownMs: NOW - (MIN_INTERVAL * 1000 + 1) })).eligible, true);
});

it('master switch takes precedence over a suppressed route', () => {
  // adsEnabled=false AND on Checkout → reports ads_disabled (checked first)
  assert.equal(computeEligibility(base({ adsEnabled: false, currentRoute: 'Checkout' })).reason, 'ads_disabled');
});

it('isSuppressedRoute: transaction routes true, others/empty false', () => {
  assert.equal(isSuppressedRoute('Checkout'), true);
  assert.equal(isSuppressedRoute('OrderSuccess'), true);
  assert.equal(isSuppressedRoute('Home'), false);
  assert.equal(isSuppressedRoute(undefined), false);
  assert.equal(isSuppressedRoute(null), false);
});

console.log(`\n${passed} passed`);
