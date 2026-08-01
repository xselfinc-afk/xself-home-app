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
import { classifyAssortment, isFurnitureClass } from '../utils/assortmentClassifier';

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
