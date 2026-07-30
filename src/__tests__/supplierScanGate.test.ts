/**
 * Scanner gate + cross-source isolation-under-failure tests.
 * Run: npx tsx src/__tests__/supplierScanGate.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeHealthState, preflightScannable, readHealthState } from '../../scripts/lib/supplierSession/scanGate';
import { UnhealthySessionError } from '../../scripts/lib/supplierSession/health';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xself-gate-'));
const pickupHealth = path.join(dir, '.giga-session-pickup.health.json');
const dropshipHealth = path.join(dir, '.giga-session-dropship.health.json');
const NOW = 2_000_000_000_000;

console.log('scanner gate');

it('healthy + fresh → scan allowed', () => {
  writeHealthState(pickupHealth, 'pickup', 'healthy', NOW);
  assert.doesNotThrow(() => preflightScannable('pickup', { healthPath: pickupHealth, now: NOW }));
  assert.equal(readHealthState(pickupHealth)?.health, 'healthy');
});
it('CRITICAL: unhealthy session BLOCKS scan (throws, never zero)', () => {
  writeHealthState(pickupHealth, 'pickup', 'authentication_required', NOW);
  assert.throws(() => preflightScannable('pickup', { healthPath: pickupHealth, now: NOW }),
    (e: unknown) => e instanceof UnhealthySessionError && (e as UnhealthySessionError).state === 'authentication_required');
});
it('missing health file → blocked (not_initialized)', () => {
  assert.throws(() => preflightScannable('pickup', { healthPath: path.join(dir, 'nope.json'), now: NOW }),
    (e: unknown) => e instanceof UnhealthySessionError && (e as UnhealthySessionError).state === 'not_initialized');
});
it('stale health file (age > maxAge) → blocked (unknown_failure)', () => {
  writeHealthState(pickupHealth, 'pickup', 'healthy', NOW - 10 * 60 * 60 * 1000); // 10h ago
  assert.throws(() => preflightScannable('pickup', { healthPath: pickupHealth, now: NOW, maxAgeMs: 6 * 60 * 60 * 1000 }),
    (e: unknown) => e instanceof UnhealthySessionError && (e as UnhealthySessionError).state === 'unknown_failure');
});

console.log('\ncross-source isolation under failure');
it('one source failing does NOT affect the other', () => {
  writeHealthState(pickupHealth, 'pickup', 'captcha_required', NOW);   // pickup broken
  writeHealthState(dropshipHealth, 'dropship', 'healthy', NOW);         // dropship fine
  assert.throws(() => preflightScannable('pickup', { healthPath: pickupHealth, now: NOW }));
  assert.doesNotThrow(() => preflightScannable('dropship', { healthPath: dropshipHealth, now: NOW }));
  // and the two health files are distinct artifacts
  assert.notEqual(pickupHealth, dropshipHealth);
  assert.equal(readHealthState(pickupHealth)?.source, 'pickup');
  assert.equal(readHealthState(dropshipHealth)?.source, 'dropship');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed`);
