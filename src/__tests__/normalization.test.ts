/**
 * Normalization engine unit tests.
 * Run with: npx tsx src/__tests__/normalization.test.ts
 *
 * Uses Node's assert module — no Jest required.
 * Tests pure functions only; no React, no Supabase.
 */

import assert from 'node:assert/strict';

import { isUsableBullet, isUsableSentence } from '../services/dirtyTextFilters';
import { cleanTitle, buildDisplayTitle } from '../services/titleGenerator';
import { buildBulletPoints, buildDescription } from '../services/featureGenerator';
import { fmtDimensions, fmtWeight, categoryCode, sceneCode } from '../services/specFormatter';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e instanceof Error ? e.message : e}`);
    failed++;
  }
}

// ── dirtyTextFilters ──────────────────────────────────────────────────────────

console.log('\ndirtyTextFilters');

test('blocks dimension strings', () => {
  assert.equal(isUsableBullet('43.66" × 15.74" × 74.00"'), false);
  assert.equal(isUsableBullet('W 43" × D 15" × H 74"'), false);
  assert.equal(isUsableBullet('18.7"W x 18.3"D x 19.5"H'), false);
});

test('blocks weight values', () => {
  assert.equal(isUsableBullet('134 lbs'), false);
  assert.equal(isUsableBullet('This unit weighs 134 lbs for stability'), false);
  assert.equal(isUsableBullet('43.5 lb net weight'), false);
});

test('blocks supplier section headers', () => {
  assert.equal(isUsableBullet('Selling Points:'), false);
  assert.equal(isUsableBullet('Selling Points: Multifunctional 3-in-1 design'), false);
  assert.equal(isUsableBullet('Assembly Kit: Yes'), false);
  assert.equal(isUsableBullet('Package size: 25.4"L x 20.1"W x 15.7"H'), false);
  assert.equal(isUsableBullet('Internal space size: 18.7"W x 18.3"D x 19.5"H'), false);
});

test('blocks product dimensions/size phrases', () => {
  assert.equal(isUsableBullet('Product dimensions: W 43" × D 15" × H 74"'), false);
  assert.equal(isUsableBullet('Overall dimensions are 48 inches wide'), false);
});

test('allows clean feature bullets', () => {
  assert.equal(isUsableBullet('Smooth-gliding drawers open and close effortlessly for daily use'), true);
  assert.equal(isUsableBullet('Fits naturally in bedrooms, guest rooms, and walk-in closets'), true);
  assert.equal(isUsableBullet('Reinforced construction stays firmly in place on any flat surface'), true);
  assert.equal(isUsableBullet('Tucks clutter out of sight while keeping essentials accessible'), true);
});

test('blocks dimension sentences in isUsableSentence', () => {
  assert.equal(isUsableSentence('Product weight: 134 lbs'), false);
  assert.equal(isUsableSentence('The assembled dimensions are 43" wide by 15" deep'), false);
});

test('allows clean description sentences', () => {
  assert.equal(isUsableSentence('A streamlined dresser that keeps your bedroom organized.'), true);
  assert.equal(isUsableSentence('Built for everyday use with smooth-gliding drawers.'), true);
});

// ── titleGenerator ────────────────────────────────────────────────────────────

console.log('\ntitleGenerator');

test('cleanTitle strips promotional words', () => {
  // Note: CATEGORY_SUFFIXES_TO_STRIP also strips "- CapitalWord" patterns at end.
  // Use examples that don't have capitalised words after a hyphen.
  assert.equal(cleanTitle('Hot Sale Nightstand with drawer'), 'Nightstand with drawer');
  assert.equal(cleanTitle('Brand New Dresser for bedroom'), 'Dresser for bedroom');
});

test('cleanTitle handles empty/null', () => {
  assert.equal(cleanTitle(''), '');
});

test('cleanTitle truncates at 80 chars', () => {
  const long = 'A'.repeat(50) + ' ' + 'B'.repeat(50);
  assert.ok(cleanTitle(long).length <= 80);
});

test('buildDisplayTitle strips [Tag] prefix', () => {
  assert.equal(buildDisplayTitle('[Video] Rubberwood Dining Chairs Set'), 'Rubberwood Dining Chairs Set');
  assert.equal(buildDisplayTitle('[Photo] White 6-Drawer Dresser'), 'White 6-Drawer Dresser');
});

test('buildDisplayTitle strips OLD SKU prefix', () => {
  assert.equal(buildDisplayTitle('OLD SKU ABC123 Modern Dresser'), 'Modern Dresser');
  assert.equal(buildDisplayTitle('new sku: XYZ999 Cabinet'), 'Cabinet');
});

test('buildDisplayTitle moves Set of N to end', () => {
  assert.equal(
    buildDisplayTitle('Set of 2 Rubberwood Dining Chairs'),
    'Rubberwood Dining Chairs, Set of 2',
  );
});

test('buildDisplayTitle truncates at 55 chars', () => {
  const long = 'Modern Contemporary Solid Wood 6-Drawer Wide Bedroom Storage Dresser with Mirror';
  assert.ok(buildDisplayTitle(long).length <= 55);
});

// ── featureGenerator ──────────────────────────────────────────────────────────

console.log('\nfeatureGenerator');

test('buildBulletPoints filters dirty characteristics', () => {
  const dirty = [
    'Selling Points: Great design',
    'Assembly Kit: Yes',
    'Package size: 25.4"L x 20.1"W',
    '134 lbs total weight',
  ];
  const result = buildBulletPoints(dirty, '', { name: 'Dresser', category: 'dresser' });
  // All dirty ones blocked → should fall back to category templates
  assert.ok(result.length >= 4);
  result.forEach(f => {
    assert.equal(isUsableBullet(f), true, `Dirty bullet leaked: "${f}"`);
  });
});

test('buildBulletPoints uses clean characteristics', () => {
  const clean = [
    'Smooth-gliding drawers open and close effortlessly',
    'Fits naturally in bedrooms and walk-in closets',
    'Solid base stays level on hardwood and carpet',
    'Clean profile blends with modern and transitional décor',
  ];
  const result = buildBulletPoints(clean, '', { name: 'Dresser', category: 'dresser' });
  assert.ok(result.length >= 4);
  assert.ok(result[0].includes('Smooth') || result.some(r => r.includes('Smooth')));
});

test('buildDescription filters dimension sentences', () => {
  const desc = 'Product weight: 134 lbs. A stylish dresser for any bedroom. Assembled dimensions: W 43" × D 15" × H 74".';
  const result = buildDescription(desc);
  assert.ok(!result.includes('134 lbs'), 'Weight sentence leaked');
  assert.ok(!result.includes('Assembled dimensions'), 'Dimension sentence leaked');
});

test('buildDescription skips title-repeat sentences', () => {
  const title = 'Modern 6-Drawer White Dresser';
  const desc = 'Modern 6-Drawer White Dresser features smooth-gliding drawers. Built for everyday bedroom use.';
  const result = buildDescription(desc, undefined, title);
  assert.ok(!result.startsWith('Modern 6-Drawer White Dresser'), 'Title-repeat sentence not filtered');
});

// ── specFormatter ─────────────────────────────────────────────────────────────

console.log('\nspecFormatter');

test('fmtDimensions produces retail string', () => {
  assert.equal(fmtDimensions('43.66', '15.74', '74.00'), 'W 43.66" × D 15.74" × H 74"');
  assert.equal(fmtDimensions(43, 15, 74), 'W 43" × D 15" × H 74"');
});

test('fmtWeight produces retail string', () => {
  assert.equal(fmtWeight('134.00'), '134 lb');
  assert.equal(fmtWeight(43.5), '43.5 lb');
});

test('categoryCode maps correctly', () => {
  assert.equal(categoryCode('dresser'), 'DR');
  assert.equal(categoryCode('cabinet'), 'CB');
  // "TV Stand with Storage" hits the 'storage' → CB rule first in map order.
  // Use a name without competing keywords.
  assert.equal(categoryCode('', 'TV Stand'), 'TV');
  assert.equal(categoryCode('unknown category xyz'), 'GH');
});

test('sceneCode maps correctly', () => {
  assert.equal(sceneCode('dresser'), 'BD');
  assert.equal(sceneCode('sofa'), 'LR');
  assert.equal(sceneCode('cabinet'), 'HM');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
