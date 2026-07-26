/**
 * Focused offline tests for the scoped onboarding completion gate
 * (scripts/onboardScopedSkus.ts). Pure — importing does NOT run main() (direct-invocation guard).
 * Run: npx tsx src/__tests__/onboardScopedSkus.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateCompletionGate } from '../../scripts/onboardScopedSkus';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('scoped onboarding completion-gate tests');

it('1. success only when every sellable-eligible SKU has an active review', () => {
  const g = evaluateCompletionGate(['S1', 'S2'], new Set(['S1', 'S2']), new Set(['S1', 'S2']));
  assert.equal(g.ok, true);
  assert.deepEqual(g.eligible, ['S1', 'S2']);
  assert.deepEqual(g.missingReviews, []);
});
it('2. a sellable SKU with ZERO active reviews FAILS the gate (cannot complete)', () => {
  const g = evaluateCompletionGate(['S1', 'S2'], new Set(['S1', 'S2']), new Set(['S1']));
  assert.equal(g.ok, false);
  assert.deepEqual(g.missingReviews, ['S2']);
});
it('3. blocked / non-sellable SKUs are excluded (not failures); eligible subset can still complete', () => {
  const g = evaluateCompletionGate(['S1', 'B1'], new Set(['S1']), new Set(['S1']));
  assert.equal(g.ok, true);
  assert.deepEqual(g.eligible, ['S1']);
  assert.deepEqual(g.excluded, ['B1']);
});
it('4. none sellable → not ok (fail-closed: nothing to complete)', () => {
  const g = evaluateCompletionGate(['B1', 'B2'], new Set(), new Set());
  assert.equal(g.ok, false);
  assert.deepEqual(g.eligible, []);
  assert.deepEqual(g.excluded, ['B1', 'B2']);
});
it('5. sellable but no reviews at all → not ok', () => {
  const g = evaluateCompletionGate(['S1'], new Set(['S1']), new Set());
  assert.equal(g.ok, false);
  assert.deepEqual(g.missingReviews, ['S1']);
});

// ── source-level: thin delegator, review bootstrap wired, not the 8-stage runner ──
const src = readFileSync('scripts/onboardScopedSkus.ts', 'utf8');
it('6. invokes the existing review bootstrap (seedReviewsForSellable) as a stage', () => {
  assert.ok(src.includes('scripts/seedReviewsForSellable.ts'), 'onboarding wrapper calls the review helper');
});
it('7. delegates to existing stages; does NOT run the 8-stage runGigaAutoPublish', () => {
  assert.ok(src.includes('scripts/normalizeProducts.ts'));
  assert.ok(src.includes('dynamic-pricing'));
  assert.ok(src.includes('refresh_product_inventory_status'));
  assert.ok(!src.includes('scripts/runGigaAutoPublish'), 'must not spawn/invoke the full 8-stage runner (mention in a comment is fine)');
});
it('8. propagates non-zero exit on stage failure (fail-fast)', () => {
  assert.ok(/process\.exit\(r\.status/.test(src), 'stage failure → non-zero exit');
  assert.ok(/ONBOARDING INCOMPLETE/.test(src) && /process\.exit\(1\)/.test(src), 'gate failure → non-zero exit');
});

console.log(`\n${passed} passed`);
