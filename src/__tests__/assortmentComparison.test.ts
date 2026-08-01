/**
 * Assortment comparison tests (pure; no database, no supplier, no network).
 *
 * The central property: this tooling is a MIRROR, not a switch. Production behavior must remain
 * byte-identical while the comparison runs, and the comparison itself must be incapable of writing.
 *
 * Run: npx tsx src/__tests__/assortmentComparison.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FORBIDDEN_WRITE_TABLES,
  LEGACY_HARD_JUNK,
  changedRows,
  compareOne,
  legacyJunkDecision,
  newAssortmentDecision,
  summarise,
  type ComparisonInput,
} from '../services/assortmentComparison';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PLAN_SAVED = 'scripts/planGigaSavedItems.ts';
const PLAN_PUBLISH = 'scripts/planGigaAutoPublish.ts';
const COMPARISON = 'src/services/assortmentComparison.ts';
const COMPARE_SCRIPT = 'scripts/compareAssortmentDecisions.ts';

/** Candidate (not in our DB) — the only case where the assortment gate applies. */
function candidate(title: string, over: Partial<ComparisonInput> = {}): ComparisonInput {
  return { sku: 'SKU1', title, inSupplier: false, inStd: false, inSell: false, ...over };
}

function main(): void {
  // ── 1. Production behavior is byte-identical ────────────────────────────────

  it('1. the legacy replica is character-identical to BOTH production literals', () => {
    const expected = String(LEGACY_HARD_JUNK);
    for (const f of [PLAN_SAVED, PLAN_PUBLISH]) {
      const m = read(f).match(/^const HARD_JUNK = (.+);$/m);
      assert.ok(m, `no HARD_JUNK literal found in ${f}`);
      assert.equal(m![1], expected, `HARD_JUNK drifted in ${f}`);
    }
  });

  it('2. production plan scripts do NOT import the classifier or the comparison', () => {
    for (const f of [PLAN_SAVED, PLAN_PUBLISH]) {
      const src = read(f);
      assert.ok(!/assortmentClassifier/.test(src), `${f} must not import assortmentClassifier yet`);
      assert.ok(!/assortmentComparison/.test(src), `${f} must not import assortmentComparison`);
    }
  });

  it('3. the production junk gate is still applied unconditionally in planGigaSavedItems', () => {
    const src = read(PLAN_SAVED);
    // Both call sites intact: the invalid_reasons tag and the hardInvalid gate.
    assert.ok(/invalid_reasons\.push\('junk_category'\)/.test(src), 'junk_category reason removed');
    assert.ok(/HARD_JUNK\.test\(title\)/.test(src), 'hardInvalid junk term removed');
    // Membership precedence still short-circuits before the gate.
    assert.ok(/already_published/.test(src) && /already_imported/.test(src), 'membership precedence changed');
  });

  it('4. planGigaAutoPublish still consults the taxonomy before HARD_JUNK', () => {
    const src = read(PLAN_PUBLISH);
    assert.ok(/if \(!c\.commerceCanonical\)/.test(src), 'taxonomy-first ordering changed');
    assert.ok(/HARD_JUNK\.test\(c\.title\)/.test(src), 'junk fallback removed');
  });

  // ── 2. Comparison mode is read-only ─────────────────────────────────────────

  it('5. the comparison module contains no write or network verbs', () => {
    const src = read(COMPARISON);
    for (const verb of ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc(', 'fetch(', 'writeFileSync']) {
      assert.ok(!src.includes(verb), `comparison module must not contain ${verb}`);
    }
    assert.ok(!/createClient/.test(src), 'comparison module must not construct a database client');
  });

  it('6. the comparison SCRIPT only reads — no write verb against any table', () => {
    const src = read(COMPARE_SCRIPT);
    for (const verb of ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc(']) {
      assert.ok(!src.includes(verb), `comparison script must not contain ${verb}`);
    }
    // Its only Supabase calls are .from(...).select(...)
    const froms = src.match(/\.from\('[a-z_]+'\)/g) ?? [];
    assert.ok(froms.length > 0, 'expected the script to read at least one table');
    for (const t of FORBIDDEN_WRITE_TABLES) {
      const writeRe = new RegExp(`from\\('${t}'\\)[\\s\\S]{0,80}?\\.(insert|update|upsert|delete)\\(`);
      assert.ok(!writeRe.test(src), `script writes to ${t}`);
    }
  });

  it('7. comparison is pure — identical input yields identical output', () => {
    const i = candidate('Twin Size Murphy Bed with Bookshelf, White');
    assert.deepEqual(compareOne(i), compareOne(i));
  });

  // ── 3. No saved_assets or publication state is modified ─────────────────────

  it('8. published and imported SKUs never reach the gate — decision cannot change', () => {
    const t = 'Outdoor Patio Rattan Sofa Set'; // legacy would exclude this as a candidate
    const published = compareOne(candidate(t, { inSell: true }));
    const imported = compareOne(candidate(t, { inSupplier: true }));
    const standardized = compareOne(candidate(t, { inStd: true }));
    for (const r of [published, imported, standardized]) {
      assert.equal(r.gateApplies, false);
      assert.equal(r.changeType, 'gate_not_applicable');
    }
    assert.equal(summarise([published, imported, standardized]).publishedAffected, 0);
  });

  it('9. publishedAffected is 0 even when every published row would classify differently', () => {
    const rows = ['Murphy Bed with Storage', 'Luggage Set of 3', 'Outdoor Patio Sofa Set'].map(t =>
      compareOne(candidate(t, { inSell: true })),
    );
    assert.equal(summarise(rows).publishedAffected, 0);
    assert.equal(changedRows(rows).length, 0);
  });

  // ── 4. Rescued furniture stays protected ────────────────────────────────────

  it('10. every rescued furniture case is excluded by legacy and accepted by the new gate', () => {
    const rescued = [
      'Twin Size Murphy Bed with Bookshelf, White',
      'Murphy queen bed with Wooden doors design, fake drawers, metal legs',
      'Triple Bunk Bed for Kids,3 Bed Bunk Beds for 3,Metal',
      'Farmhouse Black Double Tilt Out Trash Cabinet for 20 Gallon Trash Can',
      '10 Gallon Tilt Out Trash Cabinet Freestanding Trash Bin Cabinet Wood',
      'Modern 55-75 Gallon Fish Tank Stand with Power Outlet',
      '44.48" Large Dog Crate Furniture, Indoor Wooden Dog Kennel End Table',
      'Bean Bag Chair, Bean Bag Sofa Chair with Armrests',
      'Baby Classic Nursery Dresser with 8 Drawers and 2 Cabinet',
      'Convertible Toddler Bed with Storage Drawers, 3-in-1 Solid Wood',
      'Full Size Wood Platform Bed for Kids, Wood Low Profile',
      'White 4-Drawer Kids Dresser, Wooden Storage Cabinet',
      'Cat Ears Pink Gaming Chair - Pink PU Leather Ergonomic',
    ];
    for (const t of rescued) {
      const r = compareOne(candidate(t));
      assert.equal(legacyJunkDecision(t), 'excluded', `legacy should have excluded: ${t}`);
      assert.equal(r.newDecision, 'accepted', `new gate must accept: ${t} (got ${r.newDecision})`);
      assert.equal(r.changeType, 'rescued');
    }
  });

  // ── 5. Genuine non-furniture stays excluded ─────────────────────────────────

  it('11. genuine non-furniture remains excluded under the new gate', () => {
    const excluded = [
      '20"/24"/28" 3 pcs/set in ABS Spinner Wheel Luggage, Carry on Suitcase',
      'Luggage Set of 3, 20-inch with USB Port, Airline Certified',
      '55-inch Trampoline for Kids Indoor & Outdoor Small Toddler',
      'STAINLESS STEEL CAT LITTER BOX',
      '48.8" Modern Cat Tower, Wood Cat Tree Tower',
      'FKZNPJ 16 inch sporty kids bike with training wheels and stand',
    ];
    for (const t of excluded) {
      const r = compareOne(candidate(t));
      assert.equal(r.newDecision, 'excluded', `must stay excluded: ${t} (got ${r.newDecision})`);
      assert.equal(r.changeType, 'unchanged_excluded');
    }
  });

  it('12. no rescued case is ever a genuine non-furniture class', () => {
    assert.notEqual(newAssortmentDecision('Fish Tank Stand with Storage').assortmentClass, 'genuine_non_furniture');
    assert.equal(newAssortmentDecision('55 Gallon Aquarium Tank Kit').decision, 'manual_review');
  });

  // ── 6. Outdoor / decor are routed, never silently dropped ───────────────────

  it('13. outdoor furniture and decor route to policy review, not exclusion', () => {
    const outdoor = compareOne(candidate('TOPMAX 6 Piece Patio Sofa Set, Acacia Wood Outdoor Modular Sectional'));
    assert.equal(outdoor.assortmentClass, 'outdoor_furniture');
    assert.equal(outdoor.newDecision, 'policy_review');
    assert.equal(outdoor.changeType, 'moved_to_policy_review');

    const decor = compareOne(candidate('Outdoor Garden Sculpture Flamingo Flower Pot Planter'));
    assert.equal(decor.assortmentClass, 'home_decor');
    assert.equal(decor.newDecision, 'policy_review');
  });

  it('14. policy_review is never counted as an added or removed candidate', () => {
    const rows = [
      compareOne(candidate('Outdoor Patio Sofa Set, All-Weather Wicker')),
      compareOne(candidate('Outdoor Garden Statue with Solar Light')),
    ];
    const s = summarise(rows);
    assert.equal(s.candidatesAdded, 0);
    assert.equal(s.candidatesRemoved, 0);
    assert.equal(s.routedToPolicyReview, 2);
  });

  // ── 7. Summary integrity ────────────────────────────────────────────────────

  it('15. summary counts reconcile exactly with the row set', () => {
    const rows = [
      compareOne(candidate('Twin Size Murphy Bed with Bookshelf')),        // rescued
      compareOne(candidate('Luggage Set of 3')),                            // unchanged_excluded
      compareOne(candidate('6-Drawer Dresser for Bedroom')),                // unchanged_accepted
      compareOne(candidate('Outdoor Patio Sofa Set')),                      // policy_review
      compareOne(candidate('Murphy Bed', { inSell: true })),                // gate_not_applicable
    ];
    const s = summarise(rows);
    assert.equal(s.total, 5);
    assert.equal(s.gateApplies, 4);
    assert.equal(s.candidatesAdded, 1);
    assert.equal(s.candidatesRemoved, 0);
    assert.equal(s.routedToPolicyReview, 1);
    assert.equal(s.publishedAffected, 0);
    assert.equal(Object.values(s.byChangeType).reduce((a, b) => a + b, 0), 5);
    assert.equal(Object.values(s.byAssortmentClass).reduce((a, b) => a + b, 0), 5);
    assert.equal(changedRows(rows).length, 2); // rescued + policy_review
  });

  it('16. an empty title is never silently accepted', () => {
    const r = compareOne(candidate(''));
    assert.equal(r.assortmentClass, 'ambiguous_manual_review');
    assert.equal(r.newDecision, 'manual_review');
    assert.equal(r.changeType, 'moved_to_manual_review');
  });

  console.log(`\n${passed} passed`);
}
main();
