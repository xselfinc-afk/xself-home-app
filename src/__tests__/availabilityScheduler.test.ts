/**
 * Availability-scan scheduler tests (static; no launchd interaction, no network, no browser).
 *
 * The property that matters most: this path must be provably browser-free. The whole point of the
 * API-only monitor is that it survives an expired browser session, so a stray Playwright import
 * would silently reintroduce the dependency the design exists to remove.
 *
 * Run: npx tsx src/__tests__/availabilityScheduler.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { INVENTORY_AUTOMATION_DEFAULTS } from '../services/inventoryAutomationConfig';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const INSTALLER = 'scripts/installAvailabilityScanScheduler.sh';
const RUNNER = 'scripts/runAvailabilityScan.sh';
const SCANNER = 'scripts/scanPublishedAvailability.ts';
const ADAPTER = 'src/services/openApiAvailability.ts';

/** Every file that makes up the scheduled API-only path. */
const API_ONLY_PATH = [INSTALLER, RUNNER, SCANNER, ADAPTER];
const MIN_CONFIRMATION_HOURS = INVENTORY_AUTOMATION_DEFAULTS.minConfirmationIntervalHours;

/**
 * Strip comments so the ban-list checks CODE, not prose. These files legitimately *document* that
 * they never use a browser, and a naive substring scan would flag that documentation as a violation.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/^\s*\/\/.*$/gm, ' ')          // line comments (ts)
    .replace(/^\s*#.*$/gm, ' ')             // line comments (bash)
    .replace(/(\S)\s+#\s.*$/gm, '$1');      // trailing bash comments
}

function main(): void {
  it('1. the interval is exactly 172800 seconds (48 hours)', () => {
    const src = read(INSTALLER);
    assert.match(src, /INTERVAL=172800/);
    assert.match(src, /<key>StartInterval<\/key><integer>\$\{INTERVAL\}<\/integer>/);
    // 48 hours, stated in seconds so it cannot drift.
    assert.equal(172800, 48 * 60 * 60);
    // The old 3-day cadence must be gone everywhere in the scheduled path.
    for (const f of [INSTALLER, RUNNER]) {
      assert.ok(!read(f).includes('259200'), `${f} still references the 3-day interval`);
      assert.ok(!/3 days|three-day/i.test(read(f)), `${f} still says 3 days`);
    }
  });

  it('1b. installer and status output state 48 hours', () => {
    const src = read(INSTALLER);
    // Both the install confirmation and the status readout must report the real cadence.
    const matches = src.match(/echo "interval   \$\{INTERVAL\}s \(48 hours\)"/g) ?? [];
    assert.equal(matches.length, 2, 'both install and status must print the 48-hour cadence');
    assert.match(src, /once every 48 hours \(172800 seconds\)/);
  });

  it('1c. the confirmation interval sits below the scan cadence', () => {
    // 36h guard against a 48h cadence: a legitimate next scan always counts, an immediate retry
    // never does. If the guard ever met or exceeded the cadence, real cycles would stop counting.
    assert.ok(MIN_CONFIRMATION_HOURS < 48, 'the guard must be below the 48h cadence');
    assert.equal(MIN_CONFIRMATION_HOURS, 36);
  });

  it('2. NO browser anywhere in the scheduled path', () => {
    const banned = [
      'playwright', 'puppeteer', 'chromium', 'chrome', 'browserContext', 'launchPersistentContext',
      'storageState', '.giga-session', 'supplierBrowser', 'route=/product/info/price/warehouse',
    ];
    for (const f of API_ONLY_PATH) {
      const src = codeOnly(read(f)).toLowerCase();
      for (const b of banned) {
        assert.ok(!src.includes(b.toLowerCase()), `${f} must not reference "${b}"`);
      }
    }
  });

  it('3. the scanner uses ONLY the Open API endpoint', () => {
    const src = codeOnly(read(SCANNER));
    assert.match(src, /gigaApiClient/);

    // GIGA 的失败信封用数字 0 当 code。真值判断会被 `0 &&` 短路掉，
    // 于是 HTTP 200 + {code:0,error:"…"} 被当成正常数据返回，真实错误原文丢失。
    const client = fs.readFileSync(
      path.join(process.cwd(), 'src', 'services', 'gigaApiClient.ts'),
      'utf8',
    );
    assert.ok(
      client.includes("data?.code !== undefined && String(data.code) !== '200'"),
      'the business-error guard must compare against undefined, not truthiness',
    );
    assert.ok(
      !/data\?\.code && String\(data\.code\)/.test(client),
      'the falsy-zero guard must not come back',
    );
    assert.match(src, /buyer\/product\/price\/v1/);
    assert.ok(!/gigab2b\.com\/index\.php/.test(src), 'storefront XHR must not appear');
  });

  it('4. the runner sets the correct working directory and repo', () => {
    const src = read(RUNNER);
    assert.match(src, /REPO="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/\.\." && pwd\)"/);
    assert.match(src, /cd "\$REPO"/);
    assert.match(read(INSTALLER), /<key>WorkingDirectory<\/key><string>\$\{REPO\}<\/string>/);
  });

  it('5. credentials are loaded but never echoed', () => {
    const src = read(RUNNER);
    assert.match(src, /dotenv -e \.env\.giga-alt\.local -e \.env\.local/);
    // The runner must not print any env var value.
    assert.ok(!/echo .*\$\{?(SUPABASE_SERVICE_ROLE_KEY|SUPPLIER_[A-Z_]*|.*SECRET.*|.*TOKEN.*)/i.test(src),
      'runner must never echo a credential');
    assert.ok(!/cat .*\.env/.test(src), 'runner must never cat an env file');
  });

  it('6. the runner fails loudly when credentials are absent', () => {
    const src = read(RUNNER);
    assert.match(src, /\.env\.giga-alt\.local missing/);
    assert.match(src, /\.env\.local missing/);
  });

  it('7. install / status / run-now / enable / disable / uninstall / report all exist', () => {
    const src = read(INSTALLER);
    for (const c of ['install', 'status', 'run-now', 'enable', 'disable', 'uninstall', 'report']) {
      assert.ok(new RegExp(`^\\s*${c}\\)`, 'm').test(src), `missing subcommand: ${c}`);
    }
  });

  it('8. the agent is interval-scheduled, and a boot trigger cannot become a boot scan', () => {
    const src = read(INSTALLER);
    assert.ok(!/StartCalendarInterval/.test(src), 'interval scheduling only');

    // RunAtLoad used to be false so that installing could never fire a run. That also meant the
    // 48h StartInterval countdown restarted at every boot and, on a Mac that reboots roughly
    // daily, never once reached 48h — the agent sat loaded at `runs = 0` having never scanned.
    //
    // The trigger is now every boot; the thing that keeps it from SCANNING every boot is the
    // runner's own cadence guard. That is the property to assert: trigger often, scan on schedule.
    assert.match(src, /<key>RunAtLoad<\/key><true\/>/);

    const runner = read(RUNNER);
    assert.ok(/MIN_INTERVAL_HOURS/.test(runner), 'the runner must carry its own cadence guard');
    assert.ok(/availability-scan skipped/.test(runner), 'a guarded run must say it was skipped');
    assert.ok(
      runner.indexOf('MIN_INTERVAL_HOURS') < runner.indexOf('scanPublishedAvailability.ts'),
      'the guard must be evaluated before the scan starts',
    );
    // A run that the guard turns away exits 0 without touching the supplier or the database.
    assert.ok(/exit 0/.test(runner.slice(runner.indexOf('MIN_INTERVAL_HOURS'), runner.indexOf('scanPublishedAvailability.ts'))));
  });

  it('9. the scheduled run persists evidence but cannot change publication by itself', () => {
    const runner = read(RUNNER);
    // The scheduler DOES run --live: that is how evidence and lifecycle state advance every cycle.
    // The scan has no publication write path at all (availabilityPersistence.test.ts asserts it),
    // so --live here cannot touch the catalogue.
    assert.match(runner, /scanPublishedAvailability\.ts --limit=400 --live/);
    const scanner = read(SCANNER);
    assert.match(scanner, /const LIVE = has\('--live'\)/);
    assert.match(scanner, /const DRY = !LIVE/);
    // 调度器只扫描、只提建议。它曾经在这里直接调用发布执行器并硬编码批准参数，
    // 等于替用户签字 —— 现在整段已移除。
    // 断言只看代码：注释里保留了这段历史说明，不应被当成实际调用。
    const runnerCode = runner.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.ok(!/applyInventoryLifecycleActions/.test(runnerCode),
      'the scheduler must never invoke the publication executor');
    assert.ok(!/--approve\b/.test(runnerCode), 'the scheduler must never forge approval');
    assert.ok(!/approved-by/.test(runnerCode), 'the scheduler must never name itself the approver');
    assert.ok(!/--only=all|--all\b/.test(runner), 'the scheduler must never use an "all" mode');
  });

  it('9b. 候选统计只在扫描成功后进行，且仍然不执行任何发布变更', () => {
    const runner = read(RUNNER);
    // 失败或中止的扫描只有部分证据，连"建议"都不该基于它统计。
    assert.match(runner, /if \[ "\$code" -eq 0 \]; then/);
    const runnerCode = runner.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    const guarded = runnerCode.slice(runnerCode.indexOf('if [ "$code" -eq 0 ]; then'));
    assert.ok(/eligible_for_delist|eligible_for_relist/.test(guarded),
      '成功后应统计候选，供人工审批');
    assert.ok(/awaiting human approval/.test(guarded),
      '必须明确声明在等待人工批准');
    assert.ok(!guarded.includes('applyInventoryLifecycleActions.ts'),
      '成功守卫内同样不得执行发布变更');
  });

  it('10. overlapping runs are prevented by a self-healing lock', () => {
    const src = read(SCANNER);
    assert.match(src, /acquireLock/);
    assert.match(src, /LOCK_STALE_MS/);
    assert.match(src, /process\.kill\(info\.pid, 0\)/);   // dead-PID reclaim
    assert.match(src, /die\(4, 'another scan is already running'/); // distinct exit code when held
  });

  it('11. destructive actions abort when the failure limit is exceeded', () => {
    const src = read(SCANNER);
    assert.match(src, /evaluateFailureRateAllowed/);
    assert.match(src, /process\.exit\(2\)/);
    assert.match(read(RUNNER), /ABORTED — failure rate exceeded/);
  });

  it('12. logs and reports are written to known, redacted locations', () => {
    const src = read(INSTALLER);
    assert.match(src, /StandardOutPath/);
    assert.match(src, /StandardErrorPath/);
    assert.match(read(RUNNER), /grep -v '\^\\\[GIGA\\\]'/); // client debug lines stripped
    assert.match(read(SCANNER), /redactReason/);
  });

  console.log(`\n${passed} passed`);
}
main();
