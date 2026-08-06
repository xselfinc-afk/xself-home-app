/**
 * Open API availability adapter tests (pure; no network, no database, no browser).
 *
 * The property everything else depends on: ONLY an explicit `skuAvailable === false` is a zero.
 * Every failure mode must be non-authoritative, because a delist triggered by a network blip is
 * indistinguishable to the customer from losing the product.
 *
 * Run: npx tsx src/__tests__/openApiAvailability.test.ts
 */
import assert from 'node:assert/strict';
import {
  agreesWithSharedVocabulary,
  classifyBatch,
  extractRows,
  isApiConfirmed,
  isApiErrorEnvelope,
  isApiFailure,
  redactReason,
  tally,
  toInventoryResultStatus,
  type ApiAvailabilityStatus,
  type BatchOutcome,
} from '../services/openApiAvailability';
import { countsAsConfirmedZero, isConfirmed } from '../services/inventoryResult';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const ok = (rows: unknown): BatchOutcome => ({ kind: 'ok', rows });
const one = (skus: string[], o: BatchOutcome) => classifyBatch(skus, o);

function main(): void {
  // ── Confirmed answers ───────────────────────────────────────────────────────

  it('1. skuAvailable=true → confirmed_available', () => {
    const [r] = one(['A'], ok([{ sku: 'A', skuAvailable: true }]));
    assert.equal(r.status, 'confirmed_available');
    assert.equal(r.available, true);
    assert.equal(r.inventoryStatus, 'confirmed_in_stock_out_of_state');
  });

  it('2. skuAvailable=false → confirmed_out_of_stock (the ONLY zero)', () => {
    const [r] = one(['A'], ok([{ sku: 'A', skuAvailable: false }]));
    assert.equal(r.status, 'confirmed_out_of_stock');
    assert.equal(r.available, false);
    assert.ok(countsAsConfirmedZero(r.inventoryStatus));
  });

  it('3. availability never claims California stock', () => {
    const [r] = one(['A'], ok([{ sku: 'A', skuAvailable: true }]));
    assert.notEqual(r.inventoryStatus, 'confirmed_in_stock_ca',
      'the Open API returns no warehouse data — CA must never be inferred from it');
  });

  // ── Every failure mode is non-authoritative ─────────────────────────────────

  it('4. code=0 error envelope → api_failed, never zero', () => {
    const envelope = { code: 0, error: 'Oops! Something went wrong', msg: 'Oops!', data: {} };
    assert.ok(isApiErrorEnvelope(envelope));
    const [r] = one(['A'], ok(envelope));
    assert.equal(r.status, 'api_failed');
    assert.equal(r.available, null);
    assert.ok(!countsAsConfirmedZero(r.inventoryStatus));
  });

  it('5. timeout / network error → network_failed, never zero', () => {
    const [r] = one(['A'], { kind: 'network_error', message: 'ETIMEDOUT' });
    assert.equal(r.status, 'network_failed');
    assert.equal(r.available, null);
    assert.ok(!countsAsConfirmedZero(r.inventoryStatus));
  });

  it('6. rate limit → rate_limited, never zero', () => {
    const [r] = one(['A'], { kind: 'rate_limited', message: '429' });
    assert.equal(r.status, 'rate_limited');
    assert.equal(r.available, null);
    assert.equal(r.inventoryStatus, 'supplier_unavailable');
  });

  it('7. malformed response → malformed_response, never zero', () => {
    for (const bad of [ok({ unexpected: 'shape' }), ok('not json'), ok(null), { kind: 'malformed', message: 'bad json' } as BatchOutcome]) {
      const [r] = one(['A'], bad);
      assert.equal(r.status, 'malformed_response', JSON.stringify(bad).slice(0, 40));
      assert.equal(r.available, null);
      assert.ok(!countsAsConfirmedZero(r.inventoryStatus));
    }
  });

  it('8. SKU absent from the response → missing_sku (unknown), never zero', () => {
    const rs = one(['A', 'B'], ok([{ sku: 'A', skuAvailable: true }]));
    const b = rs.find(r => r.sku === 'B')!;
    assert.equal(b.status, 'missing_sku');
    assert.equal(b.available, null);
    assert.equal(b.inventoryStatus, 'inventory_unknown');
    assert.ok(!countsAsConfirmedZero(b.inventoryStatus));
  });

  it('9. present row with a non-boolean flag is unknown, not zero', () => {
    for (const v of [undefined, null, '', 'maybe', {}]) {
      const [r] = one(['A'], ok([{ sku: 'A', skuAvailable: v }]));
      assert.equal(r.status, 'malformed_response', String(v));
      assert.notEqual(r.status, 'confirmed_out_of_stock');
    }
  });

  it('10. NO failure status maps to a confirmed zero — exhaustive', () => {
    const failures: ApiAvailabilityStatus[] = [
      'api_failed', 'rate_limited', 'network_failed', 'malformed_response', 'missing_sku', 'supplier_unavailable',
    ];
    for (const f of failures) {
      assert.ok(isApiFailure(f), `${f} must be a failure`);
      assert.ok(!countsAsConfirmedZero(toInventoryResultStatus(f)), `${f} must never be a zero`);
      assert.ok(!isConfirmed(toInventoryResultStatus(f)), `${f} must never be confirmed`);
    }
    assert.ok(isApiConfirmed('confirmed_available') && isApiConfirmed('confirmed_out_of_stock'));
  });

  // ── Batch behaviour ─────────────────────────────────────────────────────────

  it('11. a whole-batch failure marks every requested SKU, none dropped', () => {
    const skus = ['A', 'B', 'C'];
    const rs = one(skus, { kind: 'api_error', message: 'HTTP 500' });
    assert.equal(rs.length, 3);
    assert.deepEqual(rs.map(r => r.sku), skus);
    assert.ok(rs.every(r => r.available === null));
  });

  it('12. mixed batches classify each SKU independently', () => {
    const rs = one(['A', 'B', 'C'], ok([
      { sku: 'A', skuAvailable: true },
      { sku: 'B', skuAvailable: false },
    ]));
    assert.equal(rs.find(r => r.sku === 'A')!.status, 'confirmed_available');
    assert.equal(rs.find(r => r.sku === 'B')!.status, 'confirmed_out_of_stock');
    assert.equal(rs.find(r => r.sku === 'C')!.status, 'missing_sku');
  });

  it('13. response shapes: array, {data:[]}, {data:{list:[]}}', () => {
    const row = [{ sku: 'A', skuAvailable: true }];
    for (const p of [row, { data: row }, { data: { list: row } }]) {
      assert.deepEqual(extractRows(p), row);
      assert.equal(one(['A'], ok(p))[0].status, 'confirmed_available');
    }
    assert.equal(extractRows({ nope: 1 }), null);
  });

  it('14. classification is idempotent and pure', () => {
    const o = ok([{ sku: 'A', skuAvailable: false }]);
    assert.deepEqual(one(['A'], o), one(['A'], o));
  });

  it('15. skuCode is accepted as the key alongside sku', () => {
    const [r] = one(['A'], ok([{ skuCode: 'A', skuAvailable: true }]));
    assert.equal(r.status, 'confirmed_available');
  });

  // ── Secrets never reach a report ────────────────────────────────────────────

  it('16. reasons are redacted', () => {
    assert.match(redactReason('failed with sign=abcdefghijklmnopqrstuvwxyz012345'), /\[REDACTED\]/);
    assert.match(redactReason({ message: 'token: aVeryLongSecretValueThatShouldNotLeak123' }), /\[REDACTED\]/);
    assert.ok(!redactReason('x'.repeat(500)).includes('x'.repeat(200)));
    const [r] = one(['A'], { kind: 'api_error', message: 'client-id: 8ebfc2b3-39ac-49c5-866e-c6b32e7bf08b' });
    assert.match(r.reason, /\[REDACTED\]/);
  });

  // ── Tally + vocabulary agreement ────────────────────────────────────────────

  it('17. tally counts and failure percentage', () => {
    const rs = one(['A', 'B', 'C', 'D'], ok([
      { sku: 'A', skuAvailable: true },
      { sku: 'B', skuAvailable: true },
      { sku: 'C', skuAvailable: false },
    ]));
    const t = tally(rs);
    assert.equal(t.total, 4);
    assert.equal(t.confirmedAvailable, 2);
    assert.equal(t.confirmedOutOfStock, 1);
    assert.equal(t.failures, 1);
    assert.equal(t.failurePercent, 25);
    assert.equal(tally([]).failurePercent, 0);
  });

  it('18. adapter statuses never disagree with the shared vocabulary', () => {
    const rs = [
      ...one(['A'], ok([{ sku: 'A', skuAvailable: true }])),
      ...one(['B'], ok([{ sku: 'B', skuAvailable: false }])),
      ...one(['C'], { kind: 'network_error', message: 'x' }),
      ...one(['D'], { kind: 'rate_limited' }),
      ...one(['E'], ok({ code: 0, error: 'boom' })),
      ...one(['F'], ok([])),
    ];
    for (const r of rs) assert.ok(agreesWithSharedVocabulary(r), `${r.sku}/${r.status} disagrees`);
  });

  // ── Detail fallback: price omits skuAvailable, detail supplies it ───────────
  //
  // Regression guard for three real products (XH-CB-HM-06904C / E / K, supplier codes
  // N710P206904C / E / K). They were synced with a lean payload; `/price/v1` returns their rows
  // without `skuAvailable`, so every scan classified them `malformed_response`, no availability
  // row was ever written, and they stayed out of `sellable_products` while published and in stock.
  // Precedence matches `scripts/lib/gigaAccountReadClient.ts`: price first, detail as fallback.

  const detail = (rows: Array<{ sku: string; skuAvailable?: unknown }>) =>
    new Map(rows.map(r => [r.sku, r] as const));

  it('19. price skuAvailable=true wins even when detail disagrees', () => {
    const [r] = classifyBatch(['A'], ok([{ sku: 'A', skuAvailable: true }]), detail([{ sku: 'A', skuAvailable: false }]));
    assert.equal(r.status, 'confirmed_available');
    assert.equal(r.available, true);
    assert.equal(r.reason, 'skuAvailable=true');
  });

  it('20. price skuAvailable=false wins even when detail disagrees', () => {
    const [r] = classifyBatch(['A'], ok([{ sku: 'A', skuAvailable: false }]), detail([{ sku: 'A', skuAvailable: true }]));
    assert.equal(r.status, 'confirmed_out_of_stock');
    assert.equal(r.available, false);
    assert.equal(r.reason, 'skuAvailable=false');
  });

  it('21. price omits the flag + detail true → confirmed_available', () => {
    for (const sku of ['N710P206904C', 'N710P206904E', 'N710P206904K']) {
      const [r] = classifyBatch([sku], ok([{ sku, price: 240 }]), detail([{ sku, skuAvailable: true }]));
      assert.equal(r.status, 'confirmed_available', `${sku} must resolve from detail`);
      assert.equal(r.available, true);
      assert.equal(r.inventoryStatus, 'confirmed_in_stock_out_of_state');
      assert.ok(agreesWithSharedVocabulary(r));
    }
  });

  it('22. price omits the flag + detail false → confirmed_out_of_stock', () => {
    const [r] = classifyBatch(['A'], ok([{ sku: 'A', price: 240 }]), detail([{ sku: 'A', skuAvailable: false }]));
    assert.equal(r.status, 'confirmed_out_of_stock');
    assert.equal(r.available, false);
    assert.equal(countsAsConfirmedZero(r.inventoryStatus), true);
  });

  it('23. neither price nor detail has a usable flag → malformed_response, never zero', () => {
    const cases = [
      classifyBatch(['A'], ok([{ sku: 'A', price: 240 }]), detail([{ sku: 'A' }]))[0],
      classifyBatch(['A'], ok([{ sku: 'A', price: 240 }]), detail([{ sku: 'A', skuAvailable: 'maybe' }]))[0],
      classifyBatch(['A'], ok([{ sku: 'A', price: 240 }]), detail([{ sku: 'B', skuAvailable: true }]))[0],
      classifyBatch(['A'], ok([{ sku: 'A', price: 240 }]), new Map())[0],
      classifyBatch(['A'], ok([{ sku: 'A', price: 240 }]))[0],
    ];
    for (const r of cases) {
      assert.equal(r.status, 'malformed_response');
      assert.equal(r.available, null);
      assert.equal(countsAsConfirmedZero(r.inventoryStatus), false);
      assert.equal(r.reason, 'skuAvailable missing or non-boolean');
    }
  });

  it('24. a transport failure is api_failed, never out_of_stock — detail cannot rescue it', () => {
    const transportFailures: BatchOutcome[] = [
      { kind: 'api_error', message: 'boom' },
      { kind: 'network_error', message: 'ECONNRESET' },
      { kind: 'rate_limited' },
      { kind: 'malformed', message: 'bad json' },
    ];
    for (const outcome of transportFailures) {
      const [r] = classifyBatch(['A'], outcome, detail([{ sku: 'A', skuAvailable: false }]));
      assert.notEqual(r.status, 'confirmed_out_of_stock');
      assert.notEqual(r.status, 'confirmed_available');
      assert.equal(r.available, null);
      assert.equal(countsAsConfirmedZero(r.inventoryStatus), false);
      assert.ok(agreesWithSharedVocabulary(r));
    }
    // The `code: 0` success-shaped failure is the same story.
    const [envelope] = classifyBatch(['A'], ok({ code: 0, error: 'boom' }), detail([{ sku: 'A', skuAvailable: true }]));
    assert.equal(envelope.status, 'api_failed');
    assert.equal(envelope.available, null);
    // And a SKU the supplier never returned stays unknown — the detail map must not invent it.
    const [absent] = classifyBatch(['A'], ok([]), detail([{ sku: 'A', skuAvailable: true }]));
    assert.equal(absent.status, 'missing_sku');
    assert.equal(absent.available, null);
  });

  console.log(`\n${passed} passed`);
}
main();
