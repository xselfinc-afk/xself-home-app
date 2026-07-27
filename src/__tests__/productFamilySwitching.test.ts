/**
 * Product Family PDP switching invariants (Phases 2–5) — source-structure test over
 * App.tsx (the repo has no React renderer in its test tooling; it locks composition
 * against source, matching homeCommerceEntryPlacement.test.ts). Proves the reactivated
 * family path switches EVERY SKU-specific field to the selected child and never leaks the
 * family representative. Run: npx tsx src/__tests__/productFamilySwitching.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const src = readFileSync(join(process.cwd(), 'App.tsx'), 'utf8');
const count = (s: string) => src.split(s).length - 1;

console.log('product family PDP switching invariants');

it('Phase 2: PDP mounts the family loader ONLY behind the pilot gate; single-SKU fallback preserved', () => {
  assert.ok(src.includes('isPilotFamily(familyKey)'), 'family load gated by isPilotFamily');
  assert.ok(src.includes('loadProductFamily(familyKey!)'), 'pilot families use loadProductFamily');
  assert.ok(src.includes('const openSingle = () => loadProductDetail(skuId)'), 'single-SKU loader preserved as fallback');
  // The tapped SKU is preselected when it belongs to the family.
  assert.ok(src.includes('fam.variants!.find(v => v.supplierProductId === skuId)'), 'opened SKU is preselected');
});

it('Phase 3: selected variant must resolve to a concrete child — no silent representative fallback', () => {
  assert.ok(src.includes('const isFamily = (product.variantProducts?.length ?? 0) > 0 && (product.variants?.length ?? 0) > 1'));
  assert.ok(/const resolvedSibling: Product \| undefined = selectedVariant\?\.supplierProductId/.test(src));
  assert.ok(src.includes('const variantResolved: boolean = !isFamily'), 'variantResolved invariant present');
  assert.ok(src.includes('resolvedSibling.id === selectedVariant.supplierProductId'), 'resolved child id must equal variant fulfillment key');
});

it('Phase 4: child CONTENT comes from selectedSibling', () => {
  assert.ok(src.includes('selectedSibling.displayTitle ?? selectedSibling.name'), 'title from sibling');
  assert.ok(src.includes('selectedSibling.desc'), 'description from sibling');
  assert.ok(src.includes('selectedSibling.features'), 'features from sibling');
  assert.ok(src.includes('selectedSibling.specs'), 'specs from sibling');
});

it('Phase 4: child IDENTITY/price/images/stock come from the selected variant', () => {
  assert.ok(src.includes('selectedVariant?.images ?? product.images'), 'gallery from selected variant');
  assert.ok(src.includes('selectedVariant?.price ?? product.price'), 'price from selected variant');
  assert.ok(src.includes('selectedVariant.supplierProductId ?? product.id'), 'cart fulfillment key = selected variant SKU');
});

it('Phase 5: reviews, header rating, and analytics follow the selected child', () => {
  assert.ok(src.includes('<ReviewSection product={selectedSibling} />'), 'ReviewSection keyed to selected child');
  assert.ok(src.includes("trackView(selectedChildId)"), 'analytics view keyed to selected child');
  assert.ok(src.includes(".eq('supplier_product_id', selectedChildId)"), 'header rating query keyed to selected child');
  // The old representative-keyed forms must be gone.
  assert.equal(src.includes("trackView(product.id)"), false, 'no trackView(product.id) leak');
  assert.equal(src.includes("<ReviewSection product={product} />"), false, 'no representative ReviewSection leak');
});

it('Phase 5: spec fallback reads the selected child (no representative material/weight/SKU leak)', () => {
  assert.ok(src.includes('selectedSibling.tags?.material'), 'fallback material from sibling');
  assert.ok(src.includes('(selectedSibling as any).weight'), 'fallback weight from sibling');
});

it('Phase 3/4: purchase CTAs are hard-disabled when the family child is unresolved', () => {
  assert.ok(src.includes('if (!variantResolved) return;'), 'add/buy handlers gate on variantResolved');
  assert.ok(count('isOutOfStock || !variantResolved') >= 3, 'both inline CTAs + floating CTA reflect variantResolved');
});

console.log(`\n${passed} switching invariants passed.`);
