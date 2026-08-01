/**
 * Saved Items assortment gate tests (pure; no database, no supplier, no network).
 *
 * The central property: with the flag OFF the gate is indistinguishable from the legacy inline
 * expression it replaced. Everything else this suite proves is secondary to that — a wiring change
 * that alters production behavior while disabled would be a regression no matter how correct the
 * enabled branch is.
 *
 * Run: npx tsx src/__tests__/savedItemsAssortmentGate.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SAVED_ITEMS_TAXONOMY_FIRST_ENABLED,
  isTaxonomyFirstEnabled,
} from '../config/savedItemsAssortment';
import {
  LEGACY_HARD_JUNK,
  LEGACY_JUNK_REASON,
  NON_FURNITURE_REASON,
  assortmentGate,
  isNonCandidateOutcome,
  legacyJunkBlocked,
  reviewClassificationFor,
} from '../services/savedItemsAssortmentGate';
import { HARD_JUNK } from '../../scripts/planGigaSavedItems';
import { NON_FURNITURE_SKUS, OUTDOOR_POLICY_SKUS, RESCUED_FURNITURE_SKUS } from './fixtures/outdoorPolicySkus';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PLAN_SAVED = 'scripts/planGigaSavedItems.ts';
const PLAN_PUBLISH = 'scripts/planGigaAutoPublish.ts';

/** Titles spanning every branch, used for the exhaustive legacy-equivalence sweep. */
const CORPUS: string[] = [
  ...OUTDOOR_POLICY_SKUS.map(([, t]) => t),
  ...RESCUED_FURNITURE_SKUS.map(([, t]) => t),
  ...NON_FURNITURE_SKUS.map(([, t]) => t),
  'Twin Size Murphy Bed with Bookshelf, White',
  '6-Drawer Dresser for Bedroom, White',
  'Stainless Steel Trash Can 13 Gallon',
  'Outdoor Garden Sculpture Flamingo Flower Pot Planter',
  '',
  '   ',
  'XJ-9920 Assembly Kit Model B',
];

function main(): void {
  // ── 1. Flag defaults false, and OFF is byte-identical to legacy ─────────────

  it('1. the shipped flag default is false', () => {
    assert.equal(SAVED_ITEMS_TAXONOMY_FIRST_ENABLED, false);
    assert.equal(isTaxonomyFirstEnabled(), false);
    assert.equal(isTaxonomyFirstEnabled(undefined), false);
    // A config file that ships `true` must fail the suite, not just look wrong in review.
    assert.match(read('src/config/savedItemsAssortment.ts'), /SAVED_ITEMS_TAXONOMY_FIRST_ENABLED = false;/);
  });

  it('2. the gate replica is the SAME regex as the production literal', () => {
    assert.equal(LEGACY_HARD_JUNK.source, HARD_JUNK.source);
    assert.equal(LEGACY_HARD_JUNK.flags, HARD_JUNK.flags);
    // planGigaAutoPublish keeps its own copy; it must not drift either.
    const m = read(PLAN_PUBLISH).match(/^const HARD_JUNK = (.+);$/m);
    assert.ok(m, 'no HARD_JUNK literal in planGigaAutoPublish.ts');
    assert.equal(m![1], String(LEGACY_HARD_JUNK));
  });

  it('3. flag OFF reproduces the legacy expression exactly, across the whole corpus', () => {
    for (const title of CORPUS) {
      const g = assortmentGate({ title, taxonomyFirst: false });
      assert.equal(g.blocked, HARD_JUNK.test(title), `blocked mismatch: ${title.slice(0, 50)}`);
      assert.equal(g.blocked, legacyJunkBlocked(title));
      assert.equal(g.mode, 'legacy');
      assert.equal(g.reason, g.blocked ? LEGACY_JUNK_REASON : null);
      // Legacy mode has no notion of assortment class and must never invent one.
      assert.equal(g.assortmentClass, null);
      // Legacy mode never produces a review classification, so the report shape cannot change.
      assert.equal(reviewClassificationFor(g.outcome), null);
    }
  });

  it('4. the default (no override) path is the legacy path', () => {
    for (const title of CORPUS.slice(0, 20)) {
      assert.deepEqual(assortmentGate({ title }), assortmentGate({ title, taxonomyFirst: false }));
    }
  });

  // ── 2. Flag ON — validated outcomes ─────────────────────────────────────────

  it('5. flag ON rescues all validated furniture candidates', () => {
    assert.equal(RESCUED_FURNITURE_SKUS.length, 9);
    for (const [sku, title] of RESCUED_FURNITURE_SKUS) {
      assert.equal(assortmentGate({ title, taxonomyFirst: false }).blocked, true, `${sku} should be legacy-blocked`);
      const g = assortmentGate({ title, taxonomyFirst: true });
      assert.equal(g.blocked, false, `${sku} still blocked`);
      assert.equal(g.outcome, 'allow', `${sku} → ${g.outcome}`);
      assert.equal(reviewClassificationFor(g.outcome), null, `${sku} must stay a normal candidate`);
    }
  });

  it('6. flag ON newly excludes ZERO gate-applicable candidates', () => {
    // Only candidates reach the gate, so only candidates can be newly excluded. `alreadyImported`
    // holds titles that ARE non-furniture but belong to imported SKUs — membership precedence means
    // the gate never sees them, which is exactly why they are excluded from this sweep.
    const alreadyImported = new Set([
      // W2531P353603 — a stair stepper, already in supplier_products. Classified non-furniture, but
      // never re-gated: imported products keep 'already_imported' regardless of the flag.
      'Stair Stepper with Resistance Home-Upgrade Vertical Climber Workout Machine for Full-Body Exercise Climber Fitness Equipment with Stable Frame Adjustable Handlebar-Pink',
    ]);
    const candidates = CORPUS.filter(t => t.trim() && !alreadyImported.has(t));
    const newlyExcluded = candidates.filter(
      t => !assortmentGate({ title: t, taxonomyFirst: false }).blocked
        && assortmentGate({ title: t, taxonomyFirst: true }).blocked,
    );
    assert.deepEqual(newlyExcluded, [], `newly excluded: ${newlyExcluded.join(' | ')}`);
  });

  it('6b. an already-imported non-furniture SKU is never re-gated', () => {
    const stairStepper = 'Stair Stepper with Resistance Home-Upgrade Vertical Climber Workout Machine for Full-Body Exercise Climber Fitness Equipment with Stable Frame Adjustable Handlebar-Pink';
    // The classifier does call it non-furniture …
    assert.equal(assortmentGate({ title: stairStepper, taxonomyFirst: true }).outcome, 'reject_non_furniture');
    // … and legacy accepted it, so it WOULD be a newly-excluded candidate — except that membership
    // precedence in planGigaSavedItems returns 'already_imported' before the gate is consulted.
    assert.equal(assortmentGate({ title: stairStepper, taxonomyFirst: false }).blocked, false);
    const src = read(PLAN_SAVED);
    const elseBranch = src.slice(src.indexOf("classification = 'already_imported';"));
    assert.ok(elseBranch.indexOf('gate.blocked') > 0, 'the gate must be consulted only after membership');
  });

  it('7. the confirmed outdoor set maps to policy_review_outdoor', () => {
    const EXCEPTION = 'W2500P479541'; // documented dual-use egg chair → manual review
    let outdoor = 0;
    for (const [sku, title] of OUTDOOR_POLICY_SKUS) {
      const g = assortmentGate({ title, taxonomyFirst: true });
      if (sku === EXCEPTION) {
        assert.equal(g.outcome, 'manual_review_required', sku);
        continue;
      }
      assert.equal(g.outcome, 'policy_review_outdoor', `${sku} → ${g.outcome}`);
      assert.equal(g.blocked, false, `${sku} must be held, not rejected`);
      assert.equal(reviewClassificationFor(g.outcome), 'policy_review_outdoor');
      outdoor++;
    }
    assert.equal(outdoor, 41);
  });

  it('8. both dual-use hanging egg chairs map to manual review', () => {
    for (const t of [
      'Folding PE Rattan Hanging Egg Chair with Stand, Gray Indoor Outdoor Hammock Swing Basket Chair, Aluminum Steel Frame for Patio Balcony Backyard Bedroom',
      'Foldable Hanging Egg Chair with Stand, HDPE Rattan Wicker Swing Chair with Cushion, Heavy Duty Frame 350 Lbs Capacity, Outdoor Patio Indoor Bedroom Balcony, Black+ Black',
    ]) {
      const g = assortmentGate({ title: t, taxonomyFirst: true });
      assert.equal(g.outcome, 'manual_review_required');
      assert.equal(g.blocked, false, 'manual review holds, it does not reject');
      assert.equal(reviewClassificationFor(g.outcome), 'manual_review_required');
    }
  });

  it('9. genuine non-furniture stays excluded, with an explicit reason', () => {
    assert.equal(NON_FURNITURE_SKUS.length, 30);
    for (const [sku, title] of NON_FURNITURE_SKUS) {
      const g = assortmentGate({ title, taxonomyFirst: true });
      assert.equal(g.outcome, 'reject_non_furniture', `${sku} → ${g.outcome}`);
      assert.equal(g.blocked, true, sku);
      assert.equal(g.reason, NON_FURNITURE_REASON, sku);
    }
  });

  it('10. every review outcome is a NON-candidate — none can auto-publish', () => {
    for (const o of ['policy_review_outdoor', 'policy_review_decor', 'manual_review_required', 'reject_non_furniture'] as const) {
      assert.ok(isNonCandidateOutcome(o), `${o} must not be treated as a candidate`);
    }
    assert.ok(!isNonCandidateOutcome('allow'));
    // Review classifications are distinct from 'new_candidate', which is what downstream consumes.
    for (const o of ['policy_review_outdoor', 'policy_review_decor', 'manual_review_required'] as const) {
      assert.notEqual(reviewClassificationFor(o), 'new_candidate');
    }
  });

  // ── 3. Wiring safety in the plan script ─────────────────────────────────────

  it('11. membership precedence is unchanged and still runs before the gate', () => {
    const src = read(PLAN_SAVED);
    assert.match(src, /if \(inSell === true\) \{\s*classification = 'already_published';/);
    assert.match(src, /\} else if \(inSupplier \|\| inStd\) \{\s*classification = 'already_imported';/);
    // The gate is consulted only inside the else branch's hardInvalid expression.
    assert.match(src, /const hardInvalid =[\s\S]{0,200}gate\.blocked/);
  });

  it('12. existing image / price / enrichment gates still apply', () => {
    const src = read(PLAN_SAVED);
    for (const term of [
      "invalid_reasons.push('missing_title')",
      "invalid_reasons.push('no_image')",
      "invalid_reasons.push('image_unknown')",
      "invalid_reasons.push('no_price')",
      "invalid_reasons.push('price_not_positive')",
      "invalid_reasons.push('price_unknown')",
      "invalid_reasons.push('enrichment_skipped')",
    ]) {
      assert.ok(src.includes(term), `safety check removed: ${term}`);
    }
    // hardInvalid still ORs every original term — the gate was added, not substituted.
    for (const term of ['!hasTitle', 'hasImage === false', 'hasPrice === false', '!pricePositive', 'hasImage === null']) {
      assert.match(src, new RegExp(`const hardInvalid =[\\s\\S]{0,400}${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
    // A review outcome can only be assigned when hardInvalid is false.
    assert.match(src, /classification = hardInvalid\s*\?\s*'blocked_or_invalid'/);
  });

  it('13. compare mode is read-only and short-circuits before supplier/database work', () => {
    const src = read(PLAN_SAVED);
    assert.match(src, /if \(COMPARE_ASSORTMENT\) return compareAssortment\(\);/);
    const body = src.slice(src.indexOf('export async function compareAssortment'), src.indexOf('export async function main'));
    for (const verb of ['writeFileSync', 'mkdirSync', '.insert(', '.update(', '.upsert(', '.delete(', '.rpc(', 'fetchAllSavedItems', 'createClient']) {
      assert.ok(!body.includes(verb), `compare mode must not contain ${verb}`);
    }
  });

  it('14. planGigaAutoPublish is untouched by this wiring', () => {
    const src = read(PLAN_PUBLISH);
    assert.ok(!/savedItemsAssortmentGate|savedItemsAssortment|assortmentClassifier/.test(src),
      'auto-publish must not import the new gate');
    assert.match(src, /if \(!c\.commerceCanonical\)/, 'taxonomy-first ordering changed');
    assert.match(src, /HARD_JUNK\.test\(c\.title\)/, 'junk fallback removed');
    // It never consumes the saved-plan report, so new classifications cannot reach it.
    assert.ok(!src.includes('latest-saved-plan'), 'auto-publish must not read the saved plan');
  });

  it('15. the gate is pure — repeated calls are identical', () => {
    const t = 'Twin Size Murphy Bed with Bookshelf, White';
    assert.deepEqual(assortmentGate({ title: t, taxonomyFirst: true }), assortmentGate({ title: t, taxonomyFirst: true }));
    assert.deepEqual(assortmentGate({ title: t }), assortmentGate({ title: t }));
  });

  console.log(`\n${passed} passed`);
}
main();
