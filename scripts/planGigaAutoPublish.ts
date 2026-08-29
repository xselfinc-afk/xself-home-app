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
 *                             distinct colors (no dup). Per-color cost MAY differ (see below).
 *   HOLD_PRICE                NO LONGER PRODUCED (2026-08-09, approved). Kept in the report schema
 *                             so existing consumers keep working; it now always tallies 0.
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
import { sellerScopeOf, isSequenceFormat } from '../src/services/familyKeyGenerator';

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
// Manual overrides written by the manual-handling loop (onboarding bridge
// 'manual-override'). Shape: { [supplier_product_id]: { action: 'standalone'|'dup_keep'|'skip',
// approved_by, note, at } }. Consumed read-only here; unknown actions are ignored.
const MANUAL_OVERRIDES: Record<string, { action?: string } & Record<string, unknown>> = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(REPORT_DIR, 'manual-overrides.json'), 'utf8')); }
  catch { return {}; }
})();
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

// ── Three-value sibling confirmation (candidate → hard veto → confirm) ────────
// GIGA's associateProductList mixes true variants with cross-sells, and for S-format
// ids the SKU prefix carries no relatedness signal at all — so "looks related" is
// only ever a CANDIDATE. Confirmation compares product facts three-valued:
// compatible / incompatible / unknown, where ONLY incompatible vetoes (unknown is
// never treated as false). Verdicts: none | uncertain (→ manual) | confirmed.
type Fact = 'compatible' | 'incompatible' | 'unknown';
const compareFact = (a: string | number | null, b: string | number | null): Fact =>
  a == null || b == null || a === '' || b === '' ? 'unknown' : (a === b ? 'compatible' : 'incompatible');

/** Dominant product-noun token from a title — the granularity classifyCommerce lacks
 *  (bar cabinet vs pantry cabinet are both "cabinets" there but are different goods). */
const PRODUCT_NOUNS: [RegExp, string][] = [
  [/bar\s+cabinet/i, 'bar-cabinet'], [/wine\s+cabinet/i, 'wine-cabinet'],
  [/pantry\s+cabinet|pantry\b/i, 'pantry-cabinet'], [/file\s+cabinet/i, 'file-cabinet'],
  [/buffet|sideboard/i, 'buffet-sideboard'], [/kitchen\s+island/i, 'kitchen-island'],
  [/bathroom\s+vanity|vanity\b/i, 'vanity'], [/fridge\s+cabinet|coffee\s+bar/i, 'coffee-bar-cabinet'],
  [/tv\s+stand|media\s+console/i, 'tv-stand'], [/nightstand|bedside/i, 'nightstand'],
  [/bookshelf|bookcase/i, 'bookshelf'], [/rocking\s+chair/i, 'rocking-chair'],
  [/office\s+chair|gaming\s+chair|game\s+chair/i, 'office-chair'], [/dining\s+chair/i, 'dining-chair'],
  [/accent\s+chair|armchair|lounge\s+chair/i, 'accent-chair'],
  [/sofa\s+bed|sleeper/i, 'sofa-bed'], [/sectional/i, 'sectional'], [/loveseat/i, 'loveseat'],
  [/sofa|couch/i, 'sofa'], [/bed\s+frame|platform\s+bed|headboard/i, 'bed'],
  [/dresser|chest\s+of\s+drawers/i, 'dresser'], [/wardrobe|armoire/i, 'wardrobe'],
  [/coffee\s+table/i, 'coffee-table'], [/console\s+table/i, 'console-table'],
  [/dining\s+table/i, 'dining-table'], [/desk\b/i, 'desk'], [/cabinet/i, 'cabinet'],
];
const productNoun = (title: string): string | null => {
  for (const [re, tok] of PRODUCT_NOUNS) if (re.test(title)) return tok;
  return null;
};

/** Confirm one candidate pair using both sides' facts. Any incompatible → 'none'
 *  (vetoed); ≥1 strong compatible and zero incompatible → 'confirmed'; otherwise
 *  'uncertain' (a human decides — per the merge-protection rules). */
function confirmSiblingRelation(input: {
  myTitle: string; sibTitle: string;
}): 'confirmed' | 'uncertain' | 'none' {
  // Drawer/door counts, widths and colors are VARIANT AXES — differing there is what
  // makes two rows variants of one family, so they must never veto this relation
  // (the -vg- family key already splits presentation by config+width). The one hard
  // veto at this level is the product noun: a bar cabinet is not a pantry cabinet,
  // whatever GIGA's associate list says.
  const nounFact = compareFact(productNoun(input.myTitle), productNoun(input.sibTitle));
  if (nounFact === 'incompatible') return 'none';
  // unknown ≠ false: an unextractable noun is not evidence either way → a human decides.
  return nounFact === 'compatible' ? 'confirmed' : 'uncertain';
}
const drawers = (t: string) => { const m = String(t ?? '').match(/(\d+)\s*[- ]?drawers?/i); return m ? +m[1] : null; };
const doors = (t: string) => { const m = String(t ?? '').match(/(\d+)\s*[- ]?doors?/i); return m ? +m[1] : null; };

type Cand = {
  id: string; title: string; normTitle: string; key: string; cat: string; color: string;
  normCost: number; origPrice: number | null; img: boolean; imgCount: number;
  dim: string; drawers: number | null; doors: number | null;
  isVg: boolean; hasLiveSibling: boolean; liveSiblingUncertain: boolean; liveSiblingIds: string[]; uncertainSiblingIds: string[]; dupGroupIds?: string[]; overrideApplied?: string; cfgMissing: boolean; widthMissing: boolean; commerceCanonical: boolean; bucket: string; reasons: string[];
  /** 成品尺寸缺失时的备用规格轴（Seats + 件数）；取不到就是 null，此时不猜。 */
  fallbackSpec: string | null;
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
 * 成品尺寸缺失时的备用规格轴：`attributes.Seats` + comboInfo 总件数。
 *
 * 为什么需要它：实测这 20 件沙发的 assembledLength/Width/Height 全是字符串
 * `"Not Applicable"`，裸 length/width/height 全为 null —— 现场调 GIGA detailInfo/v1
 * 复核过，供应商**确实不提供成品尺寸**，不是我们没读到。于是 deriveWidth 必然返回 null，
 * 族键落上 `wmissing`，整批被当成「规格不明」扣留。
 *
 * 但同一份 payload 里另有两个结构化字段，20/20 件齐全，且合起来能唯一确定商品：
 *   attributes.Seats        "2 Seat" / "3 Seat" / "4 Seat"
 *   comboInfo[].qty 之和    2 / 3 / 4 / 5 / 6 件装
 * 实测 18 件 Chenille 按这两项正好还原成 9 个真实商品 × 2 个颜色，颜色零重复，
 * 与完全独立的成本分组结果逐件一致。
 *
 * 【边界】这里用的是**件数**，不是箱子的长宽高。包装箱尺寸绝不能当成品尺寸使用：
 * 这 18 件的最大箱长全部是 31.1 英寸，拿它当宽度会得到清一色的 `w31`，毫无区分度，
 * 还会把箱规当成商品尺寸写进族键。件数是「这件商品由几个包裹构成」这一结构事实，
 * 与商品形态直接相关（2 座 2 件 = Loveseat，4 座 6 件 = U 形），且不冒充任何尺寸。
 *
 * 返回 null 表示这条备用轴对该商品不可用 —— 此时绝不猜，维持人工确认。
 */
export function deriveFallbackSpec(raw: Record<string, unknown> | null | undefined): string | null {
  const attrs = (raw?.attributes ?? null) as Record<string, unknown> | null;
  const seats = typeof attrs?.Seats === 'string' ? attrs.Seats.trim().toLowerCase() : '';
  const combo = Array.isArray(raw?.comboInfo) ? (raw!.comboInfo as Array<Record<string, unknown>>) : null;
  if (!seats || !combo || combo.length === 0) return null;
  let pieces = 0;
  for (const c of combo) {
    const q = Number(c?.qty);
    if (!Number.isFinite(q) || q <= 0) return null;   // 件数不完整就不是可靠的轴
    pieces += q;
  }
  return `${seats}|p${pieces}`;
}

/**
 * 按备用规格轴给一族分组。任何一个成员取不到轴就返回 null —— 半份证据不足以分族。
 */
export function fallbackSpecGroups<T extends { fallbackSpec: string | null }>(members: T[]): T[][] | null {
  if (members.some(m => !m.fallbackSpec)) return null;
  const by = new Map<string, T[]>();
  for (const m of members) {
    const k = m.fallbackSpec!;
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(m);
  }
  return [...by.keys()].sort().map(k => by.get(k)!);
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
  hasLiveSibling: boolean; liveSiblingUncertain?: boolean; widthMissing: boolean; cfgMissing: boolean; noConfigAxis: boolean;
  /**
   * 成品尺寸缺失，但备用规格轴（Seats + 件数）已经确定了这件商品的规格。
   * 缺省 false —— 不传就是改动前的行为，wmissing 照旧扣留。
   */
  specResolved?: boolean;
}): { bucket: string; reason: string } {
  // 在售兄弟的合并保护永远优先，任何 fallback 都不能绕过它。confirmed → 合并保护；
  // uncertain（候选存在但商品事实无法证实同款）→ 人工裁决，绝不自动合并也不自动放行。
  if (c.hasLiveSibling) return { bucket: 'HOLD_PHASE2', reason: 'fragmented_cluster' };
  if (c.liveSiblingUncertain) return { bucket: 'HOLD_PHASE2', reason: 'sibling_uncertain_manual' };
  if (c.widthMissing && c.specResolved) {
    return { bucket: 'SAFE_SINGLETON', reason: 'spec_from_attributes_standalone' };
  }
  if (c.widthMissing) return { bucket: 'HOLD_PHASE2', reason: 'wmissing_fragmented' };
  if (c.cfgMissing) {
    // 「这个品类本来就没有配置轴」与「本该有轴但没解析出来」是两件事，原因码分开记，便于日后
    // 改进解析器时能按 unresolved_axis_standalone 精确定位到哪些商品受影响。
    return { bucket: 'SAFE_SINGLETON', reason: c.noConfigAxis ? 'no_config_axis_standalone' : 'unresolved_axis_standalone' };
  }
  return { bucket: 'SAFE_SINGLETON', reason: 'no_live_sibling_standalone' };
}

/**
 * 尺寸容差。制造与量测误差按 0.5 英寸与 1% 取大者。
 *
 * 实测依据：同款 4 抽屉文件柜的黑白两色量出 14.65 与 14.76 英寸（差 0.11），原来的精确
 * 相等比较把它判成 config_mismatch；而真正被误合并的酒柜是 19.59 对 15.95（差 3.64），
 * 必须继续判为不同。0.5 英寸稳稳落在这两者之间。
 */
const DIM_TOL_ABS = 0.5;
const DIM_TOL_PCT = 0.01;

/**
 * `LxWxH` 字符串 → 三个正数。任何一维不是有限正数就返回 null。
 *
 * 关键：供应商给 ''、'-'、'N/A' 时这个串是 `NaNxNaNxNaN`。它是 truthy，所以原来的
 * `new Set(dims).filter(Boolean).size <= 1` 会因为「三件商品都解析失败、字符串恰好相同」
 * 而认定它们尺寸一致 —— 尺寸完全未知反而成了「规格相同」的证据。这里把它归为未知。
 */
export function parseDim(dim: string): number[] | null {
  const parts = String(dim ?? '').split('x');
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  return nums.every(n => Number.isFinite(n) && n > 0) ? nums : null;
}

/**
 * 一族成员的尺寸能否视为同一规格。两两比较，任一对超出容差即不兼容。
 * 尺寸未知的成员不参与比较 —— 未知不是冲突（与仓库既有的「unknown 不算负面事实」一致）。
 */
export function dimsCompatible(dims: string[]): boolean {
  const parsed = dims.map(parseDim).filter((d): d is number[] => d !== null);
  return parsed.every((a, i) => parsed.slice(i + 1).every(b =>
    a.every((v, k) => Math.abs(v - b[k]) <= Math.max(DIM_TOL_ABS, Math.max(v, b[k]) * DIM_TOL_PCT))));
}

/**
 * 退化族键下的子分组 —— 按采购成本聚类。
 *
 * 正常族键里 config 轴与宽度已经把不同商品分开了，共享族键即同款。带 `cfgmissing` /
 * `wmissing` 的键没有这个保证：实测 13 件 Chenille Cloud 沙发（Loveseat / 3-Seater /
 * 4-Seater / L-Shaped / U-Shaped，成本 $212.5–$515.1）因为规格与尺寸都没解析出来而共享
 * 同一个键，被当成「同款 13 色」，颜色必然重复，整族被 duplicate_color 扣下。
 *
 * 为什么用成本而不用标题：同族标题的结构并不稳定 —— 实测同一款沙发的 7 个颜色里，
 * Coffee 与 Camel 两件根本没有「<颜色> breathable fabric」那一段，按标题分会把真色族拆散。
 * 而同款换色的采购成本一致（该族 7 件全部 $259），不同形态/尺寸的成本必然不同
 * （上面那 13 件有 9 个不同成本，正好对应 9 个真实商品）。
 *
 * 这不违背 2026-08-09「同族各颜色成本可以不同」那条规则：那条规则针对的是**键本身有区分度**
 * 的族（2drawer / 4door），此处只在键已经失去区分度时，把成本当作**唯一还可用的**区分依据。
 * 容差沿用既有的 COST_TOL_ABS / COST_TOL_PCT，避免取整噪声拆散真族。
 */
export function costSubgroups<T extends { normCost: number }>(members: T[]): T[][] {
  const sorted = [...members].sort((a, b) => a.normCost - b.normCost);
  const groups: T[][] = [];
  for (const m of sorted) {
    const prev = groups.at(-1)?.at(-1);
    const tol = prev ? Math.max(COST_TOL_ABS, Math.max(m.normCost, prev.normCost) * COST_TOL_PCT) : 0;
    if (prev && Math.abs(m.normCost - prev.normCost) <= tol) groups.at(-1)!.push(m);
    else groups.push([m]);
  }
  return groups;
}

/**
 * 一组同款成员里，**哪几件**颜色真的撞了。
 *
 * 原来的判定是整族一刀切：`members.forEach(... 'duplicate_color')`，两件撞色会把同族另外
 * 五个颜色唯一的商品一起扣下。这里只返回真正冲突的 id，其余照常评估。
 */
export function duplicateColorIds<T extends { id: string; color: string }>(members: T[]): Set<string> {
  const seen = new Map<string, number>();
  for (const m of members) {
    const c = m.color.trim().toLowerCase();
    if (c) seen.set(c, (seen.get(c) ?? 0) + 1);
  }
  return new Set(members.filter(m => {
    const c = m.color.trim().toLowerCase();
    return c !== '' && (seen.get(c) ?? 0) > 1;
  }).map(m => m.id));
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
  const { data: stdRows } = await sb.from('standardized_products').select('supplier_product_id, product_title, commerce_product_type');
  const { data: sellRows } = await sb.from('sellable_products').select('supplier_product_id');
  const stdSet = new Set((stdRows ?? []).map((r: any) => r.supplier_product_id));
  const sellSet = new Set((sellRows ?? []).map((r: any) => r.supplier_product_id));
  // Live-side facts for sibling CONFIRMATION (three-value evaluation below).
  const stdMeta = new Map<string, { title: string; productType: string | null }>(
    (stdRows ?? []).map((r: any) => [r.supplier_product_id, { title: String(r.product_title ?? ''), productType: r.commerce_product_type ?? null }]),
  );
  // Raw payloads for BOTH sides (every live row also exists in supplier_products).
  const rawById = new Map<string, any>(supplier.map(r => [r.supplier_product_id, (r.raw_payload ?? {}) as any]));
  const titleById = new Map<string, string>(supplier.map(r => [r.supplier_product_id, String(r.title ?? '')]));

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
    // Candidate live siblings → hard supplier-scope gate (sellerCode, never SKU-tail
    // lookalikes) → three-value confirmation on product facts. sharedPrefixLen is no
    // longer a sufficient condition for ANY format; for S-format ids it is not
    // consulted at all (the sequence segment carries no relatedness).
    const myScope = sellerScopeOf(raw, id);
    const sFormat = isSequenceFormat(id, myScope);
    const liveCandidates = assoc.filter(s => s !== id
      && (stdSet.has(s) || sellSet.has(s))
      && myScope != null && s.toUpperCase().startsWith(myScope)
      && (sFormat ? true : sharedPrefixLen(id, s) >= PREFIX_MIN));
    let hasLiveSibling = false; let liveSiblingUncertain = false;
    const liveSiblingIds: string[] = []; const uncertainSiblingIds: string[] = [];
    for (const s of liveCandidates) {
      const verdict = confirmSiblingRelation({
        myTitle: String(r.title ?? ''),
        sibTitle: stdMeta.get(s)?.title || titleById.get(s) || '',
      });
      if (verdict === 'confirmed') { hasLiveSibling = true; liveSiblingIds.push(s); }
      if (verdict === 'uncertain') { liveSiblingUncertain = true; uncertainSiblingIds.push(s); }
    }
    // Manual override (reports/giga-auto-publish/manual-overrides.json,     // by the manual-handling loop (bridge) with an approver on record): 'standalone'
    // clears the SIBLING holds for this SKU — every other gate (junk/quality/image/
    // price/stock/duplicate protections) still applies unchanged.
    let overrideApplied: string | undefined;
    const ov = MANUAL_OVERRIDES[id];
    if (ov?.action === 'standalone' && (hasLiveSibling || liveSiblingUncertain)) {
      hasLiveSibling = false; liveSiblingUncertain = false; overrideApplied = 'standalone';
    }
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
      isVg: key.includes('-vg-'), hasLiveSibling, liveSiblingUncertain, liveSiblingIds, uncertainSiblingIds, overrideApplied, fallbackSpec: deriveFallbackSpec(raw),
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
          // 成品尺寸缺失时，备用规格轴（Seats + 件数）一旦读得出，这件商品的规格就是确定的。
          specResolved: m.fallbackSpec != null,
        });
        m.bucket = v.bucket;
        m.reasons.push(v.reason);
      });
      continue;
    }
    // ── 退化族键的子分组 ────────────────────────────────────────────────────
    // `cfgmissing` / `wmissing` 表示规格轴或宽度没能解析出来。这样的键对「是不是同一件
    // 商品」没有任何区分力，却被下面的族规则当成同款不同色。实测 18 件不同形态的沙发
    // （Loveseat / 3-Seater / 4-Seater / L-Shaped / U-Shaped）因此被并成两族，颜色必然
    // 重复，整族被 duplicate_color 扣下 —— 拦截的是分族错误，不是商品问题。
    const degenerateKey = key.includes('cfgmissing') || key.includes('wmissing');

    // 宽度未知时不评估族关系：不知道商品多大，就不能断言两件是同款换色。逐件按单件路径
    // 处理，与 fragmentedVerdict 对「孤身一件 wmissing」的既有裁决完全一致（仍然扣留，
    // 且 hasLiveSibling 的合并保护优先级不变）。
    //
    // 备用规格轴（2026-08-29 批准）：成品尺寸缺失不再直接扣留。先试 Seats + 件数。
    // 现场调 GIGA detailInfo/v1 复核过，这批商品的 assembledLength/Width/Height 就是
    // 字符串 "Not Applicable"、裸 length/width/height 全为 null —— 供应商确实不提供成品
    // 尺寸，不是我们没读到。但同一份 payload 里 Seats 与 comboInfo 件数齐全，且足以区分。
    let widthMissingUnresolved = false;
    let fallbackGroups: Cand[][] | null = null;
    if (key.includes('wmissing')) {
      fallbackGroups = fallbackSpecGroups(members);
      if (!fallbackGroups) {
        // 备用轴读不出来 —— 不猜，维持人工确认，与改动前完全一致。
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
      widthMissingUnresolved = true;   // 逐组再判：这一组是否真被备用轴分清楚了
    }

    const groups = fallbackGroups ?? (degenerateKey ? costSubgroups(members) : [members]);
    for (const group of groups) {
      // 同一个父键分出多个族时，族键必须各自唯一 —— apply runner 用 key 去重卡片
      // （runGigaAutoPublish.ts 的 passCards），两族共用一个键会被算成同一张卡。
      const groupKey = groups.length > 1 ? `${key}#${group[0].id}` : key;

      const single = (m: Cand) => {
        const v = fragmentedVerdict({
          hasLiveSibling: m.hasLiveSibling,
          widthMissing: m.widthMissing,
          cfgMissing: m.cfgMissing,
          noConfigAxis: NO_CONFIG_AXIS_CATS.has(m.cat.toLowerCase()),
          // 成品尺寸缺失时，备用规格轴（Seats + 件数）一旦读得出，这件商品的规格就是确定的。
          specResolved: m.fallbackSpec != null,
        });
        m.bucket = v.bucket;
        m.reasons.push(v.reason);
      };

      if (group.length < 2) { single(group[0]); continue; }

      // 备用轴分出的组内若还有重复颜色，说明这条轴对这一组不够细。成品尺寸本来就未知，
      // 无法区分「同一件商品出现两次」与「轴太粗把两件商品并在一起」—— 按规则不猜，
      // 整组维持人工确认，且原因仍如实记为尺寸缺失，不冒充 duplicate_color。
      if (widthMissingUnresolved && duplicateColorIds(group).size > 0) {
        group.forEach(m => { m.bucket = 'HOLD_PHASE2'; m.reasons.push('wmissing_fragmented'); });
        continue;
      }

      // ── 只拦真正冲突的 SKU，不再整族连坐 ──────────────────────────────────
      const dupIds = duplicateColorIds(group);
      const noColor = group.filter(m => !m.color.trim());
      noColor.forEach(m => { m.bucket = 'HOLD_PHASE2'; m.reasons.push('missing_color'); });
      group.filter(m => dupIds.has(m.id))
        .forEach(m => {
          if (MANUAL_OVERRIDES[m.id]?.action === 'dup_keep') { m.overrideApplied = 'dup_keep'; return; }
          m.bucket = 'HOLD_PHASE2'; m.reasons.push('duplicate_color');
          m.dupGroupIds = group.filter(g => dupIds.has(g.id)).map(g => g.id);
        });

      const rest = group.filter(m => !dupIds.has(m.id) && m.color.trim());
      if (rest.length === 0) continue;
      if (rest.length === 1) { single(rest[0]); continue; }

      const cats = new Set(rest.map(m => m.cat));
      const draw = new Set(rest.map(m => m.drawers).filter(v => v != null));
      const door = new Set(rest.map(m => m.doors).filter(v => v != null));
      const costs = new Set(rest.map(m => m.normCost));
      // 尺寸改为带容差比较：0.11 英寸的量测差不再算规格不一致，3.64 英寸的真实差仍然算。
      const sameConfig = cats.size === 1 && dimsCompatible(rest.map(m => m.dim)) && draw.size <= 1 && door.size <= 1;

      const minCost = Math.min(...costs), maxCost = Math.max(...costs);
      const costWithinTol = (maxCost - minCost) <= COST_TOL_ABS || (minCost > 0 && (maxCost - minCost) / minCost <= COST_TOL_PCT);

      if (!sameConfig) {
        rest.forEach(m => { m.bucket = 'HOLD_PHASE2'; m.reasons.push('config_mismatch'); });
        continue;
      }

      // BUSINESS RULE (approved 2026-08-09): members of one family MAY carry different supplier
      // cost / selling price / inventory / delivery fee. Cost equality was never a safety property —
      // it was a presentation worry about a single "from $X" card. Every member is still priced
      // independently by Stage 4 from its OWN cost, and a member whose own cost is missing or <= 0
      // is already rejected per-SKU upstream (baseBucketOf → REJECT no_price), so a family can never
      // be formed out of an unpriced SKU. What still holds a family is unchanged: duplicate colors,
      // category/dimension/config mismatch, identity conflicts, and per-SKU pricing failures.
      //
      // The reason code still records whether costs differ, and by how much of a margin, so the
      // effect stays visible in the report: `cost_within_tolerance` (rounding noise) vs
      // `per_color_cost_differs` (a real per-color price difference, now released).
      //
      // `cost: maxCost` below stays REPORT-ONLY — the apply runner reads only { key, skus } from
      // families (runGigaAutoPublish.ts), so per-SKU pricing is untouched by this field.
      rest.forEach(m => {
        m.bucket = 'SAFE_CLEAN_COLOR_VARIANT';
        if (costs.size > 1) m.reasons.push(costWithinTol ? 'cost_within_tolerance' : 'per_color_cost_differs');
      });
      safeVariantFamilies.push({ key: groupKey, skus: rest.map(m => m.id).sort(), colors: rest.map(m => m.color), cost: maxCost });
    }
  }

  // ── Manual skip override (manual-handling loop) ────────────────────────
  // A human decided this SKU should not be onboarded now. It leaves the needs-
  // attention list and never enters proposed_batch; every safety gate above already
  // ran, and un-skipping is just deleting the override entry.
  for (const c of cands) {
    if (MANUAL_OVERRIDES[c.id]?.action === 'skip') {
      c.bucket = 'SKIPPED_MANUAL'; c.reasons = ['manual_skip']; c.overrideApplied = 'skip';
    } else if (c.overrideApplied === 'standalone' && (c.bucket === 'SAFE_SINGLETON' || c.bucket === 'SAFE_CLEAN_COLOR_VARIANT')) {
      // Leave an explicit trace in the plan output whenever the override actually mattered.
      if (!c.reasons.includes('manual_standalone_override')) c.reasons.push('manual_standalone_override');
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
    candidates: cands.map(c => ({ id: c.id, bucket: c.bucket, key: c.key, cat: c.cat, color: c.color, normCost: c.normCost, dim: c.dim, drawers: c.drawers, doors: c.doors, img: c.img, reasons: c.reasons, title: c.title, liveSiblingIds: c.liveSiblingIds, uncertainSiblingIds: c.uncertainSiblingIds, dupGroupIds: c.dupGroupIds ?? null, overrideApplied: c.overrideApplied ?? null })),
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
