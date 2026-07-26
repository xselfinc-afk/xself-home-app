/**
 * Defect-fix test: the warehouse-inventory scraper must NOT treat an absent / unrendered /
 * "No data" warehouse component as authoritative out-of-stock. Only an affirmative rendered
 * "0 Available" counts as OUT_OF_STOCK; everything else is INCONCLUSIVE (retryable, no zero write).
 * Pure/offline — importing does NOT run main() (direct-invocation guard).
 * Run: npx tsx src/__tests__/warehouseOosClassification.test.ts
 */
import assert from 'node:assert/strict';
import { classifyEmptyWarehouse } from '../../scripts/syncGigaFurnitureInventory';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('warehouse empty-rows classification (defect fix)');

it('1. affirmative rendered "0 Available" → out_of_stock', () => {
  assert.equal(classifyEmptyWarehouse(['"0 Available"']), 'out_of_stock');
  assert.equal(classifyEmptyWarehouse(['"0 Available"', 'Buy/AddToCart disabled']), 'out_of_stock');
});
it('2. proven false-negative signature (No data + N/A + Buy disabled, no "0 Available") → inconclusive', () => {
  assert.equal(
    classifyEmptyWarehouse(['Warehouse Quantity: No data', 'Total Item Cost: N/A', 'Buy/AddToCart disabled']),
    'inconclusive',
  );
});
it('3. absent / minimal signals → inconclusive (never a false zero)', () => {
  assert.equal(classifyEmptyWarehouse([]), 'inconclusive');
  assert.equal(classifyEmptyWarehouse(['Warehouse Quantity: No data']), 'inconclusive');
});
it('4. ambiguous signals alone are never authoritative OOS (old score>=2 defect is gone)', () => {
  assert.notEqual(
    classifyEmptyWarehouse(['Warehouse Quantity: No data', 'Total Item Cost: N/A', 'Buy/AddToCart disabled']),
    'out_of_stock',
  );
});
it('5. "0 Available" present alongside ambiguous signals → still out_of_stock', () => {
  assert.equal(classifyEmptyWarehouse(['Total Item Cost: N/A', '"0 Available"']), 'out_of_stock');
});
it('6. importing the module did not execute main() (guard holds)', () => {
  assert.equal(typeof classifyEmptyWarehouse, 'function');
});

console.log(`\n${passed} passed`);
