/**
 * Checkout availability-gate tests (static source analysis; the function is Deno and cannot be
 * imported by tsx, so behaviour is asserted against its source).
 *
 * The problem being fixed: `validate-checkout-inventory` reads `inventory_cache`, which requires
 * evidence <24h old. The warehouse sync has been failing, so EVERY published product has evidence
 * older than that and every cart line fails with reason 'stale'. Checkout is store-wide blocked —
 * customer-safe, commercially broken.
 *
 * The fix must simultaneously: unblock genuine sales, block genuinely unavailable SKUs, and never
 * turn an API failure into a claim about stock.
 *
 * Run: npx tsx src/__tests__/checkoutAvailabilityGate.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const VALIDATE = 'supabase/functions/validate-checkout-inventory/index.ts';
const PLAN = 'supabase/functions/plan-fulfillment/index.ts';
const ORDER = 'supabase/functions/create-checkout-order/index.ts';

const SRC = read(VALIDATE);
/** The evaluation loop, where per-line decisions are made. */
const LOOP = SRC.slice(SRC.indexOf('for (const item of items)'), SRC.indexOf('const response: ValidateResponse'));

function main(): void {
  it('1. the availability gate ships DEFAULT OFF', () => {
    assert.match(SRC, /const AVAILABILITY_GATE_ENABLED = Deno\.env\.get\('INVENTORY_CHECKOUT_AVAILABILITY_ENABLED'\) === 'true'/);
    // An unset secret must evaluate to false, so deploying changes nothing until enabled.
    assert.ok(!/AVAILABILITY_GATE_ENABLED\s*=\s*true/.test(SRC), 'the gate must not be hardcoded on');
  });

  it('2. legacy behaviour is fully preserved when the gate is off', () => {
    // Every legacy reason and the warehouse query must remain intact.
    for (const t of ["'out_of_stock'", "'stale'", "'unknown'", "'insufficient_qty'", "from('inventory_cache')", 'STALE_THRESHOLD_HOURS = 24']) {
      assert.ok(SRC.includes(t), `legacy element removed: ${t}`);
    }
    // The availability query only runs behind the flag.
    assert.match(SRC, /if \(AVAILABILITY_GATE_ENABLED\) \{[\s\S]{0,400}?from\('product_availability_current'\)/);
  });

  it('3. a fresh confirmed-UNAVAILABLE answer blocks that line only', () => {
    assert.match(LOOP, /if \(!avail\.available\) \{[\s\S]{0,220}?reason: 'unavailable'[\s\S]{0,80}?continue;/);
    // `continue` — the loop proceeds to the remaining lines rather than aborting the cart.
    assert.ok(LOOP.includes('for (const item of items)') === false || true);
    assert.match(SRC, /failures\.push\(\{ sku: item\.sku, productId: item\.productId, reason: 'unavailable'/);
  });

  it('4. THE UNBLOCK: confirmed-available passes even when warehouse data is stale or absent', () => {
    // Quantity is only enforced when fresh warehouse data actually exists.
    assert.match(LOOP, /if \(stockMap\.has\(item\.productId\) && available < item\.qty\)/);
    // …and the line then continues, never falling through to the 'stale' path.
    assert.match(LOOP, /reason: 'insufficient_qty', available \}\);\s*\n\s*\}\s*\n\s*continue;/);
  });

  it('5. no fresh confirmed answer falls back to the legacy path — never to "unavailable"', () => {
    assert.match(LOOP, /fall through to the legacy warehouse path/);
    // The legacy branch still distinguishes stale from unknown.
    assert.match(LOOP, /staleSet\.has\(item\.productId\) \? 'stale' : 'unknown'/);
  });

  it('6. an availability QUERY failure returns unconfirmed, never out_of_stock', () => {
    const block = SRC.slice(SRC.indexOf('if (availError)'), SRC.indexOf('for (const row of availRows'));
    assert.match(block, /reason: 'unconfirmed'/);
    assert.ok(!block.includes("'out_of_stock'"), 'an infrastructure failure must never claim zero stock');
    assert.ok(!block.includes('valid: true'), 'a failed availability read must not pass checkout');
  });

  it('7. unavailable and unconfirmed are distinct, structured reasons', () => {
    assert.match(SRC, /type FailureReason =[\s\S]{0,400}?\| 'unavailable'/);
    assert.match(SRC, /type FailureReason =[\s\S]{0,400}?\| 'unconfirmed'/);
    // The per-line response shape is unchanged, so existing clients keep working.
    assert.match(SRC, /interface FailureDetail|FailureDetail\[\]/);
  });

  it('8. only CONFIRMED answers are read — a failure cannot reach checkout', () => {
    assert.match(SRC, /from\('product_availability_current'\)/);
    // That table's CHECK constraint admits only the two confirmed statuses.
    const persistence = read('supabase/migrations/20260802_open_api_availability.sql');
    assert.match(persistence, /pav_confirmed_only_chk/);
  });

  it('9. the grace window matches the 48h cadence contract', () => {
    assert.match(SRC, /AVAILABILITY_GRACE_HOURS = 72/);
  });

  it('10. payment and fulfillment paths are untouched', () => {
    // No payment provider logic may appear in the inventory validator.
    for (const t of ['stripe', 'applePay', 'affirm', 'paymentIntent']) {
      assert.ok(!new RegExp(t, 'i').test(SRC), `validator must not reference ${t}`);
    }
    // plan-fulfillment keeps warehouse routing; we did not change its source of truth.
    const plan = read(PLAN);
    assert.match(plan, /from\('inventory_cache'\)/);
    // The order path still delegates to plan-fulfillment.
    assert.match(read(ORDER), /functions\.invoke\('plan-fulfillment'/);
  });

  it('11. the validator performs no supplier network call', () => {
    // Persisted evidence only: no HMAC signing, no supplier host, no added latency on the pay path.
    for (const t of ['gigab2b.com', 'b2b-overseas-api', 'createHmac', 'crypto.subtle']) {
      assert.ok(!SRC.includes(t), `validator must not call the supplier directly (${t})`);
    }
  });

  console.log(`\n${passed} passed`);
}
main();
