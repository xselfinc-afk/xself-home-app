/**
 * gigaAutoPublishOrchestrator.ts — single-command GIGA auto-publish orchestrator.
 *
 * Orchestrates the existing committed tools (no business logic duplicated):
 *   1. scripts/planGigaAutoPublish.ts   → fresh plan (writes reports/giga-auto-publish/latest-plan.json)
 *   2. scripts/runGigaAutoPublish.ts --dry-run  → simulate the proposed batch
 *   3. (--apply-safe only) scripts/runGigaAutoPublish.ts --apply  → ONLY if the dry-run is clean
 *
 * "Clean dry-run" gate for apply: hold_skus=0 AND stage_failures=none AND planned/pass skus > 0.
 * Apply is the ONLY path that writes product data, and only via runGigaAutoPublish.ts --apply.
 *
 * Modes (exactly one required):
 *   --dry-run-only   plan + dry-run, never apply.
 *   --apply-safe     plan + dry-run + apply IFF the dry-run is clean.
 * Flags:
 *   --max-skus=N     required, positive integer (cap the proposed batch).
 *   --summary        print only the compact ORCHESTRATOR summary block.
 *
 * Reports (gitignored): reports/giga-auto-publish/latest-orchestrator.{json,md}
 * (the planner/runner write their own latest-plan / latest-dry-run / latest-apply files.)
 *
 * Usage:
 *   npx tsx scripts/gigaAutoPublishOrchestrator.ts --max-skus=50 --dry-run-only --summary
 *   npx tsx scripts/gigaAutoPublishOrchestrator.ts --max-skus=50 --apply-safe   --summary
 *
 * NO deploy, no App UI changes. Does not modify product data except through the runner's --apply.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const SUMMARY = argv.includes('--summary');
const DRY_ONLY = argv.includes('--dry-run-only');
const APPLY_SAFE = argv.includes('--apply-safe');
const maxArg = argv.find(a => a.startsWith('--max-skus='));
const MAX_SKUS = maxArg ? parseInt(maxArg.split('=')[1], 10) : NaN;

const REPORT_DIR = path.join(process.cwd(), 'reports', 'giga-auto-publish');
const PLAN_FILE = path.join('reports', 'giga-auto-publish', 'latest-plan.json');
const OUT_JSON = path.join(REPORT_DIR, 'latest-orchestrator.json');
const OUT_MD = path.join(REPORT_DIR, 'latest-orchestrator.md');
const rel = (p: string) => path.relative(process.cwd(), p);

// ── Guardrails ──────────────────────────────────────────────────────────────
function die(msg: string) { console.error(`[orchestrator] ${msg}`); process.exit(1); }
if (DRY_ONLY === APPLY_SAFE) die('require EXACTLY ONE of --dry-run-only or --apply-safe');
if (!Number.isInteger(MAX_SKUS) || MAX_SKUS <= 0) die('--max-skus=<positive integer> is required');

// Parse a child's "KEY=VALUE" compact summary lines into a map.
function parseKV(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([a-z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
function runChild(label: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('npx', ['tsx', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

(async () => {
  const log: string[] = [];
  const steps: Record<string, any> = {};
  let aborted: string | null = null;
  let applied = false;

  // ── Step 1: plan ──────────────────────────────────────────────────────────
  const plan = runChild('plan', ['scripts/planGigaAutoPublish.ts', `--max-skus=${MAX_SKUS}`, '--summary']);
  log.push(`### plan\nexit=${plan.status}\n${plan.stdout}\n${plan.stderr}`);
  if (plan.status !== 0) aborted = 'plan_failed';
  const planKV = parseKV(plan.stdout);
  steps.plan = planKV;
  const plannedSkus = parseInt(planKV.proposed_batch_skus ?? '0', 10) || 0;
  const expectedCards = parseInt(planKV.expected_app_card_delta ?? '0', 10) || 0;

  // ── Step 2: dry-run ─────────────────────────────────────────────────────────
  let dryKV: Record<string, string> = {};
  let dryPass = false, holdSkus = -1, stageFailures = 'unknown';
  if (!aborted) {
    if (plannedSkus === 0) {
      aborted = 'planned_skus_0';
    } else {
      const dry = runChild('dry-run', ['scripts/runGigaAutoPublish.ts', '--plan', PLAN_FILE, '--dry-run', '--summary']);
      log.push(`### dry-run\nexit=${dry.status}\n${dry.stdout}\n${dry.stderr}`);
      dryKV = parseKV(dry.stdout);
      steps.dryRun = dryKV;
      holdSkus = parseInt(dryKV.hold_skus ?? '-1', 10);
      stageFailures = dryKV.stage_failures ?? 'unknown';
      const passSkus = parseInt(dryKV.dry_run_pass_skus ?? '0', 10) || 0;
      dryPass = dry.status === 0 && holdSkus === 0 && stageFailures === 'none' && passSkus > 0;
      if (dry.status !== 0) aborted = aborted ?? 'dry_run_failed';
    }
  }

  // ── Step 3: apply (only --apply-safe AND clean dry-run) ──────────────────────
  let applyKV: Record<string, string> = {};
  if (APPLY_SAFE && !aborted) {
    if (!dryPass) {
      aborted = `dry_run_not_clean(hold_skus=${holdSkus},stage_failures=${stageFailures})`;
    } else {
      const ap = runChild('apply', ['scripts/runGigaAutoPublish.ts', '--plan', PLAN_FILE, '--apply', '--summary']);
      log.push(`### apply\nexit=${ap.status}\n${ap.stdout}\n${ap.stderr}`);
      applyKV = parseKV(ap.stdout);
      steps.apply = applyKV;
      applied = ap.status === 0 && (applyKV.top_risks === 'none');
      if (ap.status !== 0) aborted = 'apply_failed';
    }
  }

  // ── Reports ─────────────────────────────────────────────────────────────────
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const mode = DRY_ONLY ? 'dry-run-only' : 'apply-safe';
  const full = {
    note: 'Orchestrator run. Detailed per-stage reports in latest-plan/latest-dry-run/latest-apply.',
    mode, max_skus: MAX_SKUS, planned_skus: plannedSkus, expected_app_cards: expectedCards,
    dry_run: { pass: dryPass, hold_skus: holdSkus, stage_failures: stageFailures, summary: dryKV },
    apply: { ran: applied, summary: applyKV }, aborted, plan_summary: planKV, log,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(full, null, 2));
  fs.writeFileSync(OUT_MD, [
    '# GIGA Auto-Publish Orchestrator', '', `- mode: ${mode}`, `- max_skus: ${MAX_SKUS}`,
    `- planned_skus: ${plannedSkus}`, `- expected_app_cards: ${expectedCards}`,
    `- dry_run_pass: ${dryPass} (hold_skus=${holdSkus}, stage_failures=${stageFailures})`,
    `- applied: ${applied}`, `- aborted: ${aborted ?? 'no'}`, '',
    '## Stage logs', '', '```', ...log, '```',
  ].join('\n'));

  // ── Output ────────────────────────────────────────────────────────────────
  const dataWrites = applied ? 'yes (via runGigaAutoPublish --apply)' : 'none';
  if (SUMMARY) {
    console.log('ORCHESTRATOR_SUMMARY');
    console.log(`mode=${mode}`);
    console.log(`max_skus=${MAX_SKUS}`);
    console.log(`planned_skus=${plannedSkus}`);
    console.log(`expected_app_cards=${expectedCards}`);
    console.log(`dry_run_pass=${dryPass}`);
    console.log(`hold_skus=${holdSkus}`);
    console.log(`stage_failures=${stageFailures}`);
    console.log(`applied=${applied}`);
    console.log(`aborted=${aborted ?? 'no'}`);
    console.log(`sellable_after=${applyKV.sellable_after ?? 'n/a'}`);
    console.log(`product_reviews_after=${applyKV.product_reviews_after ?? 'n/a'}`);
    console.log(`data_writes=${dataWrites}`);
    console.log(`report_json=${rel(OUT_JSON)}`);
    console.log(`report_md=${rel(OUT_MD)}`);
  } else {
    console.log(`[orchestrator] mode=${mode} planned=${plannedSkus} cards=${expectedCards} dryPass=${dryPass} applied=${applied} aborted=${aborted ?? 'no'}`);
    console.log(`[orchestrator] reports: ${rel(OUT_JSON)} , ${rel(OUT_MD)}`);
  }
  // exit non-zero if an apply-safe run aborted or a requested stage failed
  if (aborted && !(DRY_ONLY && (aborted.startsWith('dry_run_not_clean')))) process.exit(APPLY_SAFE ? 2 : (plan.status !== 0 ? 1 : 0));
})().catch(e => { console.error('[orchestrator] fatal:', e instanceof Error ? e.message : e); process.exit(1); });
