/**
 * Automated GIGA session refresh.
 *
 * One command does everything:
 *   1. Verifies the GitHub CLI is logged in.
 *   2. Opens a real Chromium window with a persistent profile so prior logins
 *      survive between runs (no DevTools cookie copy required).
 *   3. If you're not logged into GIGA, pauses and asks you to log in.
 *   4. Verifies the session by hitting a known account/product page.
 *   5. Saves the Playwright storageState to scripts/.giga-session.json.
 *   6. Validates by running the existing sync in DRY_RUN mode (no DB writes).
 *   7. base64-encodes the session and pushes it to the GitHub secret
 *      GIGA_SESSION_B64 via the GitHub CLI (over stdin, never as a CLI arg).
 *   8. Triggers the "Sync GIGA Inventory" workflow and watches the run.
 *
 * Never prints cookie values, session JSON, or the base64 payload.
 *
 * Run:
 *   npm run giga:refresh-session
 */

import * as dotenv from 'dotenv';
import { chromium, BrowserContext } from 'playwright';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// Load env vars from .env.local first (script-only secrets — SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY), then .env as fallback. dotenv does NOT
// overwrite already-set keys, so .env.local wins over .env, and any var
// already exported in the shell wins over both.
dotenv.config({ path: path.join(process.cwd(), '.env.local') });
dotenv.config({ path: path.join(process.cwd(), '.env') });

// ── Config ────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();
const SESSION_FILE = path.join(PROJECT_ROOT, 'scripts', '.giga-session.json');
const PROFILE_DIR  = path.join(PROJECT_ROOT, 'scripts', '.giga-chrome-profile');

const HOME_URL    = 'https://www.gigab2b.com/index.php?route=common/home';
const ACCOUNT_URL = 'https://www.gigab2b.com/index.php?route=account/account';
// Known product / search URL — used as a positive smoke test after login.
const SMOKE_URL   = 'https://www.gigab2b.com/index.php?route=product/search&search=N725S412541K';

const SECRET_NAME   = 'GIGA_SESSION_B64';
const WORKFLOW_NAME = 'Sync GIGA Inventory';

// ── Tiny logging helpers (intentionally never log secrets) ────────────────────

function info(msg: string): void { console.log(`[refresh] ${msg}`); }
function warn(msg: string): void { console.warn(`[refresh] ⚠ ${msg}`); }
function fail(msg: string, code = 1): never {
  console.error(`[refresh] ✗ ${msg}`);
  process.exit(code);
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

// ── Auth + login helpers ──────────────────────────────────────────────────────

function ghAuthOk(): boolean {
  const r = spawnSync('gh', ['auth', 'status'], { stdio: 'pipe' });
  return r.status === 0;
}

async function isLoggedIn(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  try {
    await page.goto(ACCOUNT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const finalUrl = page.url();
    if (/login|sign[-_]?in/i.test(finalUrl)) return false;

    const text: string = await page.evaluate(
      () => (document.body?.innerText ?? '').slice(0, 2000),
    );
    const hasLoginCta = /\b(log\s*in|sign\s*in|password)\b/i.test(text);
    const hasLogoutCta = /\b(log\s*out|sign\s*out|my\s*account|dashboard)\b/i.test(text);
    return hasLogoutCta || !hasLoginCta;
  } catch (e) {
    warn(`account-page check failed: ${(e as Error).message.slice(0, 120)}`);
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Child-process helpers ─────────────────────────────────────────────────────

interface RunResult { code: number; output: string }

function runStreaming(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...(opts.env ?? {}) },
      cwd: opts.cwd ?? PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', d => { const s = d.toString(); output += s; process.stdout.write(s); });
    child.stderr?.on('data', d => { const s = d.toString(); output += s; process.stderr.write(s); });
    child.on('close', code => resolve({ code: code ?? 1, output }));
  });
}

// Push the base64 payload to the GitHub secret over STDIN so it never
// lands in shell history, ps output, or any log.
function setGitHubSecret(secretName: string, value: string): Promise<{ code: number; errText: string }> {
  return new Promise(resolve => {
    // Older `gh` versions don't support `--body-file -`. Omit body flags
    // entirely so `gh secret set` reads the value from stdin instead.
    const child = spawn('gh', ['secret', 'set', secretName], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let combined = '';
    child.stdout?.on('data', d => { combined += d.toString(); });
    child.stderr?.on('data', d => { combined += d.toString(); });
    child.on('close', code => resolve({ code: code ?? 1, errText: combined }));
    child.stdin?.write(value);
    child.stdin?.end();
  });
}

// Parse the inventory-sync output to decide if the session truly works.
// We require: no "Session expired" line AND at least one product succeeded.
function validationOk(output: string): { ok: boolean; reason: string } {
  if (/Session expired|FAILED:\s*GIGA session expired/i.test(output)) {
    return { ok: false, reason: 'Session expired during validation' };
  }
  const m = output.match(/Products\s+succeeded\s*:\s*(\d+)/i);
  const succeeded = m ? parseInt(m[1], 10) : 0;
  if (succeeded < 1) {
    return { ok: false, reason: 'Validation found 0 products succeeded' };
  }
  return { ok: true, reason: `validated (${succeeded} product(s) succeeded)` };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  info('────────────────────────────────────────────────────────────');
  info(' GIGA session refresh');
  info('────────────────────────────────────────────────────────────');

  // 0) Pre-flight: GitHub CLI must be authenticated.
  if (!ghAuthOk()) {
    fail(
      'GitHub CLI is not authenticated.\n' +
      '       Run `gh auth login` first, then re-run `npm run giga:refresh-session`.',
    );
  }
  info('GitHub CLI ready');

  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  // 1) Launch a real Chromium with a persistent profile.
  info('Launching Chromium (persistent profile)…');
  const context: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const startPage = context.pages()[0] ?? (await context.newPage());
    info(`Opening ${HOME_URL}`);
    await startPage.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});

    // 2) Detect login. If not logged in, hand the keyboard to the user.
    let loggedIn = await isLoggedIn(context);
    if (loggedIn) {
      info('Already signed in (persistent profile reused).');
    } else {
      console.log('');
      console.log('────────────────────────────────────────────────────────────');
      console.log(' Not signed into GIGA.');
      console.log(' Please log in to GIGA in the opened browser,');
      console.log(' then press Enter here.');
      console.log('────────────────────────────────────────────────────────────');
      console.log('');
      await waitForEnter('Press Enter when you have finished logging in: ');
      loggedIn = await isLoggedIn(context);
    }

    if (!loggedIn) {
      fail('GIGA login still not detected — aborting before any secret update.');
    }

    // 3) Smoke-test a product/search page in the SAME context.
    info('Smoke-testing a product search page…');
    const smoke = await context.newPage();
    try {
      await smoke.goto(SMOKE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (/login|sign[-_]?in/i.test(smoke.url())) {
        fail('Smoke test redirected to login — session not valid.');
      }
    } finally {
      await smoke.close().catch(() => {});
    }

    // 4) Dump storageState to scripts/.giga-session.json.
    info(`Writing storageState → ${path.relative(PROJECT_ROOT, SESSION_FILE)}`);
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    await context.storageState({ path: SESSION_FILE });
  } finally {
    await context.close().catch(() => {});
  }

  // 5) Validate by invoking the existing sync script in DRY_RUN mode.
  //    Resolve the Supabase script credentials from .env.local / .env. These
  //    are required by syncGigaFurnitureInventory.ts to load product list and
  //    confirm DB connectivity (DRY_RUN skips writes but still SELECTs).
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const missing: string[] = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!supabaseKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) {
    fail(
      `Missing required env var(s) before validation: ${missing.join(', ')}.\n` +
      `       Add them to .env.local (preferred) or .env at the repo root, then re-run.\n` +
      `       Example .env.local entries (do NOT commit):\n` +
      `         SUPABASE_URL=https://<id>.supabase.co\n` +
      `         SUPABASE_SERVICE_ROLE_KEY=<service-role-key>\n` +
      `       NOTE: the GitHub secret is intentionally NOT updated when env is incomplete.`,
    );
  }
  info('Validating: DRY_RUN=1 INVENTORY_LIMIT=2 HEADED=1 (no DB writes)…');
  const validation = await runStreaming(
    'npx',
    ['tsx', 'scripts/syncGigaFurnitureInventory.ts'],
    {
      env: {
        DRY_RUN: '1',
        INVENTORY_LIMIT: '2',
        HEADED: '1',
        GIGA_SESSION_FILE: SESSION_FILE,
        SUPABASE_URL: supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: supabaseKey,
      },
    },
  );

  if (validation.code !== 0) {
    fail(`Validation exited with code ${validation.code}. NOT updating GitHub secret.`);
  }
  const verdict = validationOk(validation.output);
  if (!verdict.ok) {
    fail(`${verdict.reason}. NOT updating GitHub secret.`);
  }
  info(`Validation passed — ${verdict.reason}`);

  // 6) Encode + push secret (never printed to logs).
  info('Encoding session and updating GitHub secret…');
  const sessionBuf = fs.readFileSync(SESSION_FILE);
  const b64 = sessionBuf.toString('base64');

  const setResult = await setGitHubSecret(SECRET_NAME, b64);
  if (setResult.code !== 0) {
    fail(`gh secret set failed (${setResult.code}): ${setResult.errText.slice(0, 400)}`);
  }
  info(`GitHub secret ${SECRET_NAME} updated`);

  // 7) Trigger the workflow.
  info(`Triggering workflow "${WORKFLOW_NAME}"…`);
  const trigger = await runStreaming('gh', ['workflow', 'run', WORKFLOW_NAME]);
  if (trigger.code !== 0) {
    fail(`gh workflow run failed (${trigger.code}). Check 'gh workflow list'.`);
  }

  // 8) Give the run a moment to materialize, then auto-watch the latest one.
  await new Promise(r => setTimeout(r, 4000));
  info('Watching the latest run (Ctrl+C to detach — the run will keep going)…');

  const list = spawnSync(
    'gh',
    ['run', 'list', '--workflow', WORKFLOW_NAME, '--limit', '1', '--json', 'databaseId'],
    { cwd: PROJECT_ROOT, encoding: 'utf8' },
  );

  let runId: string | null = null;
  if (list.status === 0 && list.stdout) {
    try {
      const arr = JSON.parse(list.stdout) as Array<{ databaseId: number }>;
      if (arr.length > 0) runId = String(arr[0].databaseId);
    } catch {
      // ignore — fall through to interactive `gh run watch`
    }
  }

  if (runId) {
    await runStreaming('gh', ['run', 'watch', runId, '--exit-status']);
  } else {
    await runStreaming('gh', ['run', 'watch']);
  }

  info('Done.');
}

main().catch(e => {
  const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
  console.error(`[refresh] Fatal: ${msg}`);
  process.exit(1);
});
