/**
 * Shop your way (Phase 2.5) — PURE intent-based Home discovery mapping.
 * No I/O, no React, no DB — safe to unit-test with tsx.
 *
 * Maps the live commerce catalog to three intent lenses that reuse EXISTING routes
 * ONLY (no new taxonomy, no backend, no dead routes):
 *   - room    → existing Department/Category results (room → category/department slug)
 *   - product → existing Product-Type results (curated high-intent product types)
 *   - need    → existing approved Collections (mirrors CollectionScreen COLLECTIONS)
 *
 * LIMITATION: there is no dedicated production "need" taxonomy/config. The Need lens
 * intentionally surfaces the approved Collections subset until a real need model is
 * defined (product/CMS work — out of scope for this pass).
 *
 * Every entry carries a concrete { screen, params } route to an EXISTING registered
 * screen (CommerceResults or Collection), so the UI can never produce a dead route.
 */
import type { CommerceCatalog } from './commerceCatalog';

export type SywMode = 'room' | 'product' | 'need';

export type SywRoute =
  | { screen: 'CommerceResults'; params: { department?: string; category?: string; productType?: string } }
  | { screen: 'Collection'; params: { key: string } };

export interface SywEntry {
  id: string;
  label: string;
  sub?: string;
  count?: number;
  image?: string;
  route: SywRoute;
}

export interface ShopYourWayContent {
  room: SywEntry[];
  product: SywEntry[];
  need: SywEntry[];
}

// Room → existing Department/Category route (existing registry slugs only). A room
// with no matching catalog node (or zero items) is skipped, never rendered dead.
const ROOM_ROUTES: { label: string; department: string; category?: string }[] = [
  { label: 'Living Room', department: 'furniture', category: 'living-room-furniture' },
  { label: 'Bedroom', department: 'furniture', category: 'bedroom-furniture' },
  { label: 'Dining Room', department: 'furniture', category: 'dining-furniture' },
  { label: 'Home Office', department: 'furniture', category: 'home-office-furniture' },
  { label: 'Bathroom', department: 'bathroom' },
];

// High-intent product types in display order; resolved against the live catalog and
// skipped when absent. Slugs are existing PRODUCT_TYPES registry ids.
const HIGH_INTENT_TYPES = ['sofa', 'dresser', 'sideboard', 'bed', 'bathroom-vanity', 'tv-stand', 'desk', 'nightstand'];

// Need → existing approved Collections (mirror of CollectionScreen COLLECTIONS keys).
const NEED_COLLECTIONS: { key: string; label: string; sub: string }[] = [
  { key: 'spring-sale', label: 'Spring Sale', sub: 'Up to 30% off selected furniture' },
  { key: 'spring-collection', label: 'Spring Collection', sub: 'Fresh picks for the season' },
];

export function buildShopYourWay(catalog: CommerceCatalog): ShopYourWayContent {
  // Index every product type → its full path + node data (first occurrence wins).
  const typeIndex = new Map<string, SywEntry>();
  for (const d of catalog.departments) {
    for (const c of d.categories) {
      for (const t of c.types) {
        if (!typeIndex.has(t.id)) {
          typeIndex.set(t.id, {
            id: t.id, label: t.label, count: t.count, image: t.image,
            route: { screen: 'CommerceResults', params: { department: d.id, category: c.id, productType: t.id } },
          });
        }
      }
    }
  }

  // Room — resolve each room to a real category (preferred) or department node.
  const room: SywEntry[] = [];
  for (const r of ROOM_ROUTES) {
    const dep = catalog.departments.find(d => d.id === r.department);
    if (!dep) continue;
    if (r.category) {
      const cat = dep.categories.find(c => c.id === r.category);
      if (!cat || cat.count <= 0) continue;
      room.push({
        id: `room:${r.category}`, label: r.label, count: cat.count, image: cat.image,
        route: { screen: 'CommerceResults', params: { department: dep.id, category: cat.id } },
      });
    } else {
      if (dep.count <= 0) continue;
      room.push({
        id: `room:${dep.id}`, label: r.label, count: dep.count, image: dep.image,
        route: { screen: 'CommerceResults', params: { department: dep.id } },
      });
    }
  }

  // Product — high-intent types that actually exist in the catalog.
  const product: SywEntry[] = [];
  for (const slug of HIGH_INTENT_TYPES) {
    const e = typeIndex.get(slug);
    if (e && (e.count ?? 0) > 0) product.push(e);
    if (product.length >= 8) break;
  }

  // Need — existing approved Collections (no dedicated need taxonomy yet).
  const need: SywEntry[] = NEED_COLLECTIONS.map(n => ({
    id: `need:${n.key}`, label: n.label, sub: n.sub,
    route: { screen: 'Collection', params: { key: n.key } },
  }));

  return { room, product, need };
}
