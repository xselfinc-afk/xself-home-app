/**
 * Focused tests for the supplier AI-image-disclaimer filter added to dirtyTextFilters.SKIP_BULLET_PATTERNS.
 * Pure/offline — reuses the existing normalization text-cleaning path (isUsableSentence/isUsableBullet,
 * buildDescription/buildBulletPoints). No SKU special-casing.
 * Run: npx tsx src/__tests__/descriptionDisclaimerFilter.test.ts
 */
import assert from 'node:assert/strict';
import { isUsableSentence, isUsableBullet } from '../services/dirtyTextFilters';
import { buildDescription, buildBulletPoints } from '../services/featureGenerator';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('description disclaimer filter tests');

const DISCLAIMER_1 = 'These images contains AI-generated human models';
const DISCLAIMER_1b = 'These images contain AI-generated human models';
const DISCLAIMER_2 = 'Some figures in this lifestyle photo are created using artificial intelligence';
const DISCLAIMER_3 = 'Image contains an AI-generated model';
const DISCLAIMER_4 = 'Images are for reference and may contain AI-generated people';

// Real product copy (from the W2531P353603 stepper, after the disclaimer)
const REAL_1 = 'Non-slip pedals and secure handlebars ensure a safe and stable workout';
const REAL_2 = 'The vertical climber is the ultimate workout machine designed to mimic rock climbing';

// Legitimate AI PRODUCT features — must NOT be filtered
const AI_FEATURE_1 = 'Features an AI-powered voice assistant for hands-free control';
const AI_FEATURE_2 = 'This smart mirror uses artificial intelligence to suggest daily outfits';
const AI_FEATURE_3 = 'Body-composition scale with AI-generated fitness insights synced to the app';

it('1. removes the known disclaimer variants', () => {
  for (const d of [DISCLAIMER_1, DISCLAIMER_1b, DISCLAIMER_2, DISCLAIMER_3, DISCLAIMER_4]) {
    assert.equal(isUsableSentence(d), false, `sentence should be filtered: ${d}`);
    assert.equal(isUsableBullet(d), false, `bullet should be filtered: ${d}`);
  }
});
it('2. preserves the real product sentences that follow', () => {
  assert.equal(isUsableSentence(REAL_1), true);
  assert.equal(isUsableSentence(REAL_2), true);
});
it('3. removes disclaimer characteristics from bullets', () => {
  const chars = [DISCLAIMER_1 + '. ' + DISCLAIMER_2 + '.', REAL_1, REAL_2];
  const bullets = buildBulletPoints(chars, '', { name: 'Stair Stepper', category: 'Step Machines' });
  assert.ok(!bullets.some(b => /ai-generated|artificial intelligence/i.test(b)), 'no disclaimer in bullets');
});
it('4. preserves valid characteristics', () => {
  const chars = [DISCLAIMER_1, REAL_1, REAL_2];
  const bullets = buildBulletPoints(chars, '', { name: 'Stair Stepper', category: 'Step Machines' });
  assert.ok(bullets.some(b => /non-slip pedals/i.test(b)) || bullets.some(b => /vertical climber/i.test(b)), 'real copy retained');
});
it('5. does NOT remove legitimate AI product-feature copy', () => {
  for (const f of [AI_FEATURE_1, AI_FEATURE_2, AI_FEATURE_3]) {
    assert.equal(isUsableSentence(f), true, `AI feature should be kept: ${f}`);
  }
});
it('6. produces a non-empty, genuine short_description for the W2531 fixture', () => {
  const desc = `${DISCLAIMER_1}. ${DISCLAIMER_2}. ${REAL_1}. ${REAL_2}.`;
  const chars = [`${DISCLAIMER_1}. ${DISCLAIMER_2}.`, REAL_1, REAL_2];
  const out = buildDescription(desc, chars, 'Stair Stepper with Resistance Vertical Climber');
  assert.ok(out.length > 0, 'non-empty');
  assert.ok(!/ai-generated|artificial intelligence/i.test(out), 'disclaimer removed');
  assert.ok(/pedals|climber|workout/i.test(out), 'genuine product copy present');
});
it('7. no regression to a normal furniture description', () => {
  const desc = 'This solid oak dresser features six spacious soft-close drawers. It brings warm, timeless storage to any bedroom.';
  const out = buildDescription(desc, undefined, '6-Drawer Oak Dresser');
  assert.ok(out.length > 0);
  assert.match(out, /dresser|drawers|storage/i);
});

console.log(`\n${passed} passed`);
