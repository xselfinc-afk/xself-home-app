/**
 * adminGigaServer.ts — localhost-only admin API for GIGA Auto Publish (Phase 1: read-only + Dry Run).
 *
 * Holds secrets server-side (.env.local / .env) and shells the committed orchestrator. The browser
 * (admin/orders.html, served same-origin from here) only calls /giga/* endpoints — NO service_role
 * or GIGA secret ever reaches the client. Binds 127.0.0.1 only.
 *
 * Phase 1 endpoints (NO apply / NO write path):
 *   GET  /                      → serves admin/orders.html (same-origin)
 *   GET  /giga/status           → live sellable/review counts + latest plan/dry-run/apply/orchestrator summaries + held SKUs
 *   GET  /giga/holds            → held SKUs/reasons from latest reports
 *   GET  /giga/report?type=plan|dry-run|apply|orchestrator → compact report JSON (logs/units stripped)
 *   POST /giga/dry-run          → start a background dry-run-only job → { jobId } (concurrency-locked)
 *   GET  /giga/job/:id          → { state: running|done|failed, summary{}, errorTail? }
 *
 * Run: npm run admin:giga   (then open the printed http://127.0.0.1:<port>/ )
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.ADMIN_GIGA_PORT ?? '8799', 10);
const REPORTS = path.join(process.cwd(), 'reports', 'giga-auto-publish');
const ADMIN_HTML = path.join(process.cwd(), 'admin', 'orders.html');

const SUPA_URL = process.env.SUPABASE_URL ?? '';
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const sb = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } }) : null;

// ── helpers ──────────────────────────────────────────────────────────────────
function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(path.join(REPORTS, file), 'utf8')); } catch { return null; }
}
function parseKV(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) { const m = line.match(/^([a-z_]+)=(.*)$/); if (m) out[m[1]] = m[2]; }
  return out;
}
function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}
// Strip large arrays so the browser never receives huge logs.
function compact(report: any): any {
  if (!report || typeof report !== 'object') return report;
  const { log: _l, units: _u, candidates: _c, ...rest } = report;
  return rest;
}
function heldFromReports(): Array<{ sku: string; reason: string; source: string }> {
  const out: Array<{ sku: string; reason: string; source: string }> = [];
  const orch = readJson('latest-orchestrator.json');
  if (orch?.held_skus?.length) {
    const reasons = Object.keys(orch.held_reasons ?? {}).join(',') || 'held';
    for (const sku of orch.held_skus) out.push({ sku, reason: reasons, source: 'orchestrator' });
  }
  const dry = readJson('latest-dry-run.json');
  for (const u of (dry?.units ?? [])) {
    if (u.held) for (const sku of u.skus) if (!out.some(h => h.sku === sku)) out.push({ sku, reason: (u.reasons ?? []).join(';') || 'held', source: 'dry-run' });
  }
  return out;
}

// ── background job registry (in-memory) + concurrency lock ──────────────────
type Job = { id: string; state: 'running' | 'done' | 'failed'; summary: Record<string, string>; errorTail?: string; startedAt: number };
const jobs = new Map<string, Job>();
let running: string | null = null;

function startDryRun(): Job | { error: string } {
  if (running) return { error: 'a job is already running' };
  const id = `dry-${Date.now()}`;
  const job: Job = { id, state: 'running', summary: {}, startedAt: Date.now() };
  jobs.set(id, job);
  running = id;
  const child = spawn('npx', ['tsx', 'scripts/gigaAutoPublishOrchestrator.ts', '--max-skus=50', '--dry-run-only', '--summary'], { cwd: process.cwd() });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.on('close', code => {
    job.summary = parseKV(stdout);
    if (code === 0) job.state = 'done';
    else { job.state = 'failed'; job.errorTail = (stderr || stdout).slice(-800); }
    running = null;
  });
  child.on('error', err => { job.state = 'failed'; job.errorTail = String(err).slice(-800); running = null; });
  return job;
}

// ── routing ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const p = url.pathname;
  try {
    // serve admin same-origin
    if (req.method === 'GET' && (p === '/' || p === '/admin' || p === '/admin/orders.html')) {
      if (!fs.existsSync(ADMIN_HTML)) return send(res, 404, 'admin/orders.html not found', 'text/plain');
      return send(res, 200, fs.readFileSync(ADMIN_HTML, 'utf8'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && p === '/giga/status') {
      let sellable: number | null = null, reviews: number | null = null;
      if (sb) {
        const s = await sb.from('sellable_products').select('*', { count: 'exact', head: true });
        const r = await sb.from('product_reviews').select('*', { count: 'exact', head: true });
        sellable = s.count ?? null; reviews = r.count ?? null;
      }
      const plan = readJson('latest-plan.json');
      const dry = readJson('latest-dry-run.json');
      const apply = readJson('latest-apply.json');
      const orch = readJson('latest-orchestrator.json');
      return send(res, 200, {
        sellable_products: sellable,
        product_reviews: reviews,
        latest_plan: plan ? { planned_skus: plan.proposed_batch?.sku_count ?? null, planned_cards: plan.proposed_batch?.card_count ?? null, buckets: plan.buckets ?? null } : null,
        latest_dry_run: dry ? { pass_skus: dry.result?.dry_run_pass_skus ?? null, pass_cards: dry.result?.dry_run_pass_cards ?? null, hold_skus: dry.result?.hold_skus ?? null, stage_failures: dry.stage_failures ?? null } : null,
        latest_apply: apply ? { reached_stage: apply.reached_stage ?? null, results: apply.results ?? null, catalog: apply.catalog ?? null } : null,
        latest_orchestrator: orch ? { mode: orch.mode, applied: orch.applied, held_skus: orch.held_skus ?? [], held_reasons: orch.held_reasons ?? {}, clean_subset: orch.clean_subset ?? null } : null,
        held: heldFromReports(),
        job_running: running != null,
      });
    }

    if (req.method === 'GET' && p === '/giga/holds') return send(res, 200, { held: heldFromReports() });

    if (req.method === 'GET' && p === '/giga/report') {
      const type = url.searchParams.get('type') ?? 'orchestrator';
      const file = { plan: 'latest-plan.json', 'dry-run': 'latest-dry-run.json', apply: 'latest-apply.json', orchestrator: 'latest-orchestrator.json' }[type];
      if (!file) return send(res, 400, { error: 'type must be plan|dry-run|apply|orchestrator' });
      const data = readJson(file);
      if (!data) return send(res, 404, { error: `no ${type} report yet` });
      return send(res, 200, compact(data));
    }

    if (req.method === 'POST' && p === '/giga/dry-run') {
      const r = startDryRun();
      if ('error' in r) return send(res, 423, r); // 423 Locked
      return send(res, 202, { jobId: r.id, state: r.state });
    }

    if (req.method === 'GET' && p.startsWith('/giga/job/')) {
      const id = p.slice('/giga/job/'.length);
      const job = jobs.get(id);
      if (!job) return send(res, 404, { error: 'unknown job' });
      return send(res, 200, { state: job.state, summary: job.summary, errorTail: job.state === 'failed' ? job.errorTail : undefined });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: e instanceof Error ? e.message : 'server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[admin-giga] localhost-only server on http://${HOST}:${PORT}/`);
  console.log(`[admin-giga] open the admin at  http://${HOST}:${PORT}/`);
  console.log(`[admin-giga] supabase counts: ${sb ? 'enabled (service role, server-side)' : 'DISABLED (no SUPABASE creds)'}`);
});
