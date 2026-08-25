/**
 * Pay-After-Pickup domain-logic regression (pure; no DB, no network, no Stripe).
 *
 * Covers the pure-logic items from the Phase-1 test list:
 *   authorization success != paid · BOL release requires a LIVE AUTHORIZED hold ·
 *   expired authorization blocks release · amount mismatch blocks release ·
 *   requires_payment_method handoff (not mis-recorded FAILED) · confirm pickup before capture ·
 *   issue blocks capture · capture only the AUTHORIZED hold · due policy · capture schedule.
 *
 * Run: npx tsx src/__tests__/pickupPayAfterPickup.test.ts
 */
import assert from 'node:assert/strict';
import {
  type AuthorizationRecord,
  CAPTURE_SAFETY_MARGIN_MS,
  computeCaptureSchedule,
  computePaymentDue,
  evaluateCaptureEligibility,
  evaluateReleaseGate,
  extractCaptureBeforeIso,
  hasAuthorizationLapsed,
  isAuthorizationLive,
  isPastDue,
  mapAuthorizationStatus,
  MissingPickupTimingError,
} from '../../supabase/functions/_shared/pickup/pickupDomain';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const NOW = new Date('2026-08-25T12:00:00Z');
const hour = 3600_000;

const liveAuth = (over: Partial<AuthorizationRecord> = {}): AuthorizationRecord => ({
  status: 'AUTHORIZED',
  amount_cents: 8000,
  capture_before: new Date(NOW.getTime() + 48 * hour).toISOString(),
  provider_payment_intent_id: 'pi_live',
  ...over,
});

const baseOrder = {
  order_id: 'PU-1', fulfillment_method: 'pickup' as const, status: 'pending_pickup',
  pickup_stage: 'AUTHORIZED', total_cents: 8000, payment_method_saved_at: NOW.toISOString(),
  customer_email: 'c@example.com',
};
const originalBol = { document_type: 'ORIGINAL_BOL', released_at: null, superseded_at: null };
const releaseInput = (over: Record<string, unknown> = {}) => ({
  order: baseOrder, supplierOrderExists: true, originalBol, authorization: liveAuth(), at: NOW, ...over,
});

function main(): void {
  console.log('Pay-After-Pickup domain logic');

  // ── authorization state model ────────────────────────────────────────────────
  it('AUTHORIZED is a hold, NOT captured/paid (requires_capture → AUTHORIZED)', () => {
    assert.equal(mapAuthorizationStatus('requires_capture'), 'AUTHORIZED');
    assert.notEqual(mapAuthorizationStatus('requires_capture'), 'CAPTURED');
    assert.equal(mapAuthorizationStatus('succeeded'), 'CAPTURED'); // only after capture
    assert.equal(isAuthorizationLive(liveAuth(), NOW), true);
  });

  it('requires_payment_method handoff: decline after confirm = FAILED, untouched = REQUIRES_ACTION', () => {
    assert.equal(mapAuthorizationStatus('requires_payment_method', { afterConfirmAttempt: true }), 'FAILED');
    assert.equal(mapAuthorizationStatus('requires_payment_method', { afterConfirmAttempt: false }), 'REQUIRES_ACTION');
    assert.equal(mapAuthorizationStatus('requires_action'), 'REQUIRES_ACTION');
    assert.equal(mapAuthorizationStatus('requires_confirmation'), 'REQUIRES_CONFIRMATION');
  });

  // ── BOL release gate ─────────────────────────────────────────────────────────
  it('release requires a live AUTHORIZED hold — all preconditions met → ok', () => {
    const r = evaluateReleaseGate(releaseInput());
    assert.equal(r.ok, true, JSON.stringify(r.failed));
  });

  it('no authorization blocks release', () => {
    const r = evaluateReleaseGate(releaseInput({ authorization: undefined }));
    assert.equal(r.ok, false);
    assert.ok(r.failed.some(f => f.key === 'payment_authorized'));
  });

  it('EXPIRED authorization blocks release (fail-closed)', () => {
    const expired = liveAuth({ capture_before: new Date(NOW.getTime() - hour).toISOString() });
    assert.equal(hasAuthorizationLapsed(expired, NOW), true);
    const r = evaluateReleaseGate(releaseInput({ authorization: expired }));
    assert.equal(r.ok, false);
    assert.ok(r.failed.some(f => f.key === 'payment_authorized' && /lapsed/.test(f.detail)));
  });

  it('AMOUNT MISMATCH blocks release', () => {
    const r = evaluateReleaseGate(releaseInput({ authorization: liveAuth({ amount_cents: 7000 }) }));
    assert.equal(r.ok, false);
    assert.ok(r.failed.some(f => f.key === 'payment_authorized' && /order is 8000/.test(f.detail)));
  });

  it('missing supplier order / original BOL / already-released each block release', () => {
    assert.equal(evaluateReleaseGate(releaseInput({ supplierOrderExists: false })).ok, false);
    assert.equal(evaluateReleaseGate(releaseInput({ originalBol: undefined })).ok, false);
    assert.equal(evaluateReleaseGate(releaseInput({ originalBol: { ...originalBol, released_at: NOW.toISOString() } })).ok, false);
  });

  it('missing saved payment method blocks release', () => {
    const r = evaluateReleaseGate(releaseInput({ order: { ...baseOrder, payment_method_saved_at: null } }));
    assert.equal(r.ok, false);
    assert.ok(r.failed.some(f => f.key === 'payment_setup_ready'));
  });

  // ── capture eligibility ──────────────────────────────────────────────────────
  const confirmed = { order_id: 'PU-1', pickup_stage: 'CONFIRMED', pickup_confirmed_at: NOW.toISOString() };

  it('CONFIRM PICKUP required before capture', () => {
    const notConfirmed = { order_id: 'PU-1', pickup_stage: 'PICKED_UP', pickup_confirmed_at: null };
    assert.equal(evaluateCaptureEligibility({ order: notConfirmed, authorization: liveAuth(), hasOpenIssue: false, at: NOW }).capturable, false);
    assert.equal(evaluateCaptureEligibility({ order: confirmed, authorization: liveAuth(), hasOpenIssue: false, at: NOW }).capturable, true);
  });

  it('OPEN ISSUE blocks capture', () => {
    assert.equal(evaluateCaptureEligibility({ order: confirmed, authorization: liveAuth(), hasOpenIssue: true, at: NOW }).capturable, false);
  });

  it('capture only an AUTHORIZED hold; CAPTURED is idempotent no-op; lapsed fails closed', () => {
    assert.equal(evaluateCaptureEligibility({ order: confirmed, authorization: liveAuth({ status: 'CAPTURED' }), hasOpenIssue: false, at: NOW }).capturable, false);
    assert.equal(evaluateCaptureEligibility({ order: confirmed, authorization: liveAuth({ status: 'REQUIRES_ACTION' }), hasOpenIssue: false, at: NOW }).capturable, false);
    const lapsed = liveAuth({ capture_before: new Date(NOW.getTime() - hour).toISOString() });
    assert.equal(evaluateCaptureEligibility({ order: confirmed, authorization: lapsed, hasOpenIssue: false, at: NOW }).capturable, false);
  });

  // ── due policy ───────────────────────────────────────────────────────────────
  const cfg = { paymentTermHours: 24, dayEndLocalTime: '23:59', timezoneOffsetMinutes: -420 };

  it('due = pickup + 24h when the exact pickup instant is known', () => {
    const r = computePaymentDue({ pickedUpAt: '2026-08-25T10:00:00Z' }, cfg);
    assert.equal(r.basis, 'EXACT_PICKUP_TIME');
    assert.equal(r.displayPrecision, 'DATE_TIME');
    assert.equal(r.paymentDueAt, '2026-08-26T10:00:00.000Z');
  });

  it('due = end of next day (date only) when only a pickup date is known — never guesses a time', () => {
    const r = computePaymentDue({ pickupDate: '2026-08-25' }, cfg);
    assert.equal(r.basis, 'END_OF_NEXT_DAY');
    assert.equal(r.displayPrecision, 'DATE');
    assert.ok(new Date(r.paymentDueAt).getTime() >= new Date('2026-08-26T00:00:00Z').getTime());
  });

  it('no pickup timing at all → throws, never fabricates a deadline', () => {
    assert.throws(() => computePaymentDue({}, cfg), MissingPickupTimingError);
  });

  it('isPastDue only true strictly after the deadline', () => {
    assert.equal(isPastDue('2026-08-25T11:00:00Z', NOW), true);
    assert.equal(isPastDue('2026-08-25T13:00:00Z', NOW), false);
    assert.equal(isPastDue(null, NOW), false);
  });

  // ── capture schedule (customer deadline vs authorization expiry) ──────────────
  it('capture schedule: hold wins when it would lapse before the customer deadline', () => {
    const due = new Date(NOW.getTime() + 30 * hour).toISOString();          // customer: +30h
    const captureBefore = new Date(NOW.getTime() + 20 * hour).toISOString(); // hold: +20h
    const s = computeCaptureSchedule(due, captureBefore)!;
    assert.equal(s.basis, 'AUTHORIZATION_EXPIRY');
    assert.equal(s.shortenedByAuthorization, true);
    // due at hold_expiry - safety margin
    assert.equal(new Date(s.captureDueAt).getTime(), new Date(captureBefore).getTime() - CAPTURE_SAFETY_MARGIN_MS);
  });

  it('capture schedule: customer deadline wins when comfortably inside the hold window', () => {
    const due = new Date(NOW.getTime() + 20 * hour).toISOString();
    const captureBefore = new Date(NOW.getTime() + 100 * hour).toISOString();
    const s = computeCaptureSchedule(due, captureBefore)!;
    assert.equal(s.basis, 'CUSTOMER_DEADLINE');
    assert.equal(s.shortenedByAuthorization, false);
    assert.equal(s.captureDueAt, due);
  });

  // ── capture_before extraction (real Stripe object shapes) ─────────────────────
  it('capture_before: read from PI.charges.data[0], latest_charge object, or a charge — else null', () => {
    const unix = 1756900800; // 2026-09-03T12:00:00Z
    const iso = new Date(unix * 1000).toISOString();
    // (a) PI with expanded charges array
    assert.equal(extractCaptureBeforeIso({ charges: { data: [{ payment_method_details: { card: { capture_before: unix } } }] } }), iso);
    // (b) PI with expanded latest_charge object
    assert.equal(extractCaptureBeforeIso({ latest_charge: { payment_method_details: { card: { capture_before: unix } } } }), iso);
    // (c) a charge object directly
    assert.equal(extractCaptureBeforeIso({ payment_method_details: { card: { capture_before: unix } } }), iso);
    // (d) not present → null (never fabricated)
    assert.equal(extractCaptureBeforeIso({ latest_charge: 'ch_unexpanded' }), null);
    assert.equal(extractCaptureBeforeIso({}), null);
    assert.equal(extractCaptureBeforeIso(null), null);
  });

  it('capture_before feeds the fail-closed expiry: extracted past deadline → lapsed', () => {
    const pastUnix = Math.floor(NOW.getTime() / 1000) - 3600;
    const cb = extractCaptureBeforeIso({ payment_method_details: { card: { capture_before: pastUnix } } });
    assert.ok(cb);
    assert.equal(hasAuthorizationLapsed({ status: 'AUTHORIZED', amount_cents: 1, capture_before: cb, provider_payment_intent_id: 'pi' }, NOW), true);
  });

  console.log(`\n${passed} passed`);
}

main();
