/**
 * Discovery sniffer for GIGA's per-warehouse XHR.
 *
 * Opens a real Chrome window using the persistent profile, navigates to a
 * product detail page, clicks "Specified Warehouse" if available, and records
 * every XHR the page fires. After the warehouse table renders, prints each
 * XHR's URL/method/status/size and flags those whose response body contains
 * GIGA warehouse codes (CA, NJ, AT, TX prefixes).
 *
 * Run:
 *   npx tsx scripts/discoverGigaWarehouseXhr.ts --product-id 1064421
 *
 * Output:
 *   - A summary table to stdout.
 *   - tmp/giga-xhr-discovery.json    (full record of every XHR)
 *   - tmp/giga-xhr-discovery-<n>.json (body of each warehouse-flagged response)
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_FILE = process.env.GIGA_SESSION_FILE
  ?? path.join(process.cwd(), 'scripts', '.giga-session.json');

const PROFILE_DIR = process.env.GIGA_PROFILE_DIR
  ?? path.join(process.cwd(), 'scripts', '.giga-chrome-profile');

const WH_RE = /\b(CA[A-Z]*\d+|NJX\d+|NJ[A-Z]*\d+|AT[A-Z]*\d+|TX[A-Z]*\d+)\b/;

function parseArgs(argv: string[]): { id: string } {
  let id = '1064421';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--product-id' || argv[i] === '--id') id = argv[++i] ?? id;
  }
  if (process.env.PRODUCT_ID) id = process.env.PRODUCT_ID;
  return { id };
}

interface XhrRecord {
  index: number;
  method: string;
  url: string;
  status: number | null;
  contentType: string;
  bodyLen: number;
  bodyPreview: string;
  hasWarehouseCode: boolean;
  postData: string | null;
  responsePath: string | null;
}

async function run() {
  const { id } = parseArgs(process.argv.slice(2));
  const productUrl = `https://www.gigab2b.com/index.php?route=product/product&product_id=${id}`;

  const { chromium } = await import('playwright');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), 'tmp'), { recursive: true });

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: 'chrome',
      viewport: null,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: null,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  }

  // Seed cookies from saved storageState the first time we use this profile.
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      const cookies = (state.cookies ?? []).filter((c: { domain: string }) =>
        /(^|\.)gigab2b\.com$/.test(c.domain),
      );
      if (cookies.length > 0) await context.addCookies(cookies);
    } catch { /* ignore */ }
  }

  const page = context.pages()[0] ?? await context.newPage();
  const records: XhrRecord[] = [];
  let counter = 0;

  page.on('response', async (response) => {
    const url = response.url();
    // Only record XHR/fetch endpoints on gigab2b.com (skip images/css/font)
    if (!/gigab2b\.com\/index\.php\?route=/i.test(url)) return;
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|woff2?|ttf|ico)(?:\?|$)/i.test(url)) return;

    const rec: XhrRecord = {
      index: ++counter,
      method: response.request().method(),
      url,
      status: response.status(),
      contentType: response.headers()['content-type'] ?? '',
      bodyLen: 0,
      bodyPreview: '',
      hasWarehouseCode: false,
      postData: response.request().postData(),
      responsePath: null,
    };

    try {
      const buf = await response.body();
      const text = buf.toString('utf8');
      rec.bodyLen = text.length;
      rec.bodyPreview = text.slice(0, 200).replace(/\s+/g, ' ');
      rec.hasWarehouseCode = WH_RE.test(text);
      if (rec.hasWarehouseCode) {
        const dumpPath = path.join(process.cwd(), 'tmp', `giga-xhr-discovery-${rec.index}.json`);
        fs.writeFileSync(dumpPath, text);
        rec.responsePath = dumpPath;
      }
    } catch { /* response body unavailable */ }

    records.push(rec);
  });

  console.log(`\n[discover] Navigating to ${productUrl}`);
  try {
    await page.goto(productUrl, { waitUntil: 'networkidle', timeout: 60_000 });
  } catch (err) {
    console.warn('[discover] navigation timed out:', err instanceof Error ? err.message : err);
  }

  await page.waitForTimeout(2_000);

  // Try clicking the "Specified Warehouse" radio if it exists. It can appear
  // under different labels in the new UI — try a few selectors in order.
  const candidates = [
    'label:has-text("Specified Warehouse")',
    'text=Specified Warehouse',
    'text=Warehouse Quantity',
    '[class*="specified"]',
  ];
  let clicked = false;
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) {
        await loc.click({ trial: false, timeout: 5_000 });
        console.log(`[discover] Clicked: ${sel}`);
        clicked = true;
        break;
      }
    } catch { /* try next */ }
  }
  if (!clicked) {
    console.log('[discover] No "Specified Warehouse" affordance found — scrolling page to trigger lazy XHRs');
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight / 2 }));
    await page.waitForTimeout(2_000);
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight }));
  }

  // Wait for any warehouse text to appear OR for a deadline so we capture
  // whatever XHRs fire in response to the click/scroll.
  try {
    await page.waitForFunction(
      () => {
        const t = document.body.innerText;
        return /\b(?:CA|NJ|AT|TX)[A-Z]*\d+\b/.test(t) && /Warehouse|warehouse/.test(t);
      },
      { timeout: 12_000 },
    );
  } catch { /* fine */ }

  await page.waitForTimeout(2_000);

  // Final dump
  const indexPath = path.join(process.cwd(), 'tmp', 'giga-xhr-discovery.json');
  fs.writeFileSync(indexPath, JSON.stringify(records, null, 2));

  console.log(`\n[discover] Captured ${records.length} XHR(s). Index → ${indexPath}\n`);
  const withWh = records.filter(r => r.hasWarehouseCode);
  console.log(`[discover] XHRs containing warehouse codes: ${withWh.length}\n`);

  console.log('─── XHRs by index ───────────────────────────────────────────');
  for (const r of records) {
    const tag = r.hasWarehouseCode ? '★' : ' ';
    const shortUrl = r.url.replace(/^https:\/\/www\.gigab2b\.com\/index\.php\?/, '');
    console.log(
      ` ${tag} #${String(r.index).padStart(3)}  ${r.method.padEnd(4)} ${String(r.status ?? '-').padStart(3)}  ` +
      `${String(r.bodyLen).padStart(6)}B  ${shortUrl.slice(0, 110)}`,
    );
  }

  if (withWh.length > 0) {
    console.log('\n─── Warehouse-bearing XHRs (dumped to tmp/) ────────────────');
    for (const r of withWh) {
      console.log(`  #${r.index}  ${r.method} ${r.url}`);
      if (r.responsePath) console.log(`        body: ${r.responsePath}`);
      console.log(`        preview: ${r.bodyPreview}`);
    }
  } else {
    console.log('\n[discover] No warehouse codes found in any XHR — increase wait or try a different product.');
  }

  await context.close();
}

run().catch(err => {
  console.error('[discover] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
