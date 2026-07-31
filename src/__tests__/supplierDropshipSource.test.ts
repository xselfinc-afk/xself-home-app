/**
 * Dropship source-config + bounded-probe + identity/crossover tests. Confirms the Dropship
 * source is fully isolated from Pickup (never reuses a path), the dropship bounded probe is
 * genuine (requires real gigab2b session cookies), and identity verification blocks any
 * account crossover. No credentials — only truncated safe hashes.
 * Run: npx tsx src/__tests__/supplierDropshipSource.test.ts
 */
import assert from 'node:assert/strict';
import { sourceConfig } from '../../scripts/lib/supplierSession/sources';
import { probeDropshipSession } from '../../scripts/supplierBrowser';
import { verifyIdentity, hashIdentifier } from '../../scripts/lib/supplierSession/identity';
import type { StorageState } from '../../scripts/lib/supplierSession/snapshot';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

function main() {
  it('dropship source config is fully isolated — never reuses a pickup path', () => {
    const d = sourceConfig('dropship', '/repo');
    const p = sourceConfig('pickup', '/repo');
    assert.equal(d.role, 'dropship');
    assert.ok(d.profileDir.endsWith('/dropship'), d.profileDir);            // …/XSelfSupplierBrowser/dropship
    assert.equal(d.snapshotPath, '/repo/scripts/.giga-session-dropship.json');
    assert.equal(d.backupPath, '/repo/scripts/.giga-session-dropship.backup.json');
    assert.equal(d.lockPath, '/repo/scripts/.giga-session-dropship.lock');
    assert.equal(d.healthPath, '/repo/scripts/.giga-session-dropship.health.json');
    assert.equal(d.keychainService, 'xself-giga-dropship');
    for (const k of ['profileDir', 'snapshotPath', 'backupPath', 'lockPath', 'healthPath', 'keychainService', 'keychainAccount'] as const) {
      assert.notEqual((d as any)[k], (p as any)[k], `dropship must not reuse pickup ${k}`);
    }
  });

  it('probeDropshipSession is genuine: requires real gigab2b session cookies', () => {
    const withCookies: StorageState = { cookies: [{ name: 'OCSESSID', value: 'session-only', domain: 'www.gigab2b.com' }, { name: 'gmd_device_id', value: 'dev', domain: '.gigab2b.com' }], origins: [] };
    const noGiga: StorageState = { cookies: [{ name: 'foo', value: 'x', domain: 'example.com' }], origins: [] };
    const empty: StorageState = { cookies: [], origins: [] };
    assert.deepEqual(probeDropshipSession(withCookies), { probeOk: true, classification: 'identity_confirmed' });
    assert.equal(probeDropshipSession(noGiga).probeOk, false);
    assert.equal(probeDropshipSession(empty).probeOk, false);
    assert.equal(probeDropshipSession(empty).classification, 'missing_required_cookies');
  });

  it('dropship identity verifies role + expected account hash (not the pickup id)', () => {
    const DROPSHIP = '82482447';
    const r = verifyIdentity({ accountId: DROPSHIP, role: 'dropship' }, { role: 'dropship', accountIdHash: hashIdentifier(DROPSHIP) });
    assert.equal(r.ok, true);
    assert.equal(r.state, 'healthy');
    assert.equal(r.safeId, hashIdentifier(DROPSHIP)); // truncated hash only
    assert.notEqual(r.safeId, DROPSHIP);               // never the raw id
  });

  it('CRITICAL: account crossover is blocked (pickup id or pickup role on the dropship source → account_mismatch)', () => {
    const DROPSHIP = '82482447', PICKUP = '76938981';
    // The OTHER account's buyer id shows on the dropship page → mismatch, promotion blocked.
    const idCross = verifyIdentity({ accountId: PICKUP, role: 'dropship' }, { role: 'dropship', accountIdHash: hashIdentifier(DROPSHIP) });
    assert.equal(idCross.ok, false);
    assert.equal(idCross.state, 'account_mismatch');
    // The pickup ROLE under the dropship source → mismatch.
    const roleCross = verifyIdentity({ role: 'pickup' }, { role: 'dropship' });
    assert.equal(roleCross.ok, false);
    assert.equal(roleCross.state, 'account_mismatch');
  });

  console.log(`\n${passed} passed`);
}
main();
