/**
 * Standardized inventory projection tests (pure; no network, no database).
 *
 * The property everything else depends on: a failed read is never a zero. `standardized_products`
 * keeps its last reliable numbers unless a channel actually reported stock or two independent
 * channels both reported none.
 *
 * Run: npx tsx src/__tests__/standardizedInventoryProjection.test.ts
 */
import assert from 'node:assert/strict';
import {
  applyStandardizedInventoryProjection,
  assertNoPublicationWrite,
  buildStandardizedInventoryUpdate,
  channelFromAccountFacts,
  deriveStandardizedInventoryProjection,
  STANDARDIZED_INVENTORY_WRITABLE_COLUMNS,
  type InventoryChannelObservation,
} from '../services/standardizedInventoryProjection';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }
async function itAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn(); passed++; console.log(`  ✓ ${name}`);
}

const CHECKED_AT = '2026-08-06T18:00:00.000Z';

const ok = (channel: string, available: boolean, quantity: number | null): InventoryChannelObservation =>
  ({ channel, read_ok: true, available, quantity });
const failed = (channel: string, reason: string): InventoryChannelObservation =>
  ({ channel, read_ok: false, available: null, quantity: null, failure_reason: reason });

const derive = (
  channels: InventoryChannelObservation[],
  currentInventoryStatus: string | null,
  currentTotalAvailableQty: number | null,
) => deriveStandardizedInventoryProjection({
  channels, currentInventoryStatus, currentTotalAvailableQty, evidenceCheckedAt: CHECKED_AT,
});

async function main(): Promise<void> {
  // ── Rule A: the larger channel wins, never the sum ──────────────────────────

  it('1. Pickup 15 + Dropship 25 → in_stock / 25', () => {
    const p = derive([ok('pickup', true, 15), ok('dropship', true, 25)], 'out_of_stock', 0);
    assert.equal(p.next_inventory_status, 'in_stock');
    assert.equal(p.next_total_available_qty, 25);
    assert.equal(p.should_write, true);
    assert.equal(p.quantity_strategy, 'max_reliable_channel_quantity');
    assert.deepEqual(p.reliable_channels, ['pickup', 'dropship']);
  });

  it('2. Pickup 47 + Dropship 42 → in_stock / 47', () => {
    const p = derive([ok('pickup', true, 47), ok('dropship', true, 42)], 'out_of_stock', 0);
    assert.equal(p.next_inventory_status, 'in_stock');
    assert.equal(p.next_total_available_qty, 47);
    assert.equal(p.quantity_strategy, 'max_reliable_channel_quantity');
  });

  it('10. the two channels are NEVER summed', () => {
    for (const [a, b, expected] of [[15, 25, 25], [47, 42, 47], [5, 5, 5]] as const) {
      const p = derive([ok('pickup', true, a), ok('dropship', true, b)], null, null);
      assert.equal(p.next_total_available_qty, expected);
      assert.notEqual(p.next_total_available_qty, a + b, `${a}+${b} must not be added`);
    }
  });

  // ── Rule C: a partial failure cannot demote a confirmed in-stock ────────────

  it('3. Pickup in stock 15 + Dropship API failure → in_stock / 15', () => {
    const p = derive([ok('pickup', true, 15), failed('dropship', 'api_failed')], 'out_of_stock', 0);
    assert.equal(p.next_inventory_status, 'in_stock');
    assert.equal(p.next_total_available_qty, 15);
    assert.equal(p.should_write, true);
    assert.deepEqual(p.reliable_channels, ['pickup']);
    assert.deepEqual(p.failed_channels, [{ channel: 'dropship', reason: 'api_failed' }]);
  });

  it('4. Pickup API failure + Dropship in stock 25 → in_stock / 25', () => {
    const p = derive([failed('pickup', 'network_error'), ok('dropship', true, 25)], null, null);
    assert.equal(p.next_inventory_status, 'in_stock');
    assert.equal(p.next_total_available_qty, 25);
    assert.equal(p.should_write, true);
    assert.deepEqual(p.failed_channels, [{ channel: 'pickup', reason: 'network_error' }]);
  });

  // ── Rule B: a zero needs two clean channels to agree ───────────────────────

  it('5. both channels confirm unavailable → out_of_stock / 0', () => {
    const p = derive([ok('pickup', false, null), ok('dropship', false, null)], 'in_stock', 72);
    assert.equal(p.next_inventory_status, 'out_of_stock');
    assert.equal(p.next_total_available_qty, 0);
    assert.equal(p.should_write, true);
    assert.equal(p.reason, 'confirmed_out_of_stock_both_channels');
    assert.equal(p.quantity_strategy, 'zero_confirmed_out_of_stock');
  });

  it('5b. a single clean channel saying unavailable is NOT enough for a zero', () => {
    const p = derive([ok('open_api', false, null)], 'in_stock', 72);
    assert.equal(p.should_write, false);
    assert.equal(p.reason, 'insufficient_channels_for_out_of_stock');
    assert.equal(p.next_inventory_status, 'in_stock');
    assert.equal(p.next_total_available_qty, 72);
  });

  // ── Rule D: failures preserve, never fabricate ─────────────────────────────

  it('6. both channels fail → keep the old status and quantity, write nothing', () => {
    const p = derive([failed('pickup', 'api_failed'), failed('dropship', 'api_failed')], 'in_stock', 68);
    assert.equal(p.should_write, false);
    assert.equal(p.reason, 'no_reliable_evidence');
    assert.equal(p.next_inventory_status, 'in_stock');
    assert.equal(p.next_total_available_qty, 68);
    assert.equal(p.quantity_strategy, 'no_write');
  });

  it('7. every failure mode preserves the previous values — none of them writes 0', () => {
    const failureModes = [
      'api_failed', 'network_error', 'inventory_unknown', 'identity_mapping_error',
      'favorites_not_synchronized', 'supplier_product_not_found', 'malformed_response', 'code=0',
    ];
    for (const mode of failureModes) {
      const p = derive([failed('pickup', mode), failed('dropship', mode)], 'in_stock', 68);
      assert.equal(p.should_write, false, `${mode} must not write`);
      assert.equal(p.next_total_available_qty, 68, `${mode} must preserve the quantity`);
      assert.equal(p.next_inventory_status, 'in_stock', `${mode} must preserve the status`);
      assert.notEqual(p.next_inventory_status, 'out_of_stock', `${mode} must never look like a zero`);
    }
  });

  it('11. no failure path can ever produce total_available_qty = 0', () => {
    const cases = [
      derive([failed('pickup', 'api_failed'), failed('dropship', 'api_failed')], 'in_stock', 68),
      derive([failed('pickup', 'code=0')], 'in_stock', 68),
      derive([ok('pickup', null as never, null), failed('dropship', 'api_failed')], 'in_stock', 68),
      derive([ok('open_api', false, null)], 'in_stock', 68),
    ];
    for (const p of cases) {
      assert.equal(p.should_write, false);
      assert.notEqual(p.next_total_available_qty, 0);
      assert.equal(p.next_total_available_qty, 68);
    }
  });

  // ── Rule E: available but unmeasured ───────────────────────────────────────

  it('8. available=true with no quantity anywhere → keep the last reliable quantity', () => {
    const p = derive([ok('pickup', true, null), ok('dropship', true, null)], 'out_of_stock', 31);
    assert.equal(p.next_inventory_status, 'in_stock');
    assert.equal(p.next_total_available_qty, 31);
    assert.equal(p.should_write, true);
    assert.equal(p.reason, 'available_without_reliable_quantity');
    assert.equal(p.quantity_strategy, 'preserve_previous_reliable_quantity');
  });

  it('8b. a zero or negative quantity on an available channel is not a usable quantity', () => {
    const p = derive([ok('pickup', true, 0), ok('dropship', true, -3)], 'out_of_stock', 31);
    assert.equal(p.next_total_available_qty, 31);
    assert.equal(p.reason, 'available_without_reliable_quantity');
  });

  // ── Idempotence ───────────────────────────────────────────────────────────

  it('9. a result identical to the stored values is not written', () => {
    const p = derive([ok('pickup', true, 47), ok('dropship', true, 42)], 'in_stock', 47);
    assert.equal(p.should_write, false);
    assert.equal(p.reason, 'no_change');
    assert.equal(p.quantity_strategy, 'no_write');
    assert.equal(p.next_inventory_status, 'in_stock');
    assert.equal(p.next_total_available_qty, 47);
  });

  // ── Payload safety ────────────────────────────────────────────────────────

  it('12. the update payload can never carry a publication or catalog field', () => {
    const p = derive([ok('pickup', true, 15), ok('dropship', true, 25)], 'out_of_stock', 0);
    const payload = buildStandardizedInventoryUpdate(p);
    assert.deepEqual(Object.keys(payload).sort(), [...STANDARDIZED_INVENTORY_WRITABLE_COLUMNS].sort());
    assert.equal('published' in payload, false);
    assert.equal(payload.inventory_last_synced_at, CHECKED_AT);

    for (const forbidden of ['published', 'selling_price', 'product_title', 'primary_image', 'delist_reason']) {
      assert.throws(
        () => assertNoPublicationWrite({ inventory_status: 'in_stock', [forbidden]: 'x' }),
        /standardized_inventory_forbidden_column|standardized_inventory_unexpected_column/,
        `${forbidden} must be rejected`,
      );
    }
    // A projection that declined to write cannot be turned into a payload at all.
    const declined = derive([failed('pickup', 'api_failed')], 'in_stock', 68);
    assert.throws(() => buildStandardizedInventoryUpdate(declined), /not_permitted/);
  });

  // ── The writer: exactly one row, matched by XSelf SKU ──────────────────────

  const fakeClient = (rows: unknown[], error: { message: string } | null = null) => {
    const calls: Array<{ table: string; payload: Record<string, unknown>; column: string; value: unknown }> = [];
    const client = {
      from(table: string) {
        return {
          update(payload: Record<string, unknown>) {
            return {
              eq(column: string, value: unknown) {
                calls.push({ table, payload, column, value });
                return { select: async () => ({ data: rows, error }) };
              },
            };
          },
        };
      },
    };
    return { client, calls };
  };

  await itAsync('13. the single-SKU path updates exactly one row, matched on the XSelf SKU', async () => {
    const p = derive([ok('pickup', true, 15), ok('dropship', true, 25)], 'out_of_stock', 0);
    const { client, calls } = fakeClient([{ supplier_product_id: 'N710P206904E' }]);
    const result = await applyStandardizedInventoryProjection(client, 'XH-CB-HM-06904E', p, 'out_of_stock', 0);

    assert.equal(result.standardized_inventory_write_attempted, true);
    assert.equal(result.standardized_inventory_write_succeeded, true);
    assert.equal(result.rows_written, 1);
    assert.equal(result.previous_inventory_status, 'out_of_stock');
    assert.equal(result.next_inventory_status, 'in_stock');
    assert.equal(result.previous_total_available_qty, 0);
    assert.equal(result.next_total_available_qty, 25);
    assert.equal(result.quantity_strategy, 'max_reliable_channel_quantity');
    assert.equal(result.reason, 'reliable_channel_in_stock');

    assert.equal(calls.length, 1, 'exactly one UPDATE');
    assert.equal(calls[0].table, 'standardized_products');
    assert.equal(calls[0].column, 'sku_custom', 'must match on the XSelf SKU, exactly');
    assert.equal(calls[0].value, 'XH-CB-HM-06904E');
    assert.equal('published' in calls[0].payload, false);

    // A filter that matched more than one row is a failure, not an accepted write.
    const many = fakeClient([{ a: 1 }, { a: 2 }]);
    const broad = await applyStandardizedInventoryProjection(many.client, 'XH-CB-HM-06904E', p, 'out_of_stock', 0);
    assert.equal(broad.standardized_inventory_write_succeeded, false);
    assert.match(broad.error ?? '', /expected exactly 1 row/);

    // should_write=false issues no UPDATE at all.
    const noWrite = fakeClient([]);
    const declined = derive([failed('pickup', 'api_failed')], 'in_stock', 68);
    const skipped = await applyStandardizedInventoryProjection(noWrite.client, 'XH-CB-HM-06904C', declined, 'in_stock', 68);
    assert.equal(skipped.standardized_inventory_write_attempted, false);
    assert.equal(noWrite.calls.length, 0, 'no UPDATE may be issued when should_write is false');
    assert.equal(skipped.next_total_available_qty, 68);
  });

  // ── Both production paths share this exact function ────────────────────────

  it('14. the scan and the single-SKU path use the same shared projection', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const scanner = fs.readFileSync('scripts/scanPublishedAvailability.ts', 'utf8');
    const bridge = fs.readFileSync('scripts/xoneInventoryLifecycleBridge.ts', 'utf8');
    for (const [name, src] of [['scanner', scanner], ['bridge', bridge]] as const) {
      assert.ok(src.includes('deriveStandardizedInventoryProjection'), `${name} must derive via the shared function`);
      assert.ok(src.includes('applyStandardizedInventoryProjection'), `${name} must write via the shared function`);
      assert.ok(
        src.includes("from '../src/services/standardizedInventoryProjection'"),
        `${name} must import the one shared module — no second implementation`,
      );
    }
    // Neither path may hand-roll an inventory UPDATE on standardized_products.
    for (const [name, src] of [['scanner', scanner], ['bridge', bridge]] as const) {
      assert.equal(
        /from\('standardized_products'\)\s*\.update\(/.test(src), false,
        `${name} must not update standardized_products outside the shared writer`,
      );
    }
  });

  // ── The three real products this was built for ─────────────────────────────

  it('15/16. E / K / C fixtures behave as observed in production', () => {
    // E — Pickup 15, Dropship 25, stored 31.
    const e = derive([ok('pickup', true, 15), ok('dropship', true, 25)], 'in_stock', 31);
    assert.equal(e.next_inventory_status, 'in_stock');
    assert.equal(e.next_total_available_qty, 25);
    assert.equal(e.should_write, true);

    // K — Pickup 47, Dropship 42, stored 72.
    const k = derive([ok('pickup', true, 47), ok('dropship', true, 42)], 'in_stock', 72);
    assert.equal(k.next_inventory_status, 'in_stock');
    assert.equal(k.next_total_available_qty, 47);
    assert.equal(k.should_write, true);

    // C — favorites missing on both accounts, price endpoint returns code=0. Nothing is known,
    // so the stored values survive untouched. This is the case that must never write a zero.
    const c = derive([
      failed('pickup', 'favorites_not_synchronized'),
      failed('dropship', 'favorites_not_synchronized'),
      failed('open_api', 'api_failed'),
    ], 'in_stock', 68);
    assert.equal(c.should_write, false);
    assert.equal(c.reason, 'no_reliable_evidence');
    assert.equal(c.next_inventory_status, 'in_stock');
    assert.equal(c.next_total_available_qty, 68);
    assert.equal(c.failed_channels.length, 3);
  });

  it('channelFromAccountFacts maps a targeted read, and a null read stays unreliable', () => {
    const live = channelFromAccountFacts('pickup', { available: true, total_available_qty: 47 });
    assert.deepEqual(live, { channel: 'pickup', read_ok: true, available: true, quantity: 47, failure_reason: null });
    const dead = channelFromAccountFacts('dropship', null, 'favorites_not_synchronized');
    assert.equal(dead.read_ok, false);
    assert.equal(dead.quantity, null);
    assert.equal(dead.failure_reason, 'favorites_not_synchronized');
  });

  console.log(`\n${passed} passed`);
}

void main();
