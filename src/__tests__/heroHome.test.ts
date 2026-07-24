/**
 * Home Hero invariants (Phase 2.5) — pure source-structure test; no I/O beyond reading
 * App.tsx / HeroBanner.tsx as text, no DB, no React (the repo has no RN renderer in its
 * test tooling). Run: npx tsx src/__tests__/heroHome.test.ts   (from repo root)
 *
 * Proves the two final Hero decisions:
 *   - Title is an explicit two-line string, capped at two lines (never three).
 *   - Home Hero uses ONE fixed asset; no random/rotating selector controls it.
 *   - CTA handler/route remain connected.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const app = readFileSync(join(process.cwd(), 'App.tsx'), 'utf8');
const hero = readFileSync(join(process.cwd(), 'src/components/HeroBanner.tsx'), 'utf8');

console.log('home hero tests');

it('title is the explicit two-line string "Make room for\\nwhat matters"', () => {
  // Literal backslash-n in the source string forces the exact two-line split.
  assert.ok(app.includes("title={'Make room for\\nwhat matters'}"), 'explicit \\n title present');
});

it('title is capped at two lines (numberOfLines={2}) so it can never render three', () => {
  assert.ok(hero.includes('style={[styles.titleSerif, TEXT_SHADOW]} numberOfLines={2}'), 'titleSerif capped at 2 lines');
});

it('Home Hero uses ONE fixed asset source (the approved sofa)', () => {
  assert.ok(app.includes("require('./assets/home/home-hero.jpg')"), 'fixed hero asset required');
  assert.ok(app.includes('const HOME_HERO_IMAGE ='), 'fixed image constant declared');
  assert.ok(app.includes('imageSource={HOME_HERO_IMAGE}'), 'hero uses the fixed imageSource');
});

it('no random / rotating / product-data selector controls the Home Hero', () => {
  assert.equal(app.includes('selectHeroImage'), false, 'random selector import/usage removed');
  assert.equal(app.includes('heroImageResult'), false, 'randomized hero memo removed');
  assert.equal(app.includes('heroSeenRef'), false, 'anti-repeat ref removed');
  assert.equal(app.includes('image={heroImageResult'), false, 'hero image no longer from the selector');
});

it('HeroBanner exposes a deterministic imageSource path (precedence over variantUrl url)', () => {
  assert.ok(hero.includes('imageSource'), 'imageSource prop threaded');
  assert.ok(hero.includes('const heroSource = imageSource ??'), 'imageSource takes precedence');
  assert.ok(hero.includes('source={heroSource}'), 'image renders from the resolved source');
});

it('Home Hero uses the approved height ratio (0.80)', () => {
  assert.ok(app.includes('heightRatio={0.80}'), 'hero heightRatio is 0.80');
});

it('CTA routes to the existing Furniture department world (not a collection/sale feed)', () => {
  assert.ok(app.includes("navigation.navigate('CommerceBrowse', { level: 'department', department: 'furniture' })"), 'CTA routes to Furniture department');
  assert.equal(app.includes("{ key: 'make-room' }"), false, 'no longer routes to make-room');
  assert.equal(app.includes("navigation.navigate('Collection', { key: 'spring-sale' })"), false, 'no longer routes to spring-sale');
  assert.ok(app.includes('ctaText="Explore the collection"'), 'CTA label intact');
});

console.log(`\n${passed} passed`);
