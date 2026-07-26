/**
 * Focused offline tests for the --candidates source mode of scripts/syncGigaNewlySavedCandidates.ts.
 * Pure helpers only (parseCsvRfc4180, selectApprovedCandidates) — importing the script does NOT run
 * the CLI (main() is guarded by a direct-invocation check). No network, no DB.
 * Run: npx tsx src/__tests__/candidateImportSource.test.ts
 */
import assert from 'node:assert/strict';
import { parseCsvRfc4180, selectApprovedCandidates } from '../../scripts/syncGigaNewlySavedCandidates';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('candidate import-source tests');

// ── CSV fixture builder (mirrors candidates.csv columns) ──
const HEADER = ['supplier_product_id', 'supplier_sku', 'title', 'supplier_category', 'supplier_category_code', 'price', 'sku_available', 'image_count', 'department_id', 'category_id', 'product_type_id', 'headline_bucket', 'needs_review_reason', 'duplicate_of', 'duplicate_reason', 'in_supplier_products', 'in_standardized_products', 'in_sellable_products', 'classification_source', 'taxonomy_version'];
const q = (v: string) => /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
const row = (over: Record<string, string>): Record<string, string> => ({
  supplier_product_id: '', supplier_sku: '', title: 'T', supplier_category: 'Cat', supplier_category_code: '1', price: '99', sku_available: 'available', image_count: '5', department_id: 'furniture', category_id: 'living-room-furniture', product_type_id: 'sofa', headline_bucket: 'ready', needs_review_reason: '', duplicate_of: '', duplicate_reason: '', in_supplier_products: 'false', in_standardized_products: 'false', in_sellable_products: 'false', classification_source: 'title_only', taxonomy_version: '56438dda', ...over,
});
const csv = (rows: Record<string, string>[]) => [HEADER, ...rows.map(r => HEADER.map(h => r[h]))].map(a => a.map(q).join(',')).join('\r\n') + '\r\n';

// Eligible ready rows
const RDY1 = row({ supplier_product_id: 'RDY1', supplier_sku: 'RDY1' });
const RDY2 = row({ supplier_product_id: 'RDY2', title: 'Sofa, "Big", Modular\nWith Newline' }); // tricky quoted/newline title
// Realistic non-ready rows (headline reflects the bucket) → caught by the headline guard
const NR1 = row({ supplier_product_id: 'NR1', headline_bucket: 'needs_review', product_type_id: 'needs-review', needs_review_reason: 'classifier_needs_review' });
const DUP1 = row({ supplier_product_id: 'DUP1', headline_bucket: 'duplicate', duplicate_of: 'RDY1', duplicate_reason: 'same_title' });
const IMP1 = row({ supplier_product_id: 'IMP1', headline_bucket: 'already_imported', in_supplier_products: 'true' });
const PUB1 = row({ supplier_product_id: 'PUB1', headline_bucket: 'already_published', in_sellable_products: 'true' });
// headline=ready but explicitly unavailable → unavailable guard
const UNAV1 = row({ supplier_product_id: 'UNAV1', sku_available: 'unavailable' });
// Defense-in-depth: headline=ready but a contradictory flag → specific guards must still reject
const NRG = row({ supplier_product_id: 'NRG', product_type_id: 'needs-review', needs_review_reason: 'x' });
const DUPG = row({ supplier_product_id: 'DUPG', duplicate_of: 'RDY1' });
const IMPG = row({ supplier_product_id: 'IMPG', in_supplier_products: 'true' });
const PUBG = row({ supplier_product_id: 'PUBG', in_sellable_products: 'true' });
const FIX = csv([RDY1, RDY2, NR1, DUP1, IMP1, PUB1, UNAV1, NRG, DUPG, IMPG, PUBG]);
const reason = (sku: string) => selectApprovedCandidates(FIX, [sku]).rejections.find(r => r.sku === sku)?.reason;

// ── §8.10 parser ──
it('parseCsvRfc4180 handles quoted commas / escaped quotes / newlines / empty cells', () => {
  const p = parseCsvRfc4180('a,b,c\r\n"x,y","he said ""hi""","l1\nl2"\r\n,,\r\n');
  assert.deepEqual(p[0], ['a', 'b', 'c']);
  assert.deepEqual(p[1], ['x,y', 'he said "hi"', 'l1\nl2']);
  assert.deepEqual(p[2], ['', '', '']);
});
it('tricky ready title (comma+quote+newline) parses as ONE eligible row', () => {
  const sel = selectApprovedCandidates(FIX, ['RDY2']);
  assert.equal(sel.rejections.length, 0);
  assert.equal(sel.eligible.length, 1);
  assert.match(sel.eligible[0].title, /Sofa, "Big", Modular\nWith Newline/);
});

// ── §8.3 only ready eligible; §8.4 --only intersect ──
it('no --only: only fully-eligible ready rows returned; contradictory ready rows rejected', () => {
  const sel = selectApprovedCandidates(FIX, null);
  assert.deepEqual(sel.eligible.map(e => e.sku).sort(), ['RDY1', 'RDY2']);
  assert.equal(sel.readyCount, 7); // RDY1,RDY2,UNAV1,NRG,DUPG,IMPG,PUBG have headline=ready
  for (const s of ['UNAV1', 'NRG', 'DUPG', 'IMPG', 'PUBG']) assert.ok(sel.rejections.some(r => r.sku === s), `${s} rejected`);
});
it('--only intersects with the candidate-ready set', () => {
  const sel = selectApprovedCandidates(FIX, ['RDY1', 'RDY2']);
  assert.equal(sel.rejections.length, 0);
  assert.deepEqual(sel.eligible.map(e => e.sku).sort(), ['RDY1', 'RDY2']);
});

// ── §8.5–8.9 loud rejections (never silent) — realistic rows caught by the headline guard ──
it('non-ready rows fail loudly via the headline guard', () => {
  assert.equal(reason('NR1'), 'not_ready(headline=needs_review)');
  assert.equal(reason('DUP1'), 'not_ready(headline=duplicate)');
  assert.equal(reason('IMP1'), 'not_ready(headline=already_imported)');
  assert.equal(reason('PUB1'), 'not_ready(headline=already_published)');
});
it('absent SKU fails loudly; explicitly-unavailable ready row fails loudly', () => {
  assert.equal(reason('NOPE'), 'not_in_candidates');
  assert.equal(reason('UNAV1'), 'unavailable');
});
it('defense-in-depth: ready rows with contradictory flags still rejected by specific guards', () => {
  assert.equal(reason('NRG'), 'needs_review');
  assert.equal(reason('DUPG'), 'duplicate_of=RDY1');
  assert.equal(reason('IMPG'), 'already_imported_or_published_per_report');
  assert.equal(reason('PUBG'), 'already_imported_or_published_per_report');
});

// ── §8.14 all-or-nothing at the selection layer: one bad SKU → rejection present → CLI writes nothing ──
it('a mixed --only set yields rejections (CLI would write nothing)', () => {
  const sel = selectApprovedCandidates(FIX, ['RDY1', 'NR1']);
  assert.equal(sel.eligible.length, 1);
  assert.equal(sel.rejections.length, 1);
  assert.equal(sel.rejections[0].sku, 'NR1');
});

// ── malformed input ──
it('missing required column throws', () => {
  assert.throws(() => selectApprovedCandidates('foo,bar\r\n1,2\r\n', null), /missing required column/);
});
it('empty csv yields empty selection (no throw)', () => {
  assert.deepEqual(selectApprovedCandidates('', null), { eligible: [], rejections: [], readyCount: 0 });
});

console.log(`\n${passed} passed`);
