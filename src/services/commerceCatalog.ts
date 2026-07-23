/**
 * Commerce Catalog — PURE grouping/filtering (Phase 2, Commerce Layer data).
 *
 * Derives the Department → Category → Product Type hierarchy from a supplied list
 * of adapted products, using the Phase 1 pure classifier (classifyCommerce).
 * NO I/O here (no supabase / adapter imports) so it is unit-testable and free of
 * React-Native transitive imports. The live loader lives in commerceCatalogLoader.ts.
 *
 * Display labels come from the Phase 1 registry so the UI shows explicit
 * customer-facing taxonomy names, never slugs. No schema/product-data changes.
 */
import {
  classifyCommerce, DEPARTMENTS, CATEGORIES, PRODUCT_TYPES, NEEDS_REVIEW,
} from '../utils/commerceTaxonomy';
import type { Product } from '../data/products';

const DEPT_LABEL = new Map(DEPARTMENTS.map(d => [d.id, d.label]));
const CAT_LABEL = new Map(CATEGORIES.map(c => [c.id, c.label]));
const TYPE_LABEL = new Map(PRODUCT_TYPES.map(t => [t.id, t.label]));
const DEPT_ORDER = DEPARTMENTS.map(d => d.id); // registry order = display order

export type CommercePath = { department?: string; category?: string; productType?: string };
export type TypeNode = { id: string; label: string; count: number; image?: string };
export type CategoryNode = { id: string; label: string; count: number; image?: string; types: TypeNode[] };
export type DepartmentNode = { id: string; label: string; count: number; image?: string; categories: CategoryNode[] };
export type CommerceCatalog = { total: number; departments: DepartmentNode[]; needsReview: number };

/** Pure classification input for a Product (mirrors adaptStandardizedRow's inputs). */
function classify(p: Product) {
  return classifyCommerce({ name: p.name, category: p.category, categoryLabel: p.categoryLabel });
}

/** Group products into a Department → Category → Product Type tree with real counts. */
export function buildCommerceCatalog(products: Product[]): CommerceCatalog {
  const depts = new Map<string, { count: number; image?: string; cats: Map<string, { count: number; image?: string; types: Map<string, { count: number; image?: string }> }> }>();
  let needsReview = 0;

  for (const p of products) {
    const { department, category, productType } = classify(p);
    if (productType === NEEDS_REVIEW || department === NEEDS_REVIEW) { needsReview++; continue; }
    const img = p.images?.[0];
    const d = depts.get(department) ?? { count: 0, image: img, cats: new Map() };
    d.count++; if (!d.image) d.image = img;
    const c = d.cats.get(category) ?? { count: 0, image: img, types: new Map() };
    c.count++; if (!c.image) c.image = img;
    const t = c.types.get(productType) ?? { count: 0, image: img };
    t.count++; if (!t.image) t.image = img;
    c.types.set(productType, t); d.cats.set(category, c); depts.set(department, d);
  }

  const byCountDesc = <T extends { count: number }>(a: T, b: T) => b.count - a.count;
  const departments: DepartmentNode[] = [...depts.entries()]
    .map(([id, d]) => ({
      id, label: DEPT_LABEL.get(id) ?? id, count: d.count, image: d.image,
      categories: [...d.cats.entries()].map(([cid, c]) => ({
        id: cid, label: CAT_LABEL.get(cid) ?? cid, count: c.count, image: c.image,
        types: [...c.types.entries()].map(([tid, t]) => ({
          id: tid, label: TYPE_LABEL.get(tid) ?? tid, count: t.count, image: t.image,
        })).sort(byCountDesc),
      })).sort(byCountDesc),
    }))
    .filter(d => d.count > 0)
    .sort((a, b) => {
      const ia = DEPT_ORDER.indexOf(a.id), ib = DEPT_ORDER.indexOf(b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });

  return { total: products.length, departments, needsReview };
}

/** Products behind a Department / Category / Product-Type results screen. */
export function filterProducts(products: Product[], path: CommercePath): Product[] {
  return products.filter(p => {
    const c = classify(p);
    if (path.department && c.department !== path.department) return false;
    if (path.category && c.category !== path.category) return false;
    if (path.productType && c.productType !== path.productType) return false;
    return true;
  });
}

export const labelForDepartment = (id?: string) => (id ? DEPT_LABEL.get(id) ?? id : '');
export const labelForCategory = (id?: string) => (id ? CAT_LABEL.get(id) ?? id : '');
export const labelForType = (id?: string) => (id ? TYPE_LABEL.get(id) ?? id : '');
