/**
 * Production guardrails for Xself Home.
 *
 * Encodes every regression we've already paid for so the same break can never
 * ship twice. Run before every commit that touches payment / checkout /
 * inventory / fulfillment / admin / native iOS, and at the end of every
 * automated coding-agent task (Claude Code, Codex, etc.).
 *
 * Usage:
 *   npm run guard:prod
 *   npm run verify:before-final
 *
 * Exit codes:
 *   0  All guards pass.
 *   1  At least one guard failed.
 *
 * Adding a new guard
 * ------------------
 * Add a `check('Category name', () => string[])` block below. Return an empty
 * array on success, or one descriptive string per failure
 * (format: "<file>: <missing pattern>").
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = process.cwd();

interface CheckResult {
  category: string;
  status: 'PASS' | 'FAIL';
  failures: string[];
}

const results: CheckResult[] = [];

// ── Helpers ──────────────────────────────────────────────────────────────────

function read(rel: string): string | null {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(ROOT, rel));
}

function check(category: string, run: () => string[]): void {
  let failures: string[];
  try {
    failures = run();
  } catch (e) {
    failures = [`exception: ${(e as Error).message}`];
  }
  results.push({
    category,
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    failures,
  });
}

function listFilesRecursive(rel: string, predicate: (file: string) => boolean): string[] {
  const root = path.join(ROOT, rel);
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  (function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'Pods' || entry.name === '.git') continue;
        walk(full);
      } else if (entry.isFile() && predicate(full)) {
        out.push(path.relative(ROOT, full));
      }
    }
  })(root);
  return out;
}

function fileMust(rel: string, ...needles: (string | RegExp)[]): string[] {
  const text = read(rel);
  if (text === null) return [`${rel}: file missing`];
  const out: string[] = [];
  for (const n of needles) {
    const re = typeof n === 'string'
      ? new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      : n;
    if (!re.test(text)) out.push(`${rel}: missing pattern ${n.toString()}`);
  }
  return out;
}

// ── Check 1: Apple Pay iOS capability ───────────────────────────────────────

check('Apple Pay iOS capability', () => {
  const failures: string[] = [];
  failures.push(...fileMust(
    'ios/XselfHome/XselfHome.entitlements',
    'com.apple.developer.in-app-payments',
    'merchant.com.xself.home',
  ));
  failures.push(...fileMust(
    'ios/XselfHome.xcodeproj/project.pbxproj',
    'CODE_SIGN_ENTITLEMENTS',
  ));
  failures.push(...fileMust(
    'app.json',
    'merchant.com.xself.home',
    '@stripe/stripe-react-native',
  ));
  return failures;
});

// ── Check 2: Affirm redirect ────────────────────────────────────────────────

check('Affirm redirect', () => {
  const failures: string[] = [];
  failures.push(...fileMust(
    'ios/XselfHome/Info.plist',
    'CFBundleURLTypes',
    /xselfhome/,
  ));
  failures.push(...fileMust(
    'App.tsx',
    /urlScheme\s*=\s*["']xselfhome["']/,
  ));
  return failures;
});

// ── Frontend scope helper used by Stripe + Supabase safety ──────────────────
// Frontend = anything that ships to the React Native bundle or the static
// admin page. Edge functions (supabase/functions/**) live on the server and
// legitimately reference STRIPE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY.
function frontendFiles(): string[] {
  const out: string[] = [];
  out.push(...listFilesRecursive('src',   f => /\.(ts|tsx|js|json|html)$/.test(f)));
  out.push(...listFilesRecursive('admin', f => /\.(ts|tsx|js|json|html)$/.test(f)));
  if (exists('App.tsx'))  out.push('App.tsx');
  if (exists('app.json')) out.push('app.json');
  // Test files (src/__tests__) are NOT part of the shipped app bundle — exclude them from the
  // "frontend bundle" secret/import checks (they run in Node/CI, never embedded in the app).
  return out.filter(f => !/(^|\/)__tests__\//.test(f));
}

// ── Check 3: Stripe safety ──────────────────────────────────────────────────

check('Stripe safety', () => {
  const failures: string[] = [];

  // (a) No server secret references in frontend files.
  const FORBIDDEN: Array<{ re: RegExp; name: string }> = [
    { re: /STRIPE_SECRET_KEY/,         name: 'STRIPE_SECRET_KEY' },
    { re: /SUPABASE_SERVICE_ROLE_KEY/, name: 'SUPABASE_SERVICE_ROLE_KEY' },
    { re: /sk_live_[A-Za-z0-9]/,       name: 'sk_live_… (Stripe live secret)' },
    { re: /sk_test_[A-Za-z0-9]/,       name: 'sk_test_… (Stripe test secret)' },
  ];
  for (const file of frontendFiles()) {
    const text = read(file);
    if (text === null) continue;
    for (const f of FORBIDDEN) {
      if (f.re.test(text)) failures.push(`${file}: contains forbidden ${f.name}`);
    }
  }

  // (b) StripeProvider is mounted.
  failures.push(...fileMust('App.tsx', /<StripeProvider\b/));

  // (c) create-checkout-order still supports both card + affirm and attaches
  //     shipping for Affirm.
  failures.push(...fileMust(
    'supabase/functions/create-checkout-order/index.ts',
    /payment_method_types\[\][\s\S]{0,40}['"]card['"]/,
    /payment_method_types\[\][\s\S]{0,40}['"]affirm['"]/,
    /shipping\[name\]/,
    /shipping\[address\]\[line1\]/,
  ));

  return failures;
});

// ── Check 4: Supabase safety ───────────────────────────────────────────────

check('Supabase safety', () => {
  const failures: string[] = [];

  // (a) No service-role key in frontend.
  for (const file of frontendFiles()) {
    const text = read(file);
    if (text === null) continue;
    if (/SUPABASE_SERVICE_ROLE_KEY/.test(text)) {
      failures.push(`${file}: contains forbidden SUPABASE_SERVICE_ROLE_KEY`);
    }
  }

  // (b) Supabase client uses EXPO_PUBLIC_* env vars.
  const supabaseClient = read('src/lib/supabase.ts');
  if (supabaseClient === null) {
    failures.push('src/lib/supabase.ts: file missing');
  } else {
    if (!/EXPO_PUBLIC_SUPABASE_URL/.test(supabaseClient)) {
      failures.push('src/lib/supabase.ts: missing EXPO_PUBLIC_SUPABASE_URL reference');
    }
    if (!/EXPO_PUBLIC_SUPABASE_ANON_KEY/.test(supabaseClient)) {
      failures.push('src/lib/supabase.ts: missing EXPO_PUBLIC_SUPABASE_ANON_KEY reference');
    }
  }

  return failures;
});

// ── Check 5: Checkout inventory error handling ─────────────────────────────

check('Checkout inventory error handling', () => {
  const text = read('src/screens/CheckoutScreen.tsx');
  if (text === null) return ['src/screens/CheckoutScreen.tsx: file missing'];
  const failures: string[] = [];
  const STATUSES = [
    'inventory_unavailable',
    'warehouse_data_unavailable',
    'stale_inventory',
    'no_inventory',
    'insufficient_qty',
  ];
  for (const s of STATUSES) {
    if (!text.includes(s)) {
      failures.push(`src/screens/CheckoutScreen.tsx: missing inventory status "${s}"`);
    }
  }
  // The inventory branch must route to setIsInventoryStale, not to
  // setDeliveryErrorKind('geocode_failed'). Crude proxy: confirm
  // inventory_unavailable lives close to setIsInventoryStale.
  if (!/inventory_unavailable[\s\S]{0,500}setIsInventoryStale/.test(text)) {
    failures.push(
      'src/screens/CheckoutScreen.tsx: inventory_unavailable is not routed to setIsInventoryStale ' +
      '(may fall through to geocode/address error)',
    );
  }
  return failures;
});

// ── Check 6: Inventory sync automation ─────────────────────────────────────

check('Inventory sync automation', () => {
  const failures: string[] = [];
  for (const f of [
    'scripts/syncGigaFurnitureInventory.ts',
    'scripts/runGigaInventorySync.sh',
    'scripts/autoRefreshGigaSession.ts',
  ]) {
    if (!exists(f)) failures.push(`${f}: file missing`);
  }
  const pkgText = read('package.json');
  let scripts: Record<string, string> = {};
  if (pkgText) {
    try { scripts = (JSON.parse(pkgText)?.scripts ?? {}) as Record<string, string>; }
    catch (e) { failures.push(`package.json: JSON parse failed — ${(e as Error).message}`); }
  } else {
    failures.push('package.json: file missing');
  }
  for (const s of [
    'inventory:sync',
    'inventory:run-now-local',
    'inventory:install-local',
    'giga:refresh-session',
  ]) {
    if (!scripts[s]) failures.push(`package.json: missing script "${s}"`);
  }

  const sync = read('scripts/syncGigaFurnitureInventory.ts') ?? '';
  const OOS_SIGNALS = [
    '0 Available',
    'Warehouse Quantity',
    'Total Item Cost',
    'Buy/AddToCart disabled',
  ];
  for (const sig of OOS_SIGNALS) {
    if (!sync.includes(sig)) {
      failures.push(`scripts/syncGigaFurnitureInventory.ts: missing OOS signal "${sig}"`);
    }
  }

  const runner = read('scripts/runGigaInventorySync.sh') ?? '';
  if (!/autoRefreshGigaSession/.test(runner) ||
      !/AUTO_RECOVERED/.test(runner) ||
      !/ACTION_REQUIRED/.test(runner)) {
    failures.push('scripts/runGigaInventorySync.sh: missing auto-refresh / auto-healing logic ' +
      '(autoRefreshGigaSession + AUTO_RECOVERED + ACTION_REQUIRED)');
  }

  return failures;
});

// ── Check 11: iOS native version sync + .easignore ─────────────────────────
// Two regressions this guard catches:
//   1. pbxproj MARKETING_VERSION/CURRENT_PROJECT_VERSION drifting behind
//      app.json — produces an .ipa whose Info.plist version disagrees with
//      what we think we're shipping.
//   2. .easignore deleted or stripped of the entries that keep scraper
//      tokens/logs out of the EAS upload.

check('iOS release config', () => {
  const failures: string[] = [];

  const appJsonText = read('app.json');
  if (appJsonText === null) {
    failures.push('app.json: file missing');
    return failures;
  }
  let appJson: { expo?: { version?: string; ios?: { buildNumber?: string } } };
  try { appJson = JSON.parse(appJsonText); }
  catch (e) { return [`app.json: parse error — ${(e as Error).message}`]; }

  const appVersion = appJson?.expo?.version;
  const appBuild   = appJson?.expo?.ios?.buildNumber;
  if (!appVersion) failures.push('app.json: expo.version missing');
  if (!appBuild)   failures.push('app.json: expo.ios.buildNumber missing');

  const pbxRel = 'ios/XselfHome.xcodeproj/project.pbxproj';
  const pbxText = read(pbxRel);
  if (pbxText === null) {
    failures.push(`${pbxRel}: file missing`);
  } else if (appVersion && appBuild) {
    const marketingValues = new Set<string>();
    const projectValues   = new Set<string>();
    for (const m of pbxText.matchAll(/MARKETING_VERSION\s*=\s*([^;]+);/g)) {
      marketingValues.add(m[1].trim());
    }
    for (const m of pbxText.matchAll(/CURRENT_PROJECT_VERSION\s*=\s*([^;]+);/g)) {
      projectValues.add(m[1].trim());
    }
    if (marketingValues.size === 0) {
      failures.push(`${pbxRel}: no MARKETING_VERSION entries found`);
    }
    if (projectValues.size === 0) {
      failures.push(`${pbxRel}: no CURRENT_PROJECT_VERSION entries found`);
    }
    for (const v of marketingValues) {
      if (v !== appVersion) {
        failures.push(`${pbxRel}: MARKETING_VERSION="${v}" does not match app.json expo.version="${appVersion}" — run npm run sync:ios-version`);
      }
    }
    for (const v of projectValues) {
      if (v !== appBuild) {
        failures.push(`${pbxRel}: CURRENT_PROJECT_VERSION="${v}" does not match app.json expo.ios.buildNumber="${appBuild}" — run npm run sync:ios-version`);
      }
    }
  }

  // Info.plist must reference the build-setting variables, NOT hardcode the
  // version/build. A literal value here will silently overrule pbxproj's
  // MARKETING_VERSION / CURRENT_PROJECT_VERSION (the exact bug we just hit:
  // EAS shipped 1.0.3/24 from Info.plist even though pbxproj said 1.0.4/25).
  const plistRel = 'ios/XselfHome/Info.plist';
  const plistText = read(plistRel);
  if (plistText === null) {
    failures.push(`${plistRel}: file missing`);
  } else {
    const shortMatch = plistText.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/);
    const bundleMatch = plistText.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/);
    if (!shortMatch) {
      failures.push(`${plistRel}: CFBundleShortVersionString missing`);
    } else if (shortMatch[1].trim() !== '$(MARKETING_VERSION)') {
      failures.push(`${plistRel}: CFBundleShortVersionString="${shortMatch[1]}" — must be $(MARKETING_VERSION). ` +
        'A literal here overrides pbxproj and ships the wrong version.');
    }
    if (!bundleMatch) {
      failures.push(`${plistRel}: CFBundleVersion missing`);
    } else if (bundleMatch[1].trim() !== '$(CURRENT_PROJECT_VERSION)') {
      failures.push(`${plistRel}: CFBundleVersion="${bundleMatch[1]}" — must be $(CURRENT_PROJECT_VERSION). ` +
        'A literal here overrides pbxproj and ships the wrong buildNumber.');
    }
    // Defense in depth: forbid any literal mention of stale ship versions
    // anywhere in Info.plist (including comment or hidden keys).
    for (const stale of ['1.0.3', '1.0.2', '1.0.1']) {
      if (plistText.includes(`<string>${stale}</string>`)) {
        failures.push(`${plistRel}: contains stale literal version <string>${stale}</string>`);
      }
    }
  }

  if (!exists('.easignore')) {
    failures.push('.easignore: file missing — EAS uploads will include logs/scraper state');
  } else {
    const ei = read('.easignore') ?? '';
    const REQUIRED = [
      'logs/',
      'scripts/.giga-chrome-profile/',
      'scripts/.giga-session.json',
      'ios/Pods/',
      'node_modules/',
    ];
    for (const r of REQUIRED) {
      if (!ei.split('\n').some(line => line.trim() === r)) {
        failures.push(`.easignore: missing required exclusion "${r}"`);
      }
    }
  }

  return failures;
});

// ── Check 12: Playwright/Chromium environment auto-repair ──────────────────
// Encodes the contract for the GIGA scraper's "old/broken Playwright package"
// recovery path: the repair script must exist, the runner must trigger it on
// detected browser failures, AUTO_REPAIRED must be a possible status, and the
// repair script's smoke test must resolve `playwright` from the repo's own
// node_modules (NOT from /tmp where it would always fail).

check('Inventory Playwright auto-repair', () => {
  const failures: string[] = [];

  if (!exists('scripts/repairInventorySyncEnvironment.sh')) {
    failures.push('scripts/repairInventorySyncEnvironment.sh: file missing');
  }

  const runner = read('scripts/runGigaInventorySync.sh') ?? '';
  if (!/AUTO_REPAIRED/.test(runner)) {
    failures.push('scripts/runGigaInventorySync.sh: missing AUTO_REPAIRED status');
  }
  if (!/repairInventorySyncEnvironment\.sh/.test(runner) &&
      !/inventory:repair-env/.test(runner)) {
    failures.push('scripts/runGigaInventorySync.sh: does not invoke repairInventorySyncEnvironment.sh ' +
      '(or `inventory:repair-env`) on browser failure');
  }

  const repair = read('scripts/repairInventorySyncEnvironment.sh') ?? '';
  if (repair) {
    // The smoke test must NOT live under /tmp with a bare `require('playwright')`
    // — Node resolves modules relative to the script's location, so a /tmp
    // smoke file fails with "Cannot find module 'playwright'". The fix is to
    // write the smoke file inside REPO_ROOT or to require playwright by
    // absolute path / NODE_PATH.
    const looksFixed =
      /\$REPO_ROOT[^\n]*\.pw-smoke/.test(repair) ||
      /require\(['"]\$REPO_ROOT\/node_modules\/playwright['"]\)/.test(repair) ||
      /NODE_PATH=["']?\$REPO_ROOT\/node_modules/.test(repair);
    if (!looksFixed) {
      failures.push('scripts/repairInventorySyncEnvironment.sh: smoke test must resolve playwright ' +
        'from REPO_ROOT/node_modules (write the temp file under $REPO_ROOT or set NODE_PATH)');
    }
  }

  // Pattern matcher must catch the documented Playwright/Chromium failures.
  const REQUIRED_PATTERNS = [
    'browserType\\.launch',
    'chrome-headless-shell',
    'Timeout 180000ms exceeded',
    'Execution context was destroyed',
    'Target (page|browser|context) has been closed',
    // Note: the shell source escapes its inner quotes, so the file on disk
    // contains the bytes `['\"]playwright['\"]` (backslash-quote), not `['"]`.
    "Cannot find module ['\\\"]playwright['\\\"]",
    "chromium executable",
    'browser has been closed',
    'Failed to launch',
  ];
  for (const p of REQUIRED_PATTERNS) {
    if (!runner.includes(p)) {
      failures.push(`scripts/runGigaInventorySync.sh: browser_failure_in() missing pattern \`${p}\``);
    }
  }

  return failures;
});

// ── Check 7: Admin backend ──────────────────────────────────────────────────

check('Admin backend', () => {
  const failures: string[] = [];
  for (const f of [
    'admin/orders.html',
    'supabase/functions/admin-create-payment-link/index.ts',
    'supabase/functions/admin-update-order-status/index.ts',
    'supabase/admin_order_status_events.sql',
  ]) {
    if (!exists(f)) failures.push(`${f}: file missing`);
  }
  const admin = read('admin/orders.html') ?? '';
  for (const forbidden of ['STRIPE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (admin.includes(forbidden)) failures.push(`admin/orders.html: contains forbidden ${forbidden}`);
  }
  for (const re of [/sk_live_[A-Za-z0-9]/, /sk_test_[A-Za-z0-9]/]) {
    if (re.test(admin)) failures.push(`admin/orders.html: contains forbidden ${re.toString()}`);
  }
  return failures;
});

// ── Check 8: Fulfillment rules ──────────────────────────────────────────────

check('Fulfillment rules', () => {
  const failures: string[] = [];
  const plan = read('supabase/functions/plan-fulfillment/index.ts');
  if (plan === null) {
    failures.push('supabase/functions/plan-fulfillment/index.ts: file missing');
    return failures;
  }
  // Dual-radius pickup (CA 100mi / approved out-of-state 50mi) is centralized in the shared
  // resolver; the planner must consume it via pickupRadiusMiles(state), not a flat constant.
  if (!/pickupRadiusMiles\(/.test(plan)) {
    failures.push('supabase/functions/plan-fulfillment/index.ts: must use pickupRadiusMiles(state) (dual-radius pickup)');
  }
  // Forbid stale 30-mile pickup phrasing in shipping runtime sources.
  const runtimeFiles = [
    ...listFilesRecursive('src',                f => /\.(ts|tsx)$/.test(f)),
    ...listFilesRecursive('supabase/functions', f => /\.ts$/.test(f)),
  ];
  for (const file of runtimeFiles) {
    const text = read(file);
    if (text === null) continue;
    if (/PICKUP_THRESHOLD_MILES\s*=\s*30\b/.test(text)) {
      failures.push(`${file}: stale "PICKUP_THRESHOLD_MILES = 30"`);
    }
    if (/30\s*mi(?:les?)?\s+of\s+warehouse/i.test(text)) {
      failures.push(`${file}: stale user-facing "30 mi of warehouse" phrasing`);
    }
    if (/within\s+30\s*mi(?:les?)?/i.test(text)) {
      failures.push(`${file}: stale "within 30 miles" phrasing`);
    }
  }
  return failures;
});

// ── Check 13: Pickup rule lock ──────────────────────────────────────────────
// Freezes the LOCKED Pickup business rules so a Delivery redesign cannot silently
// change pickup radius / fee / time window / date offsets / option / pass.
// See docs/fulfillment-rules.md.

check('Pickup rule lock', () => {
  const failures: string[] = [];

  // Dual-radius pickup lock (approved 2026-07): CA = 100mi, approved out-of-state = 50mi,
  // centralized in supabase/functions/_shared/fulfillmentEligibility.ts. The obsolete
  // single-100 client/server equality check is intentionally removed — the client no longer
  // computes a pickup radius (server is authoritative via pickupRadiusMiles(state)).
  const plan = read('supabase/functions/plan-fulfillment/index.ts') ?? '';
  const elig = read('supabase/functions/_shared/fulfillmentEligibility.ts') ?? '';
  const caRadius  = elig.match(/PICKUP_RADIUS_MILES_BY_STATE[^}]*CA:\s*(\d+)/)?.[1];
  const oosRadius = elig.match(/DEFAULT_PICKUP_RADIUS_MILES\s*=\s*(\d+)/)?.[1];
  if (caRadius !== '100') failures.push(`_shared/fulfillmentEligibility.ts: CA pickup radius must be 100 (found ${caRadius ?? 'none'})`);
  if (oosRadius !== '50') failures.push(`_shared/fulfillmentEligibility.ts: default out-of-state pickup radius must be 50 (found ${oosRadius ?? 'none'})`);
  if (!/pickupRadiusMiles\(/.test(plan)) failures.push('supabase/functions/plan-fulfillment/index.ts: must consume pickupRadiusMiles(state)');

  // Fee: server computes free pickup, and the locked frontend constant is 0.
  failures.push(...fileMust('supabase/functions/create-checkout-order/index.ts', /usePickup\s*\?\s*0\s*:/));
  failures.push(...fileMust('src/types/fulfillment.ts', /PICKUP_FEE\s*=\s*0\b/));

  // Time window + business-day offsets (frontend) and the edge ETA string.
  failures.push(...fileMust('src/services/pickupDateService.ts',
    "PICKUP_TIME_WINDOW = '10:00 AM – 2:00 PM'",
    /PICKUP_EARLIEST_BUSINESS_DAYS\s*=\s*1\b/,
    /PICKUP_LATEST_BUSINESS_DAYS\s*=\s*4\b/,
  ));
  failures.push(...fileMust('supabase/functions/plan-fulfillment/index.ts', '10:00 AM – 2:00 PM'));

  // Checkout still renders the pickup option.
  failures.push(...fileMust('src/screens/CheckoutScreen.tsx',
    'planHasPickup',
    // Probe for "the pickup option still renders". The customer-facing wording was
    // shortened to "Pickup — Free" (2026-08-16); the locked BUSINESS rules above
    // (radius / $0 fee / time window / date offsets) are untouched.
    'Pickup — Free',
    /setFulfillmentChoice\(['"]pickup['"]\)/,
  ));

  // My Orders still renders the pickup status flow. (The shipped labels are "Preparing for pickup" /
  // "Ready for pickup" plus the pickup-date service; the earlier "Pickup Pass" strings were never-shipped
  // WIP, so the lock now pins the ACTUAL shipped pickup status flow rather than unshipped strings.)
  failures.push(...fileMust('src/screens/OrdersScreen.tsx',
    'Preparing for pickup',
    'Ready for pickup',
    'formatPickupDate',
  ));

  return failures;
});

// ── Check 14: Delivery account separation ───────────────────────────────────
// Keeps the Delivery (dropship, Buyer 82482447) integration separate from Pickup
// (Buyer 76938981), keeps Delivery secrets out of the frontend bundle, and prevents any
// production dropShip-sync call from tests/scripts. See docs/delivery-architecture.md.

check('Delivery account separation', () => {
  const failures: string[] = [];

  // (a) Account-separation registry + safety guard exist.
  failures.push(...fileMust('src/config/supplierAccounts.ts',
    'SUPPLIER_DELIVERY_SANDBOX_CLIENT_ID',
    'assertSafeDiscoveryRequest',
  ));

  // (b) Server-side Delivery client uses ONLY SUPPLIER_DELIVERY_* (never Pickup creds).
  const dc = read('supabase/functions/_shared/gigaDeliveryClient.ts');
  if (dc === null) {
    failures.push('supabase/functions/_shared/gigaDeliveryClient.ts: file missing');
  } else {
    if (!/SUPPLIER_DELIVERY_/.test(dc)) failures.push('gigaDeliveryClient.ts: does not reference SUPPLIER_DELIVERY_* creds');
    if (/SUPPLIER_CLIENT_(ID|SECRET)/.test(dc)) failures.push('gigaDeliveryClient.ts: must NOT reference Pickup creds (SUPPLIER_CLIENT_*)');
  }

  // (c) Pickup client must NOT reference Delivery creds.
  const pc = read('src/services/gigaApiClient.ts') ?? '';
  if (/SUPPLIER_DELIVERY_/.test(pc)) {
    failures.push('src/services/gigaApiClient.ts: Pickup client must NOT reference SUPPLIER_DELIVERY_*');
  }

  // (d) No frontend file READS a Delivery secret, and none imports the server Delivery client.
  for (const file of frontendFiles()) {
    const text = read(file);
    if (text === null) continue;
    if (/(process\.env\.SUPPLIER_DELIVERY_\w*SECRET|Deno\.env\.get\(\s*['"]SUPPLIER_DELIVERY_\w*SECRET)/.test(text)) {
      failures.push(`${file}: frontend must not read a Delivery secret`);
    }
    if (/(?:from|require\()\s*['"][^'"]*gigaDeliveryClient/.test(text)) {
      failures.push(`${file}: frontend must not import the server-side Delivery client`);
    }
  }

  // (e) No script or test pairs the production host with a money-moving endpoint.
  const toolingFiles = [
    ...listFilesRecursive('scripts',       f => /\.(ts|tsx|js)$/.test(f)),
    ...listFilesRecursive('src/__tests__', f => /\.(ts|tsx)$/.test(f)),
  ];
  const MM = ['dropShip-sync', 'pickUpSelfLabel-sync', 'order/create', 'order/giScSupplyLabel-sync'];
  for (const file of toolingFiles) {
    if (file === 'scripts/productionGuardrails.ts') continue; // this guard legitimately lists the patterns
    const text = read(file);
    if (text === null) continue;
    // Portal-safety-guard TEST fixtures reference the forbidden patterns only to ASSERT the guard
    // STOPS them (expectStop) — never to call them. Same rationale as excluding this guard itself.
    if (/portalSafetyGuard/.test(text) && /expectStop/.test(text)) continue;
    if (text.includes('openapi.gigab2b.com') && MM.some(m => text.includes(m))) {
      failures.push(`${file}: pairs production host with a money-moving endpoint — forbidden in tooling/tests`);
    }
  }

  return failures;
});

// ── Check 15: Delivery dynamic fee (no hardcoded $99) ────────────────────────
// The temporary $99 placeholder must be gone; the Delivery fee is server-authoritative
// from GIGA product/price/v1 (read-only) and create-checkout-order must fail-closed (no
// $99 fallback). Pickup stays free and locked (Check 13). See docs/delivery-architecture.md.
check('Delivery dynamic fee', () => {
  const failures: string[] = [];

  // (a) Frontend: no hardcoded Delivery fee, no customer-facing "$99"/"Home Delivery".
  // Three-method fulfillment (2026-09-10): the third-party GIGA option is labelled "Shipping — $X",
  // XSELF's own option "Local Delivery — Free", pickup stays "Pickup — Free" (Check 13). The old
  // "Delivery — $X" label must not come back, and the internal Local Delivery radius must never
  // be shown (the "within 30 miles" probe in Check 8 covers that).
  const fulfill = read('src/types/fulfillment.ts') ?? '';
  if (/SHIPPING_FEE/.test(fulfill)) failures.push('src/types/fulfillment.ts: SHIPPING_FEE must be removed (Delivery fee is dynamic)');
  const checkout = read('src/screens/CheckoutScreen.tsx') ?? '';
  if (/SHIPPING_FEE/.test(checkout)) failures.push('CheckoutScreen.tsx: must not reference SHIPPING_FEE');
  if (/Home Delivery/.test(checkout)) failures.push('CheckoutScreen.tsx: customer-facing "Home Delivery" must be removed (use "Delivery")');
  if (/\$99(?![0-9])/.test(checkout)) failures.push('CheckoutScreen.tsx: must not display "$99"');
  if (!/Shipping — \$/.test(checkout)) failures.push('CheckoutScreen.tsx: third-party shipping must be labelled "Shipping — $X"');
  if (!/Local Delivery — Free/.test(checkout)) failures.push('CheckoutScreen.tsx: must render the "Local Delivery — Free" option');
  if (/Delivery — \$/.test(checkout)) failures.push('CheckoutScreen.tsx: legacy "Delivery — $X" label must not return (use "Shipping — $X")');
  if (!/clientSupportsLocalDelivery: true/.test(checkout)) failures.push('CheckoutScreen.tsx: must declare clientSupportsLocalDelivery: true (server refuses local_delivery otherwise)');

  // (b) plan-fulfillment: computes dynamic fee; no $99 constant; no order/dropship call.
  const plan = read('supabase/functions/plan-fulfillment/index.ts') ?? '';
  if (/SHIPPING_FEE\s*=\s*99/.test(plan)) failures.push('plan-fulfillment: SHIPPING_FEE = 99 must be removed');
  if (!/computeDeliveryFee/.test(plan) || !/deliveryProductPrice/.test(plan)) failures.push('plan-fulfillment: must compute the Delivery fee via deliveryProductPrice + computeDeliveryFee');
  if (!/deliveryFeeCents/.test(plan)) failures.push('plan-fulfillment: must return deliveryFeeCents');
  if (/dropShip-sync|order\/create|pickUpSelfLabel-sync/.test(plan)) failures.push('plan-fulfillment: must not reference any order/dropship endpoint');

  // (c) create-checkout-order: no "?? 99" fallback; uses server fee; fail-closed.
  const cco = read('supabase/functions/create-checkout-order/index.ts') ?? '';
  if (/\?\?\s*99\b/.test(cco)) failures.push('create-checkout-order: the "?? 99" Delivery fallback must be removed');
  if (!/deliveryFeeCents/.test(cco)) failures.push('create-checkout-order: must use planData.deliveryFeeCents');
  if (!/delivery_fee_unavailable/.test(cco)) failures.push('create-checkout-order: must fail-closed (delivery_fee_unavailable) when no Delivery fee');
  if (/dropShip-sync|order\/create/.test(cco)) failures.push('create-checkout-order: must not reference dropship/create-order endpoint');

  // (d) Shared fee module + read-only Delivery price helper exist.
  if (read('supabase/functions/_shared/deliveryFee.ts') === null) failures.push('supabase/functions/_shared/deliveryFee.ts: missing');
  const dc = read('supabase/functions/_shared/gigaDeliveryClient.ts') ?? '';
  if (!/product\/price\/v1/.test(dc)) failures.push('gigaDeliveryClient.ts: must expose the read-only product/price/v1 helper');

  return failures;
});

// ── Check 16: Delivery version gate (old builds safe, new builds dynamic) ────
// The client-capability gate (clientSupportsDynamicDelivery) must exist so a production
// deploy serves old shipped builds legacy-compatible behavior (numeric shipping, never 422)
// and new builds the dynamic GIGA fee. See docs/delivery-architecture.md + deliveryGate.test.ts.
check('Delivery version gate', () => {
  const failures: string[] = [];

  const plan = read('supabase/functions/plan-fulfillment/index.ts') ?? '';
  if (!/clientSupportsDynamicDelivery/.test(plan)) failures.push('plan-fulfillment: missing clientSupportsDynamicDelivery gate');
  if (!/LEGACY_DELIVERY_FEE_DOLLARS/.test(plan)) failures.push('plan-fulfillment: missing legacy fee branch (LEGACY_DELIVERY_FEE_DOLLARS)');

  const cco = read('supabase/functions/create-checkout-order/index.ts') ?? '';
  if (!/clientSupportsDynamicDelivery/.test(cco)) failures.push('create-checkout-order: missing clientSupportsDynamicDelivery gate');
  if (!/LEGACY_DELIVERY_FEE_DOLLARS/.test(cco)) failures.push('create-checkout-order: missing legacy fee branch');
  // Must propagate the flag to its internal plan-fulfillment invoke.
  if (!/plan-fulfillment'[\s\S]{0,400}clientSupportsDynamicDelivery/.test(cco)) failures.push('create-checkout-order: must propagate clientSupportsDynamicDelivery to plan-fulfillment');

  // Frontend must send the flag to BOTH edge functions (≥2 occurrences of `:true`).
  const co = read('src/screens/CheckoutScreen.tsx') ?? '';
  const sends = (co.match(/clientSupportsDynamicDelivery:\s*true/g) ?? []).length;
  if (sends < 2) failures.push('CheckoutScreen.tsx: must send clientSupportsDynamicDelivery:true to BOTH plan-fulfillment and create-checkout-order');

  // Pure, testable gate helpers must exist.
  const df = read('supabase/functions/_shared/deliveryFee.ts') ?? '';
  if (!/resolveCheckoutShippingCents/.test(df) || !/resolvePlanShippingDollars/.test(df)) failures.push('_shared/deliveryFee.ts: missing pure gate helpers');

  return failures;
});

// ── Check 17: Delivery fee cache source (portal cache; not giga_products/sku_custom) ──
// Step 4: new dynamic-delivery clients read the cached Delivery fee from
// giga_delivery_fee_cache (keyed by supplier_product_id). The checkout path must NOT touch
// the stale catalog table or the customized SKU fields. See docs/delivery-architecture.md.
check('Delivery fee cache source', () => {
  const failures: string[] = [];
  const plan = read('supabase/functions/plan-fulfillment/index.ts') ?? '';
  if (!/giga_delivery_fee_cache/.test(plan)) failures.push('plan-fulfillment: must read giga_delivery_fee_cache');
  if (!/computeDeliveryFeeFromCache/.test(plan)) failures.push('plan-fulfillment: must use computeDeliveryFeeFromCache');
  if (/giga_products/.test(plan)) failures.push('plan-fulfillment: must NOT reference giga_products (stale catalog table)');
  // Match column/field USE (quoted select or property access) — not a benign comment mention.
  if (/['"`]sku_(custom|search)\b|\.sku_(custom|search)\b/.test(plan)) failures.push('plan-fulfillment: must NOT use sku_custom/sku_search as a column/field for GIGA lookup');

  const df = read('supabase/functions/_shared/deliveryFee.ts') ?? '';
  if (!/computeDeliveryFeeFromCache/.test(df)) failures.push('_shared/deliveryFee.ts: missing computeDeliveryFeeFromCache');
  if (!/charged_fee_cents/.test(df)) failures.push('_shared/deliveryFee.ts: cache helper must charge from charged_fee_cents');

  return failures;
});

// ── Check 9: Splash / prebuild blocker ──────────────────────────────────────

check('Splash/prebuild blocker', () => {
  const failures: string[] = [];
  const text = read('app.json');
  if (text === null) return ['app.json: file missing'];
  let appJson: { expo?: { splash?: { image?: string } } };
  try { appJson = JSON.parse(text); }
  catch (e) { return [`app.json: parse error — ${(e as Error).message}`]; }
  const splashImage = appJson?.expo?.splash?.image;
  if (typeof splashImage === 'string' && splashImage.length > 0) {
    const splashPath = splashImage.replace(/^\.\//, '');
    if (!exists(splashPath)) {
      failures.push(
        `app.json references missing splash image "${splashImage}". ` +
        `This blocks "expo prebuild" from re-injecting Apple Pay entitlement + URL scheme.`,
      );
    }
  }
  return failures;
});

// ── Check 10: TypeScript ────────────────────────────────────────────────────

check('TypeScript', () => {
  const failures: string[] = [];
  const result = spawnSync('npx', ['tsc', '--noEmit', '--skipLibCheck'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) {
    failures.push(`tsc spawn error: ${result.error.message}`);
    return failures;
  }
  if (result.status !== 0) {
    failures.push(`tsc exited with code ${result.status}`);
    const out = ((result.stdout ?? '') + '\n' + (result.stderr ?? ''))
      .split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of out.slice(0, 30)) failures.push(`  tsc: ${line}`);
    if (out.length > 30) failures.push(`  tsc: …+${out.length - 30} more lines`);
  }
  return failures;
});

// ── Check 19: SKU identity & family scope lock ──────────────────────────────
// Freezes the SKU Identity Foundation (2026-08-29): full supplier_product_id is the
// only internal identity; sku_custom is display-only, deterministic, unique (DB
// UNIQUE), rerun-stable; family/variant decisions are sellerCode-scoped and SKU
// prefix length is never a sufficient family condition (S-format never consults it).

check('SKU identity & family scope lock', () => {
  const failures: string[] = [];

  // 1. Identity chain never truncates: order/fulfillment servers key on the full
  //    supplier id and must not import the display-suffix helpers.
  for (const rel of ['supabase/functions/create-checkout-order/index.ts', 'supabase/functions/plan-fulfillment/index.ts']) {
    const txt = read(rel) ?? '';
    if (/skuSuffix|skuIdentitySuffixCandidates/.test(txt)) {
      failures.push(`${rel}: must not use display-SKU suffix helpers for identity`);
    }
  }

  // 2. Deterministic generator — no randomness/time in the SKU source of truth.
  failures.push(...fileMust('src/services/specFormatter.ts', 'skuIdentitySuffixCandidates', 'resolveUniqueSkuCustom'));
  const spec = read('src/services/specFormatter.ts') ?? '';
  if (/Math\.random|Date\.now/.test(spec)) failures.push('src/services/specFormatter.ts: sku generator must be deterministic');

  // 3. Single suffix implementation: skuGenerator re-exports, never re-implements.
  const gen = read('src/utils/skuGenerator.ts') ?? '';
  if (!/import \{ skuSuffix \} from '\.\.\/services\/specFormatter'/.test(gen)) {
    failures.push('src/utils/skuGenerator.ts: must import skuSuffix from specFormatter (single source)');
  }
  if (/function skuSuffix/.test(gen)) failures.push('src/utils/skuGenerator.ts: duplicate skuSuffix implementation reintroduced');

  // 4. Rerun stability: normalization keeps stored sku_custom verbatim.
  failures.push(...fileMust('scripts/normalizeProducts.ts', 'existingSkuById', 'resolveUniqueSkuCustom'));

  // 5. Family scope: sellerCode-authoritative, S-format never prefix-judged.
  failures.push(...fileMust('src/services/familyKeyGenerator.ts', 'sellerScopeOf', 'isSequenceFormat', /computeFamilyKey\([^)]*sellerScope/));
  failures.push(...fileMust('scripts/planGigaAutoPublish.ts', 'sellerScopeOf', 'isSequenceFormat', 'confirmSiblingRelation'));
  // syncGigaVariants: lock the actual candidate-filter BEHAVIOR, not just imports —
  // the keep decision must be scope-gated with the S-format prefix bypass, and the
  // old prefix-only rule must not reappear anywhere in the file.
  failures.push(...fileMust('scripts/syncGigaVariants.ts',
    /const scope = sellerScopeOf\(raw, row\.supplier_product_id\)/,
    /keep:\s*inScope && \(sFormat \? true : shared\.length >= PREFIX_MIN_MATCH\)/,
  ));
  const sync = read('scripts/syncGigaVariants.ts') ?? '';
  if (/keep:\s*shared\.length\s*>=\s*PREFIX_MIN_MATCH/.test(sync)) {
    failures.push('scripts/syncGigaVariants.ts: prefix-only sibling rule reintroduced (keep must be scope-gated)');
  }

  // 6. DB uniqueness is committed as a migration (constraint name pinned).
  failures.push(...fileMust('supabase/migrations/20260829_sku_custom_identity_migration.sql', 'standardized_products_sku_custom_key'));

  return failures;
});

// ── Check 18: Review coverage (sellable products must have >=1 active review) ──
// DB-backed guard (SELECT-only, via scripts/checkReviewCoverage.ts). Maps the
// checker's exit code: SOFT-SKIP (pass) when creds are missing or the DB is
// unreachable (exit 2) so offline commits / credential-less CI never break;
// HARD-FAIL only when the query succeeds and >=1 sellable product has no active
// review (exit 1). Never writes the DB, never generates reviews.

check('Review coverage', () => {
  const r = spawnSync('npx', ['tsx', 'scripts/checkReviewCoverage.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 90_000,
  });
  if (r.error || r.status === null) {
    console.log('    · Review coverage: skipped (checker unavailable)');
    return [];
  }
  if (r.status === 2) {
    console.log('    · Review coverage: skipped (no DB creds / DB unreachable)');
    return [];
  }
  if (r.status === 0) return [];
  // Non-zero (exit 1) → surface the checker's reported lines as failures.
  const out = (r.stdout ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  const fails = out.filter(l => l.startsWith('·') || l.startsWith('FAIL:'));
  return fails.length ? fails : [`review coverage check failed (exit ${r.status})`];
});

// ── Print report ────────────────────────────────────────────────────────────

let anyFailed = false;
console.log('═══════════════════════════════════════════════════════════════════');
console.log(' Xself Home — Production Guardrails');
console.log('═══════════════════════════════════════════════════════════════════');
for (const r of results) {
  const symbol = r.status === 'PASS' ? '✓' : '✗';
  console.log(`${symbol} [${r.status}] ${r.category}`);
  for (const f of r.failures) {
    console.log(`    · ${f}`);
  }
  if (r.status === 'FAIL') anyFailed = true;
}
console.log('═══════════════════════════════════════════════════════════════════');
const passCount = results.filter(r => r.status === 'PASS').length;
const failCount = results.length - passCount;
console.log(` Total: ${results.length} | Pass: ${passCount} | Fail: ${failCount}`);
if (anyFailed) {
  console.log(' STATUS: ✗ GUARDS FAILED — fix the listed issues before final report.');
} else {
  console.log(' STATUS: ✓ ALL GUARDS PASSED.');
}
console.log('═══════════════════════════════════════════════════════════════════');

process.exit(anyFailed ? 1 : 0);
