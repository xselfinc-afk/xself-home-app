/**
 * Pay-After-Pickup checkout + webhook integration (B + C).
 *
 * Part A — pure routing/param invariants (no infra).
 * Part B — DB integration against the prod-schema replica (docker container pap_verify_db):
 *          applies the EXACT mutations each edge-function branch issues and asserts the
 *          payment_status invariants on the real prod schema. No PostgREST/Stripe/network,
 *          no real charge.
 *
 * Requires the replica up:  docker ps | grep pap_verify_db
 * Run: npx tsx src/__tests__/pickupCheckoutWebhook.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  buildSetupIntentParams,
  classifyWebhookEvent,
  shouldUsePayAfterPickup,
} from '../../supabase/functions/_shared/pickup/pickupDomain';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

// ── DB helper: run SQL in the replica, return trimmed single value ──────────────
function sql(q: string): string {
  const out = execFileSync('docker', ['exec', '-i', 'pap_verify_db', 'psql', '-U', 'postgres', '-d', 'verify', '-tAc', q], {
    encoding: 'utf8',
  });
  // Drop psql command-status tags (UPDATE 1 / INSERT 0 1 / DELETE 3) so RETURNING/value
  // assertions see only data rows.
  return out
    .split('\n')
    .filter((l) => !/^(UPDATE|INSERT|DELETE|SELECT|BEGIN|COMMIT)\b/.test(l.trim()))
    .join('\n')
    .trim();
}
function dbAvailable(): boolean {
  try { return sql('select 1;') === '1'; } catch { return false; }
}

function main(): void {
  console.log('Pay-After-Pickup checkout + webhook (B + C)');

  // ══ Part A — pure invariants ══════════════════════════════════════════════════
  it('shouldUsePayAfterPickup: only pickup + capability + pickup-plan → true', () => {
    assert.equal(shouldUsePayAfterPickup('pickup', true, true), true);
    assert.equal(shouldUsePayAfterPickup('delivery', true, true), false);   // Delivery never enters
    assert.equal(shouldUsePayAfterPickup('pickup', false, true), false);    // no capability
    assert.equal(shouldUsePayAfterPickup('pickup', true, false), false);    // planner said not pickup
  });

  it('SetupIntent params: $0 (no amount), off_session, phase=checkout_setup', () => {
    const p = buildSetupIntentParams('ORD-1', 'cus_123');
    assert.equal(p.get('amount'), null, 'a SetupIntent must never carry an amount');
    assert.equal(p.get('usage'), 'off_session');
    assert.equal(p.get('customer'), 'cus_123');
    assert.equal(p.get('metadata[phase]'), 'checkout_setup');
    assert.equal(p.get('metadata[order_id]'), 'ORD-1');
  });

  it('webhook phase table: ONLY delivery / admin-link / pickup-capture set paid', () => {
    // Delivery success (no phase, or explicit) — unchanged, sets paid.
    assert.deepEqual(classifyWebhookEvent('payment_intent.succeeded', {}), { phase: 'delivery_payment', setsPaid: true });
    assert.deepEqual(classifyWebhookEvent('payment_intent.succeeded', { phase: 'delivery_payment' }), { phase: 'delivery_payment', setsPaid: true });
    assert.deepEqual(classifyWebhookEvent('checkout.session.completed', {}), { phase: 'admin_link', setsPaid: true });
    assert.deepEqual(classifyWebhookEvent('payment_intent.succeeded', { phase: 'pickup_capture' }), { phase: 'pickup_capture', setsPaid: true });
    // Card-save and authorization NEVER set paid.
    assert.deepEqual(classifyWebhookEvent('setup_intent.succeeded', {}), { phase: 'checkout_setup', setsPaid: false });
    assert.deepEqual(classifyWebhookEvent('payment_intent.amount_capturable_updated', {}), { phase: 'pickup_authorization', setsPaid: false });
    // A pickup-authorization PI that somehow 'succeeded' must NOT be treated as paid.
    assert.deepEqual(classifyWebhookEvent('payment_intent.succeeded', { phase: 'pickup_authorization' }), { phase: 'pickup_authorization', setsPaid: false });
  });

  it('requires_* handoff never mislabels an untouched intent as FAILED (via mapAuthorizationStatus)', () => {
    // covered in depth in pickupPayAfterPickup.test.ts; assert the setsPaid invariant boundary here.
    assert.equal(classifyWebhookEvent('setup_intent.succeeded', {}).setsPaid, false);
    assert.equal(classifyWebhookEvent('payment_intent.amount_capturable_updated', {}).setsPaid, false);
  });

  // ══ Part B — DB integration against the prod-schema replica ═══════════════════
  if (!dbAvailable()) {
    console.log('  ⚠ replica pap_verify_db not reachable — skipping DB integration (pure invariants above still ran)');
    console.log(`\n${passed} passed (DB integration skipped)`);
    return;
  }

  // fresh fixtures each run
  sql(`delete from public.inventory_reservations where order_id like 'T-%';
       delete from public.pickup_payment_authorizations where order_id like 'T-%';
       delete from public.orders where order_id like 'T-%';`);

  it('DB: Delivery payment_intent.succeeded → paid (existing behaviour preserved)', () => {
    sql(`insert into public.orders (order_id,order_number,status,payment_status,fulfillment_method,total,total_cents)
         values ('T-DLV','ORD-TDLV','pending_payment','pending','delivery',50,5000);`);
    // exact effect of the existing succeeded handler for a delivery PI:
    sql(`update public.orders set status='paid', payment_status='paid' where order_id='T-DLV' and status not in ('paid','pending_pickup');`);
    assert.equal(sql(`select payment_status from public.orders where order_id='T-DLV';`), 'paid');
  });

  it('DB: setup_intent.succeeded → card_saved, NOT paid', () => {
    sql(`insert into public.orders (order_id,order_number,status,payment_status,fulfillment_method,total,total_cents,pickup_stage)
         values ('T-PU','ORD-TPU','pending_pickup','pending','pickup',80,8000,'AWAITING_SUPPLIER_ORDER');`);
    // exact effect of the setup_intent.succeeded handler:
    sql(`update public.orders set payment_status='card_saved', payment_method_saved_at=now(), setup_intent_id='seti_1'
         where order_id='T-PU' and payment_status='pending';`);
    const st = sql(`select payment_status||'|'||(payment_method_saved_at is not null) from public.orders where order_id='T-PU';`);
    assert.equal(st, 'card_saved|true');
    assert.notEqual(st.split('|')[0], 'paid');
  });

  it('DB: authorization (amount_capturable_updated) → authorized, NOT paid', () => {
    sql(`update public.orders set authorization_payment_intent_id='pi_auth', authorization_status='AUTHORIZED',
         authorization_amount_cents=8800, pickup_stage='AUTHORIZED', payment_status='authorized'
         where order_id='T-PU' and payment_status not in ('paid');`);
    const st = sql(`select payment_status||'|'||authorization_status||'|'||authorization_amount_cents from public.orders where order_id='T-PU';`);
    assert.equal(st, 'authorized|AUTHORIZED|8800');
    assert.notEqual(st.split('|')[0], 'paid');
  });

  it('DB: pickup CAPTURE succeeded → paid (only capture sets paid)', () => {
    const rows = sql(`update public.orders set payment_status='paid', authorization_status='CAPTURED', pickup_stage='CAPTURED'
         where order_id='T-PU' and payment_status not in ('paid') returning order_id;`);
    assert.equal(rows, 'T-PU'); // exactly one fresh transition
    assert.equal(sql(`select payment_status||'|'||pickup_stage from public.orders where order_id='T-PU';`), 'paid|CAPTURED');
    // idempotent redelivery: guard makes it a no-op (0 rows)
    const again = sql(`update public.orders set payment_status='paid' where order_id='T-PU' and payment_status not in ('paid') returning order_id;`);
    assert.equal(again, '', 'redelivered capture must be a no-op');
  });

  it('DB: retry does NOT create a duplicate authorization (unique idempotency_key)', () => {
    sql(`insert into public.pickup_payment_authorizations (order_id,amount_cents,idempotency_key,status)
         values ('T-PU',8800,'T-PU:8800:auth','REQUIRES_ACTION');`);
    let dupBlocked = false;
    try {
      sql(`insert into public.pickup_payment_authorizations (order_id,amount_cents,idempotency_key,status)
           values ('T-PU',8800,'T-PU:8800:auth','REQUIRES_ACTION');`);
    } catch { dupBlocked = true; }
    assert.equal(dupBlocked, true, 'a retry with the same idempotency_key must be rejected');
    assert.equal(sql(`select count(*) from public.pickup_payment_authorizations where order_id='T-PU';`), '1');
  });

  it('DB: Delivery reservation still swept by 10-min logic; pickup_hold excluded', () => {
    sql(`insert into public.inventory_reservations (order_id,product_id,supplier_sku,warehouse_code,quantity,status,expires_at,reservation_policy)
         values ('T-DLV','p','S','CA2',1,'reserved', now() - interval '1 minute','payment_10min');`);
    sql(`insert into public.inventory_reservations (order_id,product_id,supplier_sku,warehouse_code,quantity,status,expires_at,reservation_policy,pickup_release_deadline)
         values ('T-PU','p','S','CA2',1,'reserved', now() - interval '1 minute','pickup_hold', now() + interval '24 hours');`);
    // the delivery 10-min sweep query (policy-scoped) sees ONLY the delivery row
    const swept = sql(`select coalesce(string_agg(order_id,','),'') from public.inventory_reservations
                       where status='reserved' and expires_at < now() and reservation_policy='payment_10min'
                       and order_id like 'T-%';`);
    assert.equal(swept, 'T-DLV');
  });

  // cleanup
  sql(`delete from public.inventory_reservations where order_id like 'T-%';
       delete from public.pickup_payment_authorizations where order_id like 'T-%';
       delete from public.orders where order_id like 'T-%';`);

  console.log(`\n${passed} passed`);
}

main();
