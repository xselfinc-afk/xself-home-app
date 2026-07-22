/**
 * Commerce Taxonomy engine (Phase 1) — Xself Home Commerce Bible v1.0 hierarchy.
 *
 * Pure, deterministic, no side effects / DB / React. Sibling of
 * productClassification.ts — it does NOT modify or replace `inferCategoryPath`
 * (the legacy category system stays byte-for-byte intact).
 *
 * FOUR-LEVEL model (canonical values are stable kebab-case slugs, NOT labels):
 *
 *     Department  →  Category  →  Product Type  →  Rooms[]
 *
 *   furniture     → bedroom-furniture       → dresser        → [bedroom]
 *   furniture     → living-room-furniture   → sofa           → [living-room]
 *   furniture     → accent-storage-furniture→ sideboard      → [living-room, dining-room, entryway]
 *   bathroom      → bathroom-furniture      → bathroom-vanity→ [bathroom]
 *   outdoor-garden→ patio-furniture         → outdoor-bench  → [outdoor]
 *   pet-supplies  → pet-furniture           → pet-house      → []
 *
 * Room names ("bedroom", "living-room", "dining-room", "home-office", …) and
 * furniture groupings ("cabinets-&-sideboards") are NEVER Departments — they are
 * Rooms and/or appear inside customer-facing Category labels ("Bedroom Furniture").
 * ("bathroom" is intentionally both a Department and a Room per the Bible example.)
 *
 * Extensible: future non-furniture Departments (Kitchen & Dining, Storage &
 * Organization, Cleaning & Household, Travel, Pet Supplies, Outdoor & Garden,
 * Fitness & Sports, Kids & Baby, Automotive) are declared in DEPARTMENTS so the
 * hierarchy already supports them; categories/types get added as inventory lands.
 *
 * Anything that cannot be confidently classified resolves to the explicit
 * NEEDS_REVIEW sentinel — there is NO silent "Other" success bucket.
 */

import type { Product, CommerceClassification } from '../data/products';

export const NEEDS_REVIEW = 'needs-review';

// ── Registry types ────────────────────────────────────────────────────────────
export interface DepartmentDef { id: string; label: string; future?: boolean }
export interface CategoryDef { id: string; label: string; department: string }
export interface RoomDef { id: string; label: string }
export interface ProductTypeDef { id: string; label: string; category: string; rooms: string[] }

// ── Rooms ───────────────────────────────────────────────────────────────────
export const ROOMS: RoomDef[] = [
  { id: 'living-room', label: 'Living Room' },
  { id: 'bedroom', label: 'Bedroom' },
  { id: 'dining-room', label: 'Dining Room' },
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'home-office', label: 'Home Office' },
  { id: 'entryway', label: 'Entryway' },
  { id: 'bathroom', label: 'Bathroom' }, // also a Department (Bible-sanctioned overlap)
  { id: 'outdoor', label: 'Outdoor' },
  { id: 'kids-room', label: 'Kids Room' },
];
const ROOM_IDS = new Set(ROOMS.map(r => r.id));
/** Room slugs that must NEVER be a Department id (all rooms except the
 *  Bible-sanctioned 'bathroom', which is legitimately both). */
export const ROOM_ONLY_IDS = ROOMS.map(r => r.id).filter(id => id !== 'bathroom');

// ── Departments (current + declared future) ───────────────────────────────────
export const DEPARTMENTS: DepartmentDef[] = [
  { id: 'furniture', label: 'Furniture' },
  { id: 'bathroom', label: 'Bathroom' },
  { id: 'outdoor-garden', label: 'Outdoor & Garden' },
  { id: 'pet-supplies', label: 'Pet Supplies' },
  { id: 'kids-baby', label: 'Kids & Baby' },
  // Declared for extensibility — no current-catalog categories yet.
  { id: 'kitchen-dining', label: 'Kitchen & Dining', future: true },
  { id: 'storage-organization', label: 'Storage & Organization', future: true },
  { id: 'cleaning-household', label: 'Cleaning & Household', future: true },
  { id: 'travel', label: 'Travel', future: true },
  { id: 'fitness-sports', label: 'Fitness & Sports', future: true },
  { id: 'automotive', label: 'Automotive', future: true },
  // Sentinel department for unclassifiable products.
  { id: NEEDS_REVIEW, label: 'Needs Review' },
];

// ── Categories (each belongs to exactly one Department) ───────────────────────
export const CATEGORIES: CategoryDef[] = [
  { id: 'bedroom-furniture', label: 'Bedroom Furniture', department: 'furniture' },
  { id: 'living-room-furniture', label: 'Living Room Furniture', department: 'furniture' },
  { id: 'dining-furniture', label: 'Dining Furniture', department: 'furniture' },
  { id: 'home-office-furniture', label: 'Home Office Furniture', department: 'furniture' },
  { id: 'accent-storage-furniture', label: 'Accent & Storage Furniture', department: 'furniture' },
  { id: 'bathroom-furniture', label: 'Bathroom Furniture', department: 'bathroom' },
  { id: 'patio-furniture', label: 'Patio Furniture', department: 'outdoor-garden' },
  { id: 'pet-furniture', label: 'Pet Furniture', department: 'pet-supplies' },
  { id: 'kids-furniture', label: 'Kids & Baby Furniture', department: 'kids-baby' },
  { id: NEEDS_REVIEW, label: 'Needs Review', department: NEEDS_REVIEW },
];

// ── Product Types (each belongs to exactly one primary Category) ──────────────
export const PRODUCT_TYPES: ProductTypeDef[] = [
  // Bedroom
  { id: 'dresser', label: 'Dresser', category: 'bedroom-furniture', rooms: ['bedroom'] },
  { id: 'nightstand', label: 'Nightstand', category: 'bedroom-furniture', rooms: ['bedroom'] },
  { id: 'bed', label: 'Bed', category: 'bedroom-furniture', rooms: ['bedroom'] },
  { id: 'wardrobe', label: 'Wardrobe', category: 'bedroom-furniture', rooms: ['bedroom'] },
  { id: 'makeup-vanity', label: 'Makeup Vanity', category: 'bedroom-furniture', rooms: ['bedroom'] },
  { id: 'full-length-mirror', label: 'Full-Length Mirror', category: 'bedroom-furniture', rooms: ['bedroom'] },
  // Living Room
  { id: 'sofa', label: 'Sofa', category: 'living-room-furniture', rooms: ['living-room'] },
  { id: 'sectional', label: 'Sectional', category: 'living-room-furniture', rooms: ['living-room'] },
  { id: 'coffee-table', label: 'Coffee Table', category: 'living-room-furniture', rooms: ['living-room'] },
  { id: 'console-table', label: 'Console Table', category: 'living-room-furniture', rooms: ['living-room', 'entryway'] },
  { id: 'side-table', label: 'Side Table', category: 'living-room-furniture', rooms: ['living-room'] },
  { id: 'tv-stand', label: 'TV Stand', category: 'living-room-furniture', rooms: ['living-room'] },
  { id: 'accent-chair', label: 'Accent Chair', category: 'living-room-furniture', rooms: ['living-room'] },
  { id: 'ottoman', label: 'Ottoman', category: 'living-room-furniture', rooms: ['living-room'] },
  // Dining
  { id: 'dining-table', label: 'Dining Table', category: 'dining-furniture', rooms: ['dining-room'] },
  { id: 'dining-set', label: 'Dining Set', category: 'dining-furniture', rooms: ['dining-room'] },
  { id: 'dining-chair', label: 'Dining Chair', category: 'dining-furniture', rooms: ['dining-room'] },
  { id: 'bar-stool', label: 'Bar Stool', category: 'dining-furniture', rooms: ['kitchen', 'dining-room'] },
  { id: 'kitchen-island', label: 'Kitchen Island', category: 'dining-furniture', rooms: ['kitchen'] },
  // Home Office
  { id: 'desk', label: 'Desk', category: 'home-office-furniture', rooms: ['home-office'] },
  { id: 'office-chair', label: 'Office Chair', category: 'home-office-furniture', rooms: ['home-office'] },
  { id: 'file-cabinet', label: 'File Cabinet', category: 'home-office-furniture', rooms: ['home-office'] },
  // Accent & Storage
  { id: 'sideboard', label: 'Sideboard', category: 'accent-storage-furniture', rooms: ['living-room', 'dining-room', 'entryway'] },
  { id: 'accent-cabinet', label: 'Accent Cabinet', category: 'accent-storage-furniture', rooms: ['living-room'] },
  { id: 'storage-cabinet', label: 'Storage Cabinet', category: 'accent-storage-furniture', rooms: ['living-room', 'bedroom', 'home-office'] },
  { id: 'bookcase', label: 'Bookcase', category: 'accent-storage-furniture', rooms: ['living-room', 'home-office'] },
  { id: 'shoe-cabinet', label: 'Shoe Cabinet', category: 'accent-storage-furniture', rooms: ['entryway'] },
  { id: 'coat-rack', label: 'Coat Rack', category: 'accent-storage-furniture', rooms: ['entryway'] },
  // Bathroom
  { id: 'bathroom-vanity', label: 'Bathroom Vanity', category: 'bathroom-furniture', rooms: ['bathroom'] },
  { id: 'bathroom-cabinet', label: 'Bathroom Cabinet', category: 'bathroom-furniture', rooms: ['bathroom'] },
  // Outdoor
  { id: 'outdoor-bench', label: 'Outdoor Bench', category: 'patio-furniture', rooms: ['outdoor'] },
  // Pet
  { id: 'pet-house', label: 'Pet House', category: 'pet-furniture', rooms: [] },
  // Kids & Baby
  { id: 'toy-box', label: 'Toy Box', category: 'kids-furniture', rooms: ['kids-room'] },
  { id: 'kids-storage', label: 'Kids Storage', category: 'kids-furniture', rooms: ['kids-room'] },
  // Sentinel
  { id: NEEDS_REVIEW, label: 'Needs Review', category: NEEDS_REVIEW, rooms: [] },
];

const CATEGORY_BY_ID = new Map(CATEGORIES.map(c => [c.id, c]));
const TYPE_BY_ID = new Map(PRODUCT_TYPES.map(t => [t.id, t]));

// ── Resolution rules ──────────────────────────────────────────────────────────

// Multi-word / whole-phrase pet tokens only — NO bare 'cat'/'dog'/'pet' substrings,
// so the legacy Pet false-positive cannot recur.
const PET_TOKENS = ['pet house', 'pet bed', 'pet crate', 'cat tree', 'cat house', 'cat litter', 'litter box enclosure', 'dog crate', 'dog house', 'dog kennel', 'rabbit hutch'];

// Reliable supplier spec categories that OVERRIDE title/label (avoid broad title
// rules like "cabinet"/"table" misrouting these). Keyed by lowercased spec value.
const AUTHORITATIVE_SPEC: Record<string, (nameLc: string) => string> = {
  'bathroom vanities': () => 'bathroom-vanity',
  'makeup vanities': () => 'makeup-vanity',
  'full length mirrors': () => 'full-length-mirror',
  'bathroom storage': () => 'bathroom-cabinet',
  'youth, kids & baby furniture': (n) => (n.includes('toy') ? 'toy-box' : 'kids-storage'),
};

// Title keyword rules, ordered specific → broad. First match wins.
const TITLE_RULES: { type: string; kw: string[] }[] = [
  { type: 'tv-stand',        kw: ['tv stand', 'tv cabinet', 'tv unit', 'media console', 'media stand', 'media storage', 'entertainment center', 'av media', 'av stand'] },
  { type: 'makeup-vanity',   kw: ['makeup vanity', 'dressing table', 'vanity desk', 'vanity table', 'vanity set', 'vanity mirror', 'vanity stool'] }, // before dresser/nightstand: "Bedside … Dressing Table" is a vanity
  { type: 'dresser',         kw: ['dresser', 'chest of drawer', 'drawer dresser', 'drawers dresser', 'double dresser', 'drawer chest'] },
  { type: 'wardrobe',        kw: ['wardrobe', 'armoire', 'closet island'] },
  { type: 'nightstand',      kw: ['nightstand', 'night stand', 'bedside table', 'bedside cabinet', 'bedside'] },
  { type: 'bed',             kw: ['bed frame', 'headboard', 'platform bed', 'bunk bed', 'loft bed', 'canopy bed', 'trundle bed', 'murphy bed'] },
  { type: 'sideboard',       kw: ['sideboard', 'buffet', 'credenza', 'server cabinet', 'serving cabinet'] },
  { type: 'bookcase',        kw: ['bookcase', 'bookshelf', 'book shelf', 'etagere'] },
  { type: 'coat-rack',       kw: ['hall tree', 'coat rack', 'coat stand'] }, // before shoe: "hall tree with shoe storage"
  { type: 'shoe-cabinet',    kw: ['shoe cabinet', 'shoe rack', 'shoe storage'] },
  { type: 'bathroom-cabinet',kw: ['bathroom storage', 'bathroom cabinet', 'bathroom floor', 'bathroom wall', 'over toilet', 'over-the-toilet', 'medicine cabinet'] },
  { type: 'coffee-table',    kw: ['coffee table', 'cocktail table', 'lift-top'] },
  { type: 'console-table',   kw: ['console table', 'entryway table', 'sofa table', 'hallway table'] },
  { type: 'side-table',      kw: ['side table', 'end table', 'accent table', 'nesting table', 'corner table'] },
  { type: 'dining-set',      kw: ['dining set', 'dining table set', 'piece dining', 'counter height dining', 'dinette set', '5-piece', '6-piece', '7-piece'] },
  { type: 'dining-table',    kw: ['dining table', 'kitchen table', 'dinette'] },
  { type: 'dining-chair',    kw: ['dining chair', 'kitchen chair'] },
  { type: 'bar-stool',       kw: ['bar stool', 'counter stool', 'bar chair'] },
  { type: 'kitchen-island',  kw: ['kitchen island', 'kitchen cart', 'bar cart', 'island cart'] },
  { type: 'office-chair',    kw: ['office chair', 'task chair', 'desk chair', 'gaming chair', 'ergonomic chair'] },
  { type: 'file-cabinet',    kw: ['file cabinet', 'filing cabinet'] },
  { type: 'desk',            kw: ['writing desk', 'computer desk', 'writing table', 'computer table', 'workstation', 'work surface', 'desk'] },
  { type: 'accent-chair',    kw: ['accent chair', 'armchair', 'arm chair', 'lounge chair', 'club chair', 'recliner'] },
  { type: 'sectional',       kw: ['sectional'] },
  { type: 'sofa',            kw: ['sofa', 'couch', 'loveseat', 'love seat', 'settee', 'futon', 'daybed'] },
  { type: 'ottoman',         kw: ['ottoman', 'footstool', 'pouf', 'pouffe'] },
  { type: 'full-length-mirror', kw: ['full length mirror', 'full-length mirror', 'floor mirror', 'dressing mirror', 'standing mirror'] },
  { type: 'accent-cabinet',  kw: ['accent cabinet', 'display cabinet', 'curio', 'glass display', 'display storage cabinet', 'bar cabinet', 'wine cabinet'] },
  { type: 'bathroom-vanity', kw: ['bathroom vanity', 'vanity sink', 'sink cabinet', 'vanity with sink'] },
  // Broad — last so specific types above win.
  { type: 'storage-cabinet', kw: ['storage cabinet', 'cabinet', 'cupboard', 'pantry'] },
];

// Normalized category_label → product type (fallback when the title is uninformative).
const LABEL_TYPE_MAP: Record<string, string> = {
  Dresser: 'dresser', Nightstand: 'nightstand', 'TV Stand': 'tv-stand', Sideboard: 'sideboard',
  Cabinet: 'storage-cabinet', Bookshelf: 'bookcase', Sofa: 'sofa', Bed: 'bed', Desk: 'desk',
  Chair: 'accent-chair', Bathroom: 'bathroom-vanity', Storage: 'storage-cabinet',
};

// Supplier spec category → product type (last resort, when title + label gave nothing).
const SPEC_FALLBACK: Record<string, string> = {
  'cabinets': 'storage-cabinet',
  'servers, sideboards & buffets': 'sideboard',
  'dressers, chests & wardrobes': 'dresser',
  'sofas': 'sofa',
  'sectionals': 'sectional',
  'tables': NEEDS_REVIEW,
  'nightstands': 'nightstand',
  'tv & entertainment furniture': 'tv-stand',
  'beds, frames & bases': 'bed',
  'kitchen islands & carts': 'kitchen-island',
  'chairs & accent seating': 'accent-chair',
  'desks & work surfaces': 'desk',
  'coat racks': 'coat-rack',
  'dining and kitchen sets': 'dining-set',
  'dining tables': 'dining-table',
  'display, shelving & etageres': 'bookcase',
  'seating for dining': 'dining-chair',
  'file cabinets & storage cabinets': 'file-cabinet',
  'pens & hutches': NEEDS_REVIEW,
  'bedroom storage': 'storage-cabinet',
  'office chairs': 'office-chair',
  'bookshelf': 'bookcase',
  'patio seating': 'outdoor-bench',
};

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some(kw => text.includes(kw));
}

/** Resolve the canonical Product Type slug, or NEEDS_REVIEW. */
function resolveProductTypeId(
  product: Pick<Product, 'name' | 'category' | 'categoryLabel'>,
): string {
  const nameLc = (product.name ?? '').toLowerCase();
  const specLc = (product.category ?? '').trim().toLowerCase();

  // 0. Pet (whole-phrase tokens only).
  if (matchesAny(nameLc, PET_TOKENS)) return 'pet-house';

  // 1. Authoritative supplier spec categories override noisy titles.
  const auth = AUTHORITATIVE_SPEC[specLc];
  if (auth) return auth(nameLc);

  // 2. Title keywords (richest fine signal — decisive for the broad "Cabinets" bucket).
  for (const rule of TITLE_RULES) {
    if (matchesAny(nameLc, rule.kw)) return rule.type;
  }

  // 3. Normalized category_label.
  if (product.categoryLabel && LABEL_TYPE_MAP[product.categoryLabel]) {
    return LABEL_TYPE_MAP[product.categoryLabel];
  }

  // 4. Supplier spec category fallback.
  if (SPEC_FALLBACK[specLc]) return SPEC_FALLBACK[specLc];

  // 5. Explicit — never a silent "Other".
  return NEEDS_REVIEW;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify a product into { department, category, productType, rooms } — all
 * stable slug ids. Pure and deterministic; never throws. Unresolvable input
 * yields the explicit NEEDS_REVIEW sentinel at every level (not "Other").
 */
export function classifyCommerce(
  product: Pick<Product, 'name' | 'category' | 'categoryLabel'>,
): CommerceClassification {
  const productType = resolveProductTypeId(product);
  const typeDef = TYPE_BY_ID.get(productType);
  const category = typeDef ? typeDef.category : NEEDS_REVIEW;
  const catDef = CATEGORY_BY_ID.get(category);
  const department = catDef ? catDef.department : NEEDS_REVIEW;
  return { department, category, productType, rooms: typeDef ? typeDef.rooms : [] };
}

export function isNeedsReview(c: CommerceClassification): boolean {
  return c.productType === NEEDS_REVIEW;
}

// ── Registry self-validation (used by tests/verification) ─────────────────────

/** Returns a list of invariant violations; empty array means the registry is sound. */
export function validateRegistry(): string[] {
  const problems: string[] = [];
  const deptIds = new Set(DEPARTMENTS.map(d => d.id));

  for (const c of CATEGORIES) {
    if (!deptIds.has(c.department)) problems.push(`category ${c.id} → unknown department ${c.department}`);
  }
  for (const t of PRODUCT_TYPES) {
    if (!CATEGORY_BY_ID.has(t.category)) problems.push(`product type ${t.id} → unknown category ${t.category}`);
    for (const r of t.rooms) if (!ROOM_IDS.has(r)) problems.push(`product type ${t.id} → unknown room ${r}`);
  }
  // Room-exclusive names must never be Department ids.
  for (const r of ROOM_ONLY_IDS) if (deptIds.has(r)) problems.push(`room "${r}" is used as a Department id`);
  // Product Type ids must never be Department ids (the cross-level NEEDS_REVIEW
  // sentinel is exempt — it is a marker, not a real taxonomy value).
  for (const t of PRODUCT_TYPES) if (t.id !== NEEDS_REVIEW && deptIds.has(t.id)) problems.push(`product type "${t.id}" is used as a Department id`);
  // The specific v1-mistake names must not be Departments.
  for (const bad of ['bedroom', 'living-room', 'dining-room', 'home-office', 'cabinets-sideboards', 'cabinets-and-sideboards']) {
    if (deptIds.has(bad)) problems.push(`forbidden department id "${bad}"`);
  }
  return problems;
}
