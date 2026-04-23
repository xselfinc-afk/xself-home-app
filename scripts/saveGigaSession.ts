/**
 * Step 1 (one-time): Open the GIGA seller portal in a visible browser,
 * let you log in manually, then save the authenticated session to disk.
 *
 * The saved session file is loaded by scrapeGigaInventory.ts so you
 * don't need to log in again on subsequent runs (until the session expires).
 *
 * Run:
 *   GIGA_LOGIN_URL="https://www.gigab2b.com/index.php?route=common/home" \
 *     npx tsx scripts/saveGigaSession.ts
 *
 * Env vars:
 *   GIGA_LOGIN_URL   — (REQUIRED) the URL to open in the browser for login
 *   GIGA_SESSION_FILE — where to write the session (default: scripts/.giga-session.json)
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import * as path from 'path';
import * as readline from 'readline';

const LOGIN_URL = process.env.GIGA_LOGIN_URL ?? '';
const SESSION_FILE = process.env.GIGA_SESSION_FILE
  ?? path.join(process.cwd(), 'scripts', '.giga-session.json');

if (!LOGIN_URL) {
  console.error(
    '[saveGigaSession] ERROR: GIGA_LOGIN_URL is not set.\n' +
    '  Example:\n' +
    '    GIGA_LOGIN_URL="https://www.gigab2b.com/index.php?route=common/home" \\\n' +
    '      npx tsx scripts/saveGigaSession.ts',
  );
  process.exit(1);
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function run() {
  console.log('\n[saveGigaSession] Opening headed browser at:', LOGIN_URL);
  console.log('[saveGigaSession] Session will be saved to:', SESSION_FILE);
  console.log('');

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Log in to the GIGA seller portal in the browser window.');
  console.log('  Complete any 2FA / CAPTCHA steps if required.');
  console.log('  Once you are on the logged-in dashboard, press Enter here.');
  console.log('═══════════════════════════════════════════════════════════');
  await waitForEnter('\nPress Enter after you have logged in → ');

  const currentUrl = page.url();
  console.log('\n[saveGigaSession] Current URL after login:', currentUrl);

  await context.storageState({ path: SESSION_FILE });
  console.log('[saveGigaSession] Session saved to:', SESSION_FILE);
  console.log('[saveGigaSession] You can now run the scraper:');
  console.log('  npx tsx scripts/scrapeGigaInventory.ts PRODUCT_URL=<url>');

  await browser.close();
}

run().catch(err => {
  console.error('[saveGigaSession] Error:', err.message);
  process.exit(1);
});
