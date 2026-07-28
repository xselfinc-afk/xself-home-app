/**
 * Pilot-scoped family collapse for the browse waterfalls (Home / Discover / Collection).
 *
 * Collapses the sellable children of a PILOT family (isPilotFamily) into a SINGLE
 * representative card carrying a From-$X price range; every non-pilot product and every
 * singleton is left untouched as its own card. The representative is emitted at the
 * position of the first family member seen, so list order is stable.
 *
 * Display-only and browse-only: Search keeps the full per-SKU pool (so any colour/SKU is
 * findable and opens its exact child preselected), and Commerce category COUNTS are left
 * per-SKU. Pure — no I/O, import-safe for tsx tests.
 */
import type { Product } from '../data/products';
import { isPilotFamily } from '../config/productFamilyPilot';

export function collapsePilotFamilies(products: Product[]): Product[] {
  // Group pilot-family members by key, in list order.
  const byKey = new Map<string, Product[]>();
  for (const p of products) {
    const key = p.product_family_key;
    if (key && isPilotFamily(key)) {
      const arr = byKey.get(key);
      if (arr) arr.push(p); else byKey.set(key, [p]);
    }
  }
  // Only families with >1 sellable member actually collapse.
  const collapsing = new Map<string, { repId: string; min: number; hasRange: boolean }>();
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    const rep = members.find(m => (m.images?.length ?? 0) > 0) ?? members[0];
    const prices = members.map(m => m.price).filter(n => Number.isFinite(n) && n > 0);
    const min = prices.length ? Math.min(...prices) : rep.price;
    collapsing.set(key, { repId: rep.id, min, hasRange: new Set(prices).size > 1 });
  }
  if (collapsing.size === 0) return products; // fast path — no pilot multi-child families present

  const out: Product[] = [];
  const emitted = new Set<string>();
  for (const p of products) {
    const key = p.product_family_key;
    const agg = key ? collapsing.get(key) : undefined;
    if (agg && key) {
      if (emitted.has(key)) continue; // family already emitted at its first-seen slot
      emitted.add(key);
      const rep = byKey.get(key)!.find(m => m.id === agg.repId)!;
      out.push({ ...rep, familyMinPrice: agg.min, familyHasPriceRange: agg.hasRange });
    } else {
      out.push(p); // non-pilot / singleton — one card per SKU, unchanged
    }
  }
  return out;
}
