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
loadEnv({ path: '.env.local' }); loadEnv({ path: '.env' });
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── CLI ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const SUMMARY = argv.includes('--summary');
const maxArg = argv.find(a => a.startsWith('--max-skus='));
const MAX_SKUS = maxArg ? Math.max(1, parseInt(maxArg.split('=')[1], 10) || 50) : 50;

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

const sharedPrefixLen = (a: string, b: string) => { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a[i] === b[i]) i++; return i; };
const drawers = (t: string) => { const m = String(t ?? '').match(/(\d+)\s*[- ]?drawers?/i); return m ? +m[1] : null; };
const doors = (t: string) => { const m = String(t ?? '').match(/(\d+)\s*[- ]?doors?/i); return m ? +m[1] : null; };

type Cand = {
  id: string; title: string; key: string; cat: string; color: string;
  normCost: number; origPrice: number | null; img: boolean; imgCount: number;
  dim: string; drawers: number | null; doors: number | null;
  isVg: boolean; bucket: string; reasons: string[];
};

(async () => {
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
  const candidates = supplier.filter(r => !stdSet.has(r.supplier_product_id));

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
    return {
      id, title: String(r.title ?? ''), key, cat: n.category_label ?? 'Other', color: (n.color ?? '').trim(),
      normCost: Number(n.price ?? 0), origPrice: n.original_price ?? null,
      img: !!n.primary_image, imgCount: Array.isArray(raw.imageUrls) ? raw.imageUrls.length : 0,
      dim: dimArr.length === 3 ? dimArr.join('x') : '', drawers: drawers(r.title), doors: doors(r.title),
      isVg: key.includes('-vg-'), bucket: '', reasons: [],
    };
  });
  console.log = log;

  // ── Base per-SKU quality classification (REJECT / HOLD_QUALITY / clean) ───
  for (const c of cands) {
    if (!c.img) { c.bucket = 'REJECT'; c.reasons.push('no_image'); continue; }
    if (!(c.normCost > 0)) { c.bucket = 'REJECT'; c.reasons.push('no_price'); continue; }
    if (HARD_JUNK.test(c.title)) { c.bucket = 'REJECT'; c.reasons.push('junk_category'); continue; }
    if (BRAND_PREFIX.test(c.title)) { c.bucket = 'HOLD_QUALITY'; c.reasons.push('brand_prefix'); continue; }
    if (MARKETING.test(c.title)) { c.bucket = 'HOLD_QUALITY'; c.reasons.push('marketing_text'); continue; }
    if (c.normCost < LOW_PRICE) { c.bucket = 'HOLD_QUALITY'; c.reasons.push('low_price'); continue; }
    if (c.title.length < 12) { c.bucket = 'HOLD_QUALITY'; c.reasons.push('weak_title'); continue; }
    if (c.cat === 'Other') { c.bucket = 'HOLD_QUALITY'; c.reasons.push('uncertain_category'); continue; }
    c.bucket = 'CLEAN'; // provisional — refined by grouping below
  }

  // ── Group CLEAN candidates by family key ──────────────────────────────────
  const byId = new Map(cands.map(c => [c.id, c]));
  const cleanByKey = new Map<string, Cand[]>();
  for (const c of cands) {
    if (c.bucket !== 'CLEAN') continue;
    if (!cleanByKey.has(c.key)) cleanByKey.set(c.key, []);
    cleanByKey.get(c.key)!.push(c);
  }

  const safeVariantFamilies: { key: string; skus: string[]; colors: string[]; cost: number }[] = [];

  for (const [key, members] of cleanByKey) {
    const isVg = key.includes('-vg-');
    if (!isVg) {
      // title-derived key → true singleton(s). Each clean member is SAFE_SINGLETON.
      members.forEach(m => { m.bucket = 'SAFE_SINGLETON'; });
      continue;
    }
    // Supplier-derived variant family. Need ≥2 co-present clean members to evaluate as a family.
    if (members.length < 2) {
      // Fragmented cluster: its siblings are not co-present (held / already live / not candidates).
      members.forEach(m => { m.bucket = 'HOLD_PHASE2'; m.reasons.push('fragmented_cluster'); });
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

    if (dupColor || !sameConfig) {
      members.forEach(m => { m.bucket = 'HOLD_PHASE2'; m.reasons.push(dupColor ? 'duplicate_color' : 'config_mismatch'); });
    } else if (costs.size > 1) {
      members.forEach(m => { m.bucket = 'HOLD_PRICE'; m.reasons.push('per_color_cost_mismatch'); });
    } else {
      members.forEach(m => { m.bucket = 'SAFE_CLEAN_COLOR_VARIANT'; });
      safeVariantFamilies.push({ key, skus: members.map(m => m.id).sort(), colors: members.map(m => m.color), cost: [...costs][0] });
    }
  }

  // ── Tally ──────────────────────────────────────────────────────────────────
  const tally = (b: string) => cands.filter(c => c.bucket === b).length;
  const safeSingletons = cands.filter(c => c.bucket === 'SAFE_SINGLETON');
  const safeVariantSkus = cands.filter(c => c.bucket === 'SAFE_CLEAN_COLOR_VARIANT');

  // ── Propose first safe batch up to MAX_SKUS ───────────────────────────────
  // Strategy: variant families FIRST (up to MAX_FAMILIES, whole-family only — never
  // split a family across the cap), then fill remaining SKU capacity with singletons.
  // Card accounting: each whole variant family = 1 card; each singleton SKU = 1 card.
  const MAX_FAMILIES = 5;
  const batch: string[] = [];
  let cards = 0;
  let familiesPicked = 0;
  for (const f of safeVariantFamilies) {
    if (familiesPicked >= MAX_FAMILIES) break;
    if (batch.length + f.skus.length > MAX_SKUS) continue; // whole-family only; skip if it won't fit
    batch.push(...f.skus); cards++; familiesPicked++;       // family = 1 card
  }
  for (const c of safeSingletons) {
    if (batch.length >= MAX_SKUS) break;
    batch.push(c.id); cards++;                              // singleton = 1 card
  }
  const proposedFamilies = safeVariantFamilies.filter(f => f.skus.every(s => batch.includes(s)));

  // ── Top risks (compact) ────────────────────────────────────────────────────
  const risks: string[] = [];
  if (tally('HOLD_PHASE2') > 0) risks.push(`phase2:${tally('HOLD_PHASE2')}(dup-color/size-config/fragmented)`);
  if (tally('HOLD_PRICE') > 0) risks.push(`price:${tally('HOLD_PRICE')}(per-color cost differs)`);
  if (tally('HOLD_QUALITY') > 0) risks.push(`quality:${tally('HOLD_QUALITY')}(brand/marketing/lowprice/other)`);
  if (tally('REJECT') > 0) risks.push(`reject:${tally('REJECT')}(junk/no-image/no-price)`);

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
      HOLD_QUALITY: tally('HOLD_QUALITY'), REJECT: tally('REJECT'),
    },
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
    console.log(`hold_quality=${tally('HOLD_QUALITY')}`);
    console.log(`reject=${tally('REJECT')}`);
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
})().catch(e => { console.error('[plan] fatal:', e instanceof Error ? e.message : e); process.exit(1); });
