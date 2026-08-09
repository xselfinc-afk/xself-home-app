/**
 * planGigaAutoPublish.ts — READ-ONLY GIGA auto-publish planner.
 *
 * Scans supplier_products, excludes already-standardized / already-sellable rows,
 * classifies the rest into onboarding buckets, proposes the next safe batch, and
 * writes full detail to report files while printing only a compact summary to chat.
 *
 * It performs NO writes of any kind: no publish, normalize, price, mirror, blurhash,
 * inventory, reviews, deploy. The only filesystem writes are the two local report
 * files under reports/giga-auto-publish/.
 *
 * Usage:
 *   npx tsx scripts/planGigaAutoPublish.ts --max-skus=50 --summary
 *
 * Flags:
 *   --max-skus=N   cap the proposed batch SKU count (default 50)
 *   --summary      print only the compact GIGA_AUTO_PLAN_SUMMARY block to chat
 *
 * Classification buckets (conservative — prefer false negatives over false positives):
 *   SAFE_SINGLETON            clean, imaged, priced, true singleton (title-derived key, no -vg- siblings)
 *   SAFE_CLEAN_COLOR_VARIANT  -vg- family, ≥2 co-present members, same category/dims/config,
 *                             distinct colors (no dup), identical normalized cost within the family
 *   HOLD_PRICE                otherwise-clean -vg- family whose per-color NORMALIZED cost differs
 *                             (would price differently → "from $X" split). Compares the same
 *                             discounted cost normalizeProduct() uses, NOT supplier_products.price.
 *   HOLD_PHASE2               -vg- family with duplicate colors OR differing size/config (dims/drawers/doors),
 *                             OR a fragmented cluster (siblings not co-present among candidates).
 *                             Needs the Phase-2 color+size/config selector before it can go live.
 *   HOLD_QUALITY              clean enough to sell eventually but uncertain now: brand-prefix or
 *                             marketing-text title, very low price (<$30), 'Other' category, weak title.
 *   REJECT                    cannot onboard: missing image, missing/zero price, or hard-junk category
 *                             (pet/kids/outdoor/patio/luggage/beanbag/trash).
 *
 * Cost note: family cost equality uses normalizeProduct().price (supplier DISCOUNTED cost), because
 * per-color discounts can differ even when list prices match (observed on cb-vg-w409p327399).
 */
(globalThis as { __DEV__?: boolean }).__DEV__ = false;
import { config as loadEnv } from 'dotenv';
// Env precedence MUST match runGigaAutoPublish.ts (+11 other GIGA scripts): .env.giga-alt.local holds
// the working GIGA API creds (openapi.gigab2b.com host) and is loaded FIRST. dotenv is first-wins, so
// omitting it made the planner sign the stock probe with the wrong .env.local creds (www.gigab2b.com)
// → HTTP 500. Loading it first gives the planner the same working credentials as the runner.
loadEnv({ path: '.env.giga-alt.local' }); loadEnv({ path: '.env.local' }); loadEnv({ path: '.env' });
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
// Commerce Taxonomy is the production classification authority (reused as-is; no parallel classifier).
import { classifyCommerce, NEEDS_REVIEW } from '../src/utils/commerceTaxonomy';

// ── CLI ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const SUMMARY = argv.includes('--summary');
const maxArg = argv.find(a => a.startsWith('--max-skus='));
const MAX_SKUS = maxArg ? Math.max(1, parseInt(maxArg.split('=')[1], 10) || 50) : 50;
// Hard per-SKU scope: --only=SKU[,SKU2] restricts the candidate set to EXACTLY these supplier SKUs,
// so the resulting plan (buckets, proposed_batch, candidates) covers only them. Used for controlled
// single-SKU publishes — the downstream apply engine reads proposed_batch.skus + plan.candidates.
const onlyArg = argv.find(a => a.startsWith('--only='));
const ONLY_SKUS = onlyArg ? onlyArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean) : null;

const REPORT_DIR = path.join(process.cwd(), 'reports', 'giga-auto-publish');
const REPORT_JSON = path.join(REPORT_DIR, 'latest-plan.json');
const REPORT_MD = path.join(REPORT_DIR, 'latest-plan.md');

// ── Quality heuristics ──────────────────────────────────────────────────────
const PREFIX_MIN = 8; // shared SKU prefix to count as a true variant sibling (matches syncGigaVariants.ts)
const LOW_PRICE = 30;
// Hard-junk → REJECT (cannot onboard as commercial indoor furniture).
const HARD_JUNK = /\b(pet|dog|cat|kitten|puppy|fish\s*tank|aquarium|litter|kennel|crate|kid|kids|toy|toddler|nursery|bunk|murphy|crib|playpen|patio|outdoor|garden|gazebo|pergola|trampoline|trash|garbage|luggage|suitcase|bean\s?bag)\b/i;
// Brand prefixes / marketing text → HOLD_QUALITY (salvageable with title cleanup, not auto-safe).
const BRAND_PREFIX = /^(trexm|vibe\s?haus|k&k|fch|gartoo|kepswin|woj|topmax|tomax|go\b)/i;
const MARKETING = /(<\s*old\s*sku|made in usa|\[video\]|assembly video provided|\d-day)/i;
// Categories with NO door/drawer configuration axis. For these, the `cfgmissing` sentinel is
// HOMOGENEOUS across the whole family (no member can ever derive a door/drawer count), so the
// family key is stable and a cfgmissing fragment is safe to seed as a standalone card — unlike
// config-bearing types (cabinet/dresser/sideboard/nightstand/bookshelf), where a future sibling
// might parse a count and split. Width still must be present (wmissing stays held). Compared
// case-insensitively against the normalized category_label.
const NO_CONFIG_AXIS_CATS = new Set(
  ['sofa', 'bed', 'table', 'chair', 'mattress', 'rug', 'mirror', 'bench', 'ottoman', 'lighting'],
);
// Per-family cost tolerance: clean color families whose per-color cost differs only by rounding
// noise (≤ $1 absolute OR ≤ 2% relative) are treated as same-cost and released, instead of holding.
const COST_TOL_ABS = 1;     // dollars
const COST_TOL_PCT = 0.02;  // 2%

// ── GIGA stock probe (read-only quantity; mirrors runGigaAutoPublish.ts stage 7) ──
// The planner cannot know pre-publish stock from the DB (inventory_cache only covers already-seeded
// SKUs), so it probes the live GIGA quantity API for would-be-safe candidates and demotes zero-stock
// ones before proposing — preventing the propose→dry-run-hold→repeat loop. Requires GIGA creds; when
// absent the probe is skipped and the runner's stage-7 stock gate remains authoritative.
const GIGA_BASE = process.env.SUPPLIER_API_BASE_URL ?? '';
const GIGA_CID = process.env.SUPPLIER_CLIENT_ID ?? '';
const GIGA_SEC = process.env.SUPPLIER_CLIENT_SECRET ?? '';
const QTY_PATH = '/b2b-overseas-api/v1/buyer/inventory/quantity/v2';
const gigaReady = () => !!(GIGA_BASE && GIGA_CID && GIGA_SEC && /openapi\.gigab2b\.com/.test(GIGA_BASE));
const gigaNonce = (n = 10) => { const c = 'abcdefghijklmnopqrstuvwxyz0123456789'; let r = ''; for (let i = 0; i < n; i++) r += c[Math.floor(Math.random() * c.length)]; return r; };
const gigaSign = (p: string, ts: string, nc: string) => {
  const msg = `${GIGA_CID}&${p}&${ts}&${nc}`, key = `${GIGA_CID}&${GIGA_SEC}&${nc}`;
  return Buffer.from(crypto.createHmac('sha256', key).update(msg).digest('hex'), 'utf8').toString('base64');
};
async function gigaQuantity(skus: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < skus.length; i += 200) {
    const batch = skus.slice(i, i + 200);
    const ts = Date.now().toString(), nc = gigaNonce();
    const res = await fetch(`${GIGA_BASE}${QTY_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'client-id': GIGA_CID, timestamp: ts, nonce: nc, sign: gigaSign(QTY_PATH, ts, nc) },
      body: JSON.stringify({ skus: batch }),
    });
    const json: any = await res.json().catch(() => null);
    if (res.status !== 200 || !json || json.success !== true) throw new Error(`giga_http_${res.status}`);
    for (const ar of (json.data ?? [])) {
      const dist = ar?.sellerInventoryInfo?.sellerInventoryDistribution ?? [];
      out.set(ar.sku, dist.reduce((acc: number, w: any) => acc + Math.max(0, Number(w.availableQtyMin) || 0), 0));
    }
  }
  return out;
}

const sharedPrefixLen = (a: string, b: string) => { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a[i] === b[i]) i++; return i; };
const drawers = (t: string) => { const m = String(t ?? '').match(/(\d+)\s*[- ]?drawers?/i); return m ? +m[1] : null; };
const doors = (t: string) => { const m = String(t ?? '').match(/(\d+)\s*[- ]?doors?/i); return m ? +m[1] : null; };

type Cand = {
  id: string; title: string; normTitle: string; key: string; cat: string; color: string;
  normCost: number; origPrice: number | null; img: boolean; imgCount: number;
  dim: string; drawers: number | null; doors: number | null;
  isVg: boolean; hasLiveSibling: boolean; cfgMissing: boolean; widthMissing: boolean; commerceCanonical: boolean; bucket: string; reasons: string[];
};

/**
 * Base per-SKU classification. Commerce Taxonomy (classifyCommerce) is the AUTHORITY: a canonical
 * product is NEVER rejected/held for a legacy HARD_JUNK word (outdoor/garden/kids/pet/…) or an 'Other'
 * legacy category_label. Only products the taxonomy cannot place (needs-review) fall back to the legacy
 * junk-reject / hold gates. Pure; exported for tests. (Variant-family grouping downstream is unchanged.)
 */
export function baseBucketOf(c: { img: boolean; normCost: number; title: string; normTitle: string; commerceCanonical: boolean }): { bucket: string; reason: string } {
  if (!c.img) return { bucket: 'REJECT', reason: 'no_image' };
  if (!(c.normCost > 0)) return { bucket: 'REJECT', reason: 'no_price' };
  if (!c.commerceCanonical) {
    // Taxonomy cannot place it → genuine junk is rejected; everything else is held for review.
    if (HARD_JUNK.test(c.title)) return { bucket: 'REJECT', reason: 'junk_category' };
    return { bucket: 'HOLD_QUALITY', reason: 'needs_review_taxonomy' };
  }
  // Canonical → legacy HARD_JUNK term and 'Other' legacy label are IGNORED (taxonomy is authoritative).
  if (BRAND_PREFIX.test(c.normTitle)) return { bucket: 'HOLD_QUALITY', reason: 'brand_prefix' };
  if (MARKETING.test(c.normTitle)) return { bucket: 'HOLD_QUALITY', reason: 'marketing_text' };
  if (c.normCost < LOW_PRICE) return { bucket: 'HOLD_QUALITY', reason: 'low_price' };
  if (c.title.length < 12) return { bucket: 'HOLD_QUALITY', reason: 'weak_title' };
  if (c.normTitle.length < 12) return { bucket: 'HOLD_QUALITY', reason: 'title_not_ready' };
  return { bucket: 'CLEAN', reason: '' }; // provisional — refined by variant grouping below
}

/**
 * Verdict for a FRAGMENTED `-vg-` cluster member — the lone co-present clean member of a supplier
 * variation group. Pure; exported for tests. See the call site for the full rationale.
 *
 * BUSINESS RULE (approved 2026-08-09): a Pickup favorite IS the decision to sell that SKU. Siblings
 * the operator did not favorite are not for sale today and must never be a prerequisite — publishing
 * one item must not require favoriting a whole supplier family. Only two things still hold an item:
 * a sibling already ON SALE (duplicate card risk → merge path), and an unknown width (data gap about
 * this product itself).
 */
export function fragmentedVerdict(c: {
  hasLiveSibling: boolean; widthMissing: boolean; cfgMissing: boolean; noConfigAxis: boolean;
}): { bucket: string; reason: string } {
  if (c.hasLiveSibling) return { bucket: 'HOLD_PHASE2', reason: 'fragmented_cluster' };
  if (c.widthMissing) return { bucket: 'HOLD_PHASE2', reason: 'wmissing_fragmented' };
  if (c.cfgMissing) {
    // 「这个品类本来就没有配置轴」与「本该有轴但没解析出来」是两件事，原因码分开记，便于日后
    // 改进解析器时能按 unresolved_axis_standalone 精确定位到哪些商品受影响。
    return { bucket: 'SAFE_SINGLETON', reason: c.noConfigAxis ? 'no_config_axis_standalone' : 'unresolved_axis_standalone' };
  }
  return { bucket: 'SAFE_SINGLETON', reason: 'no_live_sibling_standalone' };
}

export async function main() {
  const { createClient } = await import('@supabase/supabase-js');
  const pipe = await import('../src/services/normalizationPipeline');
  const normalizeProduct = (pipe as any).normalizeProduct;
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  // ── Load: all supplier rows, plus the exclusion sets ──────────────────────
  const supplier: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('supplier_products')
      .select('supplier_product_id,title,description,price,published,raw_payload')
      .range(from, from + 999);
    if (error) { console.error('supplier_products read failed:', error.message); process.exit(1); }
    supplier.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const { data: stdRows } = await sb.from('standardized_products').select('supplier_product_id');
  const { data: sellRows } = await sb.from('sellable_products').select('supplier_product_id');
  const stdSet = new Set((stdRows ?? []).map((r: any) => r.supplier_product_id));
  const sellSet = new Set((sellRows ?? []).map((r: any) => r.supplier_product_id));

  const supplierTotal = supplier.length;
  const alreadyStandardized = supplier.filter(r => stdSet.has(r.supplier_product_id)).length;
  const alreadySellable = supplier.filter(r => sellSet.has(r.supplier_product_id)).length;

  // Candidates = supplier rows NOT yet standardized (sellable ⊂ standardized).
  let candidates = supplier.filter(r => !stdSet.has(r.supplier_product_id));
  // Hard --only scope: restrict to exactly the requested SKUs (controlled single-SKU publishes).
  if (ONLY_SKUS) {
    const onlySet = new Set(ONLY_SKUS);
    candidates = candidates.filter(r => onlySet.has(r.supplier_product_id));
  }

  // ── Per-SKU derivation via the real pipeline (pure, in-memory) ────────────
  const log = console.log; console.log = () => {};
  const cands: Cand[] = candidates.map(r => {
    const id = r.supplier_product_id;
    const raw = (r.raw_payload ?? {}) as any;
    let n: any = {};
    try { n = normalizeProduct({ ...r, id }); } catch { n = { product_family_key: '(err)', category_label: 'Other', color: '', price: 0, primary_image: '', original_price: null }; }
    const dimArr = [raw.assembledLength, raw.assembledWidth, raw.assembledHeight]
      .map((v: any) => v === '' ? null : v).filter((v: any) => v != null).map((v: any) => Number(v).toFixed(2));
    const key = String(n.product_family_key ?? '');
    // Does this SKU have a variant sibling that is ALREADY live (standardized/sellable)?
    // Siblings = associateProductList entries sharing a >= PREFIX_MIN-char SKU prefix (same rule
    // as syncGigaVariants / familyKeyGenerator). Used to decide whether a fragmented -vg- member
    // can be published standalone (no live sibling) or must merge (has live sibling).
    const assoc = Array.isArray(raw.associateProductList)
      ? (raw.associateProductList as unknown[]).filter((s): s is string => typeof s === 'string').map(s => s.trim()).filter(Boolean)
      : [];
    const hasLiveSibling = assoc.some(s => s !== id && sharedPrefixLen(id, s) >= PREFIX_MIN && (stdSet.has(s) || sellSet.has(s)));
    // Commerce Taxonomy classification (same input mapping as the production adapter).
    const commerce = classifyCommerce({ name: String(n.product_title ?? r.title ?? ''), category: String((n.specifications_json ?? {})['Category'] ?? raw.category ?? ''), categoryLabel: String(n.category_label ?? '') });
    return {
      id, title: String(r.title ?? ''), normTitle: String(n.product_title ?? ''), key, cat: n.category_label ?? 'Other', color: (n.color ?? '').trim(),
      normCost: Number(n.price ?? 0), origPrice: n.original_price ?? null,
      img: !!n.primary_image, imgCount: Array.isArray(raw.imageUrls) ? raw.imageUrls.length : 0,
      dim: dimArr.length === 3 ? dimArr.join('x') : '', drawers: drawers(r.title), doors: doors(r.title),
      // cfg/width sentinels: resolveVariantSplit emits `cfgmissing` / `wmissing` tokens into the
      // key when config or width could not be derived (familyKeyGenerator.ts). Such keys are
      // unstable for future merges, so they must not seed a standalone Fast-Lane card.
      isVg: key.includes('-vg-'), hasLiveSibling,
      cfgMissing: key.includes('-cfgmissing-'), widthMissing: key.endsWith('-wmissing'),
      commerceCanonical: commerce.productType !== NEEDS_REVIEW,
      bucket: '', reasons: [],
    };
  });
  console.log = log;

  // ── Base per-SKU classification — Commerce Taxonomy authority (see baseBucketOf) ───
  // Canonical products are never rejected/held for a legacy HARD_JUNK word or 'Other' legacy label;
  // needs-review products fall back to junk-reject / hold. Variant grouping below is unchanged.
  for (const c of cands) {
    const r = baseBucketOf(c);
    c.bucket = r.bucket;
    if (r.reason) c.reasons.push(r.reason);
  }

  // ── Group CLEAN candidates by family key ──────────────────────────────────
  const byId = new Map(cands.map(c => [c.id, c]));
  const cleanByKey = new Map<string, Cand[]>();
  for (const c of cands) {
    if (c.bucket !== 'CLEAN') continue;
    if (!cleanByKey.has(c.key)) cleanByKey.set(c.key, []);
    cleanByKey.get(c.key)!.push(c);
  }

  let safeVariantFamilies: { key: string; skus: string[]; colors: string[]; cost: number }[] = [];

  for (const [key, members] of cleanByKey) {
    const isVg = key.includes('-vg-');
    if (!isVg) {
      // title-derived key → true singleton(s). Each clean member is SAFE_SINGLETON.
      members.forEach(m => { m.bucket = 'SAFE_SINGLETON'; });
      continue;
    }
    // Supplier-derived variant family. Need ≥2 co-present clean members to evaluate as a family.
    if (members.length < 2) {
      // Fragmented cluster: only one clean co-present member. Split on live-sibling presence:
      //  - NO live sibling AND fully-resolved key (real config + real width) → publishing it creates
      //    a brand-new card and touches no existing live SKU. Safe as a standalone single-color card:
      //    it seeds a STABLE family key, so any sibling imported later computes the same key and
      //    auto-groups. Promote to SAFE_SINGLETON so it flows through the unchanged apply runner.
      //  - width unresolved (wmissing sentinel) → we do not know how big the product is. That is a
      //    data gap about THIS product, not about its siblings; keep HOLD_PHASE2.
      //  - HAS live sibling → a sibling is already ON SALE, so publishing this one standalone would
      //    put a second card next to it. Must go through the merge path (mergeGigaVariantFamily);
      //    keep HOLD_PHASE2.
      //  - otherwise (incl. cfgMissing) → release as a standalone single-color card.
      //
      //    BUSINESS RULE (approved 2026-08-09): a Pickup favorite IS the decision to sell that SKU.
      //    Siblings the operator did NOT favorite are not for sale today, so they must never be a
      //    prerequisite — we do not require favoriting a whole supplier family to publish one item.
      //    This deliberately replaces the previous `cfgmissing_fragmented` hold, which blocked
      //    today's sale to protect a hypothetical future merge. That merge concern is real but is
      //    handled where it belongs: mergeGigaVariantFamily joins a later sibling into the live
      //    family. Read-only comparison over the full catalogue measured the effect at exactly
      //    +27 SAFE_SINGLETON, with SAFE_CLEAN_COLOR_VARIANT and HOLD_PRICE unchanged.
      members.forEach(m => {
        const v = fragmentedVerdict({
          hasLiveSibling: m.hasLiveSibling,
          widthMissing: m.widthMissing,
          cfgMissing: m.cfgMissing,
          noConfigAxis: NO_CONFIG_AXIS_CATS.has(m.cat.toLowerCase()),
        });
        m.bucket = v.bucket;
        m.reasons.push(v.reason);
      });
      continue;
    }
    const cats = new Set(members.map(m => m.cat));
    const dims = new Set(members.map(m => m.dim).filter(Boolean));
    const draw = new Set(members.map(m => m.drawers).filter(v => v != null));
    const door = new Set(members.map(m => m.doors).filter(v => v != null));
    const colors = members.map(m => m.color.toLowerCase()).filter(Boolean);
    const costs = new Set(members.map(m => m.normCost));
    const dupColor = colors.length !== new Set(colors).size || colors.length !== members.length;
    const sameConfig = cats.size === 1 && dims.size <= 1 && draw.size <= 1 && door.size <= 1;

    const minCost = Math.min(...costs), maxCost = Math.max(...costs);
    const costWithinTol = (maxCost - minCost) <= COST_TOL_ABS || (minCost > 0 && (maxCost - minCost) / minCost <= COST_TOL_PCT);

    if (dupColor || !sameConfig) {
      members.forEach(m => { m.bucket = 'HOLD_PHASE2'; m.reasons.push(dupColor ? 'duplicate_color' : 'config_mismatch'); });
    } else if (costs.size > 1 && !costWithinTol) {
      members.forEach(m => { m.bucket = 'HOLD_PRICE'; m.reasons.push('per_color_cost_mismatch'); });
    } else {
      // Same cost, or within the rounding-noise tolerance → release. Report the higher cost so any
      // downstream single-price-per-card stays margin-safe (pricing itself is unchanged, per-SKU).
      members.forEach(m => { m.bucket = 'SAFE_CLEAN_COLOR_VARIANT'; if (costs.size > 1) m.reasons.push('cost_within_tolerance'); });
      safeVariantFamilies.push({ key, skus: members.map(m => m.id).sort(), colors: members.map(m => m.color), cost: maxCost });
    }
  }

  // ── Current-stock gate (live GIGA probe; mirrors runGigaAutoPublish stage 7) ──
  // Demote would-be-safe SKUs with no current GIGA stock to HOLD_INVENTORY so they never enter
  // proposed_batch (the runner would otherwise hold them at 'inventory' on every cycle). Families
  // are whole-or-nothing: if any member is out of stock the whole family is held (no partial card).
  // Without GIGA creds the probe is skipped and the runner remains the authoritative stock gate.
  let stockProbeNote = '';
  const safeIdsForStock = cands.filter(c => c.bucket === 'SAFE_SINGLETON' || c.bucket === 'SAFE_CLEAN_COLOR_VARIANT').map(c => c.id);
  if (safeIdsForStock.length && gigaReady()) {
    try {
      const qty = await gigaQuantity(safeIdsForStock);
      const inStock = (s: string) => (qty.get(s) ?? 0) > 0;
      for (const c of cands) {
        if (c.bucket === 'SAFE_SINGLETON' && !inStock(c.id)) { c.bucket = 'HOLD_INVENTORY'; c.reasons.push('no_current_stock'); }
      }
      for (const f of safeVariantFamilies) {
        if (!f.skus.every(inStock)) for (const s of f.skus) {
          const c = byId.get(s); if (c && c.bucket === 'SAFE_CLEAN_COLOR_VARIANT') { c.bucket = 'HOLD_INVENTORY'; c.reasons.push('no_current_stock'); }
        }
      }
      safeVariantFamilies = safeVariantFamilies.filter(f => f.skus.every(s => byId.get(s)?.bucket === 'SAFE_CLEAN_COLOR_VARIANT'));
    } catch (e) { stockProbeNote = `stock_probe_failed:${e instanceof Error ? e.message : 'err'}(runner remains gate)`; }
  } else if (safeIdsForStock.length) {
    stockProbeNote = 'stock_not_probed:no_giga_creds(runner remains gate)';
  }

  // ── Tally ──────────────────────────────────────────────────────────────────
  const tally = (b: string) => cands.filter(c => c.bucket === b).length;
  const safeSingletons = cands.filter(c => c.bucket === 'SAFE_SINGLETON');
  const safeVariantSkus = cands.filter(c => c.bucket === 'SAFE_CLEAN_COLOR_VARIANT');

  // ── Propose first safe batch up to MAX_SKUS ───────────────────────────────
  // Strategy: variant families FIRST (up to MAX_FAMILIES, whole-family only — never
  // split a family across the cap), then fill remaining SKU capacity with singletons.
  const MAX_FAMILIES = 5;
  const batch: string[] = [];
  let familiesPicked = 0;
  for (const f of safeVariantFamilies) {
    if (familiesPicked >= MAX_FAMILIES) break;
    if (batch.length + f.skus.length > MAX_SKUS) continue; // whole-family only; skip if it won't fit
    batch.push(...f.skus); familiesPicked++;
  }
  for (const c of safeSingletons) {
    if (batch.length >= MAX_SKUS) break;
    batch.push(c.id);
  }
  const proposedFamilies = safeVariantFamilies.filter(f => f.skus.every(s => batch.includes(s)));
  // App cards = DISTINCT predicted product_family_key across the batch. This dedupes BOTH
  // supplier-derived -vg- families AND title-derived same-product color pairs among "singletons"
  // (e.g. two color variants sharing computeFamilyKey collapse to one card in the app feed).
  const cards = new Set(batch.map(id => byId.get(id)?.key).filter(Boolean)).size;

  // ── Top risks (compact) ────────────────────────────────────────────────────
  const risks: string[] = [];
  if (tally('HOLD_PHASE2') > 0) risks.push(`phase2:${tally('HOLD_PHASE2')}(dup-color/size-config/fragmented)`);
  if (tally('HOLD_PRICE') > 0) risks.push(`price:${tally('HOLD_PRICE')}(per-color cost differs)`);
  if (tally('HOLD_INVENTORY') > 0) risks.push(`inventory:${tally('HOLD_INVENTORY')}(no current stock)`);
  if (tally('HOLD_QUALITY') > 0) risks.push(`quality:${tally('HOLD_QUALITY')}(brand/marketing/lowprice/other)`);
  if (tally('REJECT') > 0) risks.push(`reject:${tally('REJECT')}(junk/no-image/no-price)`);
  if (stockProbeNote) risks.push(stockProbeNote);

  // ── Write full reports ───────────────────────────────────────────────────
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const generatedNote = 'timestamp omitted (Date.* unavailable in this runtime); stamp externally if needed';
  const fullJson = {
    generated: generatedNote,
    max_skus: MAX_SKUS,
    totals: { supplier_total: supplierTotal, already_standardized: alreadyStandardized, already_sellable: alreadySellable, candidates: cands.length },
    buckets: {
      SAFE_SINGLETON: safeSingletons.length,
      SAFE_CLEAN_COLOR_VARIANT: safeVariantSkus.length,
      SAFE_VARIANT_FAMILIES: safeVariantFamilies.length,
      HOLD_PRICE: tally('HOLD_PRICE'), HOLD_PHASE2: tally('HOLD_PHASE2'),
      HOLD_INVENTORY: tally('HOLD_INVENTORY'),
      HOLD_QUALITY: tally('HOLD_QUALITY'), REJECT: tally('REJECT'),
    },
    stock_probe: stockProbeNote || (gigaReady() ? 'probed' : 'skipped'),
    proposed_batch: { skus: batch, sku_count: batch.length, card_count: cards, families: proposedFamilies },
    safe_variant_families: safeVariantFamilies,
    candidates: cands.map(c => ({ id: c.id, bucket: c.bucket, key: c.key, cat: c.cat, color: c.color, normCost: c.normCost, dim: c.dim, drawers: c.drawers, doors: c.doors, img: c.img, reasons: c.reasons, title: c.title })),
  };
  fs.writeFileSync(REPORT_JSON, JSON.stringify(fullJson, null, 2));

  const md: string[] = [];
  md.push('# GIGA Auto-Publish Plan (read-only)', '');
  md.push(`- max-skus: ${MAX_SKUS}`, `- ${generatedNote}`, '');
  md.push('## Totals', `- supplier_total: ${supplierTotal}`, `- already_standardized: ${alreadyStandardized}`, `- already_sellable: ${alreadySellable}`, `- candidates: ${cands.length}`, '');
  md.push('## Buckets',
    `- SAFE_SINGLETON: ${safeSingletons.length}`,
    `- SAFE_CLEAN_COLOR_VARIANT: ${safeVariantSkus.length} skus / ${safeVariantFamilies.length} families`,
    `- HOLD_PRICE: ${tally('HOLD_PRICE')}`, `- HOLD_PHASE2: ${tally('HOLD_PHASE2')}`,
    `- HOLD_INVENTORY: ${tally('HOLD_INVENTORY')}`,
    `- HOLD_QUALITY: ${tally('HOLD_QUALITY')}`, `- REJECT: ${tally('REJECT')}`, '');
  md.push('## Proposed batch', `- skus (${batch.length}): ${batch.join(',') || '(none)'}`, `- card delta: ${cards}`, '');
  md.push('## Safe variant families');
  for (const f of safeVariantFamilies) md.push(`- ${f.key} [${f.skus.join(', ')}] colors=[${f.colors.join('/')}] cost=$${f.cost}`);
  md.push('', '## All candidates (full)', '', '| SKU | bucket | key | cat | color | cost | dims | reasons | title |', '|---|---|---|---|---|---|---|---|---|');
  for (const c of cands) md.push(`| ${c.id} | ${c.bucket} | ${c.key} | ${c.cat} | ${c.color} | ${c.normCost} | ${c.dim} | ${c.reasons.join(';')} | ${c.title.replace(/\|/g, '/').slice(0, 60)} |`);
  fs.writeFileSync(REPORT_MD, md.join('\n'));

  // ── Output ─────────────────────────────────────────────────────────────────
  const rel = (p: string) => path.relative(process.cwd(), p);
  if (SUMMARY) {
    console.log('GIGA_AUTO_PLAN_SUMMARY');
    console.log(`supplier_total=${supplierTotal}`);
    console.log(`already_standardized=${alreadyStandardized}`);
    console.log(`already_sellable=${alreadySellable}`);
    console.log(`safe_singleton_skus=${safeSingletons.length}`);
    console.log(`safe_variant_families=${safeVariantFamilies.length}`);
    console.log(`safe_variant_skus=${safeVariantSkus.length}`);
    console.log(`hold_price=${tally('HOLD_PRICE')}`);
    console.log(`hold_phase2=${tally('HOLD_PHASE2')}`);
    console.log(`hold_inventory=${tally('HOLD_INVENTORY')}`);
    console.log(`hold_quality=${tally('HOLD_QUALITY')}`);
    console.log(`reject=${tally('REJECT')}`);
    console.log(`stock_probe=${stockProbeNote || (gigaReady() ? 'probed' : 'skipped')}`);
    console.log(`proposed_batch_skus=${batch.length}`);
    console.log(`expected_sellable_delta=${batch.length}`);
    console.log(`expected_app_card_delta=${cards}`);
    console.log(`report_json=${rel(REPORT_JSON)}`);
    console.log(`report_md=${rel(REPORT_MD)}`);
    console.log(`top_risks=${risks.join(' | ') || 'none'}`);
  } else {
    console.log(`[plan] candidates=${cands.length} safe_singleton=${safeSingletons.length} safe_variant_skus=${safeVariantSkus.length} proposed=${batch.length}`);
    console.log(`[plan] reports: ${rel(REPORT_JSON)} , ${rel(REPORT_MD)}`);
  }
  console.log = log;
}

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(e => { console.error('[plan] fatal:', e instanceof Error ? e.message : e); process.exit(1); });
}
