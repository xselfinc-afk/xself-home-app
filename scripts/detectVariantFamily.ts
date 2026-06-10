/**
 * detectVariantFamily.ts — Phase 2.2 READ-ONLY variant-family detector.
 *
 * For ONE supplier variant family (default: cb-vg-w409p327399), derives per-SKU variant attributes
 * (color, width, dimensions, door/drawer config, supplier cost, proposed selling price, proposed
 * display label, proposed variant_group_key, proposed primary_variant) and recommends a grouping
 * model: (A) one multi-axis card (color × width) or (B) split into cards by width/config.
 *
 * Sources, in priority order, per SKU:
 *   1. standardized_products row (authoritative for already-live SKUs)
 *   2. normalizeProduct() over the supplier_products raw row (for unpublished candidates)
 *   3. GIGA detail + price API (for SKUs not yet in supplier_products, e.g. the group root)
 *
 * Performs NO database writes, NO publish, NO apply, NO image/blurhash/inventory/review work.
 * The only filesystem writes are the two local report files under reports/giga-auto-publish/.
 *
 * Usage:
 *   npx tsx scripts/detectVariantFamily.ts
 *   npx tsx scripts/detectVariantFamily.ts --skus=W409P327399,W409P327401,... --family-key=cb-vg-w409p327399
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

const SIM_JSON = 'reports/giga-auto-publish/latest-variant-family-split-sim.json';
const SIM_MD = 'reports/giga-auto-publish/latest-variant-family-split-sim.md';

const argv = process.argv.slice(2);
const skusArg = argv.find(a => a.startsWith('--skus='));
const familyArg = argv.find(a => a.startsWith('--family-key='));
const FAMILY_KEY = familyArg ? familyArg.split('=')[1] : 'cb-vg-w409p327399';
const FAMILY_SKUS = skusArg
  ? skusArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean)
  : ['W409P327399', 'W409P327401', 'W409P327404', 'W409P327405', 'W409P327406', 'W409P327407'];

const REPORT_DIR = path.join(process.cwd(), 'reports', 'giga-auto-publish');
const OUT_JSON = path.join(REPORT_DIR, 'latest-variant-family-detector.json');
const OUT_MD = path.join(REPORT_DIR, 'latest-variant-family-detector.md');
const rel = (p: string) => path.relative(process.cwd(), p);

// ── dynamic-pricing formula (mirrors runGigaAutoPublish.ts / dynamic-pricing edge fn) ──
const PAYMENT_FEE_RATE = 0.029;
const markup = (c: number) => c <= 50 ? 2.20 : c <= 150 ? 1.80 : c <= 400 ? 1.55 : c <= 800 ? 1.40 : 1.28;
const buffer = (c: number) => c <= 100 ? 20 : c <= 300 ? 30 : c <= 800 ? 50 : 80;
function psychRound(p: number): number {
  if (p < 100) return Math.floor(p) + 0.99;
  if (p < 300) { const d = Math.floor(p / 10) * 10 + 9; return d >= p ? d : d + 10; }
  const f = Math.floor(p / 100) * 100;
  for (const s of [49, 79, 99]) if (f + s >= p) return f + s;
  return f + 149;
}
function predictSelling(cost: number): number {
  if (!(cost > 0)) return 0;
  let base = psychRound((cost * markup(cost) + buffer(cost)) / (1 - PAYMENT_FEE_RATE));
  const floor = cost / 0.75;
  if (base < floor) base = psychRound(floor);
  return base;
}

const doorsOf = (t: string) => { const m = String(t ?? '').match(/(\d+)\s*[- ]?doors?/i); return m ? +m[1] : null; };
const drawersOf = (t: string) => { const m = String(t ?? '').match(/(\d+)\s*[- ]?drawers?/i); return m ? +m[1] : null; };

function die(msg: string): never { console.error('VARIANT_DETECTOR_ERROR'); console.error(`error=${msg}`); process.exit(1); }

type Row = {
  sku: string;
  source: 'standardized' | 'supplier_normalized' | 'giga_api' | 'unavailable';
  published: boolean | null;
  in_standardized: boolean;
  in_sellable: boolean;
  color: string;
  width: number | null;          // assembledLength (the long horizontal axis)
  dimensions: string;            // L x W x H
  doors: number | null;
  drawers: number | null;
  config_label: string;
  supplier_cost: number;
  selling_price: number | null;  // existing (std) or proposed (predictSelling)
  selling_price_source: 'standardized' | 'proposed' | 'none';
  has_image: boolean;
  title: string;
};

(async () => {
  const RUN_ID = crypto.randomUUID();
  const TIMESTAMP = new Date().toISOString();

  const { createClient } = await import('@supabase/supabase-js');
  const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) die('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const pipe = await import('../src/services/normalizationPipeline');
  const normalizeProduct = (pipe as any).normalizeProduct;

  // ── Load DB state for the family SKUs (read-only) ──
  const { data: spRows } = await sb.from('supplier_products')
    .select('supplier_product_id,title,description,price,published,raw_payload').in('supplier_product_id', FAMILY_SKUS);
  const { data: stdRows } = await sb.from('standardized_products')
    .select('supplier_product_id,color,dimensions,price,selling_price,original_price,published,product_title,primary_image,product_family_key').in('supplier_product_id', FAMILY_SKUS);
  const { data: sellRows } = await sb.from('sellable_products').select('supplier_product_id').in('supplier_product_id', FAMILY_SKUS);
  const spById = new Map((spRows ?? []).map((r: any) => [r.supplier_product_id, r]));
  const stdById = new Map((stdRows ?? []).map((r: any) => [r.supplier_product_id, r]));
  const sellSet = new Set((sellRows ?? []).map((r: any) => r.supplier_product_id));

  // ── For SKUs absent from supplier_products, fetch GIGA detail + price (read-only) ──
  const missing = FAMILY_SKUS.filter(s => !spById.has(s) && !stdById.has(s));
  const gigaDetail = new Map<string, any>(), gigaPrice = new Map<string, any>();
  if (missing.length) {
    const realLog = console.log; console.log = () => {};
    try {
      const giga = await import('../src/services/gigaApiClient');
      const d = await (giga as any).fetchProductDetails(missing);
      const dArr: any[] = d?.data?.records ?? d?.data?.list ?? (Array.isArray(d?.data) ? d.data : []);
      for (const it of dArr) if (it?.sku) gigaDetail.set(String(it.sku), it);
      const p = await (giga as any).fetchProductPrices(missing);
      const pArr: any[] = p?.data?.records ?? p?.data?.list ?? (Array.isArray(p?.data) ? p.data : []);
      for (const it of pArr) if (it?.sku) gigaPrice.set(String(it.sku), it);
    } catch { /* report unavailable below */ }
    finally { console.log = realLog; }
  }

  const widthOf = (raw: any, dims: string): number | null => {
    const al = Number(raw?.assembledLength);
    if (Number.isFinite(al) && al > 0) return al;
    const m = String(dims ?? '').match(/([\d.]+)/);
    return m ? Number(m[1]) : null;
  };
  const dimStr = (raw: any): string => {
    const a = [raw?.assembledLength, raw?.assembledWidth, raw?.assembledHeight]
      .map((v: any) => (v === '' || v == null) ? null : Number(v)).filter((v: any) => v != null).map((v: any) => v.toFixed(2));
    return a.length === 3 ? a.join('x') : '';
  };

  // ── Build per-SKU rows ──
  const rows: Row[] = FAMILY_SKUS.map(sku => {
    const std = stdById.get(sku), sp = spById.get(sku);
    const inStd = !!std, inSell = sellSet.has(sku);

    if (std) {
      const raw = (sp?.raw_payload ?? {}) as any;
      const dims = std.dimensions || dimStr(raw);
      const title = std.product_title || sp?.title || '';
      const cost = Number(sp?.price ?? std.price ?? 0);
      return {
        sku, source: 'standardized', published: std.published ?? sp?.published ?? null,
        in_standardized: true, in_sellable: inSell,
        color: String(std.color ?? '').trim(), width: widthOf(raw, dims), dimensions: dims,
        doors: doorsOf(title), drawers: drawersOf(title), config_label: '',
        supplier_cost: cost, selling_price: std.selling_price != null ? Number(std.selling_price) : null,
        selling_price_source: std.selling_price != null ? 'standardized' : 'none',
        has_image: !!std.primary_image, title,
      };
    }
    if (sp) {
      let n: any = {};
      const realLog = console.log; console.log = () => {};
      try { n = normalizeProduct({ ...sp, id: sku }); } catch { n = {}; } finally { console.log = realLog; }
      const raw = (sp.raw_payload ?? {}) as any;
      const dims = dimStr(raw);
      const cost = Number(n.price ?? sp.price ?? 0);
      return {
        sku, source: 'supplier_normalized', published: sp.published ?? false,
        in_standardized: false, in_sellable: inSell,
        color: String(n.color ?? '').trim(), width: widthOf(raw, dims), dimensions: dims,
        doors: doorsOf(sp.title), drawers: drawersOf(sp.title), config_label: '',
        supplier_cost: cost, selling_price: predictSelling(cost) || null,
        selling_price_source: cost > 0 ? 'proposed' : 'none',
        has_image: !!n.primary_image, title: sp.title ?? '',
      };
    }
    const det = gigaDetail.get(sku);
    if (det) {
      const pr = gigaPrice.get(sku) ?? {};
      const cost = Number(pr.price ?? pr.discountedPrice ?? pr.exclusivePrice ?? det.price ?? 0);
      const dims = dimStr(det);
      const title = String(det.productName ?? det.title ?? '');
      const imgs = det.imageUrls ?? det.images ?? det.imageList ?? [];
      return {
        sku, source: 'giga_api', published: null, in_standardized: false, in_sellable: false,
        color: '', width: widthOf(det, dims), dimensions: dims,
        doors: doorsOf(title), drawers: drawersOf(title), config_label: '',
        supplier_cost: cost, selling_price: predictSelling(cost) || null,
        selling_price_source: cost > 0 ? 'proposed' : 'none',
        has_image: Array.isArray(imgs) ? imgs.length > 0 : !!imgs, title,
      };
    }
    return {
      sku, source: 'unavailable', published: null, in_standardized: false, in_sellable: false,
      color: '', width: null, dimensions: '', doors: null, drawers: null, config_label: '',
      supplier_cost: 0, selling_price: null, selling_price_source: 'none', has_image: false, title: '',
    };
  });

  // ── Derive config_label + display_label + group_key + sort + primary ──
  for (const r of rows) {
    const cfg = r.doors != null ? `${r.doors}-door` : r.drawers != null ? `${r.drawers}-drawer` : '';
    r.config_label = cfg;
  }
  const widthBucket = (w: number | null) => w == null ? 'w?' : `w${Math.round(w)}`;
  const display = (r: Row) => {
    const parts = [r.color || '(no color)'];
    if (r.width != null) parts.push(`${r.width.toFixed(2)}"`);
    if (r.config_label) parts.push(r.config_label);
    return parts.join(' · ');
  };
  // Proposed group keys for the SPLIT model (B): family + config + width bucket.
  const groupKeyOf = (r: Row) => `${FAMILY_KEY}--${r.config_label || 'cfg?'}-${widthBucket(r.width)}`;

  const enriched = rows.map(r => ({
    ...r,
    variant_display_label: display(r),
    variant_group_key_split: groupKeyOf(r),
    width_bucket: widthBucket(r.width),
  }));

  // ── Grouping analysis ──
  const widths = [...new Set(enriched.map(r => r.width).filter((w): w is number => w != null).map(w => Math.round(w)))].sort((a, b) => a - b);
  const colors = enriched.map(r => r.color).filter(Boolean);
  const dupColorOverall = colors.length !== new Set(colors).size;
  const costs = [...new Set(enriched.map(r => r.supplier_cost).filter(c => c > 0))];
  const cats = new Set(enriched.map(r => (stdById.get(r.sku)?.color, r.config_label))); // config consistency proxy

  // Per width-bucket: are colors distinct within the bucket?
  const byBucket = new Map<string, typeof enriched>();
  for (const r of enriched) {
    const b = r.width_bucket;
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b)!.push(r);
  }
  const bucketAnalysis = [...byBucket.entries()].map(([bucket, members]) => {
    const cl = members.map(m => m.color).filter(Boolean);
    const dupInBucket = cl.length !== new Set(cl).size;
    const bcosts = [...new Set(members.map(m => m.supplier_cost).filter(c => c > 0))];
    return { bucket, skus: members.map(m => m.sku), colors: cl, duplicate_color: dupInBucket, distinct_costs: bcosts };
  });

  // Recommendation: split-by-width (B) is clean iff every width bucket has DISTINCT colors.
  const splitClean = bucketAnalysis.every(b => !b.duplicate_color);
  const recommendation = dupColorOverall && splitClean
    ? 'B_split_by_width'
    : (!dupColorOverall && widths.length <= 1 ? 'A_single_card_color_only' : (splitClean ? 'B_split_by_width' : 'HOLD_needs_manual_review'));

  // primary_variant: per resulting card-group, lowest selling_price with an image (matches "from $X").
  const groupField = recommendation === 'B_split_by_width' ? 'variant_group_key_split' : 'product_family_key';
  const cardGroups = new Map<string, typeof enriched>();
  for (const r of enriched) {
    const k = recommendation === 'B_split_by_width' ? r.variant_group_key_split : FAMILY_KEY;
    if (!cardGroups.has(k)) cardGroups.set(k, []);
    cardGroups.get(k)!.push(r);
  }
  const primarySkus = new Set<string>();
  for (const [, members] of cardGroups) {
    const withImg = members.filter(m => m.has_image && m.selling_price != null);
    const pick = (withImg.length ? withImg : members).slice().sort((a, b) => (a.selling_price ?? 1e9) - (b.selling_price ?? 1e9))[0];
    if (pick) primarySkus.add(pick.sku);
  }

  const finalRows = enriched.map(r => ({ ...r, primary_variant: primarySkus.has(r.sku) }));

  // ── Write reports ──
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const fullJson = {
    run_id: RUN_ID, timestamp: TIMESTAMP, family_key: FAMILY_KEY, family_skus: FAMILY_SKUS,
    summary: {
      widths, distinct_widths: widths.length, duplicate_color_overall: dupColorOverall,
      distinct_supplier_costs: costs, recommendation,
    },
    width_bucket_analysis: bucketAnalysis,
    card_groups: [...cardGroups.entries()].map(([k, m]) => ({ group_key: k, skus: m.map(x => x.sku) })),
    group_field_for_recommendation: groupField,
    skus: finalRows,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(fullJson, null, 2));

  const md: string[] = [];
  md.push('# Variant Family Detector (read-only, Phase 2.2)', '');
  md.push(`- run_id: ${RUN_ID}`, `- timestamp: ${TIMESTAMP}`, `- family_key: ${FAMILY_KEY}`, '');
  md.push('## Summary',
    `- distinct widths: ${widths.join('", ') || '(none)'}"`,
    `- duplicate color overall: ${dupColorOverall}`,
    `- distinct supplier costs: ${costs.join(', ')}`,
    `- **recommendation: ${recommendation}**`, '');
  md.push('## Width-bucket analysis', '', '| bucket | skus | colors | dup_color | costs |', '|---|---|---|---|---|');
  for (const b of bucketAnalysis) md.push(`| ${b.bucket} | ${b.skus.join(',')} | ${b.colors.join('/') || '-'} | ${b.duplicate_color} | ${b.distinct_costs.join('/')} |`);
  md.push('', '## Per-SKU', '', '| SKU | src | pub | std | sell | color | width | config | cost | sell$ | (src) | primary | display_label | group_key(split) |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of finalRows) md.push(`| ${r.sku} | ${r.source} | ${r.published} | ${r.in_standardized} | ${r.in_sellable} | ${r.color || '-'} | ${r.width ?? '-'} | ${r.config_label || '-'} | ${r.supplier_cost} | ${r.selling_price ?? '-'} | ${r.selling_price_source} | ${r.primary_variant} | ${r.variant_display_label} | ${r.variant_group_key_split} |`);
  fs.writeFileSync(OUT_MD, md.join('\n'));

  // ── Output ──
  console.log('VARIANT_DETECTOR_SUMMARY');
  console.log(`run_id=${RUN_ID}`);
  console.log(`family_key=${FAMILY_KEY}`);
  console.log(`skus=${FAMILY_SKUS.join(',')}`);
  console.log(`distinct_widths=${widths.join('/')}`);
  console.log(`duplicate_color_overall=${dupColorOverall}`);
  console.log(`distinct_costs=${costs.join('/')}`);
  console.log(`recommendation=${recommendation}`);
  console.log(`card_groups=${[...cardGroups.keys()].length}`);
  for (const r of finalRows) console.log(`sku=${r.sku} src=${r.source} color=${r.color || '-'} width=${r.width ?? '-'} cfg=${r.config_label || '-'} cost=${r.supplier_cost} sell=${r.selling_price ?? '-'} primary=${r.primary_variant} label="${r.variant_display_label}"`);
  console.log(`report_json=${rel(OUT_JSON)}`);
  console.log(`report_md=${rel(OUT_MD)}`);

  // ── Phase 2.1b: simulate the NEW split product_family_key (read-only; no DB writes) ──
  const cc = FAMILY_KEY.split('-vg-')[0];
  const bySkuFinal = new Map(finalRows.map(r => [r.sku, r]));
  const sim = FAMILY_SKUS.map(sku => {
    const sp = spById.get(sku); const det = gigaDetail.get(sku);
    const raw = (sp?.raw_payload ?? det ?? {}) as any;
    const fr = bySkuFinal.get(sku)!;
    const title = String(raw.productName ?? sp?.title ?? fr.title ?? '');
    const available = !!sp || !!det;
    const split = resolveVariantSplit(raw, sku, cc, title);
    return {
      sku, available,
      proposed_family_key: available ? split.key : null,
      config_token: split.configToken, width: split.width, width_token: split.widthToken,
      cfg_missing: available ? split.cfgMissing : false,
      width_missing: available ? split.widthMissing : false,
      color: fr.color, selling_price: fr.selling_price,
      in_standardized: fr.in_standardized, in_sellable: fr.in_sellable,
    };
  });

  // Group by proposed key (only available SKUs) and compute per-group flags.
  const simGroups = new Map<string, typeof sim>();
  for (const r of sim) { if (!r.proposed_family_key) continue; const k = r.proposed_family_key; if (!simGroups.has(k)) simGroups.set(k, []); simGroups.get(k)!.push(r); }
  const groupFlags = [...simGroups.entries()].map(([key, members]) => {
    const cl = members.map(m => m.color).filter(Boolean);
    const widthsInGroup = members.map(m => m.width).filter((w): w is number => w != null);
    const priceList = members.map(m => m.selling_price).filter((p): p is number => p != null);
    return {
      proposed_family_key: key, skus: members.map(m => m.sku), colors: cl,
      duplicate_color_inside_split_group: cl.length !== new Set(cl).size,
      width_collision: widthsInGroup.length > 1 && (Math.max(...widthsInGroup) - Math.min(...widthsInGroup) > 0.6),
      price_range_inside_split_group: priceList.length > 1 && (Math.max(...priceList) !== Math.min(...priceList)),
      live_sibling_reconciliation_needed: members.some(m => m.in_standardized || m.in_sellable) && members.some(m => !m.in_standardized && !m.in_sellable),
    };
  });
  const anyCfgMissing = sim.filter(r => r.cfg_missing).map(r => r.sku);
  const anyWidthMissing = sim.filter(r => r.width_missing).map(r => r.sku);
  const unavailable = sim.filter(r => !r.available).map(r => r.sku);

  fs.mkdirSync(path.dirname(SIM_JSON), { recursive: true });
  fs.writeFileSync(SIM_JSON, JSON.stringify({
    run_id: RUN_ID, timestamp: TIMESTAMP, family_key: FAMILY_KEY, cc,
    note: 'READ-ONLY simulation of the NEW split product_family_key via resolveVariantSplit. No DB writes.',
    flags: { cfg_missing: anyCfgMissing, width_missing: anyWidthMissing, unavailable,
      width_collision: groupFlags.filter(g => g.width_collision).map(g => g.proposed_family_key),
      duplicate_color_inside_split_group: groupFlags.filter(g => g.duplicate_color_inside_split_group).map(g => g.proposed_family_key),
      price_range_inside_split_group: groupFlags.filter(g => g.price_range_inside_split_group).map(g => g.proposed_family_key),
      live_sibling_reconciliation_needed: groupFlags.filter(g => g.live_sibling_reconciliation_needed).map(g => g.proposed_family_key) },
    proposed_groups: groupFlags, skus: sim,
  }, null, 2));

  const sm: string[] = [];
  sm.push('# Variant Family Split Simulation (read-only, Phase 2.1b)', '');
  sm.push(`- run_id: ${RUN_ID}`, `- family_key: ${FAMILY_KEY}`, `- cc: ${cc}`, '');
  sm.push('## Proposed split groups', '', '| proposed_family_key | skus | colors | dup_color | width_collision | price_range | live_reconcile |', '|---|---|---|---|---|---|---|');
  for (const g of groupFlags) sm.push(`| ${g.proposed_family_key} | ${g.skus.join(',')} | ${g.colors.join('/') || '-'} | ${g.duplicate_color_inside_split_group} | ${g.width_collision} | ${g.price_range_inside_split_group} | ${g.live_sibling_reconciliation_needed} |`);
  sm.push('', '## Per-SKU', '', '| SKU | available | proposed_family_key | config | width | cfg_missing | width_missing | color | sell$ | std | sell |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of sim) sm.push(`| ${r.sku} | ${r.available} | ${r.proposed_family_key ?? '(unavailable)'} | ${r.config_token ?? '-'} | ${r.width ?? '-'} | ${r.cfg_missing} | ${r.width_missing} | ${r.color || '-'} | ${r.selling_price ?? '-'} | ${r.in_standardized} | ${r.in_sellable} |`);
  fs.writeFileSync(SIM_MD, sm.join('\n'));

  console.log('VARIANT_SPLIT_SIM');
  for (const g of groupFlags) console.log(`group=${g.proposed_family_key} skus=${g.skus.join(',')} dup_color=${g.duplicate_color_inside_split_group} width_collision=${g.width_collision} price_range=${g.price_range_inside_split_group} live_reconcile=${g.live_sibling_reconciliation_needed}`);
  console.log(`cfg_missing=${anyCfgMissing.join(',') || 'none'}`);
  console.log(`width_missing=${anyWidthMissing.join(',') || 'none'}`);
  console.log(`unavailable=${unavailable.join(',') || 'none'}`);
  console.log(`sim_report_json=${SIM_JSON}`);
  console.log(`sim_report_md=${SIM_MD}`);
})().catch(e => { console.error('VARIANT_DETECTOR_ERROR'); console.error(`error=${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
