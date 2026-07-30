/**
 * Interstitial ad eligibility tests — pure; no I/O, no SDK, no clock, no secrets.
 * Covers computeInterstitialEligibility (the gate the manager uses) + isEligibleBrowseReturn.
 * Run: npx tsx src/__tests__/interstitialAdEligibility.test.ts
 */
import assert from 'node:assert/strict';
import {
  computeInterstitialEligibility,
  isEligibleBrowseReturn,
  type InterstitialEligibilityState,
} from '../services/interstitialAdEligibility';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const NOW = 1_000_000_000;
const MIN_SESSION = 180;   // 3 min
const MIN_INTERVAL = 600;  // 10 min

/**
 * All-green baseline: enabled, loaded, not busy, past the 3-min warm-up, no prior impression,
 * 3 detail views, returning ProductDetail -> Discover. Every named test perturbs ONE field.
 */
function base(over: Partial<InterstitialEligibilityState> = {}): InterstitialEligibilityState {
  return {
    enabled: true,
    currentRoute: 'Discover',
    previousRoute: 'ProductDetail',
    sessionStartMs: NOW - (MIN_SESSION * 1000 + 1000), // comfortably past warm-up
    nowMs: NOW,
    lastImpressionMs: 0,
    impressionsThisSession: 0,
    detailViewsThisSession: 3,
    adLoaded: true,
    adBusy: false,
    minSessionSec: MIN_SESSION,
    minIntervalSec: MIN_INTERVAL,
    maxPerSession: 1,
    minDetailViews: 3,
    ...over,
  };
}

console.log('interstitial ad eligibility tests');

it('eligible when everything is green (ProductDetail -> Discover)', () => {
  const r = computeInterstitialEligibility(base());
  assert.equal(r.eligible, true);
  assert.equal(r.reason, 'ok');
});

it('disabled -> false', () => {
  assert.deepEqual(computeInterstitialEligibility(base({ enabled: false })), { eligible: false, reason: 'disabled' });
});

it('test mode is NOT an eligibility input (unit selection only) — baseline stays eligible', () => {
  // There is no testMode field on the state; eligibility cannot depend on it.
  assert.equal(('testMode' in base()), false);
  assert.equal(computeInterstitialEligibility(base()).eligible, true);
});

it('first 3 minutes -> false (session warm-up)', () => {
  assert.equal(
    computeInterstitialEligibility(base({ sessionStartMs: NOW - (MIN_SESSION * 1000 - 1) })).reason,
    'session_warmup',
  );
});

it('fewer than 3 detail views -> false', () => {
  assert.equal(computeInterstitialEligibility(base({ detailViewsThisSession: 2 })).reason, 'insufficient_browsing');
});

it('ProductDetail as current route -> false (never on ProductDetail)', () => {
  assert.equal(
    computeInterstitialEligibility(base({ currentRoute: 'ProductDetail', previousRoute: 'Discover' })).reason,
    'not_browse_return',
  );
});

it('Cart -> false', () => {
  assert.equal(computeInterstitialEligibility(base({ currentRoute: 'CartMain' })).reason, 'not_browse_return');
  assert.equal(computeInterstitialEligibility(base({ currentRoute: 'Cart' })).reason, 'not_browse_return');
});

it('Checkout -> false', () => {
  assert.equal(computeInterstitialEligibility(base({ currentRoute: 'Checkout' })).reason, 'not_browse_return');
});

it('OrderSuccess -> false', () => {
  assert.equal(computeInterstitialEligibility(base({ currentRoute: 'OrderSuccess' })).reason, 'not_browse_return');
});

it('Support -> false', () => {
  assert.equal(computeInterstitialEligibility(base({ currentRoute: 'Support' })).reason, 'not_browse_return');
});

it('return that did NOT come from ProductDetail -> false', () => {
  // e.g. Cart -> Discover (a tab switch) is not a browse-break return.
  assert.equal(computeInterstitialEligibility(base({ previousRoute: 'CartMain' })).reason, 'not_browse_return');
});

it('eligible ProductDetail -> Discover return -> true', () => {
  assert.equal(computeInterstitialEligibility(base({ currentRoute: 'Discover' })).eligible, true);
});

it('eligible ProductDetail -> Home return -> true', () => {
  assert.equal(computeInterstitialEligibility(base({ currentRoute: 'Home' })).eligible, true);
});

it('eligible ProductDetail -> Search return -> true', () => {
  assert.equal(computeInterstitialEligibility(base({ currentRoute: 'Search' })).eligible, true);
});

it('eligible ProductDetail -> Collection return -> true', () => {
  assert.equal(computeInterstitialEligibility(base({ currentRoute: 'Collection' })).eligible, true);
});

it('maximum 1 per session -> false after one impression', () => {
  assert.equal(computeInterstitialEligibility(base({ impressionsThisSession: 1, maxPerSession: 1 })).reason, 'session_capped');
});

it('less than 10 minutes since last impression -> false', () => {
  // Raise the per-session cap so we reach the interval gate specifically.
  assert.equal(
    computeInterstitialEligibility(base({
      maxPerSession: 2, impressionsThisSession: 1, lastImpressionMs: NOW - (5 * 60 * 1000),
    })).reason,
    'frequency_capped',
  );
});

it('not loaded -> false (a failed/absent load simply does nothing)', () => {
  assert.equal(computeInterstitialEligibility(base({ adLoaded: false })).reason, 'not_loaded');
});

it('currently showing/loading -> false', () => {
  assert.equal(computeInterstitialEligibility(base({ adBusy: true })).reason, 'ad_busy');
});

it('exact boundary at 180 seconds is allowed', () => {
  assert.equal(computeInterstitialEligibility(base({ sessionStartMs: NOW - MIN_SESSION * 1000 })).eligible, true);
});

it('exact boundary at 600 seconds is allowed', () => {
  assert.equal(
    computeInterstitialEligibility(base({
      maxPerSession: 2, impressionsThisSession: 1, lastImpressionMs: NOW - MIN_INTERVAL * 1000,
    })).eligible,
    true,
  );
});

it('counter reset behavior: after a display, detailViews=0 makes it ineligible until 3 more views', () => {
  // Post-display manager state: impression recorded, detail-view counter reset to 0.
  // With the cap raised to isolate the browsing gate, it must report insufficient_browsing.
  const postDisplay = base({ impressionsThisSession: 1, maxPerSession: 2, detailViewsThisSession: 0, lastImpressionMs: NOW - MIN_INTERVAL * 1000 });
  assert.equal(computeInterstitialEligibility(postDisplay).reason, 'insufficient_browsing');
  // And at the default cap of 1, a second show is impossible regardless of browsing.
  assert.equal(computeInterstitialEligibility(base({ impressionsThisSession: 1, detailViewsThisSession: 9 })).reason, 'session_capped');
});

it('no navigation blockage contract: when nothing is loaded, the gate says not_loaded (manager then no-ops)', () => {
  // The pure gate never shows without a loaded ad; the manager swallows load/show errors
  // and returns immediately, so navigation is never blocked on failure.
  assert.equal(computeInterstitialEligibility(base({ adLoaded: false, adBusy: true })).reason, 'not_loaded');
});

it('master disabled takes precedence over an otherwise-eligible return', () => {
  assert.equal(computeInterstitialEligibility(base({ enabled: false, currentRoute: 'Home' })).reason, 'disabled');
});

it('isEligibleBrowseReturn: only ProductDetail -> {Home,Discover,Search,Collection}', () => {
  assert.equal(isEligibleBrowseReturn('ProductDetail', 'Discover'), true);
  assert.equal(isEligibleBrowseReturn('ProductDetail', 'Home'), true);
  assert.equal(isEligibleBrowseReturn('ProductDetail', 'Search'), true);
  assert.equal(isEligibleBrowseReturn('ProductDetail', 'Collection'), true);
  assert.equal(isEligibleBrowseReturn('ProductDetail', 'CartMain'), false);
  assert.equal(isEligibleBrowseReturn('ProductDetail', 'Checkout'), false);
  assert.equal(isEligibleBrowseReturn('ProductDetail', 'ProductDetail'), false);
  assert.equal(isEligibleBrowseReturn('Discover', 'Home'), false); // not from ProductDetail
  assert.equal(isEligibleBrowseReturn(undefined, 'Home'), false);
  assert.equal(isEligibleBrowseReturn('ProductDetail', undefined), false);
});

console.log(`\n${passed} passed`);
