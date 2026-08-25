/**
 * Pay-After-Pickup ops endpoints E–I + K + reservation policy.
 *
 * Part A — pure domain (amount, intent reuse, confirm/approve gates, PI params).
 * Part B — DB integration on the prod-schema replica (pap_verify_db): reservation trigger + 24h
 *          sweep, confirm/release DB effects, and the Delivery-untouched invariant. No Stripe, no
 *          charge, no network.
 *
 * Run: npx tsx src/__tests__/pickupOpsEndpoints.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  authorizationIntentReuseDecision,
  buildAuthorizationPaymentIntentParams,
  canApproveForSupplierFlow,
  computeFinalPickupAmountCents,
  computePaymentDue,
  evaluateCaptureEligibility,
  evaluatePickupConfirm,
  evaluateReleaseGate,
  pickupReservationReleaseDecision,
  type AuthorizationRecord,
} from '../../supabase/functions/_shared/pickup/pickupDomain';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }
function sql(q: string): string {
  const out = execFileSync('docker', ['exec', '-i', 'pap_verify_db', 'psql', '-U', 'postgres', '-d', 'verify', '-tAc', q], { encoding: 'utf8' });
  return out.split('\n').filter(l => !/^(UPDATE|INSERT|DELETE|SELECT|BEGIN|COMMIT)\b/.test(l.trim())).join('\n').trim();
}
function dbUp(): boolean { try { return sql('select 1;') === '1'; } catch { return false; } }

const NOW = new Date('2026-08-25T12:00:00Z');
const hour = 3600_000;
const liveAuth = (o: Partial<AuthorizationRecord> = {}): AuthorizationRecord => ({
  status: 'AUTHORIZED', amount_cents: 8800, capture_before: new Date(NOW.getTime() + 48 * hour).toISOString(),
  provider_payment_intent_id: 'pi_auth', ...o,
});

function main(): void {
  console.log('Pay-After-Pickup ops endpoints (E–I + K + reservations)');

  // ══ Part A — pure ═════════════════════════════════════════════════════════════
  // E / K
  it('K: final amount = subtotal + tax + $0 shipping (server-computed)', () => {
    assert.equal(computeFinalPickupAmountCents(8000, 800), 8800);
    assert.equal(computeFinalPickupAmountCents(0, 0), 0);
  });

  it('E: manual-capture PI params — server amount, capture_method=manual, phase, no client amount', () => {
    const p = buildAuthorizationPaymentIntentParams({ orderId: 'O1', customerId: 'cus', paymentMethodId: 'pm_1', amountCents: 8800, taxCalculationId: 'taxcalc_1' });
    assert.equal(p.get('amount'), '8800');
    assert.equal(p.get('capture_method'), 'manual');
    assert.equal(p.get('confirm'), 'true');
    assert.equal(p.get('off_session'), 'true');
    assert.equal(p.get('metadata[phase]'), 'pickup_authorization');
    assert.equal(p.get('metadata[tax_calculation_id]'), 'taxcalc_1');
  });

  it('E: retry reuses an unfinished intent, never duplicates; terminal/none handled', () => {
    assert.equal(authorizationIntentReuseDecision({ status: 'REQUIRES_ACTION' }), 'reuse');
    assert.equal(authorizationIntentReuseDecision({ status: 'REQUIRES_CONFIRMATION' }), 'reuse');
    assert.equal(authorizationIntentReuseDecision({ status: 'AUTHORIZED' }), 'terminal');
    assert.equal(authorizationIntentReuseDecision({ status: 'CAPTURED' }), 'terminal');
    assert.equal(authorizationIntentReuseDecision({ status: 'FAILED' }), 'create');
    assert.equal(authorizationIntentReuseDecision(undefined), 'create');
  });

  // F
  const relOrder = { order_id: 'O1', fulfillment_method: 'pickup', status: 'pending_pickup', pickup_stage: 'AUTHORIZED', total_cents: 8800, payment_method_saved_at: NOW.toISOString(), customer_email: 'c@x.com' };
  const originalBol = { document_type: 'ORIGINAL_BOL', released_at: null, superseded_at: null };
  it('F: release ok only with a LIVE AUTHORIZED hold matching the final total', () => {
    const ok = evaluateReleaseGate({ order: relOrder, supplierOrderExists: true, originalBol, authorization: liveAuth(), at: NOW });
    assert.equal(ok.ok, true, JSON.stringify(ok.failed));
  });
  it('F: expired authorization blocks release (fail-closed)', () => {
    const r = evaluateReleaseGate({ order: relOrder, supplierOrderExists: true, originalBol, authorization: liveAuth({ capture_before: new Date(NOW.getTime() - hour).toISOString() }), at: NOW });
    assert.equal(r.ok, false);
  });
  it('F: amount mismatch blocks release', () => {
    const r = evaluateReleaseGate({ order: relOrder, supplierOrderExists: true, originalBol, authorization: liveAuth({ amount_cents: 8000 }), at: NOW });
    assert.equal(r.ok, false);
  });
  it('F: missing supplier order or Original BOL blocks release', () => {
    assert.equal(evaluateReleaseGate({ order: relOrder, supplierOrderExists: false, originalBol, authorization: liveAuth(), at: NOW }).ok, false);
    assert.equal(evaluateReleaseGate({ order: relOrder, supplierOrderExists: true, originalBol: undefined, authorization: liveAuth(), at: NOW }).ok, false);
  });

  // G
  it('G: confirm requires a Signed BOL; then 24h due starts at confirm', () => {
    assert.equal(evaluatePickupConfirm({ order: { fulfillment_method: 'pickup', pickup_confirmed_at: null }, signedBolExists: false }).ok, false);
    assert.equal(evaluatePickupConfirm({ order: { fulfillment_method: 'pickup', pickup_confirmed_at: null }, signedBolExists: true }).ok, true);
    // idempotent: already confirmed → not confirmable again
    assert.equal(evaluatePickupConfirm({ order: { fulfillment_method: 'pickup', pickup_confirmed_at: NOW.toISOString() }, signedBolExists: true }).ok, false);
    const due = computePaymentDue({ pickedUpAt: '2026-08-25T10:00:00Z' }, { paymentTermHours: 24, dayEndLocalTime: '23:59', timezoneOffsetMinutes: -420 });
    assert.equal(due.paymentDueAt, '2026-08-26T10:00:00.000Z');
  });

  // H
  const confirmedOrder = { order_id: 'O1', pickup_stage: 'CONFIRMED', pickup_confirmed_at: NOW.toISOString(), payment_due_at: new Date(NOW.getTime() - hour).toISOString() };
  it('H: capture needs confirm + due + live hold + no issue; uses the original PI', () => {
    const e = evaluateCaptureEligibility({ order: confirmedOrder, authorization: liveAuth(), hasOpenIssue: false, at: NOW });
    assert.equal(e.capturable, true);
    assert.match(e.reason, /pi_auth/); // the original authorization PI
  });
  it('H: issue open blocks capture', () => {
    assert.equal(evaluateCaptureEligibility({ order: confirmedOrder, authorization: liveAuth(), hasOpenIssue: true, at: NOW }).capturable, false);
  });
  it('H: not due yet blocks capture unless the hold is about to lapse', () => {
    const notDue = { ...confirmedOrder, payment_due_at: new Date(NOW.getTime() + hour).toISOString() };
    assert.equal(evaluateCaptureEligibility({ order: notDue, authorization: liveAuth(), hasOpenIssue: false, at: NOW }).capturable, false);
    assert.equal(evaluateCaptureEligibility({ order: notDue, authorization: liveAuth(), hasOpenIssue: false, allowBeforeDue: true, at: NOW }).capturable, true);
  });
  it('H: expired hold fails closed even when due', () => {
    assert.equal(evaluateCaptureEligibility({ order: confirmedOrder, authorization: liveAuth({ capture_before: new Date(NOW.getTime() - hour).toISOString() }), hasOpenIssue: false, at: NOW }).capturable, false);
  });

  // I
  it('I: Delivery approval unchanged (paid only); pickup allows card_saved/authorized; pending blocked', () => {
    assert.equal(canApproveForSupplierFlow({ fulfillment_method: 'delivery', payment_status: 'paid' }).ok, true);
    assert.equal(canApproveForSupplierFlow({ fulfillment_method: 'delivery', payment_status: 'card_saved' }).ok, false); // Delivery not loosened
    assert.equal(canApproveForSupplierFlow({ fulfillment_method: 'pickup', payment_status: 'card_saved' }).ok, true);
    assert.equal(canApproveForSupplierFlow({ fulfillment_method: 'pickup', payment_status: 'authorized' }).ok, true);
    assert.equal(canApproveForSupplierFlow({ fulfillment_method: 'pickup', payment_status: 'pending' }).ok, false); // not loosened wholesale
  });

  // reservation decision (pure)
  it('reservation: supplier order releases; 24h lapse releases; delivery never evaluated', () => {
    assert.equal(pickupReservationReleaseDecision({ reservationPolicy: 'pickup_hold', status: 'reserved', supplierOrderExists: true, pickupReleaseDeadline: null, at: NOW }).release, true);
    assert.equal(pickupReservationReleaseDecision({ reservationPolicy: 'pickup_hold', status: 'reserved', supplierOrderExists: false, pickupReleaseDeadline: new Date(NOW.getTime() - hour).toISOString(), at: NOW }).release, true);
    assert.equal(pickupReservationReleaseDecision({ reservationPolicy: 'pickup_hold', status: 'reserved', supplierOrderExists: false, pickupReleaseDeadline: new Date(NOW.getTime() + hour).toISOString(), at: NOW }).release, false);
    assert.equal(pickupReservationReleaseDecision({ reservationPolicy: 'payment_10min', status: 'reserved', supplierOrderExists: false, pickupReleaseDeadline: null, at: NOW }).release, false);
  });

  // ══ Part B — DB integration on the replica ════════════════════════════════════
  if (!dbUp()) { console.log('  ⚠ replica down — skipping DB integration'); console.log(`\n${passed} passed (DB skipped)`); return; }
  const clean = () => sql(`delete from public.supplier_orders where order_id like 'E-%';
    delete from public.inventory_reservations where order_id like 'E-%';
    delete from public.pickup_documents where order_id like 'E-%';
    delete from public.orders where order_id like 'E-%';`);
  clean();

  it('DB: supplier order INSERT releases the pickup_hold reservation (trigger); delivery untouched', () => {
    sql(`insert into public.orders (order_id,order_number,status,payment_status,fulfillment_method,total,total_cents) values
         ('E-PU','O','pending_pickup','card_saved','pickup',88,8800),('E-DLV','O','pending_payment','pending','delivery',50,5000);`);
    sql(`insert into public.inventory_reservations (order_id,product_id,supplier_sku,warehouse_code,quantity,status,expires_at,reservation_policy,pickup_release_deadline) values
         ('E-PU','p','s','CA2',1,'reserved', now()+interval '24h','pickup_hold', now()+interval '24h');`);
    sql(`insert into public.inventory_reservations (order_id,product_id,supplier_sku,warehouse_code,quantity,status,expires_at,reservation_policy) values
         ('E-DLV','p','s','CA2',1,'reserved', now()+interval '10 min','payment_10min');`);
    // supplier order arrives → trigger releases the pickup_hold row
    sql(`insert into public.supplier_orders (order_id,supplier_name,supplier_order_ref) values ('E-PU','GIGA','X1');`);
    assert.equal(sql(`select status from public.inventory_reservations where order_id='E-PU';`), 'released');
    assert.equal(sql(`select status from public.inventory_reservations where order_id='E-DLV';`), 'reserved'); // delivery untouched
  });

  it('DB: 24h sweep releases past-deadline pickup_hold with no supplier order; not others', () => {
    sql(`insert into public.orders (order_id,order_number,status,payment_status,fulfillment_method,total,total_cents) values
         ('E-LAPSE','O','pending_pickup','card_saved','pickup',88,8800),('E-FRESH','O','pending_pickup','card_saved','pickup',88,8800);`);
    sql(`insert into public.inventory_reservations (order_id,product_id,supplier_sku,warehouse_code,quantity,status,expires_at,reservation_policy,pickup_release_deadline) values
         ('E-LAPSE','p','s','CA2',1,'reserved', now()-interval '1 min','pickup_hold', now()-interval '1 min'),
         ('E-FRESH','p','s','CA2',1,'reserved', now()+interval '23h','pickup_hold', now()+interval '23h');`);
    const released = sql(`select public.release_due_pickup_reservations();`);
    assert.equal(Number(released) >= 1, true);
    assert.equal(sql(`select status from public.inventory_reservations where order_id='E-LAPSE';`), 'released');
    assert.equal(sql(`select status from public.inventory_reservations where order_id='E-FRESH';`), 'reserved');
    // the still-reserved delivery row from the previous test is never touched by the sweep
    assert.equal(sql(`select status from public.inventory_reservations where order_id='E-DLV';`), 'reserved');
  });

  it('DB: confirm-pickup effect starts the 24h window; release sets released_at, never captures', () => {
    sql(`insert into public.orders (order_id,order_number,status,payment_status,fulfillment_method,total,total_cents,pickup_stage,payment_method_saved_at) values
         ('E-CONF','O','pending_pickup','authorized','pickup',88,8800,'AUTHORIZED', now());`);
    // confirm effect (endpoint G): pickup_confirmed_at + payment_due_at set; payment_status NOT paid
    sql(`update public.orders set pickup_confirmed_at=now(), payment_due_at=now()+interval '24h', payment_due_basis='EXACT_PICKUP_TIME', pickup_stage='CONFIRMED' where order_id='E-CONF' and pickup_confirmed_at is null;`);
    assert.equal(sql(`select (pickup_confirmed_at is not null)||'|'||(payment_due_at is not null)||'|'||payment_status from public.orders where order_id='E-CONF';`), 'true|true|authorized');
    // release effect (endpoint F): Original BOL released_at set; payment_status unchanged (no capture)
    sql(`insert into public.pickup_documents (order_id,document_type,file_name) values ('E-CONF','ORIGINAL_BOL','bol.pdf');`);
    sql(`update public.pickup_documents set released_at=now() where order_id='E-CONF' and document_type='ORIGINAL_BOL' and released_at is null;`);
    assert.equal(sql(`select (released_at is not null)||'|'||payment_status from public.pickup_documents pd join public.orders o on o.order_id=pd.order_id where pd.order_id='E-CONF';`), 'true|authorized');
  });

  clean();
  console.log(`\n${passed} passed`);
}

main();
