/**
 * Optional macOS Keychain helper tests (safe: only looks up a guaranteed-absent service).
 * Run: npx tsx src/__tests__/supplierKeychain.test.ts
 */
import assert from 'node:assert/strict';
import { buildFindArgs, getCredential, hasCredential, keychainSetupCommands } from '../../scripts/lib/supplierSession/keychain';
import { sourceConfig } from '../../scripts/lib/supplierSession/sources';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('keychain helper');

it('buildFindArgs produces the expected security args', () => {
  assert.deepEqual(buildFindArgs('svc', 'acct'), ['find-generic-password', '-s', 'svc', '-a', 'acct', '-w']);
});

it('keychainSetupCommands: interactive -w, no secret value in the command', () => {
  const cmds = keychainSetupCommands('xself-giga-pickup', 'xself-supplier-pickup');
  const joined = cmds.join('\n');
  assert.ok(joined.includes('add-generic-password'));
  assert.ok(joined.includes('xself-giga-pickup'));
  assert.ok(joined.includes('xself-supplier-pickup'));
  assert.ok(/-w(\s|$)/.test(joined));          // interactive prompt flag present
  assert.equal(/-w\s+\S+/.test(cmds[0]), false); // NO value passed after -w (nothing to leak)
});

it('getCredential on a guaranteed-absent service → null (no throw, no secret)', () => {
  const v = getCredential('xself-giga-__definitely-absent-service__', 'nobody');
  assert.equal(v, null);
});

it('hasCredential on an absent service → false', () => {
  assert.equal(hasCredential('xself-giga-__definitely-absent-service__', 'nobody'), false);
});

it('per-source keychain identities are distinct (pickup vs dropship)', () => {
  const p = sourceConfig('pickup', '/repo');
  const d = sourceConfig('dropship', '/repo');
  assert.notEqual(p.keychainService, d.keychainService);
  assert.notEqual(p.keychainAccount, d.keychainAccount);
  assert.equal(p.keychainService, 'xself-giga-pickup');
  assert.equal(d.keychainService, 'xself-giga-dropship');
});

console.log(`\n${passed} passed`);
