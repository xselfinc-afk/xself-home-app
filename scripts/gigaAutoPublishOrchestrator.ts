/**
 * gigaAutoPublishOrchestrator.ts — single-command GIGA auto-publish orchestrator.
 *
 * Orchestrates the committed tools (no business logic duplicated):
 *   1. scripts/planGigaAutoPublish.ts            → fresh plan (reports/giga-auto-publish/latest-plan.json)
 *   2. scripts/runGigaAutoPublish.ts --dry-run   → simulate the proposed batch (writes latest-dry-run.json with units[])
 *   3. scripts/runGigaAutoPublish.ts --apply     → ONLY on a clean dry-run; the sole product-data write path
 *
 * "Clean dry-run" gate: hold_skus=0 AND stage_failures=none AND dry_run_pass_skus>0.
 *
 * Modes (exactly one required):
 *   --dry-run-only        plan + dry-run, never apply.
 *   --apply-safe          plan + dry-run + apply the FULL plan IFF the full dry-run is clean (else abort).
 *   --apply-clean-subset  plan + dry-run; if clean → apply full; if some SKUs/families are held →
 *                         build a clean SUBSET plan (drop held units WHOLE-FAMILY), re-dry-run it,
 *                         and apply only that subset if its dry-run is clean. Held SKUs are never touched.
 * Flags:
 *   --max-skus=N          required, positive integer.
 *   --summary             print only the compact summary block.
 *
 * Reports (gitignored): latest-orchestrator.{json,md}; clean subset → latest-clean-plan.{json,md}.
 * NO deploy, no App UI changes. Modifies product data only via runGigaAutoPublish.ts --apply.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const SUMMARY = argv.includes('--summary');
const DRY_ONLY = argv.includes('--dry-run-only');
const APPLY_SAFE = argv.includes('--apply-safe');
const APPLY_CLEAN = argv.includes('--apply-clean-subset');
const maxArg = argv.find(a => a.startsWith('--max-skus='));
const MAX_SKUS = maxArg ? parseInt(maxArg.split('=')[1], 10) : NaN;

const REPORT_DIR = path.join(process.cwd(), 'reports', 'giga-auto-publish');
const PLAN_FILE = path.join('reports', 'giga-auto-publish', 'latest-plan.json');
const DRY_JSON = path.join('reports', 'giga-auto-publish', 'latest-dry-run.json');
const CLEAN_PLAN = path.join('reports', 'giga-auto-publish', 'latest-clean-plan.json');
const CLEAN_PLAN_MD = path.join(REPORT_DIR, 'latest-clean-plan.md');
const OUT_JSON = path.join(REPORT_DIR, 'latest-orchestrator.json');
const OUT_MD = path.join(REPORT_DIR, 'latest-orchestrator.md');
const rel = (p: string) => path.relative(process.cwd(), p);

function die(msg: string) { console.error(`[orchestrator] ${msg}`); process.exit(1); }
const modeCount = [DRY_ONLY, APPLY_SAFE, APPLY_CLEAN].filter(Boolean).length;
if (modeCount !== 1) die('require EXACTLY ONE of --dry-run-only | --apply-safe | --apply-clean-subset');
if (!Number.isInteger(MAX_SKUS) || MAX_SKUS <= 0) die('--max-skus=<positive integer> is required');

function parseKV(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) { const m = line.match(/^([a-z_]+)=(.*)$/); if (m) out[m[1]] = m[2]; }
  return out;
}
function child(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('npx', ['tsx', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const isClean = (kv: Record<string, string>, status: number) =>
  status === 0 && parseInt(kv.hold_skus ?? '-1', 10) === 0 && (kv.stage_failures ?? 'x') === 'none' && parseInt(kv.dry_run_pass_skus ?? '0', 10) > 0;

(async () => {
  const log: string[] = [];
  let aborted: string | null = null;
  let applied = false;
  let applyKV: Record<string, string> = {};
  let cleanPlanSkus = 0, cleanPlanCards = 0, cleanDryPass = false;
  let heldSkus: string[] = [], heldFamilies = 0, heldReasons: Record<string, number> = {};
  let appliedPlanFile = PLAN_FILE;

  // ── Step 1: plan ────────────────────────────────────────────────────────────
  const plan = child(['scripts/planGigaAutoPublish.ts', `--max-skus=${MAX_SKUS}`, '--summary']);
  log.push(`### plan\nexit=${plan.status}\n${plan.stdout}\n${plan.stderr}`);
  const planKV = parseKV(plan.stdout);
  if (plan.status !== 0) aborted = 'plan_failed';
  const plannedSkus = parseInt(planKV.proposed_batch_skus ?? '0', 10) || 0;
  const plannedCards = parseInt(planKV.expected_app_card_delta ?? '0', 10) || 0;

  // ── Step 2: full dry-run ──────────────────────────────────────────────────────
  let dryKV: Record<string, string> = {};
  let fullDryStatus = 1, fullDryPass = false;
  if (!aborted) {
    if (plannedSkus === 0) aborted = 'planned_skus_0';
    else {
      const dry = child(['scripts/runGigaAutoPublish.ts', '--plan', PLAN_FILE, '--dry-run', '--summary']);
      log.push(`### full dry-run\nexit=${dry.status}\n${dry.stdout}\n${dry.stderr}`);
      dryKV = parseKV(dry.stdout); fullDryStatus = dry.status;
      fullDryPass = isClean(dryKV, dry.status);
      if (dry.status !== 0) aborted = 'dry_run_failed';
    }
  }

  // ── Step 3: apply paths ───────────────────────────────────────────────────────
  async function applyPlan(planFile: string): Promise<boolean> {
    const ap = child(['scripts/runGigaAutoPublish.ts', '--plan', planFile, '--apply', '--summary']);
    log.push(`### apply (${planFile})\nexit=${ap.status}\n${ap.stdout}\n${ap.stderr}`);
    applyKV = parseKV(ap.stdout);
    appliedPlanFile = planFile;
    if (ap.status !== 0) { aborted = aborted ?? 'apply_failed'; return false; }
    return true;
  }

  if ((APPLY_SAFE || APPLY_CLEAN) && !aborted) {
    if (fullDryPass) {
      // full batch is clean → apply it directly
      applied = await applyPlan(PLAN_FILE);
    } else if (APPLY_SAFE) {
      aborted = `dry_run_not_clean(hold_skus=${dryKV.hold_skus},stage_failures=${dryKV.stage_failures})`;
    } else { // APPLY_CLEAN: build clean subset, re-dry-run, apply subset if clean
      try {
        const dryReport = JSON.parse(fs.readFileSync(DRY_JSON, 'utf8'));
        const units: any[] = dryReport.units ?? [];
        const passUnits = units.filter(u => !u.held);
        const heldUnits = units.filter(u => u.held);
        heldSkus = heldUnits.flatMap((u: any) => u.skus);
        heldFamilies = heldUnits.filter((u: any) => u.kind === 'family').length;
        heldUnits.forEach((u: any) => (u.reasons ?? []).forEach((r: string) => heldReasons[r] = (heldReasons[r] ?? 0) + 1));
        const cleanSkus: string[] = passUnits.flatMap((u: any) => u.skus); // families already whole in units[]
        const cleanFamilies = passUnits.filter((u: any) => u.kind === 'family').map((u: any) => ({ key: u.key, skus: u.skus }));
        cleanPlanSkus = cleanSkus.length;
        if (cleanPlanSkus === 0) { aborted = 'clean_subset_empty'; }
        else {
          // Recompute cards = distinct predicted product_family_key, using the full plan's candidates.
          const fullPlan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
          const candKey = new Map((fullPlan.candidates ?? []).map((c: any) => [c.id, c.key]));
          cleanPlanCards = new Set(cleanSkus.map(s => candKey.get(s)).filter(Boolean)).size;
          const cleanPlan = { ...fullPlan, derived_from: PLAN_FILE, proposed_batch: { skus: cleanSkus, sku_count: cleanPlanSkus, card_count: cleanPlanCards, families: cleanFamilies } };
          fs.mkdirSync(REPORT_DIR, { recursive: true });
          fs.writeFileSync(CLEAN_PLAN, JSON.stringify(cleanPlan, null, 2));
          fs.writeFileSync(CLEAN_PLAN_MD, [
            '# GIGA Auto-Publish CLEAN-SUBSET plan', '', `- derived_from: ${PLAN_FILE}`,
            `- clean_skus: ${cleanPlanSkus} (excluded ${heldSkus.length} held: ${heldSkus.join(',') || 'none'})`,
            `- clean_cards: ${cleanPlanCards}`, `- held_reasons: ${JSON.stringify(heldReasons)}`,
            '', '## clean families', ...cleanFamilies.map((f: any) => `- ${f.key}: ${f.skus.join(',')}`),
          ].join('\n'));
          // Re-dry-run the clean subset
          const cdry = child(['scripts/runGigaAutoPublish.ts', '--plan', CLEAN_PLAN, '--dry-run', '--summary']);
          log.push(`### clean-subset dry-run\nexit=${cdry.status}\n${cdry.stdout}\n${cdry.stderr}`);
          const cdryKV = parseKV(cdry.stdout);
          cleanDryPass = isClean(cdryKV, cdry.status);
          if (!cleanDryPass) aborted = `clean_subset_dry_not_clean(hold_skus=${cdryKV.hold_skus},stage_failures=${cdryKV.stage_failures})`;
          else applied = await applyPlan(CLEAN_PLAN);
        }
      } catch (e) { aborted = `clean_subset_error:${e instanceof Error ? e.message : 'err'}`; }
    }
  }

  // ── Reports ───────────────────────────────────────────────────────────────────
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const mode = DRY_ONLY ? 'dry-run-only' : APPLY_SAFE ? 'apply-safe' : 'apply-clean-subset';
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    note: 'Orchestrator run. Per-stage detail in latest-plan/latest-dry-run/latest-clean-plan/latest-apply.',
    mode, max_skus: MAX_SKUS, planned_skus: plannedSkus, planned_cards: plannedCards,
    full_dry_run_pass: fullDryPass, held_skus: heldSkus, held_families: heldFamilies, held_reasons: heldReasons,
    clean_subset: { skus: cleanPlanSkus, cards: cleanPlanCards, dry_pass: cleanDryPass },
    applied, applied_plan: applied ? appliedPlanFile : null, apply_summary: applyKV, aborted, plan_summary: planKV, log,
  }, null, 2));
  fs.writeFileSync(OUT_MD, [
    '# GIGA Auto-Publish Orchestrator', '', `- mode: ${mode}`, `- max_skus: ${MAX_SKUS}`,
    `- planned: ${plannedSkus} skus / ${plannedCards} cards`, `- full_dry_run_pass: ${fullDryPass}`,
    `- held: ${heldSkus.length} skus / ${heldFamilies} families ${JSON.stringify(heldReasons)}`,
    `- clean_subset: ${cleanPlanSkus} skus / ${cleanPlanCards} cards, dry_pass=${cleanDryPass}`,
    `- applied: ${applied} (plan=${applied ? appliedPlanFile : 'none'})`, `- aborted: ${aborted ?? 'no'}`,
    '', '## Stage logs', '', '```', ...log, '```',
  ].join('\n'));

  // ── Output ─────────────────────────────────────────────────────────────────────
  const dataWrites = applied ? `yes (via runGigaAutoPublish --apply on ${appliedPlanFile})` : 'none';
  if (SUMMARY) {
    console.log('ORCHESTRATOR_SUMMARY');
    console.log(`mode=${mode}`);
    console.log(`max_skus=${MAX_SKUS}`);
    console.log(`planned_skus=${plannedSkus}`);
    console.log(`planned_cards=${plannedCards}`);
    console.log(`full_dry_run_pass=${fullDryPass}`);
    console.log(`held_skus=${heldSkus.length}`);
    console.log(`held_families=${heldFamilies}`);
    console.log(`held_reasons=${Object.entries(heldReasons).map(([r, n]) => `${r}:${n}`).join(',') || 'none'}`);
    console.log(`clean_plan_skus=${cleanPlanSkus}`);
    console.log(`clean_plan_cards=${cleanPlanCards}`);
    console.log(`clean_dry_run_pass=${cleanDryPass}`);
    console.log(`applied=${applied}`);
    console.log(`sellable_after=${applyKV.sellable_after ?? 'n/a'}`);
    console.log(`product_reviews_after=${applyKV.product_reviews_after ?? 'n/a'}`);
    console.log(`aborted=${aborted ?? 'no'}`);
    console.log(`data_writes=${dataWrites}`);
    console.log(`report_json=${rel(OUT_JSON)}`);
    console.log(`report_md=${rel(OUT_MD)}`);
  } else {
    console.log(`[orchestrator] mode=${mode} planned=${plannedSkus} fullDryPass=${fullDryPass} cleanSubset=${cleanPlanSkus}/${cleanPlanCards}(pass=${cleanDryPass}) applied=${applied} aborted=${aborted ?? 'no'}`);
  }
  if (aborted && !(DRY_ONLY && aborted.startsWith('dry_run_not_clean'))) process.exit((APPLY_SAFE || APPLY_CLEAN) ? 2 : (plan.status !== 0 ? 1 : 0));
})().catch(e => { console.error('[orchestrator] fatal:', e instanceof Error ? e.message : e); process.exit(1); });
