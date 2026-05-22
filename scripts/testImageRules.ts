/**
 * Narrow regression tests for src/utils/productImageRules.ts.
 *
 * Run:
 *   npx tsx scripts/testImageRules.ts
 */

import {
  isLikelyNonProductImage,
  PRODUCT_IMAGE_DENY_RE,
  PRODUCT_IMAGE_DENY_KEYWORDS,
} from '../src/utils/productImageRules';

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

console.log('── isLikelyNonProductImage: rejects banner / chrome ──');
assertEqual(
  isLikelyNonProductImage('https://b2bfiles1.gigab2b.cn/bannerDesign/image20260511/e90.png?x-cc=10'),
  true,
  'bannerDesign URL is rejected',
);
assertEqual(
  isLikelyNonProductImage('https://b2bfiles1.gigab2b.cn/static/logo.png'),
  true,
  'logo URL is rejected',
);
assertEqual(
  isLikelyNonProductImage('https://b2bfiles1.gigab2b.cn/static/placeholder.jpg'),
  true,
  'placeholder URL is rejected',
);
assertEqual(
  isLikelyNonProductImage('https://b2bfiles1.gigab2b.cn/icons/cart.png'),
  true,
  'icon URL is rejected',
);
assertEqual(
  isLikelyNonProductImage('https://example.com/spinner.gif'),
  true,
  'spinner URL is rejected',
);
assertEqual(
  isLikelyNonProductImage('https://example.com/favicon.ico'),
  true,
  'favicon URL is rejected',
);
assertEqual(
  isLikelyNonProductImage('https://t.example.com/tracking/pixel.gif'),
  true,
  'tracking pixel URL is rejected',
);

console.log('');
console.log('── isLikelyNonProductImage: rejects supplier docs ──');
assertEqual(
  isLikelyNonProductImage('https://b2bfiles1.gigab2b.cn/image/wkseller/25/product-manual.jpg'),
  true,
  'manual URL is rejected',
);
assertEqual(
  isLikelyNonProductImage('https://b2bfiles1.gigab2b.cn/image/wkseller/25/spec-sheet.jpg'),
  true,
  'spec URL is rejected',
);
assertEqual(
  isLikelyNonProductImage('https://b2bfiles1.gigab2b.cn/image/wkseller/25/detail-001.jpg'),
  true,
  'detail URL is rejected',
);
assertEqual(
  isLikelyNonProductImage('https://b2bfiles1.gigab2b.cn/image/wkseller/25/dimension.jpg'),
  true,
  'dimension URL is rejected',
);
assertEqual(
  isLikelyNonProductImage('https://b2bfiles1.gigab2b.cn/image/wkseller/25/prop65-warning.jpg'),
  true,
  'prop65 URL is rejected',
);
assertEqual(
  isLikelyNonProductImage('https://b2bfiles1.gigab2b.cn/image/wkseller/25/label.jpg'),
  true,
  'label URL is rejected',
);
assertEqual(
  isLikelyNonProductImage('https://b2bfiles1.gigab2b.cn/image/wkseller/25/instruction.pdf.jpg'),
  true,
  'instruction URL is rejected',
);

console.log('');
console.log('── isLikelyNonProductImage: accepts real product images ──');
assertEqual(
  isLikelyNonProductImage('https://b2bfiles1.gigab2b.cn/image/wkseller/25/9419db57c232ad021ed5f38dc00cb5fa.jpg?x-cc=10&x-cu=91992'),
  false,
  'normal b2bfiles product image URL is accepted',
);
assertEqual(
  isLikelyNonProductImage('https://b2bfiles1.gigab2b.cn/image/wkseller/25/87011c45184a02ef32a76cfc6e438197.jpg'),
  false,
  'unsigned b2bfiles product image URL is accepted',
);
assertEqual(
  isLikelyNonProductImage('https://b2bfiles1.gigab2b.cn/image/wkseller/25/abc123.jpg?v=2&t=12345'),
  false,
  'cache-busting querystring does not match any deny keyword',
);
assertEqual(
  isLikelyNonProductImage(''),
  false,
  'empty string is not flagged',
);

console.log('');
console.log('── SVG handling (anchored to end / before "?") ──');
assertEqual(
  isLikelyNonProductImage('https://example.com/asset.svg'),
  true,
  'SVG at end of URL is rejected',
);
assertEqual(
  isLikelyNonProductImage('https://example.com/asset.svg?v=2'),
  true,
  'SVG with querystring is rejected',
);
assertEqual(
  isLikelyNonProductImage('https://example.com/asset.SVG'),
  true,
  'SVG check is case-insensitive',
);
assertEqual(
  isLikelyNonProductImage('https://example.com/svg-camera/photo.jpg'),
  false,
  'path containing letters "svg" but no .svg extension is NOT rejected',
);
assertEqual(
  isLikelyNonProductImage('https://example.com/foo.svg.jpg'),
  false,
  'mid-string ".svg" followed by another extension is NOT rejected',
);

console.log('');
console.log('── querystring does not bypass detection ──');
assertEqual(
  isLikelyNonProductImage('https://b2bfiles1.gigab2b.cn/bannerDesign/image.png?x-cc=10&x-cu=99'),
  true,
  'bannerDesign with signed querystring is rejected',
);
assertEqual(
  isLikelyNonProductImage('https://b2bfiles1.gigab2b.cn/static/logo.png?v=20260520'),
  true,
  'logo with cache-busting querystring is rejected',
);

console.log('');
console.log('── PRODUCT_IMAGE_DENY_RE matches the keyword approach ──');
// Spot-check that the compiled regex (used by Playwright fallback) agrees
// with isLikelyNonProductImage (used by normalize-time imageSelector).
const cases: { url: string; expected: boolean }[] = [
  { url: 'https://b2bfiles1.gigab2b.cn/bannerDesign/image.png', expected: true },
  { url: 'https://b2bfiles1.gigab2b.cn/image/wkseller/25/ok.jpg', expected: false },
  { url: 'https://example.com/asset.svg', expected: true },
  { url: 'https://example.com/svg-camera/photo.jpg', expected: false },
  { url: 'https://example.com/foo-favicon.ico', expected: true },
];
for (const c of cases) {
  const reMatch = PRODUCT_IMAGE_DENY_RE.test(c.url);
  const fnMatch = isLikelyNonProductImage(c.url);
  assertEqual(reMatch, c.expected, `regex matches keyword fn for "${c.url}"`);
  assertEqual(fnMatch, c.expected, `keyword fn matches expectation for "${c.url}"`);
}

console.log('');
console.log('── deny list completeness (sanity) ──');
const requiredKeywords = [
  'label', 'manual', 'instruction', 'detail', 'size', 'spec', 'cert', 'prop65',
  'closeup', 'parts', 'lighting', 'difference',
  'logo', 'placeholder', 'icon', 'sprite', 'tracking', 'pixel',
  'loading', 'spinner', 'favicon', 'bannerdesign',
];
for (const k of requiredKeywords) {
  assertEqual(
    PRODUCT_IMAGE_DENY_KEYWORDS.includes(k),
    true,
    `deny list includes "${k}"`,
  );
}

console.log('');
console.log(`Result: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
