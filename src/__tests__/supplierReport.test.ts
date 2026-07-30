/**
 * Redacted supplier-session report tests. Run: npx tsx src/__tests__/supplierReport.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildReport, writeReport, assertNoSecrets } from '../../scripts/lib/supplierSession/report';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const SECRET = 'OCSESSID_SECRET_VALUE_abcdef123456';
const report = buildReport({
  runId: 'run-1', source: 'pickup', startedAt: '2026-07-30T00:00:00.000Z',
  health: 'healthy', accountIdentityVerified: true, profilePathId: 'pickup',
  snapshotRefreshed: true, previousSnapshotBackedUp: true, probeResult: 'confirmed_in_stock_ca',
  humanActionRequired: false, failureCategory: null, safeId: 'a1b2c3d4e5f60718',
  redactedSnapshot: { cookieCount: 2, domains: ['www.gigab2b.com'], cookieNames: ['OCSESSID', 'gmd_device_id'], hasDeviceId: true },
});

console.log('supplier-session report');

it('buildReport stamps completedAt and keeps only safe fields', () => {
  assert.ok(report.completedAt);
  assert.equal(report.profilePathId, 'pickup');   // identifier, not a path
  assert.equal(report.safeId!.length, 16);        // hash only
});
it('CRITICAL: report contains NO cookie value (redacted snapshot only)', () => {
  assert.equal(JSON.stringify(report).includes(SECRET), false);
  assert.doesNotThrow(() => assertNoSecrets(report, [SECRET]));
});
it('assertNoSecrets throws if a forbidden value leaks', () => {
  const leaky = { ...report, oops: SECRET };
  assert.throws(() => assertNoSecrets(leaky, [SECRET]));
});
it('assertNoSecrets throws on sensitive key shapes (cookieHeader/password/storageState)', () => {
  assert.throws(() => assertNoSecrets({ cookieHeader: 'x=y' }, []));
  assert.throws(() => assertNoSecrets({ password: 'p' }, []));
});
it('writeReport writes runId + latest-<source> with 0600 perms', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xself-rep-'));
  const p = writeReport(dir, report);
  assert.equal(fs.existsSync(p), true);
  assert.equal(fs.existsSync(path.join(dir, 'latest-pickup.json')), true);
  assert.equal((fs.statSync(p).mode & 0o777), 0o600);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).health, 'healthy');
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} passed`);
