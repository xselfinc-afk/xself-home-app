/**
 * Phase 2 catalog verification — READ-ONLY. Confirms the Commerce Layer navigation
 * derives the correct hierarchy from the REAL Phase-1 catalog snapshot (the 349
 * sellable rows captured in the rollback baseline), with counts matching Phase 1
 * and zero unreachable products. Pure (buildCommerceCatalog has no I/O).
 *
 * Run: npx tsx scripts/verifyCommerceNavPhase2.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCommerceCatalog, filterProducts } from '../src/services/commerceCatalog';
import type { Product } from '../src/data/products';

const SNAP = 'rollback-baseline-2026-07-21/db/sellable_category_inputs.json';
type Row = { id: string; category_label: string | null; category_code: string; spec_cat: string | null; name: string | null };
function rows(txt: string): Row[] { const o = JSON.parse(txt); return Array.isArray(o) ? o : o.rows?.[0]?.j ?? o.j; }

// Build the same Product inputs the live adapter feeds classifyCommerce (category = spec||code).
const products: Product[] = rows(readFileSync(SNAP, 'utf8')).map(r => ({
  id: r.id, name: r.name ?? '', categoryLabel: r.category_label ?? undefined,
  category: (r.spec_cat && r.spec_cat.trim()) ? r.spec_cat : r.category_code,
  images: ['https://cdn/x.jpg'], desc: '', price: 199, discountPercent: 0, rating: 4.6, reviewCount: 1, stock: 1,
} as unknown as Product));

let fail = 0; const ck = (c: boolean, m: string) => { if (!c) { fail++; console.log(`  ✗ ${m}`); } };
const cat = buildCommerceCatalog(products);
const deptCount = (id: string) => cat.departments.find(d => d.id === id)?.count ?? 0;
const catCount = (d: string, c: string) => cat.departments.find(x => x.id === d)?.categories.find(x => x.id === c)?.count ?? 0;

console.log(`Phase 2 catalog verification — ${products.length} sellable rows\n`);

ck(products.length === 349, `total is 349 (got ${products.length})`);
ck(cat.needsReview === 0, `needs-review is 0 (got ${cat.needsReview})`);

// Department counts vs Phase 1 baseline
const EXP_DEPT: Record<string, number> = { furniture: 306, bathroom: 39, 'kids-baby': 2, 'pet-supplies': 1, 'outdoor-garden': 1 };
for (const [id, n] of Object.entries(EXP_DEPT)) ck(deptCount(id) === n, `department ${id} = ${n} (got ${deptCount(id)})`);

// Furniture category counts vs Phase 1
const EXP_CAT: Record<string, number> = { 'accent-storage-furniture': 121, 'bedroom-furniture': 91, 'living-room-furniture': 73, 'dining-furniture': 14, 'home-office-furniture': 7 };
for (const [id, n] of Object.entries(EXP_CAT)) ck(catCount('furniture', id) === n, `furniture/${id} = ${n} (got ${catCount('furniture', id)})`);

// Every product is reachable through exactly one dept/cat/type path
const reachable = cat.departments.reduce((s, d) => s + d.count, 0);
ck(reachable === products.length, `all products reachable (${reachable}/${products.length})`);

// Representative filter path (Furniture → Bedroom → Dresser)
ck(filterProducts(products, { department: 'furniture', category: 'bedroom-furniture', productType: 'dresser' }).length === 49, 'Dresser results = 49');

console.log('\nDepartments (active, ordered):');
for (const d of cat.departments) {
  console.log(`  ${String(d.count).padStart(4)}  ${d.label}`);
  for (const c of d.categories) console.log(`        ${String(c.count).padStart(3)}  ${c.label}  [${c.types.map(t => `${t.label} ${t.count}`).join(', ')}]`);
}
console.log(`\n${fail === 0 ? 'PHASE 2 CATALOG VERIFICATION PASSED ✓' : `FAILED ✗ (${fail})`}`);
process.exit(fail === 0 ? 0 : 1);
