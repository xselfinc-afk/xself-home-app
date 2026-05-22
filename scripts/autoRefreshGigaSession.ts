/**
 * Non-interactive GIGA session refresher.
 *
 * Launches headless Chromium with the persistent profile that
 * refreshGigaSession.ts manages, and tries to silently re-export the
 * Playwright storageState to scripts/.giga-session.json. Designed to be
 * invoked from runGigaInventorySync.sh when the daily sync detects
 * "Session expired" — this is the auto-healing path.
 *
 * Exits 0 on success, non-zero if the profile no longer has a valid login
 * (i.e. GIGA logged us out and a captcha / password is required). Never
 * prompts. Never prints cookies, session JSON, or any secret material.
 *
 * Run:
 *   npx tsx scripts/autoRefreshGigaSession.ts
 */

import { chromium, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ROOT = process.cwd();
const SESSION_FILE = path.join(PROJECT_ROOT, 'scripts', '.giga-session.json');
const PROFILE_DIR  = path.join(PROJECT_ROOT, 'scripts', '.giga-chrome-profile');
const ACCOUNT_URL  = 'https://www.gigab2b.com/index.php?route=account/account';

function info(msg: string): void { console.log(`[auto-refresh] ${msg}`); }
function err(msg: string): void  { console.error(`[auto-refresh] ✗ ${msg}`); }

async function isLoggedIn(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  try {
    await page.goto(ACCOUNT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (/login|sign[-_]?in/i.test(page.url())) return false;
    const text: string = await page.evaluate(
      () => (document.body?.innerText ?? '').slice(0, 2000),
    );
    const hasLoginCta    = /\b(log\s*in|sign\s*in|password)\b/i.test(text);
    const hasLoggedInCta = /\b(log\s*out|sign\s*out|my\s*account|dashboard)\b/i.test(text);
    return hasLoggedInCta || !hasLoginCta;
  } catch {
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(PROFILE_DIR)) {
    err(`Persistent profile not found at ${PROFILE_DIR}.`);
    err("Run 'npm run giga:refresh-session' once interactively to seed it.");
    process.exit(2);
  }

  info('Launching headless Chromium with persistent profile…');
  const context: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    if (!(await isLoggedIn(context))) {
      err('Session cannot be auto-refreshed — login or captcha is required.');
      err("Run 'npm run giga:refresh-session' from a terminal to log in interactively.");
      process.exit(1);
    }
    info('Persistent profile is still logged in; re-exporting storageState…');
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    await context.storageState({ path: SESSION_FILE });
    info(`Session file refreshed: ${path.relative(PROJECT_ROOT, SESSION_FILE)}`);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(e => {
  err(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
