/**
 * Stage 1A — READ-ONLY founder candidate report (product-bible-v1.0-rc1).
 *
 * Composes EXISTING read paths only and produces a ranked, deduped, capacity-annotated candidate
 * report for founder review. It is a RECOMMENDATION surface — it authorizes nothing.
 *
 * STRICTLY READ-ONLY: it performs ONLY Supabase .select() reads and (optionally) the existing
 * read-only saved-items fetch. It NEVER writes Supabase/inventory_cache, NEVER favorites/imports/
 * publishes/delists, and NEVER performs a supplier mutation. Its only filesystem effect is writing
 * a gitignored report under reports/stage1-candidates/.
 *
 * Candidate source (choose one):
 *   --input=<path.json>   consume an existing saved-items report (SavedItemsFetch or SavedItem[] or {sku}[])
 *   --live                fetch the saved list via the existing read-only helper (hits the supplier API, read-only)
 * Options: --max-pages=N (live), --buffer=N (capacity safety buffer), --recent-days=N
 *
 * Usage:
 *   npm run stage1:candidates:report -- --input=reports/inventory-decisions/<saved-plan>.json
 *   npm run stage1:candidates:report -- --live --max-pages=3
 */
import dotenv from 'dotenv';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  scoreCandidate, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS,
  type CandidateFeatures, type SupplyPriority, type CandidateScore,
} from '../src/services/stage1CandidateScore';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const arg = (n: string) => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const flag = (n: string) => process.argv.includes(`--${n}`);
const DAY = 86_400_000;
const chunk = <T>(a: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

interface RawCandidate { sku: string; title?: string; addedTime?: string | null; firstArrivalDate?: string | null; }

function loadFromInput(p: string): { candidates: RawCandidate[]; reportedTotal: number | null; sourceLabel: string } {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr: any[] = Array.isArray(j) ? j : (Array.isArray(j.items) ? j.items : (Array.isArray(j.candidates) ? j.candidates : []));
  const candidates: RawCandidate[] = arr
    .map(r => ({ sku: String(r?.sku ?? r?.supplier_product_id ?? '').trim(), title: r?.title ?? r?.productName ?? '', addedTime: r?.addedTime ?? null, firstArrivalDate: r?.firstArrivalDate ?? null }))
    .filter(r => r.sku);
  const reportedTotal = Number.isFinite(Number(j?.reportedTotal)) ? Number(j.reportedTotal) : null;
  return { candidates, reportedTotal, sourceLabel: `input:${path.basename(p)}` };
}

async function loadLive(maxPages: number): Promise<{ candidates: RawCandidate[]; reportedTotal: number | null; sourceLabel: string }> {
  const { fetchAllSavedItems } = await import('./lib/gigaSavedItems'); // read-only helper (no writes)
  const r = await fetchAllSavedItems({ maxPages: isFinite(maxPages) ? maxPages : undefined });
  return { candidates: r.items.map(i => ({ sku: i.sku, title: i.title, addedTime: i.addedTime, firstArrivalDate: i.firstArrivalDate })), reportedTotal: r.reportedTotal, sourceLabel: `live:${r.credsSource}` };
}

/** Best-effort days-since-saved; null when the supplier timestamp cannot be parsed (never assume). */
function daysSince(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const n = Number(ts);
  let ms: number | null = null;
  if (Number.isFinite(n)) ms = n > 1e12 ? n : (n > 1e9 ? n * 1000 : null);
  else { const p = Date.parse(ts); if (Number.isFinite(p)) ms = p; }
  if (ms == null) return null;
  const d = (Date.now() - ms) / DAY;
  return d >= 0 && d < 3650 ? Math.round(d) : null;
}

/** READ-ONLY status lookup for the candidate SKUs (dedupe + any known inventory status). */
async function fetchStatus(sb: SupabaseClient, skus: string[]) {
  const std = new Map<string, { published: boolean; inventory_status: string | null; has_ca_pickup: boolean | null }>();
  const supp = new Set<string>();
  for (const c of chunk(skus, 150)) {
    const { data: s } = await sb.from('standardized_products').select('supplier_product_id, published, inventory_status, has_ca_pickup').in('supplier_product_id', c);
    for (const r of s ?? []) std.set(r.supplier_product_id, { published: !!r.published, inventory_status: r.inventory_status ?? null, has_ca_pickup: r.has_ca_pickup ?? null });
    const { data: sp } = await sb.from('supplier_products').select('supplier_product_id').in('supplier_product_id', c);
    for (const r of sp ?? []) supp.add(r.supplier_product_id);
  }
  return { std, supp };
}

function priorityOf(st: { inventory_status: string | null; has_ca_pickup: boolean | null } | undefined): SupplyPriority {
  if (!st || !st.inventory_status) return 'unknown';
  if (st.inventory_status === 'in_stock') return st.has_ca_pickup ? 'P1' : 'P2';
  if (st.inventory_status === 'out_of_stock') return 'P4';
  return 'unknown'; // stale / unknown → not a negative fact
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('[stage1] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required (.env.local). Read-only; aborting.'); process.exit(2); }
  const inputPath = arg('input');
  const live = flag('live');
  if (!inputPath && !live) { console.error('[stage1] provide --input=<saved-items json> OR --live. Refusing to guess a supplier source.'); process.exit(2); }
  const buffer = Number(arg('buffer') ?? 50);
  const recentDays = Number(arg('recent-days') ?? DEFAULT_THRESHOLDS.recentDays);
  const thresholds = { ...DEFAULT_THRESHOLDS, recentDays };

  const src = inputPath ? loadFromInput(inputPath) : await loadLive(Number(arg('max-pages') ?? Infinity));
  if (src.candidates.length === 0) { console.error('[stage1] no candidates in source; nothing to report.'); process.exit(1); }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  const { std, supp } = await fetchStatus(sb, src.candidates.map(c => c.sku));

  const scored: (CandidateScore & { title: string })[] = src.candidates.map(c => {
    const st = std.get(c.sku);
    const duplicate = std.has(c.sku) || supp.has(c.sku);
    const dsav = daysSince(c.addedTime);
    const f: CandidateFeatures = {
      supplierProductId: c.sku, identityResolved: !!c.sku, duplicate,
      isNewlySaved: dsav == null ? true : dsav <= recentDays, daysSinceSaved: dsav,
      priority: priorityOf(st), hasShipping: null, marginState: 'unknown', costKnown: false,
      complete: null, usableImages: null, differentiated: null, fulfillmentPossible: null, slotCost: 1,
    };
    return { ...scoreCandidate(f, DEFAULT_WEIGHTS, thresholds), title: c.title ?? '' };
  }).sort((a, b) => b.score - a.score);

  // ── Favorite census (occupied = reported saved-items total for the read account) ──
  const occupied = src.reportedTotal;
  const capacityKnown = occupied != null;
  const census = { account_scope: src.sourceLabel, occupied_saved_items: occupied, safety_buffer: buffer, capacity_certain: capacityKnown, note: capacityKnown ? 'occupied = supplier-reported saved-items total; hard cap not proven — operate below with buffer' : 'saved-items total not reported; capacity UNCERTAIN — do not auto-favorite' };

  const counts = (v: string) => scored.filter(s => s.verdict === v).length;
  const summary = {
    generatedAt: new Date().toISOString(), mode: 'READ_ONLY_RECOMMENDATION', baseline: 'product-bible-v1.0-rc1',
    source: src.sourceLabel, totalCandidates: scored.length,
    verdicts: { favorite_immediately: counts('favorite_immediately'), candidate: counts('candidate'), waitlist: counts('waitlist'), request_more_evidence: counts('request_more_evidence'), ignore: counts('ignore') },
    duplicatesSkipped: scored.filter(s => s.blockReasons.includes('already_imported_duplicate')).length,
    census,
  };

  const dir = path.join(process.cwd(), 'reports', 'stage1-candidates');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `stage1-candidates-${stamp}.json`), JSON.stringify({ summary, candidates: scored }, null, 2), { mode: 0o600 });

  const top = scored.filter(s => s.verdict === 'favorite_immediately' || s.verdict === 'candidate').slice(0, 50);
  const md = [
    '# Stage 1A — Candidate Report (read-only recommendation)', '',
    `- generated: ${summary.generatedAt}`, `- source: ${summary.source}`, `- candidates: ${summary.totalCandidates}`,
    `- verdicts: ${JSON.stringify(summary.verdicts)}`,
    `- favorite census: occupied=${occupied ?? 'UNKNOWN'} buffer=${buffer} certain=${capacityKnown}`,
    capacityKnown ? '' : '- ⚠ capacity uncertain — do NOT auto-favorite; founder review only', '',
    '## Recommended for founder review (favorite/candidate, top 50 by score)', '',
    '| SKU | verdict | score | reasons | missing evidence |', '|---|---|---|---|---|',
    ...top.map(s => `| ${s.supplierProductId} | ${s.verdict} | ${s.score} | ${s.reasons.join(', ') || '-'} | ${s.missingEvidence.join(', ') || '-'} |`),
    '', '_Recommendation only. Favoriting is a manual founder action in the GIGA portal (Stage 1)._',
  ].join('\n');
  fs.writeFileSync(path.join(dir, `stage1-candidates-${stamp}.md`), md, { mode: 0o600 });

  console.log(`[stage1] ${summary.totalCandidates} candidates · ${JSON.stringify(summary.verdicts)}`);
  console.log(`[stage1] favorite census: occupied=${occupied ?? 'UNKNOWN'} buffer=${buffer} certain=${capacityKnown}`);
  console.log(`[stage1] report → reports/stage1-candidates/stage1-candidates-${stamp}.{json,md}  (recommendation only; no writes, no favorites)`);
}

if (require.main === module) {
  main().catch(e => { console.error('[stage1] fatal (read-only; no writes):', e instanceof Error ? e.message : e); process.exit(1); });
}
