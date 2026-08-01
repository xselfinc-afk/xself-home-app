/**
 * Assortment classifier tests (pure; no database, no supplier, no network).
 *
 * The central property: the same generic word — `stand`, `rack`, `bench`, `cabinet` — must resolve
 * differently depending on context. A fish-tank STAND is furniture; a bike with a kickSTAND is not.
 * A trash CABINET is furniture; a trash CAN is not. Flat keyword matching cannot express this, which
 * is why 22 furniture SKUs were wrongly excluded into REVIEW_REQUIRED.
 *
 * Run: npx tsx src/__tests__/assortmentClassifier.test.ts
 */
import assert from 'node:assert/strict';
import { classifyAssortment, isFurnitureClass, outdoorSignalOf } from '../utils/assortmentClassifier';
import { NON_FURNITURE_SKUS, OUTDOOR_POLICY_SKUS, RESCUED_FURNITURE_SKUS } from './fixtures/outdoorPolicySkus';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const cls = (title: string) => classifyAssortment({ title }).assortment;
const furniture = (title: string) => isFurnitureClass(cls(title));

function main(): void {
  // ── Required context-aware cases ────────────────────────────────────────────

  it('1. fish tank stand → furniture (the stand, not the aquarium)', () => {
    assert.equal(cls('Modern 55-75 Gallon Fish Tank Stand with Power Outlet'), 'core_indoor_furniture');
    assert.equal(cls('Aquarium Stand 40 Gallon Wood Cabinet'), 'core_indoor_furniture');
  });

  it('2. TV stand → furniture', () => {
    assert.equal(cls('TV Stand for 65 inch TV with Storage Shelves'), 'core_indoor_furniture');
    assert.equal(cls('Media Console TV Unit with Drawers'), 'core_indoor_furniture');
  });

  it('3. bicycle kickstand → non-furniture', () => {
    assert.equal(cls('Kids Bicycle 16 inch with kickstand and basket'), 'genuine_non_furniture');
  });

  it('4. training wheels and stand → non-furniture (bike beats generic "stand")', () => {
    assert.equal(
      cls('Girls bike with basket, 7-10 years, 20 inch, with training wheels and stand'),
      'genuine_non_furniture',
    );
  });

  it('5. trash cabinet → furniture', () => {
    assert.equal(cls('Farmhouse Black Double Tilt Out Trash Cabinet for 20 Gallon Trash Can'), 'core_indoor_furniture');
    assert.equal(cls('10 Gallon Tilt Out Trash Cabinet Freestanding Trash Bin Cabinet Wood'), 'core_indoor_furniture');
  });

  it('6. trash can → non-furniture', () => {
    assert.ok(!furniture('Stainless Steel Trash Can 13 Gallon Step Bin'));
  });

  it('7. Murphy bed → furniture, in every observed title casing', () => {
    assert.equal(cls('Twin Size Murphy Bed with Bookshelf, White'), 'core_indoor_furniture');
    assert.equal(cls('Murphy queen bed with Wooden doors design, fake drawers, metal legs'), 'core_indoor_furniture');
    assert.equal(cls('Multifunctional Murphy Bed Cabinet with USB Charging Station, Queen'), 'core_indoor_furniture');
  });

  it('8. patio set → outdoor furniture', () => {
    assert.equal(cls('7-Piece Outdoor Patio Furniture Set, All-Weather Wicker Rattan'), 'outdoor_furniture');
    assert.equal(cls('Aluminum Frame Large 4-Piece Outdoor Patio Furniture Set for Backyard'), 'outdoor_furniture');
    assert.equal(cls('TOPMAX 6 Piece Patio Sofa Set, Acacia Wood Outdoor Modular Sectional'), 'outdoor_furniture');
  });

  it('9. garden statue → home decor', () => {
    assert.equal(cls('A brown bear statue welcoming guests, a garden statue with solar light'), 'home_decor');
    assert.equal(cls('Outdoor Garden Sculpture Flamingo Flower Pot Planter'), 'home_decor');
    assert.equal(cls('32" H Large Outdoor Fountains with Vintage Pump'), 'home_decor');
  });

  it('10. bunk bed → furniture', () => {
    assert.equal(cls('Triple Bunk Bed for Kids,3 Bed Bunk Beds for 3,Metal Triple Bunk'), 'core_indoor_furniture');
  });

  // ── Explicitly protected furniture types ────────────────────────────────────

  it('11. every protected furniture type classifies as furniture', () => {
    const titles = [
      'Queen Murphy Bed with Storage',
      'Twin over Full Bunk Bed, Solid Wood',
      'Tilt Out Trash Cabinet, Farmhouse White',
      'Fish Tank Stand for 20 Gallon Aquarium',
      'TV Stand for 75 inch TV, Black Oak',
      'Storage Cabinet with Doors and Adjustable Shelves',
      'Bathroom Vanity 48 inch with Sink and Mirror',
      '6-Drawer Dresser for Bedroom, White',
      'Nightstand with Charging Station, Set of 2',
      'Wardrobe Armoire Closet with Hanging Rod',
      'Extendable Dining Table for 6, Walnut',
      'Upholstered Accent Chair with Ottoman',
      'L-Shaped Sectional Sofa with Chaise',
    ];
    for (const t of titles) assert.ok(furniture(t), `expected furniture for: ${t} (got ${cls(t)})`);
  });

  // ── Generic-word false-positive guards ──────────────────────────────────────

  it('12. generic words do not create false positives in non-furniture contexts', () => {
    assert.ok(furniture('Shoe Rack Bench for Entryway with Cushion Seat'));
    assert.ok(!furniture('Bike Rack for Car Trunk, 3 Bicycles'));
    assert.ok(furniture('Storage Bench with Padded Seat for Bedroom'));
    assert.ok(furniture('Plant Stand Indoor Wood 3 Tier'));
    assert.ok(!furniture('Bicycle Repair Stand with Tool Tray'));
  });

  it('13. luggage and trampolines are never furniture', () => {
    assert.equal(cls('20"/24"/28" 3 pcs/set in ABS Spinner Wheel Luggage, Carry on Suitcase'), 'genuine_non_furniture');
    assert.equal(cls('Luggage Set of 3, 20-inch with USB Port, Airline Certified'), 'genuine_non_furniture');
    assert.equal(cls('55-inch Trampoline for Kids Indoor & Outdoor Small Toddler'), 'genuine_non_furniture');
  });

  it('14. pet goods are non-furniture, but pet-adjacent furniture is rescued', () => {
    assert.equal(cls('Stainless steel cat litter box'), 'genuine_non_furniture');
    assert.equal(cls('48.8" modern cat tower cat tree'), 'genuine_non_furniture');
    assert.ok(furniture('Dog Crate End Table with Wooden Top, Indoor Kennel Furniture'));
    // Regression: the furniture head sits several words after the enclosure word.
    assert.ok(furniture('44.48" Large Dog Crate Furniture, Indoor Wooden Dog Kennel End Table with Drawer'));
    assert.ok(furniture('Litter Box Enclosure Cabinet, Hidden Cat Washroom'));
    // A plain pet enclosure with no furniture head stays non-furniture.
    assert.equal(cls('Heavy Duty Dog Crate, Folding Metal Wire Kennel 42 inch'), 'genuine_non_furniture');
  });

  // ── Indoor / outdoor split ──────────────────────────────────────────────────

  it('15. outdoor markers split furniture into indoor vs outdoor', () => {
    assert.equal(cls('Acacia Wood 3 Seater Sofa, Upholstered Cushions'), 'core_indoor_furniture');
    assert.equal(cls('Outdoor Acacia Wood 3 Seater Sofa, Weather-Resistant'), 'outdoor_furniture');
    assert.equal(cls('Outdoor Acacia Wood Round Daybed, Patio Lounger'), 'outdoor_furniture');
  });

  // ── Fail-open behavior ──────────────────────────────────────────────────────

  // ── Outdoor context (a keyword alone never decides) ─────────────────────────

  it('15a. strong outdoor product signals → outdoor_furniture', () => {
    const outdoor: Array<[string, string]> = [
      ['patio dining set', '7-Piece Patio Dining Set, Acacia Wood Table and Chairs'],
      ['outdoor sectional sofa', 'Outdoor Sectional Sofa Set, PE Rattan Wicker'],
      ['garden bench', 'Garden Bench, Cast Iron Outdoor Seating'],
      ['porch swing', '3-Seat Porch Swing with Chain, Weather Resistant'],
      ['fire pit table', 'Propane Fire Pit Table, 44 inch Rectangular'],
      ['patio umbrella', '10ft Patio Umbrella with Crank and Tilt'],
      ['outdoor storage', 'Outdoor Storage Deck Box 120 Gallon Waterproof'],
      ['poolside furniture', 'Poolside Lounge Chair Set, Aluminum Frame'],
    ];
    for (const [label, t] of outdoor) {
      assert.equal(cls(t), 'outdoor_furniture', `${label}: ${t} → ${cls(t)}`);
      assert.equal(outdoorSignalOf(t), 'strong_outdoor_product_signal', label);
    }
  });

  it('15b. a room-suitability list never makes an indoor product outdoor', () => {
    const t = 'Natural Finish Round Wood Accent Table - Elegant Curved Base End Table for Living Room, Bedroom, or Patio';
    assert.equal(cls(t), 'core_indoor_furniture');
    assert.equal(outdoorSignalOf(t), 'indoor_product_with_optional_outdoor_use');
  });

  it('15c. balcony alongside an indoor room stays indoor', () => {
    const t = 'Lazy sofa balcony leisure chair bedroom sofa chair foldable reclining chair';
    assert.equal(cls(t), 'core_indoor_furniture');
    assert.equal(outdoorSignalOf(t), 'indoor_product_with_optional_outdoor_use');
  });

  it('15d. "deck chair" is a style phrase, not a location', () => {
    const t = 'Adjustable head and waist, game chair, lounge chair in the living room, 360 degree rotatable sofa chair, Leisure Chair deck chair';
    assert.notEqual(cls(t), 'outdoor_furniture');
    assert.equal(cls(t), 'core_indoor_furniture');
    // Even with no indoor room named, a bare "deck chair" cannot establish outdoor identity.
    assert.notEqual(outdoorSignalOf('Folding Deck Chair with Armrest'), 'strong_outdoor_product_signal');
  });

  it('15e. the cat-paw sofa (W2311P345745) is indoor furniture', () => {
    const t = 'TS Cat paw leather upholstered sofa 2PC Cream White,Nordic retro light luxury living room balcony bedroom single';
    assert.equal(cls(t), 'core_indoor_furniture');
  });

  it('15f. indoor/outdoor dual use is resolved by construction, not by the keyword', () => {
    // No weather-specific construction → a suitability claim, so it stays in the core assortment.
    const bench = 'Indoor Outdoor Storage Bench with Cushion Seat';
    assert.equal(outdoorSignalOf(bench), 'outdoor_suitability_mention');
    assert.equal(cls(bench), 'core_indoor_furniture');
    // Acacia picnic construction → genuinely an outdoor product despite naming both.
    const dining = 'GO 3 Pieces Acacia Wood Table Bench Dining Set For Outdoor & Indoor Furniture With 2 Benches, Picnic';
    assert.equal(outdoorSignalOf(dining), 'strong_outdoor_product_signal');
    assert.equal(cls(dining), 'outdoor_furniture');
  });

  it('15g. a multi-location weather-built product goes to manual review, not a guess', () => {
    const t = 'Folding PE Rattan Hanging Egg Chair with Stand, Gray Indoor Outdoor Hammock Swing Basket Chair, Aluminum Steel Frame for Patio Balcony Backyard Bedroom';
    assert.equal(outdoorSignalOf(t), 'ambiguous_outdoor_manual_review');
    assert.equal(cls(t), 'ambiguous_manual_review');
  });

  it('15h. a single outdoor keyword never overrides a strong indoor identity', () => {
    for (const t of [
      'Murphy Bed Cabinet for Bedroom, also suits patio guest room',
      'Bunk Bed for Kids Bedroom, garden view window',
      '6-Drawer Dresser for Bedroom, Patio Storage Alternative',
      'Gaming Chair for Home Office, use on patio too',
    ]) {
      assert.equal(cls(t), 'core_indoor_furniture', `${t} → ${cls(t)}`);
    }
  });

  // ── Corpus regression: the real saved-asset sets must not drift ─────────────

  it('15i. the Founder outdoor-policy set stays outdoor (1 documented exception)', () => {
    // W2500P479541 is a rattan hanging egg chair marketed for "Patio Balcony Backyard Bedroom" —
    // genuinely dual-use. It moved to manual review rather than being guessed either way.
    const DUAL_USE_EXCEPTION = 'W2500P479541';
    let outdoor = 0;
    for (const [sku, title] of OUTDOOR_POLICY_SKUS) {
      const c = cls(title);
      if (sku === DUAL_USE_EXCEPTION) {
        assert.equal(c, 'ambiguous_manual_review', `${sku} should be manual review`);
        continue;
      }
      assert.equal(c, 'outdoor_furniture', `${sku} drifted out of the outdoor set → ${c}: ${title.slice(0, 60)}`);
      outdoor++;
    }
    assert.equal(OUTDOOR_POLICY_SKUS.length, 42);
    assert.equal(outdoor, 41);
  });

  it('15j. every rescued furniture SKU stays furniture', () => {
    assert.equal(RESCUED_FURNITURE_SKUS.length, 9);
    for (const [sku, title] of RESCUED_FURNITURE_SKUS) {
      assert.ok(furniture(title), `${sku} lost furniture status → ${cls(title)}`);
    }
  });

  it('15k. no genuine non-furniture SKU becomes furniture', () => {
    assert.equal(NON_FURNITURE_SKUS.length, 30);
    for (const [sku, title] of NON_FURNITURE_SKUS) {
      assert.equal(cls(title), 'genuine_non_furniture', `${sku} became ${cls(title)}: ${title.slice(0, 60)}`);
    }
  });

  it('16. unknown stays ambiguous — never silently excluded', () => {
    assert.equal(cls(''), 'ambiguous_manual_review');
    assert.equal(cls('   '), 'ambiguous_manual_review');
    assert.equal(cls('XJ-9920 Assembly Kit Model B'), 'ambiguous_manual_review');
  });

  it('17. classifier is pure — repeated calls are identical', () => {
    const t = 'Twin Size Murphy Bed with Bookshelf, White';
    assert.deepEqual(classifyAssortment({ title: t }), classifyAssortment({ title: t }));
  });

  it('18. result always reports the taxonomy view for auditability', () => {
    const r = classifyAssortment({ title: 'Twin Size Murphy Bed with Bookshelf, White' });
    assert.equal(r.taxonomyDepartment, 'furniture');
    assert.equal(r.taxonomyProductType, 'bed');
    assert.ok(r.basis.length > 0);
  });

  it('19. every HARD_JUNK keyword is resolvable in a real furniture context', () => {
    // The keywords that caused the observed false positives must not, alone, exclude furniture.
    const rescued: Array<[string, string]> = [
      ['bunk', 'Twin over Full Bunk Bed with Stairs'],
      ['murphy', 'Murphy Bed Cabinet with Shelves'],
      ['trash', 'Tilt Out Trash Cabinet Wood'],
      ['fish tank', 'Fish Tank Stand with Storage'],
      ['bean bag', 'Bean Bag Chair with Armrests'],
      ['nursery', 'Nursery Dresser with 8 Drawers'],
      ['kids', 'Full Size Wood Platform Bed for Kids'],
      ['toddler', 'Convertible Toddler Bed with Storage Drawers'],
      ['cat', 'Cat Ears Pink Gaming Chair, PU Leather Ergonomic'],
      ['crate', 'Dog Crate Furniture, Wooden Kennel End Table'],
    ];
    for (const [kw, title] of rescued) {
      assert.ok(furniture(title), `keyword "${kw}" wrongly excluded furniture: ${title} (got ${cls(title)})`);
    }
  });

  console.log(`\n${passed} passed`);
}
main();
