/**
 * Snapshot safety + identity verification tests (fs via tmp dir; pure logic).
 * Run: npx tsx src/__tests__/supplierSnapshot.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateSnapshotShape, hasRequiredCookies, redactStorageState, promoteSnapshot, rollbackSnapshot, type StorageState } from '../../scripts/lib/supplierSession/snapshot';
import { verifyIdentity, hashIdentifier } from '../../scripts/lib/supplierSession/identity';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const SECRET = 'SESSIONSECRETVALUE_do_not_leak_1234567890';
const good: StorageState = { cookies: [{ name: 'OCSESSID', value: SECRET, domain: 'www.gigab2b.com' }, { name: 'gmd_device_id', value: 'devXYZ', domain: '.gigab2b.com' }], origins: [] };
const noGiga: StorageState = { cookies: [{ name: 'x', value: 'y', domain: 'example.com' }] };

function tmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xself-snap-'));
  return { dir, snapshotPath: path.join(dir, '.giga-session-pickup.json'), backupPath: path.join(dir, '.giga-session-pickup.backup.json') };
}

console.log('snapshot shape + redaction');
it('validateSnapshotShape accepts good, rejects malformed', () => {
  assert.equal(validateSnapshotShape(good).ok, true);
  assert.equal(validateSnapshotShape({ cookies: 'nope' }).ok, false);
  assert.equal(validateSnapshotShape({ cookies: [{ name: 'a' }] }).ok, false);
  assert.equal(validateSnapshotShape(null).ok, false);
});
it('hasRequiredCookies true only with a gigab2b.com cookie', () => {
  assert.equal(hasRequiredCookies(good), true);
  assert.equal(hasRequiredCookies(noGiga), false);
});
it('CRITICAL: redactStorageState leaks NO cookie values (no secret in output)', () => {
  const red = redactStorageState(good);
  const s = JSON.stringify(red);
  assert.equal(s.includes(SECRET), false);
  assert.equal(s.includes('devXYZ'), false);
  assert.equal(red.cookieCount, 2);
  assert.deepEqual(red.cookieNames, ['OCSESSID', 'gmd_device_id']);
  assert.equal(red.hasDeviceId, true);
});

console.log('\nsnapshot promotion');
it('valid session promotion writes snapshot with 0600 perms, no leftover temp', () => {
  const p = tmpPaths();
  const r = promoteSnapshot(p, good, { probeOk: true });
  assert.equal(r.promoted, true);
  assert.equal(fs.existsSync(p.snapshotPath), true);
  assert.equal((fs.statSync(p.snapshotPath).mode & 0o777), 0o600);
  assert.equal(fs.readdirSync(p.dir).some(f => f.includes('.tmp-')), false); // atomic — no temp left
  fs.rmSync(p.dir, { recursive: true, force: true });
});
it('failed probe → NOT promoted, previous snapshot preserved', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.snapshotPath, JSON.stringify({ cookies: [{ name: 'OLD', value: 'old', domain: 'www.gigab2b.com' }] }));
  const r = promoteSnapshot(p, good, { probeOk: false });
  assert.equal(r.promoted, false);
  assert.equal(r.reason, 'probe_not_confirmed');
  assert.equal(JSON.parse(fs.readFileSync(p.snapshotPath, 'utf8')).cookies[0].name, 'OLD'); // untouched
  fs.rmSync(p.dir, { recursive: true, force: true });
});
it('invalid snapshot rejected → previous preserved', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.snapshotPath, JSON.stringify({ cookies: [{ name: 'OLD', value: 'old', domain: 'www.gigab2b.com' }] }));
  const r = promoteSnapshot(p, { cookies: 'bad' } as any, { probeOk: true });
  assert.equal(r.promoted, false);
  assert.match(r.reason!, /invalid_shape/);
  assert.equal(JSON.parse(fs.readFileSync(p.snapshotPath, 'utf8')).cookies[0].name, 'OLD');
  fs.rmSync(p.dir, { recursive: true, force: true });
});
it('missing required cookies rejected', () => {
  const p = tmpPaths();
  const r = promoteSnapshot(p, noGiga, { probeOk: true });
  assert.equal(r.promoted, false);
  assert.equal(r.reason, 'missing_required_cookies');
  fs.rmSync(p.dir, { recursive: true, force: true });
});
it('previous known-good backed up, then atomic replace; rollback restores it', () => {
  const p = tmpPaths();
  fs.writeFileSync(p.snapshotPath, JSON.stringify({ cookies: [{ name: 'PREV', value: 'v', domain: 'www.gigab2b.com' }] }));
  const r = promoteSnapshot(p, good, { probeOk: true });
  assert.equal(r.promoted, true);
  assert.equal(r.backedUp, true);
  assert.equal(JSON.parse(fs.readFileSync(p.backupPath, 'utf8')).cookies[0].name, 'PREV'); // backup = old
  assert.equal(JSON.parse(fs.readFileSync(p.snapshotPath, 'utf8')).cookies[0].name, 'OCSESSID'); // new promoted
  assert.equal(rollbackSnapshot(p), true);
  assert.equal(JSON.parse(fs.readFileSync(p.snapshotPath, 'utf8')).cookies[0].name, 'PREV'); // rolled back
  fs.rmSync(p.dir, { recursive: true, force: true });
});
it('idempotent repeated promotion (rerun-safe)', () => {
  const p = tmpPaths();
  promoteSnapshot(p, good, { probeOk: true });
  const r2 = promoteSnapshot(p, good, { probeOk: true });
  assert.equal(r2.promoted, true);
  assert.equal(fs.readdirSync(p.dir).some(f => f.includes('.tmp-')), false);
  fs.rmSync(p.dir, { recursive: true, force: true });
});

console.log('\nidentity verification');
it('role match → healthy + verified; safe hash only (no raw)', () => {
  const r = verifyIdentity({ role: 'pickup', maskedEmail: 'j***@e***.com' }, { role: 'pickup' });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'healthy');
  assert.equal(r.identityVerified, true);
  assert.notEqual(r.safeId, 'j***@e***.com'); // hashed
});
it('role mismatch → account_mismatch (dropship session under pickup source)', () => {
  const r = verifyIdentity({ role: 'dropship' }, { role: 'pickup' });
  assert.equal(r.state, 'account_mismatch');
  assert.equal(r.ok, false);
});
it('stored identity hash mismatch → account_mismatch', () => {
  const r = verifyIdentity({ accountId: 'ACCT-NEW', role: 'pickup' }, { role: 'pickup', accountIdHash: hashIdentifier('ACCT-OLD') });
  assert.equal(r.state, 'account_mismatch');
});
it('no evidence → unknown_failure (never assume correct)', () => {
  assert.equal(verifyIdentity({}, { role: 'pickup' }).state, 'unknown_failure');
});
it('hashIdentifier deterministic + not reversible-looking', () => {
  assert.equal(hashIdentifier('abc'), hashIdentifier('abc'));
  assert.notEqual(hashIdentifier('abc'), 'abc');
  assert.equal(hashIdentifier('abc').length, 16);
});

console.log(`\n${passed} passed`);
