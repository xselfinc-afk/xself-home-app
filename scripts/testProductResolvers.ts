/**
 * Narrow regression tests for src/services/productResolvers.ts.
 *
 * No test framework is wired up to the project (per CLAUDE.md, the project's
 * "test" is `npx tsc --noEmit`). This script is a self-contained runner that
 * exits non-zero on failure so it can be used in CI without depending on jest.
 *
 * Run:
 *   npx tsx scripts/testProductResolvers.ts
 */

import {
  resolveProductTitle,
  pickFirstNonEmptyString,
  resolveCustomerPrice,
  isPositiveNumber,
  resolveOriginalPrice,
  resolveDiscountPercent,
  resolveSkuDisplay,
  selectFamilySellingPrice,
  type ProductTitleInput,
} from '../src/services/productResolvers';

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
    console.error(`      expected: ${JSON.stringify(expected)}`);
    console.error(`      actual  : ${JSON.stringify(actual)}`);
  }
}

console.log('── pickFirstNonEmptyString ──');
assertEqual(pickFirstNonEmptyString('a', 'b'), 'a', 'returns first non-empty');
assertEqual(pickFirstNonEmptyString(null, undefined, 'c'), 'c', 'skips null and undefined');
assertEqual(pickFirstNonEmptyString('', '   ', 'real'), 'real', 'skips empty and whitespace');
assertEqual(pickFirstNonEmptyString('   padded   '), 'padded', 'trims surrounding whitespace');
assertEqual(pickFirstNonEmptyString(), null, 'returns null when no args');
assertEqual(pickFirstNonEmptyString('', null, undefined, '   '), null, 'returns null when all blank');

console.log('');
console.log('── resolveProductTitle: chain precedence ──');

const fullChain: ProductTitleInput = {
  optimized_title:       'Modern Vanity Set',
  product_title_display: '30" Modern Vanity, Single Sink',
  product_title:         '30 inch Modern Vanity Set with Top Sink and Mirror Cabinet',
};
assertEqual(
  resolveProductTitle(fullChain),
  'Modern Vanity Set',
  'optimized_title wins when present',
);

assertEqual(
  resolveProductTitle({
    optimized_title:       null,
    product_title_display: 'Display Title',
    product_title:         'Long Product Title',
  }),
  'Display Title',
  'product_title_display fallback when optimized_title is null',
);

assertEqual(
  resolveProductTitle({
    optimized_title:       '',
    product_title_display: '   ',
    product_title:         'Long Product Title',
  }),
  'Long Product Title',
  'product_title fallback when earlier fields are empty/whitespace',
);

assertEqual(
  resolveProductTitle({
    optimized_title:       null,
    product_title_display: undefined,
    product_title:         null,
    name:                  'Looser Name Fallback',
  }),
  'Looser Name Fallback',
  'name field used as looser fallback',
);

assertEqual(
  resolveProductTitle({
    optimized_title:       null,
    product_title_display: undefined,
    product_title:         null,
    name:                  null,
    title:                 'Looser Title Fallback',
  }),
  'Looser Title Fallback',
  'title field used when name is also empty',
);

console.log('');
console.log('── resolveProductTitle: sanitizer ──');

assertEqual(
  resolveProductTitle({ product_title: 'K&K Modern Cabinet' }),
  'Modern Cabinet',
  'K&K supplier prefix is stripped',
);

assertEqual(
  resolveProductTitle({ optimized_title: 'K & K. 30" Vanity Set' }),
  '30" Vanity Set',
  'K & K. variant with spaces and period is stripped',
);

assertEqual(
  resolveProductTitle({ product_title: 'Modern K&K Cabinet' }),
  'Modern K&K Cabinet',
  'supplier name in the middle of the title is preserved (anchored prefix only)',
);

console.log('');
console.log('── resolveProductTitle: empty / null fallback ──');

assertEqual(
  resolveProductTitle({ optimized_title: '', product_title_display: '', product_title: '' }),
  'Untitled Product',
  'all-empty input falls back to Untitled Product',
);

assertEqual(
  resolveProductTitle({ optimized_title: null, product_title_display: undefined, product_title: null }),
  'Untitled Product',
  'all-null/undefined input falls back to Untitled Product',
);

assertEqual(
  resolveProductTitle(null),
  'Untitled Product',
  'null input falls back to Untitled Product',
);

assertEqual(
  resolveProductTitle(undefined),
  'Untitled Product',
  'undefined input falls back to Untitled Product',
);

assertEqual(
  resolveProductTitle({ product_title: 'K&K' }),
  'Untitled Product',
  'title that is entirely a supplier prefix sanitizes to empty -> Untitled Product',
);

console.log('');
console.log('── resolveProductTitle: whitespace ──');

assertEqual(
  resolveProductTitle({ product_title: '   30" Modern Vanity   ' }),
  '30" Modern Vanity',
  'surrounding whitespace is trimmed',
);

console.log('');
console.log('── resolveProductTitle: non-Untitled when any field is non-empty ──');

assertEqual(
  resolveProductTitle({ optimized_title: 'A' }),
  'A',
  'single-letter optimized_title is preserved (not Untitled)',
);

assertEqual(
  resolveProductTitle({ product_title: '0' }),
  '0',
  'zero-string is a valid non-empty title (not Untitled)',
);

console.log('');
console.log('── isPositiveNumber ──');
assertEqual(isPositiveNumber(5),       true,  '5 is positive');
assertEqual(isPositiveNumber(0.01),    true,  '0.01 is positive');
assertEqual(isPositiveNumber('5'),     true,  'string "5" parses to positive');
assertEqual(isPositiveNumber('0.01'),  true,  'string "0.01" parses to positive');
assertEqual(isPositiveNumber(0),       false, '0 is not strictly positive');
assertEqual(isPositiveNumber('0'),     false, 'string "0" is not positive');
assertEqual(isPositiveNumber(-1),      false, '-1 is not positive');
assertEqual(isPositiveNumber('-1'),    false, 'string "-1" is not positive');
assertEqual(isPositiveNumber(null),    false, 'null is not positive');
assertEqual(isPositiveNumber(undefined), false, 'undefined is not positive');
assertEqual(isPositiveNumber(NaN),     false, 'NaN is not positive');
assertEqual(isPositiveNumber(Infinity), false, 'Infinity is not positive');
assertEqual(isPositiveNumber('abc'),   false, 'non-numeric string is not positive');
assertEqual(isPositiveNumber(''),      false, 'empty string is not positive');

console.log('');
console.log('── resolveCustomerPrice: ladder precedence ──');

assertEqual(
  resolveCustomerPrice({ selling_price: 449, price: 258 }),
  449,
  'selling_price wins when > 0',
);

assertEqual(
  resolveCustomerPrice({ selling_price: null, price: 258 }),
  258,
  'falls back to price when selling_price is null',
);

assertEqual(
  resolveCustomerPrice({ selling_price: undefined, price: 258 }),
  258,
  'falls back to price when selling_price is undefined',
);

assertEqual(
  resolveCustomerPrice({ selling_price: 0, price: 258 }),
  258,
  'falls back to price when selling_price is 0',
);

assertEqual(
  resolveCustomerPrice({ selling_price: -5, price: 258 }),
  258,
  'falls back to price when selling_price is negative',
);

console.log('');
console.log('── resolveCustomerPrice: string coercion ──');

assertEqual(
  resolveCustomerPrice({ selling_price: '449.00', price: 258 }),
  449,
  'numeric string selling_price is accepted and coerced',
);

assertEqual(
  resolveCustomerPrice({ selling_price: null, price: '258.50' }),
  258.5,
  'numeric string price is accepted and coerced',
);

console.log('');
console.log('── resolveCustomerPrice: invalid input → 0 ──');

assertEqual(
  resolveCustomerPrice({ selling_price: null, price: 0 }),
  0,
  'returns 0 when both fields are non-positive',
);

assertEqual(
  resolveCustomerPrice({ selling_price: null, price: null }),
  0,
  'returns 0 when both fields are null',
);

assertEqual(
  resolveCustomerPrice({}),
  0,
  'returns 0 for empty input object',
);

assertEqual(
  resolveCustomerPrice(null),
  0,
  'returns 0 for null input',
);

assertEqual(
  resolveCustomerPrice(undefined),
  0,
  'returns 0 for undefined input',
);

assertEqual(
  resolveCustomerPrice({ selling_price: 'abc', price: 'def' }),
  0,
  'returns 0 when both fields are non-numeric strings',
);

assertEqual(
  resolveCustomerPrice({ selling_price: NaN, price: -10 }),
  0,
  'returns 0 when selling_price is NaN and price is negative',
);

console.log('');
console.log('── resolveOriginalPrice: gate (>customerPrice) ──');

assertEqual(
  resolveOriginalPrice({ original_price: 400, customerPrice: 258 }),
  400,
  'original_price > customerPrice returns original_price',
);

assertEqual(
  resolveOriginalPrice({ original_price: 258, customerPrice: 258 }),
  undefined,
  'original_price equal to customerPrice returns undefined',
);

assertEqual(
  resolveOriginalPrice({ original_price: 200, customerPrice: 258 }),
  undefined,
  'original_price < customerPrice returns undefined',
);

assertEqual(
  resolveOriginalPrice({ original_price: null, customerPrice: 258 }),
  undefined,
  'null original_price returns undefined',
);

assertEqual(
  resolveOriginalPrice({ original_price: undefined, customerPrice: 258 }),
  undefined,
  'undefined original_price returns undefined',
);

assertEqual(
  resolveOriginalPrice({ original_price: 0, customerPrice: 258 }),
  undefined,
  'original_price = 0 returns undefined',
);

assertEqual(
  resolveOriginalPrice({ original_price: -10, customerPrice: 258 }),
  undefined,
  'negative original_price returns undefined',
);

console.log('');
console.log('── resolveOriginalPrice: string coercion ──');

assertEqual(
  resolveOriginalPrice({ original_price: '400.00', customerPrice: 258 }),
  400,
  'numeric string original_price is accepted and coerced',
);

assertEqual(
  resolveOriginalPrice({ original_price: 'abc', customerPrice: 258 }),
  undefined,
  'non-numeric string original_price returns undefined',
);

console.log('');
console.log('── resolveOriginalPrice: no fake discount on real M/Z shape ──');
// On rows like N710P206904M, the AI sets selling_price=449 while original_price=335.40.
// customerPrice = max(selling_price, price) = 449. original_price 335.40 is NOT > 449
// → originalPrice must be undefined (no fake strikethrough).
assertEqual(
  resolveOriginalPrice({ original_price: 335.40, customerPrice: 449 }),
  undefined,
  'no fake strikethrough when selling_price exceeds original_price',
);

console.log('');
console.log('── resolveDiscountPercent: calculation ──');

assertEqual(
  resolveDiscountPercent({ originalPrice: 400, customerPrice: 200 }),
  50,
  '50% off — $200 vs $400',
);

assertEqual(
  resolveDiscountPercent({ originalPrice: 100, customerPrice: 75 }),
  25,
  '25% off — $75 vs $100',
);

assertEqual(
  resolveDiscountPercent({ originalPrice: 99, customerPrice: 89 }),
  10,
  'rounds to nearest integer — 10.10 → 10',
);

assertEqual(
  resolveDiscountPercent({ originalPrice: 100, customerPrice: 67 }),
  33,
  'rounds half up — 33.0 → 33',
);

console.log('');
console.log('── resolveDiscountPercent: zero cases ──');

assertEqual(
  resolveDiscountPercent({ originalPrice: undefined, customerPrice: 258 }),
  0,
  'undefined originalPrice returns 0',
);

assertEqual(
  resolveDiscountPercent({ originalPrice: null, customerPrice: 258 }),
  0,
  'null originalPrice returns 0',
);

assertEqual(
  resolveDiscountPercent({ originalPrice: 400, customerPrice: 0 }),
  0,
  'customerPrice = 0 returns 0',
);

assertEqual(
  resolveDiscountPercent({ originalPrice: 400, customerPrice: -10 }),
  0,
  'negative customerPrice returns 0',
);

assertEqual(
  resolveDiscountPercent({ originalPrice: 200, customerPrice: 258 }),
  0,
  'originalPrice <= customerPrice returns 0 (no fake discount)',
);

assertEqual(
  resolveDiscountPercent({ originalPrice: 258, customerPrice: 258 }),
  0,
  'originalPrice equal to customerPrice returns 0',
);

assertEqual(
  resolveDiscountPercent(null),
  0,
  'null input returns 0',
);

assertEqual(
  resolveDiscountPercent(undefined),
  0,
  'undefined input returns 0',
);

console.log('');
console.log('── resolveDiscountPercent: integrates with resolveOriginalPrice ──');
// Compose them as the adapter does. selling_price > original_price = no discount surfaced.
{
  const customerPrice = resolveCustomerPrice({ selling_price: 449, price: 258 });
  const originalPrice = resolveOriginalPrice({ original_price: 335.40, customerPrice });
  const discountPercent = resolveDiscountPercent({ originalPrice, customerPrice });
  assertEqual(customerPrice,    449,       'composed: customerPrice = selling_price when set');
  assertEqual(originalPrice,    undefined, 'composed: originalPrice undefined when AI selling_price exceeds list');
  assertEqual(discountPercent,  0,         'composed: discountPercent 0 when no surfacing originalPrice');
}
{
  const customerPrice = resolveCustomerPrice({ selling_price: null, price: 200 });
  const originalPrice = resolveOriginalPrice({ original_price: 400, customerPrice });
  const discountPercent = resolveDiscountPercent({ originalPrice, customerPrice });
  assertEqual(customerPrice,    200, 'composed: customerPrice = price when selling_price absent');
  assertEqual(originalPrice,    400, 'composed: originalPrice surfaced when > customerPrice');
  assertEqual(discountPercent,  50,  'composed: discountPercent computed correctly');
}

console.log('');
console.log('── resolveSkuDisplay: walk order ──');

assertEqual(
  resolveSkuDisplay({ skuCustom: 'XH-CB-HM-06904M', sku: 'fallback-sku', supplier_product_id: 'N710P206904M' }),
  'XH-CB-HM-06904M',
  'skuCustom wins when present',
);

assertEqual(
  resolveSkuDisplay({ skuCustom: null, sku: 'direct-sku', supplier_product_id: 'N710P206904M' }),
  'direct-sku',
  'sku field used when skuCustom is null',
);

assertEqual(
  resolveSkuDisplay({ skuCustom: null, variants: [{ sku: 'variant-sku' }], supplier_product_id: 'N710P206904M' }),
  'variant-sku',
  'variants[0].sku used when skuCustom and sku are absent',
);

assertEqual(
  resolveSkuDisplay({ skuCustom: '', sku: '', supplierProductId: 'SUPPLIER-1' }),
  'SUPPLIER-1',
  'supplierProductId fallback works',
);

assertEqual(
  resolveSkuDisplay({ skuCustom: null, supplier_product_id: 'N710P206904M' }),
  'N710P206904M',
  'supplier_product_id fallback works (snake_case)',
);

assertEqual(
  resolveSkuDisplay({ skuCustom: null, id: 'N710P206904M' }),
  'N710P206904M',
  'id (Product.id = supplier_product_id) used as last-resort SKU',
);

console.log('');
console.log('── resolveSkuDisplay: whitespace ──');

assertEqual(
  resolveSkuDisplay({ skuCustom: '   XH-CB-HM-06904M   ' }),
  'XH-CB-HM-06904M',
  'whitespace is trimmed',
);

assertEqual(
  resolveSkuDisplay({ skuCustom: '   ', sku: 'real-sku' }),
  'real-sku',
  'whitespace-only skuCustom is skipped',
);

console.log('');
console.log('── resolveSkuDisplay: empty / null fallback to "—" ──');

assertEqual(
  resolveSkuDisplay({ skuCustom: null, sku: null, supplier_product_id: null, id: null }),
  '—',
  'all null returns "—"',
);

assertEqual(
  resolveSkuDisplay({ skuCustom: undefined, sku: undefined, id: undefined }),
  '—',
  'all undefined returns "—"',
);

assertEqual(
  resolveSkuDisplay({ skuCustom: '', sku: '', supplier_product_id: '' }),
  '—',
  'all empty strings returns "—"',
);

assertEqual(
  resolveSkuDisplay({ skuCustom: '  ', sku: '  ', supplier_product_id: '  ' }),
  '—',
  'all whitespace-only returns "—"',
);

assertEqual(
  resolveSkuDisplay({ variants: [] }),
  '—',
  'empty variants array with nothing else returns "—"',
);

assertEqual(
  resolveSkuDisplay({ variants: [null] as never }),
  '—',
  'variants[0] null with nothing else returns "—"',
);

assertEqual(
  resolveSkuDisplay(null),
  '—',
  'null input returns "—"',
);

assertEqual(
  resolveSkuDisplay(undefined),
  '—',
  'undefined input returns "—"',
);

assertEqual(
  resolveSkuDisplay({}),
  '—',
  'empty input object returns "—"',
);

console.log('');
console.log('── resolveSkuDisplay: never returns "XSF-XXXX" ──');

// Exhaustive: across every empty-input shape, the resolver must NEVER
// produce the deprecated `XSF-XXXX` placeholder (DEP-2).
const emptyShapes = [
  null,
  undefined,
  {},
  { skuCustom: null, sku: null, supplier_product_id: null },
  { skuCustom: '', sku: '', supplier_product_id: '', id: '' },
  { skuCustom: '   ', sku: '   ', supplier_product_id: '   ' },
  { variants: [] },
];
let everReturnedXSF = false;
for (const shape of emptyShapes) {
  if (resolveSkuDisplay(shape as never) === 'XSF-XXXX') everReturnedXSF = true;
}
assertEqual(everReturnedXSF, false, 'resolver never returns the deprecated XSF-XXXX placeholder');

console.log('');
console.log('── selectFamilySellingPrice ──');

assertEqual(
  selectFamilySellingPrice([449, 449]),
  449,
  'two identical prices return that price',
);

assertEqual(
  selectFamilySellingPrice([449, 408, 449]),
  449,
  'mode wins — 449 appears twice, 408 once',
);

assertEqual(
  selectFamilySellingPrice([449, 408]),
  449,
  'tie: higher price wins',
);

assertEqual(
  selectFamilySellingPrice([100, 200, 300]),
  300,
  'three-way tie: highest wins',
);

assertEqual(
  selectFamilySellingPrice([null, 0, -5, 449]),
  449,
  'ignores null, 0, negative — keeps the one valid value',
);

assertEqual(
  selectFamilySellingPrice([null, 0, -5, 'abc' as never, undefined]),
  null,
  'all invalid inputs return null',
);

assertEqual(
  selectFamilySellingPrice([]),
  null,
  'empty list returns null',
);

assertEqual(
  selectFamilySellingPrice(['449.00' as never, 449]),
  449,
  'numeric strings are coerced and counted',
);

assertEqual(
  selectFamilySellingPrice([449]),
  449,
  'single valid price returns itself',
);

console.log('');
console.log(`Result: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
