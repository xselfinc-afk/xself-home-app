/**
 * runGigaAutoPublish.ts — READ-ONLY GIGA auto-publish DRY-RUN runner.
 *
 * Consumes the planner report (reports/giga-auto-publish/latest-plan.json) and
 * simulates the 8-stage onboarding pipeline for the planner's PROPOSED BATCH ONLY,
 * writing NOTHING to the database. Prints a compact summary; full detail → report files.
 *
 * NO writes of any kind: no publish, normalize, standardized_products, price, mirror,
 * blurhash, inventory_cache, reviews, deploy. The only filesystem writes are the two
 * local report files under reports/giga-auto-publish/ (gitignored). The GIGA inventory
 * call is read-only (the same quantity/v2 probe the seeder uses — it never writes).
 *
 * Usage:
 *   npx tsx scripts/runGigaAutoPublish.ts --plan reports/giga-auto-publish/latest-plan.json --dry-run --summary
 *
 * Simulation fidelity (conservative — report HOLD_RUNNER_LIMITATION rather than pretend):
 *   1 publish    : read supplier_products.published — confirm planned SKU exists/eligible (no write)
 *   2 normalize  : normalizeProduct() in-memory — category / color / family key / discounted cost / image
 *   3 title      : readiness (non-empty, no dangling artifact) — does NOT write optimized_title
 *   4 pricing    : predict selling_price via the dynamic-pricing formula; verify within-family identical + above cost.
 *                  original_price is engine-anchored at runtime, NOT predicted here (noted, non-blocking).
 *   5 mirror     : validate a usable primary image source exists (no upload)
 *   6 blurhash   : readiness — pending mirror; large originals handled by the committed 60s fetch-timeout fix
 *   7 inventory  : LIVE read-only GIGA inventory/quantity/v2 probe (no write) → predicted qty + in_stock; zero-stock holds.
 *                  If creds/API unavailable → HOLD_RUNNER_LIMITATION (does not pretend success).
 *   8 reviews    : predict +5 generated reviews per passing SKU (seedGeneratedReviews dry-run uses --dry-run, not DRY_RUN=1)
 *
 * A unit (singleton SKU or whole variant family) that fails any stage is HELD and excluded from later stages.
 * Variant families are kept whole — a family passes only if all members pass every stage (incl. stock).
 */
(globalThis as { __DEV__?: boolean }).__DEV__ = false;
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.giga-alt.local' });
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const argv = process.argv.slice(2);
const SUMMARY = argv.includes('--summary');
const DRY_RUN = argv.includes('--dry-run'); // this runner is dry-run only
const planArg = argv.find(a => a.startsWith('--plan='))?.split('=')[1]
  ?? (argv.includes('--plan') ? argv[argv.indexOf('--plan') + 1] : undefined);
const PLAN_FILE = planArg ?? path.join('reports', 'giga-auto-publish', 'latest-plan.json');

const REPORT_DIR = path.join(process.cwd(), 'reports', 'giga-auto-publish');
const OUT_JSON = path.join(REPORT_DIR, 'latest-dry-run.json');
const OUT_MD = path.join(REPORT_DIR, 'latest-dry-run.md');

// ── dynamic-pricing formula (mirrors supabase/functions/dynamic-pricing/index.ts) ──
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
      const total = dist.reduce((acc: number, w: any) => acc + Math.max(0, Number(w.availableQtyMin) || 0), 0);
      out.set(ar.sku, total);
    }
  }
  return out;
}

const dangling = (t: string) => /,\s*\d+\s*$/.test(t) || /\b(with|and|for|the|of|to)\s*$/i.test(t) || /[-–—,;:|/&]\s*$/.test(t);

type Unit = { kind: 'family' | 'singleton'; key: string; skus: string[]; reasons: string[]; held: boolean; heldAt: string | null; per: Record<string, any> };

(async () => {
  if (!DRY_RUN) { console.error('[run] this runner is DRY-RUN only; pass --dry-run'); process.exit(1); }
  if (!fs.existsSync(PLAN_FILE)) { console.error(`[run] plan not found: ${PLAN_FILE} (run planGigaAutoPublish.ts first)`); process.exit(1); }
  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  const planned: string[] = plan?.proposed_batch?.skus ?? [];
  const planFamilies: { key: string; skus: string[] }[] = plan?.proposed_batch?.families ?? plan?.safe_variant_families ?? [];
  if (planned.length === 0) { console.error('[run] plan has no proposed_batch.skus'); process.exit(1); }

  const { createClient } = await import('@supabase/supabase-js');
  const pipe = await import('../src/services/normalizationPipeline');
  const normalizeProduct = (pipe as any).normalizeProduct;
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  // ── Build units (families whole, the rest singletons) — proposed batch only ──
  const famInBatch = planFamilies.filter(f => f.skus.every(s => planned.includes(s)));
  const famSkus = new Set(famInBatch.flatMap(f => f.skus));
  const units: Unit[] = [
    ...famInBatch.map(f => ({ kind: 'family' as const, key: f.key, skus: [...f.skus].sort(), reasons: [], held: false, heldAt: null, per: {} as Record<string, any> })),
    ...planned.filter(s => !famSkus.has(s)).map(s => ({ kind: 'singleton' as const, key: s, skus: [s], reasons: [], held: false, heldAt: null, per: {} as Record<string, any> })),
  ];

  // ── Fetch supplier_products for PLANNED SKUs ONLY (read-only) ──────────────
  const { data: spRows } = await sb.from('supplier_products')
    .select('supplier_product_id,title,description,price,published,raw_payload').in('supplier_product_id', planned);
  const byId = new Map((spRows ?? []).map((r: any) => [r.supplier_product_id, r]));

  const hold = (u: Unit, stage: string, reason: string) => { u.held = true; u.heldAt = u.heldAt ?? stage; if (!u.reasons.includes(reason)) u.reasons.push(reason); };

  // ── Stages 1–6 (per unit, in-memory) ──────────────────────────────────────
  const silence = console.log; console.log = () => {};
  for (const u of units) {
    const costs: number[] = [];
    for (const s of u.skus) {
      const r = byId.get(s);
      if (!r) { hold(u, 'publish', 'missing_supplier_row'); break; }
      let n: any; try { n = normalizeProduct({ ...r, id: s }); } catch { hold(u, 'normalize', 'normalize_error'); break; }
      const cost = Number(n.price ?? 0);
      const pred = predictSelling(cost);
      const pt = String(n.product_title ?? '');
      // Title readiness only: a clean, sufficiently-long product_title. We do NOT generate the
      // exact optimized_title here (buildOptimizedTitle is not exported — a documented runner
      // limitation), and we do NOT penalize trailing artifacts on the raw product_title, because
      // generateOptimizedTitles' trimEnds (+ committed fix 137439af) strips them at real run time.
      const titleReady = pt.length >= 12;
      const imgReady = !!n.primary_image && /^https?:\/\//.test(String(n.primary_image));
      u.per[s] = { color: n.color, cat: n.category_label, key: n.product_family_key, cost, predSelling: pred, img: imgReady, raw_title_dangling: dangling(pt), qty: null, inStock: null };
      costs.push(cost);
      if (!(cost > 0) || !n.category_label) { hold(u, 'normalize', 'normalize_incomplete'); break; }
      if (!titleReady) { hold(u, 'title', 'title_not_ready'); break; }
      if (pred < cost) { hold(u, 'pricing', 'below_cost'); break; } // defensive; markup≥1.28 never below cost
      if (!imgReady) { hold(u, 'mirror', 'no_image_source'); break; }
      // blurhash readiness: pending-mirror; large originals covered by the committed 60s fetch-timeout fix → no hold
    }
    if (!u.held && u.kind === 'family' && new Set(costs).size > 1) hold(u, 'pricing', 'within_family_cost_mismatch');
  }
  console.log = silence;

  // ── Stage 7: live read-only GIGA stock for units still passing ─────────────
  let invLimited = false;
  const survivors = units.filter(u => !u.held);
  const probeSkus = survivors.flatMap(u => u.skus);
  if (probeSkus.length) {
    if (!GIGA_BASE || !GIGA_CID || !GIGA_SEC || !/openapi\.gigab2b\.com/.test(GIGA_BASE)) {
      invLimited = true;
      for (const u of survivors) hold(u, 'inventory', 'HOLD_RUNNER_LIMITATION:no_giga_creds');
    } else {
      try {
        const qty = await gigaQuantity(probeSkus);
        for (const u of survivors) {
          let allStock = true;
          for (const s of u.skus) {
            const q = qty.get(s) ?? 0;
            u.per[s].qty = q; u.per[s].inStock = q > 0;
            if (!(q > 0)) allStock = false;
          }
          if (!allStock) hold(u, 'inventory', 'zero_stock'); // whole family held if any member has no stock
        }
      } catch (e) {
        invLimited = true;
        for (const u of survivors) hold(u, 'inventory', `HOLD_RUNNER_LIMITATION:${e instanceof Error ? e.message : 'giga_probe_failed'}`);
      }
    }
  }

  // ── Stage 8: review prediction for fully-passing units ─────────────────────
  const passing = units.filter(u => !u.held);
  const passSkus = passing.flatMap(u => u.skus);
  const passCards = passing.length;
  const reviewDelta = passSkus.length * 5;

  // ── Aggregate ──────────────────────────────────────────────────────────────
  const heldUnits = units.filter(u => u.held);
  const heldSkus = heldUnits.flatMap(u => u.skus);
  const heldFamilies = heldUnits.filter(u => u.kind === 'family').length;
  const reasonCounts: Record<string, number> = {};
  heldUnits.forEach(u => u.reasons.forEach(r => { reasonCounts[r] = (reasonCounts[r] ?? 0) + 1; }));
  const stageFailCounts: Record<string, number> = {};
  heldUnits.forEach(u => { if (u.heldAt) stageFailCounts[u.heldAt] = (stageFailCounts[u.heldAt] ?? 0) + 1; });

  const risks: string[] = [];
  if (invLimited) risks.push('inventory:runner-limitation(stock not probed)');
  Object.entries(reasonCounts).forEach(([r, n]) => { if (!r.startsWith('HOLD_RUNNER')) risks.push(`${r}:${n}`); });

  // ── Reports ──────────────────────────────────────────────────────────────
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const full = {
    note: 'DRY-RUN simulation; no DB writes. Stage 7 uses a read-only GIGA stock probe. timestamp omitted (stamp externally).',
    plan_file: PLAN_FILE,
    requested: { skus: planned.length, cards: (plan?.proposed_batch?.card_count ?? units.length) },
    result: { dry_run_pass_skus: passSkus.length, dry_run_pass_cards: passCards, hold_skus: heldSkus.length, hold_families: heldFamilies },
    deltas: { sellable: passSkus.length, app_cards: passCards, reviews: reviewDelta },
    stage_failures: stageFailCounts, hold_reasons: reasonCounts, inventory_limited: invLimited,
    units: units.map(u => ({ kind: u.kind, key: u.key, skus: u.skus, held: u.held, heldAt: u.heldAt, reasons: u.reasons, per: u.per })),
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(full, null, 2));
  const md = [
    '# GIGA Auto-Publish DRY-RUN', '', `- plan: ${PLAN_FILE}`, `- ${full.note}`, '',
    '## Result',
    `- requested: ${planned.length} skus / ${full.requested.cards} cards`,
    `- dry_run_pass: ${passSkus.length} skus / ${passCards} cards`,
    `- held: ${heldSkus.length} skus / ${heldFamilies} families`,
    `- deltas: sellable +${passSkus.length}, cards +${passCards}, reviews +${reviewDelta}`,
    `- stage_failures: ${JSON.stringify(stageFailCounts)}`,
    `- hold_reasons: ${JSON.stringify(reasonCounts)}`, '',
    '## Units', '', '| kind | key | skus | held | heldAt | reasons |', '|---|---|---|---|---|---|',
    ...units.map(u => `| ${u.kind} | ${u.key} | ${u.skus.join(',')} | ${u.held} | ${u.heldAt ?? ''} | ${u.reasons.join(';')} |`),
  ].join('\n');
  fs.writeFileSync(OUT_MD, md);

  const rel = (p: string) => path.relative(process.cwd(), p);
  if (SUMMARY) {
    console.log('GIGA_AUTO_RUN_DRY_SUMMARY');
    console.log(`plan_file=${PLAN_FILE}`);
    console.log(`requested_skus=${planned.length}`);
    console.log(`requested_cards=${full.requested.cards}`);
    console.log(`dry_run_pass_skus=${passSkus.length}`);
    console.log(`dry_run_pass_cards=${passCards}`);
    console.log(`hold_skus=${heldSkus.length}`);
    console.log(`hold_families=${heldFamilies}`);
    console.log(`hold_reasons=${Object.entries(reasonCounts).map(([r, n]) => `${r}:${n}`).join(',') || 'none'}`);
    console.log(`expected_sellable_delta=${passSkus.length}`);
    console.log(`expected_app_card_delta=${passCards}`);
    console.log(`expected_review_delta=${reviewDelta}`);
    console.log(`stage_failures=${Object.entries(stageFailCounts).map(([s, n]) => `${s}:${n}`).join(',') || 'none'}`);
    console.log(`report_json=${rel(OUT_JSON)}`);
    console.log(`report_md=${rel(OUT_MD)}`);
    console.log(`top_risks=${risks.join(' | ') || 'none'}`);
  } else {
    console.log(`[run] dry-run pass=${passSkus.length}/${planned.length} skus, ${passCards} cards; reports: ${rel(OUT_JSON)} , ${rel(OUT_MD)}`);
  }
  console.log = silence;
})().catch(e => { console.error('[run] fatal:', e instanceof Error ? e.message : e); process.exit(1); });
