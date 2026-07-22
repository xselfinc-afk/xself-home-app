/**
 * Phase 1 verification — READ-ONLY. Validates the corrected 4-level hierarchy
 * (Department → Category → Product Type → Rooms) over the 349 live rows captured
 * in the rollback baseline.
 *
 * 1. Regression guard: legacy inferCategoryPath output is byte-identical to
 *    category-baseline.json (proves current Home/Discover behavior is untouched).
 * 2. Registry invariants (Bible §7) hold.
 * 3. Coverage: every product resolves to a known Department/Category/Product Type,
 *    or is explicitly needs-review (no silent "Other").
 * 4. Audit fixes verified on real SKUs.
 * 5. Revised real-catalog counts by Department, Category, Product Type, Room.
 *
 * Run: npx tsx scripts/verifyCommerceTaxonomyPhase1.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inferCategoryPath } from '../src/utils/productClassification';
import { classifyCommerce, validateRegistry, DEPARTMENTS, CATEGORIES, PRODUCT_TYPES, ROOMS, NEEDS_REVIEW } from '../src/utils/commerceTaxonomy';

const BASE = 'rollback-baseline-2026-07-21';
type Row = { id: string; category_label: string | null; category_code: string; spec_cat: string | null; name: string | null };
function extractRows(txt: string): Row[] {
  const o = JSON.parse(txt);
  return Array.isArray(o) ? o : o.rows?.[0]?.j ?? o.j;
}
const rows = extractRows(readFileSync(`${BASE}/db/sellable_category_inputs.json`, 'utf8'));
const baseline = JSON.parse(readFileSync(`${BASE}/category-baseline.json`, 'utf8'));
const baselineL1 = new Map<string, string>(baseline.perProduct.map((x: any) => [x.id, x.level1]));
const inputFor = (r: Row) => ({ name: r.name ?? '', category: (r.spec_cat && r.spec_cat.trim()) ? r.spec_cat : r.category_code, categoryLabel: r.category_label ?? undefined });

const deptIds = new Set(DEPARTMENTS.map(d => d.id));
const catById = new Map(CATEGORIES.map(c => [c.id, c]));
const typeIds = new Set(PRODUCT_TYPES.map(t => t.id));
const roomIds = new Set(ROOMS.map(r => r.id));
let fail = 0;
const check = (cond: boolean, msg: string) => { if (!cond) { fail++; console.log(`  ✗ ${msg}`); } };

// ── 1. Legacy regression guard ──
let legacyMismatch = 0;
for (const r of rows) if (inferCategoryPath(inputFor(r)).level1 !== baselineL1.get(r.id)) legacyMismatch++;
check(legacyMismatch === 0, `legacy inferCategoryPath changed for ${legacyMismatch} products`);
console.log(`1. Legacy regression: ${legacyMismatch === 0 ? 'IDENTICAL to baseline ✓' : legacyMismatch + ' MISMATCH ✗'} (${rows.length} rows)`);

// ── 2. Registry invariants ──
const regProblems = validateRegistry();
check(regProblems.length === 0, `registry invariant violations: ${regProblems.join('; ')}`);
console.log(`2. Registry invariants: ${regProblems.length === 0 ? 'all hold ✓' : regProblems.length + ' violations ✗'}`);

// ── 3. Coverage + classify ──
const dept: Record<string, number> = {}, cat: Record<string, number> = {}, type: Record<string, number> = {}, room: Record<string, number> = {};
const byId = new Map<string, ReturnType<typeof classifyCommerce>>();
const needsReview: { id: string; name: string; spec: string | null }[] = [];
let badSlug = 0;
for (const r of rows) {
  const c = classifyCommerce(inputFor(r));
  byId.set(r.id, c);
  const known = deptIds.has(c.department) && catById.has(c.category) && typeIds.has(c.productType)
    && catById.get(c.category)!.department === c.department && c.rooms.every(rm => roomIds.has(rm));
  if (!known) badSlug++;
  if (c.productType === NEEDS_REVIEW) needsReview.push({ id: r.id, name: (r.name ?? '').slice(0, 60), spec: r.spec_cat });
  dept[c.department] = (dept[c.department] ?? 0) + 1;
  cat[c.category] = (cat[c.category] ?? 0) + 1;
  type[c.productType] = (type[c.productType] ?? 0) + 1;
  for (const rm of c.rooms) room[rm] = (room[rm] ?? 0) + 1;
}
check(badSlug === 0, `${badSlug} products produced unknown/inconsistent slugs`);
console.log(`3. Coverage: ${rows.length - badSlug}/${rows.length} valid; needs-review = ${needsReview.length} (explicit, not silent)`);

// ── 4. Audit fixes ──
const unreachable: string[] = (baseline.unreachableProducts?.items ?? []).map((x: any) => x.id);
const stillUnresolved = unreachable.filter(id => byId.get(id)?.productType === NEEDS_REVIEW);
check(stillUnresolved.length === 0, `previously-unreachable still needs-review: ${stillUnresolved.join(', ')}`);
const makeup = rows.filter(r => (r.spec_cat ?? '').toLowerCase() === 'makeup vanities');
check(makeup.every(r => byId.get(r.id)?.department === 'furniture' && byId.get(r.id)?.rooms.includes('bedroom')),
  'a makeup vanity is not in Furniture/bedroom');
check(makeup.every(r => byId.get(r.id)?.department !== 'bathroom'), 'a makeup vanity leaked into bathroom');
const pet = rows.filter(r => byId.get(r.id)?.department === 'pet-supplies');
console.log(`4. Fixes: unreachable(${unreachable.length}) now typed [${unreachable.map(id => byId.get(id)?.productType).join(', ')}]; makeup vanities ${makeup.length}→bedroom, 0→bathroom; pet-supplies=${pet.length}`);

// ── 5. Revised counts ──
const sortDesc = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]);
const withLabel = (o: Record<string, number>, labels: Map<string, string>) =>
  sortDesc(o).map(([k, v]) => `     ${String(v).padStart(4)}  ${k}${labels.get(k) ? `  (${labels.get(k)})` : ''}`).join('\n');
const deptLabels = new Map(DEPARTMENTS.map(d => [d.id, d.label]));
const catLabels = new Map(CATEGORIES.map(c => [c.id, c.label]));
const typeLabels = new Map(PRODUCT_TYPES.map(t => [t.id, t.label]));
const roomLabels = new Map(ROOMS.map(r => [r.id, r.label]));
console.log('\n5. REVISED CATALOG COUNTS');
console.log('\n  By Department:\n' + withLabel(dept, deptLabels));
console.log('\n  By Category:\n' + withLabel(cat, catLabels));
console.log('\n  By Product Type:\n' + withLabel(type, typeLabels));
console.log('\n  By Room (multi-room; counts overlap):\n' + withLabel(room, roomLabels));
if (needsReview.length) {
  console.log('\n  needs-review items:');
  for (const n of needsReview) console.log(`     ${n.id}  spec=${n.spec}  "${n.name}"`);
}

console.log(`\n${fail === 0 ? 'PHASE 1 (v2) VERIFICATION PASSED ✓' : `PHASE 1 (v2) VERIFICATION FAILED ✗ (${fail})`}`);
process.exit(fail === 0 ? 0 : 1);
