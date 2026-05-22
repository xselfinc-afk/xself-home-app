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
  return out;
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
  if (!/PICKUP_THRESHOLD_MILES\s*=\s*100\b/.test(plan)) {
    failures.push('supabase/functions/plan-fulfillment/index.ts: PICKUP_THRESHOLD_MILES is not 100');
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
