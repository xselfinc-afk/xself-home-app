/**
 * Durable supplier-session CORE tests: source/path isolation, health gate + classification,
 * profile lock (acquire / held / stale-recovery / own-only release).
 * Run: npx tsx src/__tests__/supplierSessionCore.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sourceConfig, resolveSource, SUPPLIER_SOURCES } from '../../scripts/lib/supplierSession/sources';
import { canScan, assertScannable, isHealthy, classifyPageHealth, UnhealthySessionError, ALL_HEALTH_STATES } from '../../scripts/lib/supplierSession/health';
import { acquireLock, releaseLock, isStale, readLock } from '../../scripts/lib/supplierSession/lock';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('supplier session core — source isolation');
const pick = sourceConfig('pickup', '/repo');
const drop = sourceConfig('dropship', '/repo');

it('pickup and dropship profile dirs are isolated and distinct', () => {
  assert.notEqual(pick.profileDir, drop.profileDir);
  assert.ok(pick.profileDir.endsWith('/pickup'));
  assert.ok(drop.profileDir.endsWith('/dropship'));
  assert.ok(pick.profileDir.includes('XSelfSupplierBrowser'));
});
it('snapshot / backup / lock / health targets are isolated per source', () => {
  for (const k of ['snapshotPath', 'backupPath', 'lockPath', 'healthPath'] as const) assert.notEqual((pick as any)[k], (drop as any)[k]);
  assert.ok(pick.snapshotPath.endsWith('.giga-session-pickup.json'));
  assert.ok(drop.snapshotPath.endsWith('.giga-session-dropship.json'));
});
it('no path of one source equals any path of the other (no cross-overwrite)', () => {
  const P = [pick.profileDir, pick.snapshotPath, pick.backupPath, pick.lockPath, pick.healthPath];
  const D = [drop.profileDir, drop.snapshotPath, drop.backupPath, drop.lockPath, drop.healthPath];
  for (const p of P) for (const d of D) assert.notEqual(p, d);
});
it('resolveSource validates', () => {
  assert.equal(resolveSource('pickup'), 'pickup');
  assert.equal(resolveSource('dropship'), 'dropship');
  assert.throws(() => resolveSource('whatever'));
  assert.throws(() => resolveSource(undefined));
  assert.deepEqual([...SUPPLIER_SOURCES], ['pickup', 'dropship']);
});

console.log('\nhealth gate + classification');
it('only healthy can scan; every other state blocks and is never zero', () => {
  assert.equal(canScan('healthy'), true);
  for (const s of ALL_HEALTH_STATES.filter(x => x !== 'healthy')) assert.equal(canScan(s), false, s);
});
it('assertScannable throws UnhealthySessionError for non-healthy', () => {
  assert.doesNotThrow(() => assertScannable('pickup', 'healthy'));
  for (const s of ['authentication_required', 'captcha_required', 'mfa_required', 'network_failed', 'supplier_unavailable', 'not_initialized'] as const) {
    assert.throws(() => assertScannable('pickup', s), (e: unknown) => e instanceof UnhealthySessionError && (e as UnhealthySessionError).state === s);
  }
});
it('classifyPageHealth: failure guards first', () => {
  assert.equal(classifyPageHealth({ networkError: true }), 'network_failed');
  assert.equal(classifyPageHealth({ httpStatus: 429 }), 'rate_limited');
  assert.equal(classifyPageHealth({ httpStatus: 401 }), 'authentication_required');
  assert.equal(classifyPageHealth({ isCaptcha: true }), 'captcha_required');
  assert.equal(classifyPageHealth({ isMfa: true }), 'mfa_required');
  assert.equal(classifyPageHealth({ isLoginPage: true }), 'authentication_required');
  assert.equal(classifyPageHealth({ supplierErrorCode: 'B20003' }), 'authentication_required');
  assert.equal(classifyPageHealth({ supplierErrorCode: 'E500' }), 'supplier_unavailable');
  assert.equal(classifyPageHealth({ httpStatus: 503 }), 'supplier_unavailable');
  assert.equal(classifyPageHealth({ httpStatus: 200, layoutMarkersMissing: true }), 'layout_changed');
  assert.equal(classifyPageHealth({ httpStatus: 200, authenticatedMarkersPresent: true }), 'healthy');
  assert.equal(classifyPageHealth({ httpStatus: 200 }), 'unknown_failure');
  assert.equal(isHealthy(classifyPageHealth({ httpStatus: 200, authenticatedMarkersPresent: true })), true);
});

console.log('\nprofile lock');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xself-lock-'));
const lp = path.join(tmp, '.giga-session-pickup.lock');
const aliveNow = { now: () => 1_000_000, pidAlive: () => true };

it('acquire on a free lock succeeds and writes lock info', () => {
  const r = acquireLock(lp, 'pickup', aliveNow);
  assert.equal(r.ok, true);
  const info = readLock(lp);
  assert.equal(info?.source, 'pickup');
  assert.equal(info?.pid, process.pid);
});
it('a fresh, live lock is NOT stale and blocks a second acquire (profile_locked)', () => {
  // Simulate a different, live holder.
  fs.writeFileSync(lp, JSON.stringify({ pid: 999999, source: 'pickup', acquiredAt: new Date(1_000_000).toISOString(), host: 'h' }));
  assert.equal(isStale(readLock(lp)!, aliveNow), false);
  const r = acquireLock(lp, 'pickup', aliveNow);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'profile_locked');
});
it('a dead-PID lock is stale and gets safely reclaimed (no process killed)', () => {
  fs.writeFileSync(lp, JSON.stringify({ pid: 999999, source: 'pickup', acquiredAt: new Date(1_000_000).toISOString(), host: 'h' }));
  const deadHolder = { now: () => 1_000_000, pidAlive: () => false };
  assert.equal(isStale(readLock(lp)!, deadHolder), true);
  const r = acquireLock(lp, 'pickup', deadHolder);
  assert.equal(r.ok, true);
  assert.equal(r.stoleStale, true);
});
it('an old lock (age > staleMs) is stale even if PID appears alive', () => {
  fs.writeFileSync(lp, JSON.stringify({ pid: 999999, source: 'pickup', acquiredAt: new Date(0).toISOString(), host: 'h' }));
  const old = { now: () => 100 * 60 * 1000, pidAlive: () => true }; // 100 min later
  assert.equal(isStale(readLock(lp)!, old), true);
});
it('releaseLock removes only our own lock', () => {
  acquireLock(lp, 'pickup', aliveNow); // ours
  releaseLock(lp, 'pickup');
  assert.equal(readLock(lp), null);
  // A foreign lock is not removed by us.
  fs.writeFileSync(lp, JSON.stringify({ pid: 999999, source: 'pickup', acquiredAt: new Date().toISOString(), host: 'h' }));
  releaseLock(lp, 'pickup');
  assert.notEqual(readLock(lp), null);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
