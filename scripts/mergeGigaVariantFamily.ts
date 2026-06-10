/**
 * mergeGigaVariantFamily.ts — scoped variant-family MERGE tool (Phase 2.1e).
 *
 * Merges a NEW unpublished sibling SKU into an EXISTING live variant family so the App shows one
 * card with a color selector. Built for the case the auto-publish engine cannot handle: the live
 * sibling is already standardized (excluded from planner candidates), so the new SKU alone trips
 * HOLD_PHASE2/fragmented_cluster. This tool replaces the planner's fragmented gate with an explicit
 * family-coherence proof over an exact 2-SKU allowlist.
 *
 * Option C pricing (per-variant): the live SKU's price is NEVER changed; the new SKU is priced by
 * the normal pipeline (no override); the card renders "From $<min>".
 *
 * MODES:
 *   (default)  DRY-RUN — no DB writes; coherence gate + snapshot preview + planned writes + app sim.
 *   --apply    REAL apply — only after: required args, coherence gate PASS, pre-write snapshot file,
 *              live GIGA stock>0 for the new SKU, and all scope guards. New SKU runs the proven child
 *              stages scoped via ONLY_SKUS (publish→normalize→title→pricing→mirror→blurhash→inventory→
 *              reviews) with per-stage verification + stop-on-failure; the live SKU gets exactly ONE
 *              write (product_family_key). No sellable_products write (it is a VIEW). No auto-rollback
 *              in v1 — the snapshot + rollback recipe make a failed run manually reversible.
 *
 * Hard scope: every write is filtered to the 2 allowlisted SKUs; child scripts get ONLY_SKUS=<new sku>.
 *
 * Usage:
 *   npx tsx scripts/mergeGigaVariantFamily.ts --new-sku=W409P327401 --live-sku=W409P327404 \
 *       --target-family-key=cb-vg-w409p327399-4door-w63            # dry-run
 *   npx tsx scripts/mergeGigaVariantFamily.ts ... --apply                                   # real apply
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
import { spawnSync } from 'node:child_process';
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
const SNAP_FILE = path.join(REPORT_DIR, 'w63-merge-snapshot.json');
const rel = (p: string) => path.relative(process.cwd(), p);

function die(msg: string, extra?: Record<string, unknown>): never {
  console.error('GIGA_W63_MERGE_ERROR');
  console.error(`error=${msg}`);
  if (extra) for (const [k, v] of Object.entries(extra)) console.error(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  process.exit(1);
}

// ── Arg guards (apply + dry-run share these) ─────────────────────────────────
if (!NEW_SKU) die('missing required --new-sku=<sku>');
if (!LIVE_SKU) die('missing required --live-sku=<sku>');
if (!TARGET_KEY) die('missing required --target-family-key=<key>');
if (NEW_SKU === LIVE_SKU) die('--new-sku and --live-sku must differ');

// ── GIGA stock probe (read-only; mirrors runGigaAutoPublish.ts) ──────────────
const GIGA_BASE = process.env.SUPPLIER_API_BASE_URL ?? '';
const GIGA_CID = process.env.SUPPLIER_CLIENT_ID ?? '';
const GIGA_SEC = process.env.SUPPLIER_CLIENT_SECRET ?? '';
const QTY_PATH = '/b2b-overseas-api/v1/buyer/inventory/quantity/v2';
const gigaReady = () => !!(GIGA_BASE && GIGA_CID && GIGA_SEC && /openapi\.gigab2b\.com/.test(GIGA_BASE));
function gigaNonce(n = 10) { const c = 'abcdefghijklmnopqrstuvwxyz0123456789'; let r = ''; for (let i = 0; i < n; i++) r += c[Math.floor(Math.random() * c.length)]; return r; }
function gigaSign(p: string, ts: string, nc: string) {
  const msg = `${GIGA_CID}&${p}&${ts}&${nc}`, key = `${GIGA_CID}&${GIGA_SEC}&${nc}`;
  return Buffer.from(crypto.createHmac('sha256', key).update(msg).digest('hex'), 'utf8').toString('base64');
}
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
  const STD_COLS = 'supplier_product_id,product_family_key,selling_price,original_price,price,published,normalization_status,inventory_status,total_available_qty,primary_image,primary_image_mirror_path,primary_image_blurhash,color,optimized_title';
  async function loadState() {
    const { data: sp } = await sb.from('supplier_products')
      .select('supplier_product_id,title,description,price,published,raw_payload').in('supplier_product_id', ALLOWLIST);
    const { data: std } = await sb.from('standardized_products').select(STD_COLS).in('supplier_product_id', ALLOWLIST);
    const { data: sell } = await sb.from('sellable_products').select('supplier_product_id').in('supplier_product_id', ALLOWLIST);
    return {
      spById: new Map((sp ?? []).map((r: any) => [r.supplier_product_id, r])),
      stdById: new Map((std ?? []).map((r: any) => [r.supplier_product_id, r])),
      sellSet: new Set((sell ?? []).map((r: any) => r.supplier_product_id)),
    };
  }
  let { spById, stdById, sellSet } = await loadState();

  if (!spById.has(NEW_SKU)) die(`new-sku ${NEW_SKU} not found in supplier_products`);
  if (!spById.has(LIVE_SKU)) die(`live-sku ${LIVE_SKU} not found in supplier_products`);

  const realLog = console.log; console.log = () => {};
  const normOf = (sku: string) => { const r: any = spById.get(sku); try { return normalizeProduct({ ...r, id: sku }); } catch { return {}; } };
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
  const cc = TARGET_KEY.split('-vg-')[0];
  const splitNew = resolveVariantSplit(spById.get(NEW_SKU)?.raw_payload, NEW_SKU, cc, spById.get(NEW_SKU)?.title ?? '');
  const splitLive = resolveVariantSplit(spById.get(LIVE_SKU)?.raw_payload, LIVE_SKU, cc, spById.get(LIVE_SKU)?.title ?? '');
  const checks = {
    new_sku_key_matches_target: splitNew.key === TARGET_KEY,
    live_sku_key_matches_target: splitLive.key === TARGET_KEY,
    colors_distinct: !!newColor && !!liveColor && newColor.toLowerCase() !== liveColor.toLowerCase(),
    live_sku_is_standardized_and_sellable: !!stdById.get(LIVE_SKU) && sellSet.has(LIVE_SKU),
    new_sku_not_yet_standardized_or_sellable: !stdById.get(NEW_SKU) && !sellSet.has(NEW_SKU),
    target_key_well_formed: !/cfgmissing|wmissing/.test(TARGET_KEY),
  };
  const gatePass = Object.values(checks).every(Boolean);

  const liveSell = stdById.get(LIVE_SKU)?.selling_price ?? null;
  const liveOrig = stdById.get(LIVE_SKU)?.original_price ?? null;
  const newCost = Number(nNew?.price ?? spById.get(NEW_SKU)?.price ?? 0);

  // App simulation (per-variant prices)
  const buildAppResult = (newPrice: number | null) => {
    const variants = [
      { color: liveColor, sku: LIVE_SKU, price: liveSell },
      { color: newColor, sku: NEW_SKU, price: newPrice },
    ];
    const prices = variants.map(v => Number(v.price)).filter(n => Number.isFinite(n) && n > 0);
    const min = Math.min(...prices), max = Math.max(...prices);
    const hasRange = prices.length > 1 && max > min;
    return {
      card_count: 1,
      card_price: hasRange ? `From $${min}` : `$${prices[0] ?? '?'}`,
      price_range: hasRange,
      variants: variants.map(v => ({ color: v.color, supplier_product_id: v.sku, price: v.price })),
      duplicate_color: newColor.toLowerCase() === liveColor.toLowerCase(),
      other_skus_touched: false,
    };
  };

  const rollback = [
    `standardized_products[${LIVE_SKU}].product_family_key → ${stdById.get(LIVE_SKU)?.product_family_key} (restore from snapshot)`,
    `standardized_products[${NEW_SKU}]: DELETE row if created`,
    `product_reviews[${NEW_SKU}]: DELETE generated reviews if created`,
    `supplier_products[${NEW_SKU}].published → false`,
    `${NEW_SKU} drops out of sellable_products VIEW automatically (no sellable delete)`,
    `mirrored image for ${NEW_SKU} in storage: optional cleanup (harmless orphan)`,
  ];

  // ════════════════════════════════════════════════════════════════════════
  // DRY-RUN PATH (default) — no writes
  // ════════════════════════════════════════════════════════════════════════
  if (!WANT_APPLY) {
    const plannedNewFlow = [
      `supplier_products[${NEW_SKU}].published: ${spById.get(NEW_SKU)?.published} → true`,
      `standardized_products[${NEW_SKU}]: CREATE via normalize (product_family_key=${TARGET_KEY})`,
      `dynamic-pricing[${NEW_SKU}]: selling_price → ~$279 (cost $${newCost}, normal formula; NO override)`,
      `mirror + blurhash + inventory(seed) + reviews(5) for ${NEW_SKU} only`,
      `${NEW_SKU} enters sellable_products VIEW automatically once predicate passes (no sellable write)`,
    ];
    const plannedLiveUpdate = [
      `standardized_products[${LIVE_SKU}].product_family_key: ${stdById.get(LIVE_SKU)?.product_family_key} → ${TARGET_KEY} (ONLY this column)`,
      `selling_price stays $${liveSell} · original_price ($${liveOrig}) unchanged · images/mirror/blurhash/inventory unchanged`,
      `${LIVE_SKU} remains in sellable_products VIEW (product_family_key is not in the view predicate)`,
    ];
    const appResult = buildAppResult(279);

    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const fullJson = {
      run_id: RUN_ID, timestamp: TIMESTAMP, mode: 'dry-run',
      note: 'DRY-RUN. No DB writes. Pass --apply to execute (gated on coherence + stock + snapshot).',
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
    md.push('# GIGA w63 Variant-Family Merge — DRY-RUN (Phase 2.1e)', '');
    md.push(`- run_id: ${RUN_ID}`, `- timestamp: ${TIMESTAMP}`, `- mode: dry-run (no writes)`);
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
    return;
  }

  // ════════════════════════════════════════════════════════════════════════
  // APPLY PATH (real writes) — gated; stop-on-failure; no auto-rollback in v1
  // ════════════════════════════════════════════════════════════════════════
  // Gate 1: coherence MUST pass before ANY write.
  if (!gatePass) die('coherence gate FAILED — refusing apply', checks as any);

  // Gate 2: pre-write snapshot file (byte-exact restore source).
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(SNAP_FILE, JSON.stringify({
    run_id: RUN_ID, timestamp: TIMESTAMP, new_sku: NEW_SKU, live_sku: LIVE_SKU, target_family_key: TARGET_KEY,
    rows: { [NEW_SKU]: snapshot(NEW_SKU), [LIVE_SKU]: snapshot(LIVE_SKU) },
  }, null, 2));

  // Gate 3: live GIGA stock>0 for the new SKU.
  if (!gigaReady()) die('GIGA creds not ready for stock probe — refusing apply');
  let newStock = 0;
  try { newStock = (await gigaQuantity([NEW_SKU])).get(NEW_SKU) ?? 0; }
  catch (e) { die(`GIGA stock probe failed: ${e instanceof Error ? e.message : String(e)} — refusing apply`); }
  if (!(newStock > 0)) die(`new-sku ${NEW_SKU} has no GIGA stock (qty=${newStock}) — refusing apply`);

  const ONLY = NEW_SKU;
  const logBlocks: string[] = [];
  const stageFailures: Record<string, string> = {};
  const results: Record<string, unknown> = { giga_stock: newStock };
  let reachedStage = 'start';

  const spawn = (script: string, extraEnv: Record<string, string> = {}) => {
    const r = spawnSync('npx', ['tsx', script], { env: { ...process.env, ONLY_SKUS: ONLY, ...extraEnv }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    logBlocks.push(`### ${script} (ONLY_SKUS=${ONLY})\nexit=${r.status}\n--- stdout ---\n${(r.stdout ?? '').slice(-4000)}\n--- stderr ---\n${(r.stderr ?? '').slice(-2000)}`);
    return r;
  };
  const stdScoped = async (cols: string, sku: string) => {
    const { data } = await sb.from('standardized_products').select(cols).eq('supplier_product_id', sku);
    return (data?.[0] ?? null) as any;
  };
  const fail = (stage: string, msg: string): never => { stageFailures[stage] = msg; throw new Error(`${stage}:${msg}`); };

  try {
    // Stage 1 — publish (scoped, only this SKU, only if currently false)
    reachedStage = 'publish';
    const { error: pe } = await sb.from('supplier_products').update({ published: true }).eq('supplier_product_id', NEW_SKU).eq('published', false);
    if (pe) fail('publish', pe.message);
    const { data: pub } = await sb.from('supplier_products').select('published').eq('supplier_product_id', NEW_SKU);
    if (!(pub?.[0]?.published === true)) fail('publish', 'not_published_after_update');
    results.published = true;

    // Stage 2 — normalize (scoped). Verifies the new row + the target split key.
    reachedStage = 'normalize';
    if (spawn('scripts/normalizeProducts.ts').status !== 0) fail('normalize', 'script_exit_nonzero');
    const norm = await stdScoped('supplier_product_id,normalization_status,product_family_key', NEW_SKU);
    if (!norm || norm.normalization_status !== 'done') fail('normalize', 'status_not_done');
    if (norm.product_family_key !== TARGET_KEY) fail('normalize', `key_mismatch:${norm.product_family_key}`);
    results.normalized = true;

    // Stage 3 — optimized title (scoped)
    reachedStage = 'title';
    if (spawn('scripts/generateOptimizedTitles.ts').status !== 0) fail('title', 'script_exit_nonzero');
    const titled = await stdScoped('optimized_title', NEW_SKU);
    if (!titled?.optimized_title) fail('title', 'no_optimized_title');
    results.titled = true;

    // Stage 4 — pricing (deployed dynamic-pricing edge fn; only_skus=NEW_SKU). No override.
    reachedStage = 'pricing';
    const KEY = SERVICE_KEY!;
    const priceRes = await fetch(`${(SUPABASE_URL ?? '').replace(/\/+$/, '')}/functions/v1/dynamic-pricing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, apikey: KEY },
      body: JSON.stringify({ only_skus: [NEW_SKU], dry_run: false }),
    });
    if (priceRes.status !== 200) fail('pricing', `http_${priceRes.status}`);
    const priced = await stdScoped('selling_price,original_price,price', NEW_SKU);
    if (priced?.selling_price == null) fail('pricing', 'no_selling_price');
    if (Number(priced.selling_price) <= Number(priced.price)) fail('pricing', `selling<=cost:${priced.selling_price}/${priced.price}`);
    results.selling_price = priced.selling_price;
    results.original_price = priced.original_price;

    // Stage 5 — mirror (scoped)
    reachedStage = 'mirror';
    if (spawn('scripts/mirrorImagesToStorage.ts').status !== 0) fail('mirror', 'script_exit_nonzero');
    const mir = await stdScoped('primary_image_mirror_path', NEW_SKU);
    if (!mir?.primary_image_mirror_path) fail('mirror', 'no_mirror_path');
    results.mirrored = true;

    // Stage 6 — blurhash (scoped; raised timeout + safe concurrency)
    reachedStage = 'blurhash';
    if (spawn('scripts/backfillBlurhash.ts', { FETCH_TIMEOUT_MS: '60000', CONCURRENCY: '2' }).status !== 0) fail('blurhash', 'script_exit_nonzero');
    const bh = await stdScoped('primary_image_blurhash,primary_image_w,primary_image_h,primary_image_aspect', NEW_SKU);
    if (!(bh?.primary_image_blurhash && bh.primary_image_w != null && bh.primary_image_h != null && bh.primary_image_aspect != null)) fail('blurhash', 'incomplete');
    results.blurhashed = true;

    // Stage 7 — inventory (seed only this in-stock SKU; APPLY=1)
    reachedStage = 'inventory';
    if (spawn('scripts/seedPilotInventory.ts', { APPLY: '1' }).status !== 0) fail('inventory', 'seed_exit_nonzero');
    const inv = await stdScoped('inventory_status,total_available_qty', NEW_SKU);
    if (!(inv?.inventory_status === 'in_stock' && (inv.total_available_qty ?? 0) > 0)) fail('inventory', `not_in_stock:${inv?.inventory_status}/${inv?.total_available_qty}`);
    results.inventory_in_stock = true;

    // Stage 8 — reviews (5; only this SKU; real seed)
    reachedStage = 'reviews';
    if (spawn('scripts/seedGeneratedReviews.ts').status !== 0) fail('reviews', 'seed_exit_nonzero');
    const { data: revRows } = await sb.from('product_reviews').select('supplier_product_id').eq('supplier_product_id', NEW_SKU);
    if ((revRows ?? []).length !== 5) fail('reviews', `not_5:${(revRows ?? []).length}`);
    results.reviews_added = (revRows ?? []).length;

    // ── Live SKU re-key — ONLY after the new-SKU path is complete + verified ──
    reachedStage = 'live_rekey';
    const { error: re } = await sb.from('standardized_products').update({ product_family_key: TARGET_KEY }).eq('supplier_product_id', LIVE_SKU);
    if (re) fail('live_rekey', re.message);
    const after = await stdScoped('product_family_key,selling_price,original_price', LIVE_SKU);
    if (after?.product_family_key !== TARGET_KEY) fail('live_rekey', 'key_not_updated');
    if (Number(after?.selling_price) !== Number(liveSell)) fail('live_rekey', `selling_price_changed:${after?.selling_price}`); // must stay $219
    results.live_rekeyed = true;

    reachedStage = 'done';
  } catch (e) {
    logBlocks.push(`### STOPPED at ${reachedStage}\n${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Re-read final state + write apply reports ──
  ({ spById, stdById, sellSet } = await loadState());
  const finalAppResult = buildAppResult(Number(stdById.get(NEW_SKU)?.selling_price ?? NaN) || null);

  const applyJson = {
    run_id: RUN_ID, timestamp: TIMESTAMP, mode: 'apply',
    reached_stage: reachedStage, new_sku: NEW_SKU, live_sku: LIVE_SKU, target_family_key: TARGET_KEY,
    coherence_gate: { pass: gatePass, checks }, giga_stock_new_sku: newStock,
    results, stage_failures: stageFailures,
    final_snapshot: { [NEW_SKU]: snapshot(NEW_SKU), [LIVE_SKU]: snapshot(LIVE_SKU) },
    final_app_simulation: finalAppResult,
    snapshot_file: rel(SNAP_FILE), rollback_plan: rollback, log: logBlocks,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(applyJson, null, 2));
  fs.writeFileSync(OUT_MD, [
    '# GIGA w63 Variant-Family Merge — APPLY', '',
    `- run_id: ${RUN_ID}`, `- reached_stage: ${reachedStage}`,
    `- results: ${JSON.stringify(results)}`, `- stage_failures: ${JSON.stringify(stageFailures)}`,
    `- final card_price: ${finalAppResult.card_price}`, `- snapshot: ${rel(SNAP_FILE)}`,
    '', '## Rollback', '', ...rollback.map(s => `- ${s}`),
    '', '## Stage logs', '', '```', ...logBlocks, '```',
  ].join('\n'));

  console.log('GIGA_W63_MERGE_APPLY');
  console.log(`reached_stage=${reachedStage}`);
  console.log(`giga_stock_new_sku=${newStock}`);
  console.log(`results=${JSON.stringify(results)}`);
  console.log(`stage_failures=${Object.keys(stageFailures).length ? JSON.stringify(stageFailures) : 'none'}`);
  console.log(`final_card_price=${finalAppResult.card_price}`);
  console.log(`snapshot_file=${rel(SNAP_FILE)}`);
  console.log(`report_json=${rel(OUT_JSON)}`);
  console.log(`report_md=${rel(OUT_MD)}`);
  if (reachedStage !== 'done') process.exit(2); // signal incomplete apply
})().catch(e => { console.error('GIGA_W63_MERGE_ERROR'); console.error(`error=${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
