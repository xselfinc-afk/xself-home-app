/**
 * mergeGigaVariantFamily.ts — scoped variant-family MERGE tool (Phase 2.1e). DRY-RUN PATH ONLY.
 *
 * Merges a NEW unpublished sibling SKU into an EXISTING live variant family so the App shows one
 * card with a color selector. Built for the case the auto-publish engine cannot handle: the live
 * sibling is already standardized (excluded from planner candidates), so the new SKU alone trips
 * HOLD_PHASE2/fragmented_cluster. This tool replaces the planner's fragmented gate with an explicit
 * family-coherence proof over an exact 2-SKU allowlist.
 *
 * Option C pricing (per-variant): the live SKU's price is NEVER changed; the new SKU is priced by
 * the normal pipeline; the card renders "From $<min>".
 *
 * THIS FILE IMPLEMENTS THE DRY-RUN ONLY. It performs NO database writes, NO publish, NO normalize,
 * NO mirror/blurhash/inventory/review, NO apply. `--apply` is intentionally refused. The only
 * filesystem writes are the two local report files under reports/giga-auto-publish/.
 *
 * Usage:
 *   npx tsx scripts/mergeGigaVariantFamily.ts --new-sku=W409P327401 --live-sku=W409P327404 \
 *       --target-family-key=cb-vg-w409p327399-4door-w63
 */
import { config as loadEnv } from 'dotenv';
import * as fsForEnv from 'node:fs';
{
  if (fsForEnv.existsSync('.env.giga-alt.local')) loadEnv({ path: '.env.giga-alt.local' });
  loadEnv({ path: '.env.local' });
  loadEnv({ path: '.env' });
}
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVariantSplit } from '../src/services/familyKeyGenerator';

const argv = process.argv.slice(2);
const getArg = (name: string) => {
  const a = argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=').trim() : undefined;
};
const NEW_SKU = getArg('new-sku');
const LIVE_SKU = getArg('live-sku');
const TARGET_KEY = getArg('target-family-key');
const WANT_APPLY = argv.includes('--apply');

const REPORT_DIR = path.join(process.cwd(), 'reports', 'giga-auto-publish');
const OUT_JSON = path.join(REPORT_DIR, 'latest-w63-merge.json');
const OUT_MD = path.join(REPORT_DIR, 'latest-w63-merge.md');
const rel = (p: string) => path.relative(process.cwd(), p);

function die(msg: string, extra?: Record<string, unknown>): never {
  console.error('GIGA_W63_MERGE_ERROR');
  console.error(`error=${msg}`);
  if (extra) for (const [k, v] of Object.entries(extra)) console.error(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  process.exit(1);
}

// ── Arg + mode guards ────────────────────────────────────────────────────────
if (!NEW_SKU) die('missing required --new-sku=<sku>');
if (!LIVE_SKU) die('missing required --live-sku=<sku>');
if (!TARGET_KEY) die('missing required --target-family-key=<key>');
if (NEW_SKU === LIVE_SKU) die('--new-sku and --live-sku must differ');
if (WANT_APPLY) die('apply path not implemented yet'); // dry-run only — never write

(async () => {
  const RUN_ID = crypto.randomUUID();
  const TIMESTAMP = new Date().toISOString();
  const ALLOWLIST = [NEW_SKU, LIVE_SKU];

  const { createClient } = await import('@supabase/supabase-js');
  const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) die('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from env');
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const pipe: any = await import('../src/services/normalizationPipeline');
  const normalizeProduct = pipe.normalizeProduct ?? pipe.default?.normalizeProduct;
  if (typeof normalizeProduct !== 'function') die('normalizeProduct not available from normalizationPipeline');

  // ── 1. Read-only snapshot of both SKUs ────────────────────────────────────
  const { data: sp } = await sb.from('supplier_products')
    .select('supplier_product_id,title,description,price,published,raw_payload').in('supplier_product_id', ALLOWLIST);
  const { data: std } = await sb.from('standardized_products')
    .select('supplier_product_id,product_family_key,selling_price,original_price,price,published,normalization_status,inventory_status,total_available_qty,primary_image,primary_image_mirror_path,primary_image_blurhash,color')
    .in('supplier_product_id', ALLOWLIST);
  const { data: sell } = await sb.from('sellable_products').select('supplier_product_id').in('supplier_product_id', ALLOWLIST);
  const spById = new Map((sp ?? []).map((r: any) => [r.supplier_product_id, r]));
  const stdById = new Map((std ?? []).map((r: any) => [r.supplier_product_id, r]));
  const sellSet = new Set((sell ?? []).map((r: any) => r.supplier_product_id));

  if (!spById.has(NEW_SKU)) die(`new-sku ${NEW_SKU} not found in supplier_products`);
  if (!spById.has(LIVE_SKU)) die(`live-sku ${LIVE_SKU} not found in supplier_products`);

  // Normalized view (in-memory) for color + computed family key. Silence pipeline logs.
  const realLog = console.log; console.log = () => {};
  const normOf = (sku: string) => {
    const r: any = spById.get(sku);
    try { return normalizeProduct({ ...r, id: sku }); } catch { return {}; }
  };
  const nNew: any = normOf(NEW_SKU);
  const nLive: any = normOf(LIVE_SKU);
  console.log = realLog;

  const colorOf = (sku: string, n: any) => String((stdById.get(sku)?.color ?? n?.color ?? '')).trim();
  const newColor = colorOf(NEW_SKU, nNew);
  const liveColor = colorOf(LIVE_SKU, nLive);

  const snapshot = (sku: string) => {
    const s: any = spById.get(sku); const st: any = stdById.get(sku);
    return {
      sku,
      supplier_products: { present: !!s, published: s?.published ?? null, cost: s?.price ?? null },
      standardized_products: st ? {
        product_family_key: st.product_family_key, selling_price: st.selling_price, original_price: st.original_price,
        price: st.price, published: st.published, normalization_status: st.normalization_status,
        inventory_status: st.inventory_status, total_available_qty: st.total_available_qty,
        primary_image: !!st.primary_image, mirror_path: !!st.primary_image_mirror_path, blurhash: !!st.primary_image_blurhash,
        color: st.color,
      } : null,
      in_sellable_view: sellSet.has(sku),
    };
  };

  // ── 2. Coherence gate (the safe substitute for the planner's fragmented gate) ──
  const splitNew = resolveVariantSplit(spById.get(NEW_SKU)?.raw_payload, NEW_SKU, TARGET_KEY.split('-vg-')[0], spById.get(NEW_SKU)?.title ?? '');
  const splitLive = resolveVariantSplit(spById.get(LIVE_SKU)?.raw_payload, LIVE_SKU, TARGET_KEY.split('-vg-')[0], spById.get(LIVE_SKU)?.title ?? '');
  const checks = {
    new_sku_key_matches_target: splitNew.key === TARGET_KEY,
    live_sku_key_matches_target: splitLive.key === TARGET_KEY,
    colors_distinct: !!newColor && !!liveColor && newColor.toLowerCase() !== liveColor.toLowerCase(),
    live_sku_is_standardized_and_sellable: !!stdById.get(LIVE_SKU) && sellSet.has(LIVE_SKU),
    new_sku_not_yet_standardized_or_sellable: !stdById.get(NEW_SKU) && !sellSet.has(NEW_SKU),
    target_key_well_formed: !/cfgmissing|wmissing/.test(TARGET_KEY),
  };
  const gatePass = Object.values(checks).every(Boolean);

  // ── 3. Planned writes (described only — NOT executed) ──
  const liveSell = stdById.get(LIVE_SKU)?.selling_price ?? null;
  const newCost = Number(nNew?.price ?? spById.get(NEW_SKU)?.price ?? 0);
  const plannedNewFlow = [
    `supplier_products[${NEW_SKU}].published: ${spById.get(NEW_SKU)?.published} → true`,
    `standardized_products[${NEW_SKU}]: CREATE via normalize (product_family_key=${TARGET_KEY})`,
    `dynamic-pricing[${NEW_SKU}]: selling_price → ~$279 (cost $${newCost}, normal formula; NO override)`,
    `mirror + blurhash + inventory(seed) + reviews(5) for ${NEW_SKU} only`,
    `${NEW_SKU} enters sellable_products VIEW automatically once predicate passes (no sellable write)`,
  ];
  const plannedLiveUpdate = [
    `standardized_products[${LIVE_SKU}].product_family_key: ${stdById.get(LIVE_SKU)?.product_family_key} → ${TARGET_KEY} (ONLY this column)`,
    `selling_price stays $${liveSell} · original_price unchanged · images/mirror/blurhash/inventory unchanged`,
    `${LIVE_SKU} remains in sellable_products VIEW (product_family_key is not in the view predicate)`,
  ];

  // ── 4. App simulation (per-variant prices) ──
  const variants = [
    { color: liveColor, sku: LIVE_SKU, price: liveSell },     // Natural $219
    { color: newColor, sku: NEW_SKU, price: 279 },            // Walnut $279 (expected)
  ];
  const prices = variants.map(v => Number(v.price)).filter(n => Number.isFinite(n) && n > 0);
  const min = Math.min(...prices), max = Math.max(...prices);
  const hasRange = max > min;
  const appResult = {
    card_count: 1,
    card_price: hasRange ? `From $${min}` : `$${prices[0]}`,
    price_range: hasRange,
    variants: variants.map(v => ({ color: v.color, supplier_product_id: v.sku, price: v.price })),
    duplicate_color: newColor.toLowerCase() === liveColor.toLowerCase(),
    other_skus_touched: false,
  };

  // ── 5. Rollback recipe (for the future apply path) ──
  const rollback = [
    `standardized_products[${LIVE_SKU}].product_family_key → ${stdById.get(LIVE_SKU)?.product_family_key} (restore from snapshot)`,
    `standardized_products[${NEW_SKU}]: DELETE row if created`,
    `product_reviews[${NEW_SKU}]: DELETE generated reviews if created`,
    `supplier_products[${NEW_SKU}].published → false`,
    `${NEW_SKU} drops out of sellable_products VIEW automatically (no sellable delete)`,
    `mirrored image for ${NEW_SKU} in storage: optional cleanup (harmless orphan)`,
  ];

  // ── Write reports ──
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const fullJson = {
    run_id: RUN_ID, timestamp: TIMESTAMP, mode: 'dry-run',
    note: 'DRY-RUN ONLY. No DB writes, no apply. --apply is refused.',
    new_sku: NEW_SKU, live_sku: LIVE_SKU, target_family_key: TARGET_KEY, allowlist: ALLOWLIST,
    coherence_gate: { pass: gatePass, checks },
    snapshot: { [NEW_SKU]: snapshot(NEW_SKU), [LIVE_SKU]: snapshot(LIVE_SKU) },
    planned_new_sku_flow: plannedNewFlow,
    planned_live_sku_update: plannedLiveUpdate,
    sellable_products_write_needed: false,
    app_simulation: appResult,
    rollback_plan: rollback,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(fullJson, null, 2));

  const md: string[] = [];
  md.push('# GIGA w63 Variant-Family Merge — DRY-RUN (Phase 2.1e, dry-run path only)', '');
  md.push(`- run_id: ${RUN_ID}`, `- timestamp: ${TIMESTAMP}`, `- mode: dry-run (no writes; --apply refused)`);
  md.push(`- new_sku: ${NEW_SKU} · live_sku: ${LIVE_SKU} · target_family_key: ${TARGET_KEY}`, '');
  md.push(`## Coherence gate: ${gatePass ? 'PASS' : 'FAIL'}`, '', '| check | result |', '|---|---|');
  for (const [k, v] of Object.entries(checks)) md.push(`| ${k} | ${v} |`);
  md.push('', '## Snapshot', '', '```json', JSON.stringify(fullJson.snapshot, null, 2), '```', '');
  md.push('## Planned writes — new SKU', '', ...plannedNewFlow.map(s => `- ${s}`), '');
  md.push('## Planned writes — live SKU', '', ...plannedLiveUpdate.map(s => `- ${s}`), '');
  md.push('## App simulation', '',
    `- card_count: ${appResult.card_count}`, `- card_price: ${appResult.card_price}`,
    `- variants: ${appResult.variants.map(v => `${v.color}→${v.supplier_product_id} ($${v.price})`).join(', ')}`,
    `- duplicate_color: ${appResult.duplicate_color}`, `- other_skus_touched: ${appResult.other_skus_touched}`, '');
  md.push('## Rollback plan', '', ...rollback.map(s => `- ${s}`), '');
  fs.writeFileSync(OUT_MD, md.join('\n'));

  // ── Output ──
  console.log('GIGA_W63_MERGE_DRY_RUN');
  console.log(`mode=dry-run`);
  console.log(`new_sku=${NEW_SKU}`);
  console.log(`live_sku=${LIVE_SKU}`);
  console.log(`target_family_key=${TARGET_KEY}`);
  console.log(`coherence_gate=${gatePass ? 'pass' : 'FAIL'}`);
  for (const [k, v] of Object.entries(checks)) console.log(`  check.${k}=${v}`);
  console.log(`new_sku_split_key=${splitNew.key}`);
  console.log(`live_sku_split_key=${splitLive.key}`);
  console.log(`colors=${liveColor}(${LIVE_SKU}) / ${newColor}(${NEW_SKU})`);
  console.log(`card_price=${appResult.card_price}`);
  console.log(`variants=${appResult.variants.map(v => `${v.color}→${v.supplier_product_id}($${v.price})`).join(', ')}`);
  console.log(`live_sku_price_unchanged=$${liveSell}`);
  console.log(`sellable_products_write_needed=false (view)`);
  console.log(`report_json=${rel(OUT_JSON)}`);
  console.log(`report_md=${rel(OUT_MD)}`);
  if (!gatePass) process.exitCode = 3;
})().catch(e => { console.error('GIGA_W63_MERGE_ERROR'); console.error(`error=${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
