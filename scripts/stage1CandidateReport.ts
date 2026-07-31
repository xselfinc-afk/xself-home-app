/**
 * Stage 1A — READ-ONLY founder IMPORT-PRIORITY report (product-bible-v1.0-rc1).
 *
 * Every input product is ALREADY in Saved Items, so this report ranks the import→publish backlog —
 * it NEVER recommends favoriting. It is a RECOMMENDATION surface and authorizes nothing.
 *
 * STRICTLY READ-ONLY: only Supabase .select() reads and (optionally) the existing read-only
 * saved-items fetch. It NEVER writes Supabase/inventory_cache, NEVER favorites/imports/publishes/
 * delists, and NEVER performs a supplier mutation. Its only filesystem effect is a gitignored report.
 *
 * Candidate source (choose one):
 *   --input=<path.json>   consume an existing saved-items snapshot (reads snapshot evidence when present)
 *   --live                fetch the saved list via the existing read-only helper (hits the supplier API, read-only)
 * Options: --max-pages=N (live), --recent-days=N
 *
 * Usage:
 *   npm run stage1:candidates:report -- --input=reports/giga-auto-publish/latest-saved-plan.json
 */
import dotenv from 'dotenv';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  scoreCandidate, classifyImportStatus, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS,
  type CandidateFeatures, type SupplyPriority, type ImportStatus, type ImportStatusResult,
} from '../src/services/stage1CandidateScore';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const arg = (n: string) => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const flag = (n: string) => process.argv.includes(`--${n}`);
const DAY = 86_400_000;
/** Observed PLANNING reference only — the supplier hard cap is NOT proven. Never treated as confirmed. */
const OBSERVED_FAVORITE_REFERENCE = 700;
const chunk = <T>(a: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const firstFinite = (...xs: any[]): number | null => { for (const x of xs) { const n = Number(x); if (Number.isFinite(n)) return n; } return null; };
const asBool = (v: any): boolean | null => (typeof v === 'boolean' ? v : null);

/** Saved-items occupied total, supporting camelCase, snake_case, and the totals shape. Pure/testable. */
export function parseSavedItemsTotal(j: any): number | null {
  return firstFinite(j?.reportedTotal, j?.reported_total_num, j?.totals?.saved_items_total, j?.saved_items_total);
}

interface RawCandidate {
  sku: string; title: string;
  addedTime: string | null; firstArrivalDate: string | null;
  hasImage: boolean | null; hasPrice: boolean | null;
  classification: string | null; invalidReasons: string[];
  snapImported: boolean | null; snapPublished: boolean | null;
}
interface Source { candidates: RawCandidate[]; reportedTotal: number | null; snapshotTime: string | null; sourceLabel: string; }

function loadFromInput(p: string): Source {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr: any[] = Array.isArray(j) ? j : (Array.isArray(j.items) ? j.items : (Array.isArray(j.candidates) ? j.candidates : []));
  const candidates: RawCandidate[] = arr.map(r => ({
    sku: String(r?.sku ?? r?.supplier_product_id ?? '').trim(),
    title: String(r?.title ?? r?.productName ?? ''),
    addedTime: r?.addedTime ?? null,
    firstArrivalDate: r?.first_arrival_date ?? r?.firstArrivalDate ?? null,
    hasImage: asBool(r?.has_image ?? r?.hasImage),
    hasPrice: asBool(r?.has_price ?? r?.hasPrice),
    classification: r?.classification ?? null,
    invalidReasons: Array.isArray(r?.invalid_reasons) ? r.invalid_reasons.map(String) : (Array.isArray(r?.invalidReasons) ? r.invalidReasons.map(String) : []),
    snapImported: asBool(r?.in_supplier_products) ?? asBool(r?.in_standardized_products),
    snapPublished: asBool(r?.in_sellable_products),
  })).filter(r => r.sku);
  // Census: support both camelCase and the real snapshot's snake_case / totals shapes.
  const reportedTotal = parseSavedItemsTotal(j);
  return { candidates, reportedTotal, snapshotTime: j?.timestamp ?? j?.generatedAt ?? null, sourceLabel: `input:${path.basename(p)}${j?.creds_source ? ` (${j.creds_source})` : ''}` };
}

async function loadLive(maxPages: number): Promise<Source> {
  const { fetchAllSavedItems } = await import('./lib/gigaSavedItems'); // read-only helper (no writes)
  const r = await fetchAllSavedItems({ maxPages: isFinite(maxPages) ? maxPages : undefined });
  const candidates: RawCandidate[] = r.items.map(i => ({
    sku: i.sku, title: i.title, addedTime: i.addedTime, firstArrivalDate: i.firstArrivalDate,
    hasImage: null, hasPrice: null, classification: null, invalidReasons: [], snapImported: null, snapPublished: null,
  }));
  return { candidates, reportedTotal: r.reportedTotal, snapshotTime: new Date().toISOString(), sourceLabel: `live:${r.credsSource}` };
}

/** Best-effort days-since; null when the timestamp cannot be parsed (never assume newness). */
function daysSince(ts: string | null): number | null {
  if (!ts) return null;
  const n = Number(ts);
  let ms: number | null = null;
  if (Number.isFinite(n)) ms = n > 1e12 ? n : (n > 1e9 ? n * 1000 : null);
  else { const p = Date.parse(ts); if (Number.isFinite(p)) ms = p; }
  if (ms == null) return null;
  const d = (Date.now() - ms) / DAY;
  return d >= 0 && d < 3650 ? Math.round(d) : null;
}

/** READ-ONLY live lookup: dedupe + any known inventory status. */
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
  return 'unknown'; // stale / unknown → NOT a negative fact, NOT P4
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('[stage1] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required (.env.local). Read-only; aborting.'); process.exit(2); }
  const inputPath = arg('input');
  const live = flag('live');
  if (!inputPath && !live) { console.error('[stage1] provide --input=<saved-items json> OR --live. Refusing to guess a supplier source.'); process.exit(2); }
  const recentDays = Number(arg('recent-days') ?? DEFAULT_THRESHOLDS.recentDays);
  const thresholds = { ...DEFAULT_THRESHOLDS, recentDays };

  const src: Source = inputPath ? loadFromInput(inputPath) : await loadLive(Number(arg('max-pages') ?? Infinity));
  if (src.candidates.length === 0) { console.error('[stage1] no candidates in source; nothing to report.'); process.exit(1); }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  const { std, supp } = await fetchStatus(sb, src.candidates.map(c => c.sku));

  const rows = src.candidates.map(c => {
    const st = std.get(c.sku);
    const dsav = daysSince(c.firstArrivalDate ?? c.addedTime);
    const priority = priorityOf(st);
    // Generic opportunity score (reused; ranks within a status). Unknown newness stays neutral.
    const f: CandidateFeatures = {
      supplierProductId: c.sku, identityResolved: !!c.sku, duplicate: std.has(c.sku) || supp.has(c.sku),
      isNewlySaved: dsav == null ? null : dsav <= recentDays, daysSinceSaved: dsav,
      priority, hasShipping: null,
      marginState: 'unknown', costKnown: false, complete: null,
      usableImages: c.hasImage, differentiated: null, fulfillmentPossible: null, slotCost: 1,
    };
    const score = scoreCandidate(f, DEFAULT_WEIGHTS, thresholds);
    // Saved-items import lifecycle (snapshot + live, conflict-aware).
    const imp: ImportStatusResult = classifyImportStatus({
      supplierProductId: c.sku, identityResolved: !!c.sku,
      snapshotClassification: c.classification, invalidReasons: c.invalidReasons,
      hasImage: c.hasImage, hasPrice: c.hasPrice,
      snapshotImported: c.snapImported, snapshotPublished: c.snapPublished,
      liveImported: (std.has(c.sku) || supp.has(c.sku)),         // definite: absence in queried set = false
      livePublished: st ? st.published : false,                  // not standardized ⇒ cannot be published
    });
    return { sku: c.sku, title: c.title, classification: c.classification, hasImage: c.hasImage, hasPrice: c.hasPrice, firstArrivalDate: c.firstArrivalDate ?? c.addedTime ?? null, priority, importStatus: imp.status, conflict: imp.conflict, importReasons: imp.reasons, invalidReasons: imp.invalidReasons, missingEvidence: imp.missingEvidence, nextAction: imp.nextAction, score: score.score };
  });

  const st = (s: ImportStatus) => rows.filter(r => r.importStatus === s);
  const statusCounts = { already_published: st('already_published').length, already_imported: st('already_imported').length, import_ready: st('import_ready').length, needs_more_evidence: st('needs_more_evidence').length, blocked: st('blocked').length };
  const conflicts = rows.filter(r => r.conflict);

  // ── Favorite/Saved capacity census ──
  const occupied = src.reportedTotal;
  const capacityKnown = occupied != null;
  const nearLimit = occupied != null && occupied >= OBSERVED_FAVORITE_REFERENCE - 50;
  const census = {
    account_scope: src.sourceLabel, occupied_saved_items: occupied, occupied_source: capacityKnown ? 'supplier-reported saved-items total' : 'not reported',
    hard_capacity: 'UNKNOWN (not proven)', remaining_capacity: 'UNKNOWN (hard cap unproven)',
    observed_reference_only: OBSERVED_FAVORITE_REFERENCE,
    warning: !capacityKnown ? 'saved-items total not reported — capacity UNCERTAIN' : (nearLimit ? `occupied ${occupied} is NEAR the observed ~${OBSERVED_FAVORITE_REFERENCE}+ planning reference — Saved-Items capacity may be nearly exhausted (hard cap unproven)` : `occupied ${occupied} below the observed ~${OBSERVED_FAVORITE_REFERENCE}+ planning reference`),
  };

  const snapAgeDays = src.snapshotTime ? daysSince(src.snapshotTime) : null;
  const missingSummary: Record<string, number> = {};
  for (const r of rows) for (const m of r.missingEvidence) missingSummary[m] = (missingSummary[m] ?? 0) + 1;

  const summary = {
    generatedAt: new Date().toISOString(), mode: 'READ_ONLY_IMPORT_PRIORITY', baseline: 'product-bible-v1.0-rc1',
    source: src.sourceLabel, snapshotAgeDays: snapAgeDays, totalSavedItems: rows.length,
    statusCounts, conflicts: conflicts.length, census, missingEvidenceSummary: missingSummary,
  };

  const importReady = rows.filter(r => r.importStatus === 'import_ready').sort((a, b) => b.score - a.score);

  const dir = path.join(process.cwd(), 'reports', 'stage1-candidates');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `stage1-candidates-${stamp}.json`), JSON.stringify({ summary, rows }, null, 2), { mode: 0o600 });

  const md = [
    '# Stage 1A — Saved-Items Import-Priority Report (read-only recommendation)', '',
    `- generated: ${summary.generatedAt}`, `- source: ${summary.source}`,
    `- snapshot age: ${snapAgeDays == null ? 'unknown' : snapAgeDays + ' day(s)'}`,
    `- total Saved Items: ${summary.totalSavedItems}`, '',
    '## Status distribution',
    `- Already Published: ${statusCounts.already_published}`,
    `- Already Imported: ${statusCounts.already_imported}`,
    `- Import Ready: ${statusCounts.import_ready}`,
    `- Needs More Evidence: ${statusCounts.needs_more_evidence}`,
    `- Blocked: ${statusCounts.blocked}`,
    `- snapshot↔live conflicts (→ Needs More Evidence): ${conflicts.length}`, '',
    '## Capacity',
    `- occupied Saved Items: ${occupied ?? 'UNKNOWN'} (${census.occupied_source})`,
    `- hard capacity: UNKNOWN · remaining: UNKNOWN`,
    `- ${census.warning}`, '',
    '## Missing-evidence summary', ...Object.entries(missingSummary).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`), '',
    `## Top Import Ready (${importReady.length}) — next action: import via existing giga:newly-saved:sync (dry-run first), then verify inventory + margin`, '',
    '| SKU | title | class | img | price | arrival | priority | missing evidence | invalid reasons |',
    '|---|---|---|---|---|---|---|---|---|',
    ...importReady.slice(0, 30).map(r => `| ${r.sku} | ${String(r.title).slice(0, 40)} | ${r.classification ?? '-'} | ${r.hasImage ?? '?'} | ${r.hasPrice ?? '?'} | ${r.firstArrivalDate ?? 'unknown'} | ${r.priority} | ${r.missingEvidence.join(', ') || '-'} | ${r.invalidReasons.join('; ') || '-'} |`),
    '', '_Recommendation only. These products are ALREADY in Saved Items — no favoriting is proposed. Import/publish require your separate approval._',
  ].join('\n');
  fs.writeFileSync(path.join(dir, `stage1-candidates-${stamp}.md`), md, { mode: 0o600 });

  console.log(`[stage1] ${summary.totalSavedItems} saved items · status=${JSON.stringify(statusCounts)} · conflicts=${conflicts.length}`);
  console.log(`[stage1] capacity: occupied=${occupied ?? 'UNKNOWN'} hardCap=UNKNOWN remaining=UNKNOWN · ${census.warning}`);
  console.log(`[stage1] report → reports/stage1-candidates/stage1-candidates-${stamp}.{json,md}  (import-priority; recommendation only; no writes, no favorites)`);
}

if (require.main === module) {
  main().catch(e => { console.error('[stage1] fatal (read-only; no writes):', e instanceof Error ? e.message : e); process.exit(1); });
}
