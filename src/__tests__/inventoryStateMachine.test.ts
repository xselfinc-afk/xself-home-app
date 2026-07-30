/**
 * Pure inventory state-machine + CA-priority tests. Run: npx tsx src/__tests__/inventoryStateMachine.test.ts
 */
import assert from 'node:assert/strict';
import {
  transitionInventoryState, DEFAULT_STATE_MACHINE_POLICY,
  type WorkflowSnapshot,
} from '../services/inventoryStateMachine';
import { classifyPriority } from '../services/inventoryPriority';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }
const PUBLISHED: WorkflowSnapshot = { state: 'published_in_stock', consecutiveOutOfStock: 0, consecutiveInStock: 0 };
const t = (prior: WorkflowSnapshot, status: any) => transitionInventoryState(prior, status);

console.log('inventory state machine');

it('first confirmed zero → pending_out_of_stock only (no delist)', () => {
  const r = t(PUBLISHED, 'confirmed_out_of_stock');
  assert.equal(r.next.state, 'pending_out_of_stock');
  assert.equal(r.next.consecutiveOutOfStock, 1);
  assert.equal(r.proposedAction, 'mark_pending_out_of_stock');
  assert.notEqual(r.proposedAction, 'propose_delist');
});

it('second consecutive confirmed zero → eligible_for_delist (still not delisted live)', () => {
  const a = t(PUBLISHED, 'confirmed_out_of_stock');
  const b = t(a.next, 'confirmed_out_of_stock');
  assert.equal(b.next.state, 'eligible_for_delist');
  assert.equal(b.next.consecutiveOutOfStock, 2);
  assert.equal(b.proposedAction, 'propose_delist');
});

it('failure BETWEEN zero checks does not count as a zero', () => {
  const z1 = t(PUBLISHED, 'confirmed_out_of_stock');          // oos=1, pending
  const fail = t(z1.next, 'authentication_required');         // must not increment
  assert.equal(fail.next.consecutiveOutOfStock, 1);
  assert.equal(fail.next.state, 'pending_out_of_stock');      // committed state unchanged
  assert.equal(fail.isException, true);
  const z2 = t(fail.next, 'confirmed_out_of_stock');          // now the true 2nd zero
  assert.equal(z2.next.state, 'eligible_for_delist');
});

it('auth failure cannot delist (raise_exception, state unchanged)', () => {
  const pending = t(PUBLISHED, 'confirmed_out_of_stock').next;
  const r = t(pending, 'authentication_required');
  assert.equal(r.proposedAction, 'raise_exception');
  assert.equal(r.observedException, 'blocked_auth');
  assert.equal(r.next.state, 'pending_out_of_stock');
});

it('parse failure cannot delist', () => {
  const r = t(t(PUBLISHED, 'confirmed_out_of_stock').next, 'parse_failed');
  assert.equal(r.proposedAction, 'raise_exception');
  assert.equal(r.observedException, 'blocked_parse');
});

it('network failure cannot delist', () => {
  const r = t(t(PUBLISHED, 'confirmed_out_of_stock').next, 'network_failed');
  assert.equal(r.proposedAction, 'raise_exception');
  assert.equal(r.observedException, 'blocked_parse');
});

it('inventory_unknown / stale never count as zero, surface exception', () => {
  assert.equal(t(PUBLISHED, 'inventory_unknown').observedException, 'inventory_unknown');
  assert.equal(t(PUBLISHED, 'stale').observedException, 'inventory_unknown');
  assert.equal(t(PUBLISHED, 'stale').next.consecutiveOutOfStock, 0);
});

it('repeated same result is idempotent (pure) + eligible_for_delist stays stable', () => {
  const eligible = t(t(PUBLISHED, 'confirmed_out_of_stock').next, 'confirmed_out_of_stock').next;
  const r1 = t(eligible, 'confirmed_out_of_stock');
  const r2 = t(eligible, 'confirmed_out_of_stock');
  assert.deepEqual(r1, r2);                       // pure: same inputs → same output
  assert.equal(r1.next.state, 'eligible_for_delist'); // stable terminal-ish
});

it('recovery: in-stock while pending → clear_to_published, counters reset', () => {
  const pending = t(PUBLISHED, 'confirmed_out_of_stock').next;
  const r = t(pending, 'confirmed_in_stock_ca');
  assert.equal(r.next.state, 'published_in_stock');
  assert.equal(r.proposedAction, 'clear_to_published');
  assert.equal(r.next.consecutiveOutOfStock, 0);
});

it('first confirmed in-stock AFTER delist → relist_pending (no live relist)', () => {
  const delisted: WorkflowSnapshot = { state: 'delisted_out_of_stock', consecutiveOutOfStock: 2, consecutiveInStock: 0 };
  const r = t(delisted, 'confirmed_in_stock_out_of_state');
  assert.equal(r.next.state, 'relist_pending');
  assert.equal(r.proposedAction, 'mark_relist_pending');
});

it('second consecutive in-stock after delist → eligible_for_relist', () => {
  const delisted: WorkflowSnapshot = { state: 'delisted_out_of_stock', consecutiveOutOfStock: 2, consecutiveInStock: 0 };
  const r1 = t(delisted, 'confirmed_in_stock_ca');
  const r2 = t(r1.next, 'confirmed_in_stock_ca');
  assert.equal(r2.next.state, 'eligible_for_relist');
  assert.equal(r2.proposedAction, 'propose_relist');
});

it('thresholds are configurable (require 3 zeros)', () => {
  const p = { ...DEFAULT_STATE_MACHINE_POLICY, outOfStockConfirmationsRequired: 3 };
  const a = transitionInventoryState(PUBLISHED, 'confirmed_out_of_stock', p);
  const b = transitionInventoryState(a.next, 'confirmed_out_of_stock', p);
  const c = transitionInventoryState(b.next, 'confirmed_out_of_stock', p);
  assert.equal(b.next.state, 'pending_out_of_stock'); // 2 < 3 still pending
  assert.equal(c.next.state, 'eligible_for_delist');  // 3rd triggers
});

console.log('\ncalifornia priority');
it('CA in-stock → P1', () => assert.equal(classifyPriority('confirmed_in_stock_ca'), 'P1'));
it('OOS shippable → P2', () => assert.equal(classifyPriority('confirmed_in_stock_out_of_state'), 'P2'));
it('unknown → P3', () => assert.equal(classifyPriority('inventory_unknown'), 'P3'));
it('stale → P3', () => assert.equal(classifyPriority('stale'), 'P3'));
it('auth failure → P3 (never P4)', () => assert.equal(classifyPriority('authentication_required'), 'P3'));
it('confirmed zero → P4', () => assert.equal(classifyPriority('confirmed_out_of_stock'), 'P4'));
it('transition carries the priority class', () => {
  assert.equal(t(PUBLISHED, 'confirmed_in_stock_ca').priorityClass, 'P1');
  assert.equal(t(PUBLISHED, 'confirmed_out_of_stock').priorityClass, 'P4');
});

console.log(`\n${passed} passed`);
