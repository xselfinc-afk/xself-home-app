/**
 * runGigaAutoPublish.ts — GIGA auto-publish runner (DRY-RUN simulation + controlled APPLY).
 *
 * Consumes the planner report (reports/giga-auto-publish/latest-plan.json) and operates on the
 * planner's PROPOSED BATCH ONLY. Exactly one mode must be selected:
 *
 *   --dry-run : simulate the 8 stages, write NOTHING to the DB (read-only; live GIGA stock probe only).
 *   --apply   : execute the 8 proven onboarding stages in order, with per-stage verification, stopping
 *               safely on the first failure (NO rollback in v1 — reports exactly which stage succeeded).
 *
 * Safety:
 *   - Neither flag → exit non-zero.  Both flags → exit non-zero.
 *   - APPLY processes only plan.proposed_batch SKUs; refuses if any is not a SAFE bucket.
 *   - Variant families kept whole — a family with any zero-stock member is held (no partial exposure).
 *   - Compact summary to chat when --summary; full stdout/stderr + verification → report files.
 *
 * Report files (gitignored): reports/giga-auto-publish/latest-dry-run.{json,md}
 *                            reports/giga-auto-publish/latest-apply.{json,md}
 *
 * Usage:
 *   npx tsx scripts/runGigaAutoPublish.ts --plan reports/giga-auto-publish/latest-plan.json --dry-run --summary
 *   npx tsx scripts/runGigaAutoPublish.ts --plan reports/giga-auto-publish/latest-plan.json --apply  --summary
 */
(globalThis as { __DEV__?: boolean }).__DEV__ = false;
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.giga-alt.local' });
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const SUMMARY = argv.includes('--summary');
const WANT_DRY = argv.includes('--dry-run');
const WANT_APPLY = argv.includes('--apply');
const planArg = argv.find(a => a.startsWith('--plan='))?.split('=')[1]
  ?? (argv.includes('--plan') ? argv[argv.indexOf('--plan') + 1] : undefined);
const PLAN_FILE = planArg ?? path.join('reports', 'giga-auto-publish', 'latest-plan.json');

const REPORT_DIR = path.join(process.cwd(), 'reports', 'giga-auto-publish');
const DRY_JSON = path.join(REPORT_DIR, 'latest-dry-run.json');
const DRY_MD = path.join(REPORT_DIR, 'latest-dry-run.md');
const APPLY_JSON = path.join(REPORT_DIR, 'latest-apply.json');
const APPLY_MD = path.join(REPORT_DIR, 'latest-apply.md');

// ── Mode guard: exactly one of --dry-run / --apply ──────────────────────────
if (WANT_DRY === WANT_APPLY) {
  console.error('[run] specify EXACTLY ONE of --dry-run or --apply');
  process.exit(1);
}

// ── dynamic-pricing formula (mirrors supabase/functions/dynamic-pricing/index.ts) ──
const PAYMENT_FEE_RATE = 0.029;
const markup = (c: number) => c <= 50 ? 2.20 : c <= 150 ? 1.80 : c <= 400 ? 1.55 : c <= 800 ? 1.40 : 1.28;
const buffer = (c: number) => c <= 100 ? 20 : c <= 300 ? 30 : c <= 800 ? 50 : 80;
// Within-family cost tolerance — MUST mirror planGigaAutoPublish.ts (COST_TOL_ABS / COST_TOL_PCT).
// Clean color families whose per-color cost differs only by rounding noise (≤ $1 OR ≤ 2%) pass;
// larger spreads still hold as within_family_cost_mismatch.
const COST_TOL_ABS = 1;     // dollars
const COST_TOL_PCT = 0.02;  // 2%
const costWithinTol = (costs: number[]) => {
  const minC = Math.min(...costs), maxC = Math.max(...costs);
  return (maxC - minC) <= COST_TOL_ABS || (minC > 0 && (maxC - minC) / minC <= COST_TOL_PCT);
};
function psychRound(p: number): number {
  if (p < 100) return Math.floor(p) + 0.99;
  if (p < 300) { const d = Math.floor(p / 10) * 10 + 9; return d >= p ? d : d + 10; }
  const f = Math.floor(p / 100) * 100;
  for (const s of [49, 79, 99]) if (f + s >= p) return f + s;
  return f + 149;
}
function predictSelling(cost: number): number {
  let base = psychRound((cost * markup(cost) + buffer(cost)) / (1 - PAYMENT_FEE_RATE));
  const floor = cost / 0.75;
  if (base < floor) base = psychRound(floor);
  return base;
}

// ── GIGA HMAC (read-only quantity probe; mirrors seedPilotInventory.ts) ──────
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

const dangling = (t: string) => /,\s*\d+\s*$/.test(t) || /\b(with|and|for|the|of|to)\s*$/i.test(t) || /[-–—,;:|/&]\s*$/.test(t);
const rel = (p: string) => path.relative(process.cwd(), p);

type Unit = { kind: 'family' | 'singleton'; key: string; skus: string[]; reasons: string[]; held: boolean; heldAt: string | null; per: Record<string, any> };

function loadPlan(): { plan: any; planned: string[]; planFamilies: { key: string; skus: string[] }[]; units: Unit[] } {
  if (!fs.existsSync(PLAN_FILE)) { console.error(`[run] plan not found: ${PLAN_FILE} (run planGigaAutoPublish.ts first)`); process.exit(1); }
  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  const planned: string[] = plan?.proposed_batch?.skus ?? [];
  const planFamilies: { key: string; skus: string[] }[] = plan?.proposed_batch?.families ?? plan?.safe_variant_families ?? [];
  if (planned.length === 0) { console.error('[run] plan has no proposed_batch.skus'); process.exit(1); }
  const famInBatch = planFamilies.filter(f => f.skus.every(s => planned.includes(s)));
  const famSkus = new Set(famInBatch.flatMap(f => f.skus));
  const units: Unit[] = [
    ...famInBatch.map(f => ({ kind: 'family' as const, key: f.key, skus: [...f.skus].sort(), reasons: [], held: false, heldAt: null, per: {} as Record<string, any> })),
    ...planned.filter(s => !famSkus.has(s)).map(s => ({ kind: 'singleton' as const, key: s, skus: [s], reasons: [], held: false, heldAt: null, per: {} as Record<string, any> })),
  ];
  return { plan, planned, planFamilies: famInBatch, units };
}

// ────────────────────────────────────────────────────────────────────────────
// DRY-RUN (read-only simulation) — unchanged behavior.
// ────────────────────────────────────────────────────────────────────────────
async function runDryRun() {
  const { plan, planned, units } = loadPlan();
  const { createClient } = await import('@supabase/supabase-js');
  const pipe = await import('../src/services/normalizationPipeline');
  const normalizeProduct = (pipe as any).normalizeProduct;
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  const { data: spRows } = await sb.from('supplier_products')
    .select('supplier_product_id,title,description,price,published,raw_payload').in('supplier_product_id', planned);
  const byId = new Map((spRows ?? []).map((r: any) => [r.supplier_product_id, r]));
  const hold = (u: Unit, stage: string, reason: string) => { u.held = true; u.heldAt = u.heldAt ?? stage; if (!u.reasons.includes(reason)) u.reasons.push(reason); };

  const silence = console.log; console.log = () => {};
  for (const u of units) {
    const costs: number[] = [];
    for (const s of u.skus) {
      const r = byId.get(s);
      if (!r) { hold(u, 'publish', 'missing_supplier_row'); break; }
      let n: any; try { n = normalizeProduct({ ...r, id: s }); } catch { hold(u, 'normalize', 'normalize_error'); break; }
      const cost = Number(n.price ?? 0); const pred = predictSelling(cost); const pt = String(n.product_title ?? '');
      const titleReady = pt.length >= 12;
      const imgReady = !!n.primary_image && /^https?:\/\//.test(String(n.primary_image));
      u.per[s] = { color: n.color, cat: n.category_label, key: n.product_family_key, cost, predSelling: pred, img: imgReady, raw_title_dangling: dangling(pt), qty: null, inStock: null };
      costs.push(cost);
      if (!(cost > 0) || !n.category_label) { hold(u, 'normalize', 'normalize_incomplete'); break; }
      if (!titleReady) { hold(u, 'title', 'title_not_ready'); break; }
      if (pred < cost) { hold(u, 'pricing', 'below_cost'); break; }
      if (!imgReady) { hold(u, 'mirror', 'no_image_source'); break; }
    }
    if (!u.held && u.kind === 'family' && costs.length > 1 && !costWithinTol(costs)) hold(u, 'pricing', 'within_family_cost_mismatch');
  }
  console.log = silence;

  let invLimited = false;
  const survivors = units.filter(u => !u.held);
  const probeSkus = survivors.flatMap(u => u.skus);
  if (probeSkus.length) {
    if (!gigaReady()) { invLimited = true; for (const u of survivors) { u.held = true; u.heldAt = 'inventory'; u.reasons.push('HOLD_RUNNER_LIMITATION:no_giga_creds'); } }
    else {
      try {
        const qty = await gigaQuantity(probeSkus);
        for (const u of survivors) {
          let allStock = true;
          for (const s of u.skus) { const q = qty.get(s) ?? 0; u.per[s].qty = q; u.per[s].inStock = q > 0; if (!(q > 0)) allStock = false; }
          if (!allStock) { u.held = true; u.heldAt = 'inventory'; u.reasons.push('zero_stock'); }
        }
      } catch (e) { invLimited = true; for (const u of survivors) { u.held = true; u.heldAt = 'inventory'; u.reasons.push(`HOLD_RUNNER_LIMITATION:${e instanceof Error ? e.message : 'giga_probe_failed'}`); } }
    }
  }

  const passing = units.filter(u => !u.held);
  const passSkus = passing.flatMap(u => u.skus);
  // App cards = DISTINCT predicted product_family_key among passing SKUs (matches planner fix 6a855baa):
  // dedupes both -vg- families and title-derived color pairs. (u.per[s].key is the per-SKU family key;
  // a singleton unit's own .key is its SKU id, so always read the per-SKU key here.)
  const passCards = new Set(passing.flatMap(u => u.skus.map(s => u.per[s]?.key)).filter(Boolean)).size;
  const heldUnits = units.filter(u => u.held), heldSkus = heldUnits.flatMap(u => u.skus);
  const reasonCounts: Record<string, number> = {}; heldUnits.forEach(u => u.reasons.forEach(r => reasonCounts[r] = (reasonCounts[r] ?? 0) + 1));
  const stageFail: Record<string, number> = {}; heldUnits.forEach(u => { if (u.heldAt) stageFail[u.heldAt] = (stageFail[u.heldAt] ?? 0) + 1; });
  const risks: string[] = []; if (invLimited) risks.push('inventory:runner-limitation(stock not probed)');
  Object.entries(reasonCounts).forEach(([r, n]) => { if (!r.startsWith('HOLD_RUNNER')) risks.push(`${r}:${n}`); });

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const requestedCards = plan?.proposed_batch?.card_count ?? units.length;
  fs.writeFileSync(DRY_JSON, JSON.stringify({
    note: 'DRY-RUN simulation; no DB writes. Stage 7 read-only GIGA stock probe.', plan_file: PLAN_FILE,
    requested: { skus: planned.length, cards: requestedCards },
    result: { dry_run_pass_skus: passSkus.length, dry_run_pass_cards: passCards, hold_skus: heldSkus.length, hold_families: heldUnits.filter(u => u.kind === 'family').length },
    deltas: { sellable: passSkus.length, app_cards: passCards, reviews: passSkus.length * 5 },
    stage_failures: stageFail, hold_reasons: reasonCounts, inventory_limited: invLimited,
    units: units.map(u => ({ kind: u.kind, key: u.key, skus: u.skus, held: u.held, heldAt: u.heldAt, reasons: u.reasons, per: u.per })),
  }, null, 2));
  fs.writeFileSync(DRY_MD, [
    '# GIGA Auto-Publish DRY-RUN', '', `- plan: ${PLAN_FILE}`, '',
    `## Result`, `- requested: ${planned.length} skus / ${requestedCards} cards`,
    `- dry_run_pass: ${passSkus.length} skus / ${passCards} cards`, `- held: ${heldSkus.length} skus`,
    `- deltas: sellable +${passSkus.length}, cards +${passCards}, reviews +${passSkus.length * 5}`, '',
    '## Units', '', '| kind | key | skus | held | heldAt | reasons |', '|---|---|---|---|---|---|',
    ...units.map(u => `| ${u.kind} | ${u.key} | ${u.skus.join(',')} | ${u.held} | ${u.heldAt ?? ''} | ${u.reasons.join(';')} |`),
  ].join('\n'));

  if (SUMMARY) {
    console.log('GIGA_AUTO_RUN_DRY_SUMMARY');
    console.log(`plan_file=${PLAN_FILE}`);
    console.log(`requested_skus=${planned.length}`);
    console.log(`requested_cards=${requestedCards}`);
    console.log(`dry_run_pass_skus=${passSkus.length}`);
    console.log(`dry_run_pass_cards=${passCards}`);
    console.log(`hold_skus=${heldSkus.length}`);
    console.log(`hold_families=${heldUnits.filter(u => u.kind === 'family').length}`);
    console.log(`hold_reasons=${Object.entries(reasonCounts).map(([r, n]) => `${r}:${n}`).join(',') || 'none'}`);
    console.log(`expected_sellable_delta=${passSkus.length}`);
    console.log(`expected_app_card_delta=${passCards}`);
    console.log(`expected_review_delta=${passSkus.length * 5}`);
    console.log(`stage_failures=${Object.entries(stageFail).map(([s, n]) => `${s}:${n}`).join(',') || 'none'}`);
    console.log(`report_json=${rel(DRY_JSON)}`);
    console.log(`report_md=${rel(DRY_MD)}`);
    console.log(`top_risks=${risks.join(' | ') || 'none'}`);
  } else {
    console.log(`[run] dry-run pass=${passSkus.length}/${planned.length} skus; reports: ${rel(DRY_JSON)} , ${rel(DRY_MD)}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// APPLY (controlled, real writes) — executes the proven stages in order.
// ────────────────────────────────────────────────────────────────────────────
async function runApply() {
  const { plan, planned, planFamilies } = loadPlan();
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ONLY = planned.join(',');
  const logBlocks: string[] = [];
  const stageFailures: Record<string, string> = {};
  const results: Record<string, number> = { published: 0, normalized: 0, titled: 0, priced: 0, mirrored: 0, blurhashed: 0, inventory_in_stock: 0, reviews_added: 0 };

  // ── helpers ───────────────────────────────────────────────────────────────
  const counts = async () => {
    const { count: sellable } = await sb.from('sellable_products').select('*', { count: 'exact', head: true });
    const { count: reviews } = await sb.from('product_reviews').select('*', { count: 'exact', head: true });
    const { count: std } = await sb.from('standardized_products').select('*', { count: 'exact', head: true });
    return { sellable: sellable ?? 0, reviews: reviews ?? 0, std: std ?? 0 };
  };
  const stdScoped = async (cols: string, skus: string[]) => {
    const { data } = await sb.from('standardized_products').select(cols).in('supplier_product_id', skus);
    return (data ?? []) as any[];
  };
  const spawn = (script: string, extraEnv: Record<string, string> = {}, onlySkus = ONLY) => {
    const r = spawnSync('npx', ['tsx', script], { env: { ...process.env, ONLY_SKUS: onlySkus, ...extraEnv }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    logBlocks.push(`### ${script}\nexit=${r.status}\n--- stdout ---\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`);
    return r;
  };
  const fail = (stage: string, msg: string) => { stageFailures[stage] = msg; throw new Error(`${stage}:${msg}`); };

  const before = await counts();

  // ── Guardrails ──────────────────────────────────────────────────────────
  const candById = new Map<string, any>((plan.candidates ?? []).map((c: any) => [c.id, c]));
  const nonSafe = planned.filter(s => { const b = candById.get(s)?.bucket; return b && b !== 'SAFE_SINGLETON' && b !== 'SAFE_CLEAN_COLOR_VARIANT'; });

  let reachedStage = 'guardrail';
  let inStockSkus: string[] = [];
  try {
    if (nonSafe.length) fail('guardrail', `non_safe_skus:${nonSafe.slice(0, 5).join(',')}`);

    // ── Stage 1: publish gate (inline scoped update; no dedicated script) ──
    reachedStage = 'publish';
    const { data: upd, error: upErr } = await sb.from('supplier_products').update({ published: true }).in('supplier_product_id', planned).eq('published', false).select('supplier_product_id');
    if (upErr) fail('publish', upErr.message);
    const { data: pubNow } = await sb.from('supplier_products').select('supplier_product_id').in('supplier_product_id', planned).eq('published', true);
    results.published = (pubNow ?? []).length;
    logBlocks.push(`### publish\nupdated=${(upd ?? []).length} now_published=${results.published}/${planned.length}`);
    if (results.published !== planned.length) fail('publish', `published ${results.published}/${planned.length}`);

    // ── Stage 2: normalize (scoped) ──
    reachedStage = 'normalize';
    if (spawn('scripts/normalizeProducts.ts').status !== 0) fail('normalize', 'script_exit_nonzero');
    const norm = await stdScoped('supplier_product_id,normalization_status', planned);
    results.normalized = norm.filter(r => r.normalization_status === 'done').length;
    if (results.normalized !== planned.length) fail('normalize', `done ${results.normalized}/${planned.length}`);

    // ── Stage 3: optimized titles (scoped) ──
    reachedStage = 'title';
    if (spawn('scripts/generateOptimizedTitles.ts').status !== 0) fail('title', 'script_exit_nonzero');
    const titled = await stdScoped('supplier_product_id,optimized_title', planned);
    results.titled = titled.filter(r => r.optimized_title && String(r.optimized_title).length > 0).length;
    if (results.titled !== planned.length) fail('title', `titled ${results.titled}/${planned.length}`);

    // ── Stage 4: pricing (deployed dynamic-pricing edge fn, real) ──
    reachedStage = 'pricing';
    const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const priceRes = await fetch(`${(process.env.SUPABASE_URL ?? '').replace(/\/+$/, '')}/functions/v1/dynamic-pricing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, apikey: KEY },
      body: JSON.stringify({ only_skus: planned, dry_run: false }),
    });
    const priceJson: any = await priceRes.json().catch(() => null);
    logBlocks.push(`### pricing\nhttp=${priceRes.status} updated=${priceJson?.updated ?? '?'}`);
    if (priceRes.status !== 200) fail('pricing', `http_${priceRes.status}`);
    const priced = await stdScoped('supplier_product_id,price,selling_price,original_price', planned);
    results.priced = priced.filter(r => r.selling_price != null && r.original_price != null).length;
    const belowCost = priced.filter(r => r.selling_price != null && Number(r.selling_price) < Number(r.price));
    if (results.priced !== planned.length) fail('pricing', `priced ${results.priced}/${planned.length}`);
    if (belowCost.length) fail('pricing', `below_cost:${belowCost.map(r => r.supplier_product_id).slice(0, 5).join(',')}`);

    // ── Stage 5: mirror (scoped) ──
    reachedStage = 'mirror';
    if (spawn('scripts/mirrorImagesToStorage.ts').status !== 0) fail('mirror', 'script_exit_nonzero');
    const mir = await stdScoped('supplier_product_id,primary_image_mirror_path', planned);
    results.mirrored = mir.filter(r => r.primary_image_mirror_path).length;
    if (results.mirrored !== planned.length) fail('mirror', `mirrored ${results.mirrored}/${planned.length}`);

    // ── Stage 6: blurhash (scoped; raised timeout + safe concurrency) ──
    reachedStage = 'blurhash';
    if (spawn('scripts/backfillBlurhash.ts', { FETCH_TIMEOUT_MS: '60000', CONCURRENCY: '2' }).status !== 0) fail('blurhash', 'script_exit_nonzero');
    const bh = await stdScoped('supplier_product_id,primary_image_blurhash,primary_image_w,primary_image_h,primary_image_aspect', planned);
    results.blurhashed = bh.filter(r => r.primary_image_blurhash && r.primary_image_w != null && r.primary_image_h != null && r.primary_image_aspect != null).length;
    if (results.blurhashed !== planned.length) fail('blurhash', `blurhashed ${results.blurhashed}/${planned.length}`);

    // ── Stage 7: inventory — family-whole stock gating, then seed only in-stock SKUs ──
    reachedStage = 'inventory';
    if (!gigaReady()) fail('inventory', 'no_giga_creds');
    const qty = await gigaQuantity(planned);
    const famSkus = new Set(planFamilies.flatMap(f => f.skus));
    const keepSkus: string[] = [];
    // singletons: keep if qty>0
    for (const s of planned) if (!famSkus.has(s) && (qty.get(s) ?? 0) > 0) keepSkus.push(s);
    // families: keep WHOLE only if every member has stock (no partial exposure)
    const heldFamilies: string[] = [];
    for (const f of planFamilies) {
      if (f.skus.every(s => (qty.get(s) ?? 0) > 0)) keepSkus.push(...f.skus); else heldFamilies.push(f.key);
    }
    if (keepSkus.length === 0) fail('inventory', 'no_in_stock_skus');
    if (spawn('scripts/seedPilotInventory.ts', { APPLY: '1' }, keepSkus.join(',')).status !== 0) fail('inventory', 'seed_exit_nonzero');
    const inv = await stdScoped('supplier_product_id,inventory_status,total_available_qty', keepSkus);
    results.inventory_in_stock = inv.filter(r => r.inventory_status === 'in_stock' && (r.total_available_qty ?? 0) > 0).length;
    inStockSkus = inv.filter(r => r.inventory_status === 'in_stock' && (r.total_available_qty ?? 0) > 0).map(r => r.supplier_product_id);
    logBlocks.push(`### inventory\nheld_families=${heldFamilies.join(',') || 'none'} seeded=${keepSkus.length} in_stock=${results.inventory_in_stock}`);
    if (results.inventory_in_stock !== keepSkus.length) fail('inventory', `in_stock ${results.inventory_in_stock}/${keepSkus.length}`);

    // ── Stage 8: reviews (only the in-stock / exposed SKUs; real seed, NO --dry-run) ──
    reachedStage = 'reviews';
    if (inStockSkus.length) {
      if (spawn('scripts/seedGeneratedReviews.ts', {}, inStockSkus.join(',')).status !== 0) fail('reviews', 'seed_exit_nonzero');
      const { data: revRows } = await sb.from('product_reviews').select('supplier_product_id').in('supplier_product_id', inStockSkus);
      const per = new Map<string, number>(); (revRows ?? []).forEach((r: any) => per.set(r.supplier_product_id, (per.get(r.supplier_product_id) ?? 0) + 1));
      const not5 = inStockSkus.filter(s => (per.get(s) ?? 0) !== 5);
      results.reviews_added = (revRows ?? []).length;
      if (not5.length) fail('reviews', `not_5_each:${not5.slice(0, 5).join(',')}`);
    }
    reachedStage = 'done';
  } catch (e) {
    // stop-on-failure: no rollback in v1; report exactly what succeeded.
    logBlocks.push(`### STOPPED at ${reachedStage}\n${e instanceof Error ? e.message : String(e)}`);
  }

  const after = await counts();
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const expectedSellableAfter = before.sellable + (results.inventory_in_stock || 0);
  const expectedReviewsAfter = before.reviews + (results.reviews_added || 0);
  fs.writeFileSync(APPLY_JSON, JSON.stringify({
    note: 'APPLY run. No rollback in v1 — see reached_stage / stage_failures.', plan_file: PLAN_FILE,
    reached_stage: reachedStage, requested: { skus: planned.length, cards: plan?.proposed_batch?.card_count ?? null },
    results, stage_failures: stageFailures,
    catalog: { sellable_before: before.sellable, sellable_after: after.sellable, reviews_before: before.reviews, reviews_after: after.reviews, std_before: before.std, std_after: after.std },
    log: logBlocks,
  }, null, 2));
  fs.writeFileSync(APPLY_MD, [
    '# GIGA Auto-Publish APPLY', '', `- plan: ${PLAN_FILE}`, `- reached_stage: ${reachedStage}`,
    `- results: ${JSON.stringify(results)}`, `- stage_failures: ${JSON.stringify(stageFailures)}`,
    `- catalog: sellable ${before.sellable}→${after.sellable}, reviews ${before.reviews}→${after.reviews}, std ${before.std}→${after.std}`,
    '', '## Stage logs', '', '```', ...logBlocks, '```',
  ].join('\n'));

  const topRisks = Object.entries(stageFailures).map(([s, m]) => `${s}:${m}`).join(' | ') || 'none';
  if (SUMMARY) {
    console.log('GIGA_AUTO_APPLY_SUMMARY');
    console.log(`plan_file=${PLAN_FILE}`);
    console.log(`requested_skus=${planned.length}`);
    console.log(`requested_cards=${plan?.proposed_batch?.card_count ?? ''}`);
    console.log(`published=${results.published}`);
    console.log(`normalized=${results.normalized}`);
    console.log(`titled=${results.titled}`);
    console.log(`priced=${results.priced}`);
    console.log(`mirrored=${results.mirrored}`);
    console.log(`blurhashed=${results.blurhashed}`);
    console.log(`inventory_in_stock=${results.inventory_in_stock}`);
    console.log(`reviews_added=${results.reviews_added}`);
    console.log(`hold_skus=${planned.length - (results.inventory_in_stock || 0)}`);
    console.log(`hold_families=${planFamilies.filter(f => !f.skus.every(s => inStockSkus.includes(s))).length}`);
    console.log(`sellable_before=${before.sellable}`);
    console.log(`sellable_after=${after.sellable}`);
    console.log(`expected_sellable_after=${expectedSellableAfter}`);
    console.log(`product_reviews_before=${before.reviews}`);
    console.log(`product_reviews_after=${after.reviews}`);
    console.log(`expected_product_reviews_after=${expectedReviewsAfter}`);
    console.log(`standardized_before=${before.std}`);
    console.log(`standardized_after=${after.std}`);
    console.log(`report_json=${rel(APPLY_JSON)}`);
    console.log(`report_md=${rel(APPLY_MD)}`);
    console.log(`top_risks=${topRisks}`);
  } else {
    console.log(`[run] apply reached=${reachedStage}; sellable ${before.sellable}→${after.sellable}; reports: ${rel(APPLY_JSON)} , ${rel(APPLY_MD)}`);
  }
  if (reachedStage !== 'done') process.exit(2); // signal incomplete apply
}

(async () => { if (WANT_DRY) await runDryRun(); else await runApply(); })()
  .catch(e => { console.error('[run] fatal:', e instanceof Error ? e.message : e); process.exit(1); });
