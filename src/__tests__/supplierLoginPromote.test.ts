/**
 * Single-session login→extract→probe→promote orchestrator tests (pure; injected fakes).
 * Run: npx tsx src/__tests__/supplierLoginPromote.test.ts
 */
import assert from 'node:assert/strict';
import { runLoginAndPromote, type LoginPromoteDeps } from '../../scripts/lib/supplierSession/loginPromote';
import { sourceConfig } from '../../scripts/lib/supplierSession/sources';
import type { StorageState } from '../../scripts/lib/supplierSession/snapshot';

let passed = 0;
function it(name: string, fn: () => Promise<void>): Promise<void> { return fn().then(() => { passed++; console.log(`  ✓ ${name}`); }); }

const OCSESSID_SECRET = 'OCSESSID_session_only_secret_abc123';
const sessionCookieSnap: StorageState = { cookies: [{ name: 'OCSESSID', value: OCSESSID_SECRET, domain: 'www.gigab2b.com' }, { name: 'gmd_device_id', value: 'devZZ', domain: '.gigab2b.com' }], origins: [] };

/** Build deps with a call log + overridable behaviors. */
function makeDeps(over: Partial<LoginPromoteDeps> & { authed?: boolean; authHealth?: any; evidence?: any; probeOk?: boolean; promoted?: boolean; lockOk?: boolean } = {}) {
  const log: string[] = [];
  const deps: LoginPromoteDeps = {
    expectedRole: 'pickup', expectedBuyerId: '76938981', probeSku: 'W1445P360668', timeoutMs: 1000,
    acquireLock: () => { log.push('acquireLock'); return over.lockOk ?? true; },
    releaseLock: () => { log.push('releaseLock'); },
    openContext: async () => { log.push('openContext'); },
    waitForAuth: async () => { log.push('waitForAuth'); return { authed: over.authed ?? true, health: over.authHealth ?? 'healthy', evidence: over.evidence ?? { accountId: '76938981', role: 'pickup' } }; },
    extractSnapshot: async () => { log.push('extractSnapshot'); return sessionCookieSnap; },
    probe: async () => { log.push('probe'); return { probeOk: over.probeOk ?? true, classification: over.probeOk === false ? 'authentication_required' : 'confirmed_in_stock_ca' }; },
    promote: () => { log.push('promote'); return { promoted: over.promoted ?? true, backedUp: true }; },
    persistHealth: () => { log.push('persistHealth'); },
    closeContext: async () => { log.push('closeContext'); },
    ...over,
  };
  return { deps, log };
}

async function main() {
  await it('happy path: same-context login→extract→probe→promote → healthy', async () => {
    const { deps, log } = makeDeps();
    const r = await runLoginAndPromote(deps);
    assert.equal(r.health, 'healthy');
    assert.equal(r.identityVerified, true);
    assert.equal(r.buyerIdConfirmed, true);          // Buyer 76938981 matched
    assert.equal(r.snapshotRefreshed, true);
    assert.equal(r.previousBackedUp, true);
    assert.equal(r.probeClassification, 'confirmed_in_stock_ca');
    assert.equal(r.contextClosed, true);
    assert.equal(r.lockReleased, true);
    // ordering: promote happens, THEN closeContext (browser closes only after final)
    assert.ok(log.indexOf('promote') < log.indexOf('closeContext'));
    assert.equal(log[log.length - 1], 'releaseLock'); // lock released last
  });

  await it('no browser restart: openContext called exactly once; extract uses same context', async () => {
    const { deps, log } = makeDeps();
    await runLoginAndPromote(deps);
    assert.equal(log.filter(x => x === 'openContext').length, 1);
    // extract occurs after waitForAuth with NO second openContext in between
    assert.ok(log.indexOf('extractSnapshot') > log.indexOf('waitForAuth'));
    assert.equal(log.lastIndexOf('openContext'), log.indexOf('openContext'));
  });

  await it('session-cookie-only auth succeeds (OCSESSID captured from live context → promoted)', async () => {
    const { deps } = makeDeps();
    const r = await runLoginAndPromote(deps);
    assert.equal(r.snapshotRefreshed, true);
    assert.equal(r.redactedSnapshot?.cookieNames.includes('OCSESSID'), true);
  });

  await it('probe failure preserves previous snapshot (promote NOT called)', async () => {
    const { deps, log } = makeDeps({ probeOk: false });
    const r = await runLoginAndPromote(deps);
    assert.equal(r.snapshotRefreshed, false);
    assert.equal(log.includes('promote'), false);      // promotion never attempted
    assert.match(r.failureCategory!, /probe_not_confirmed/);
    assert.equal(r.contextClosed, true);
    assert.equal(r.lockReleased, true);
  });

  await it('account mismatch blocks promotion (wrong buyer id)', async () => {
    const { deps, log } = makeDeps({ evidence: { accountId: '99999999', role: 'pickup' } });
    const r = await runLoginAndPromote(deps);
    assert.equal(r.health, 'account_mismatch');
    assert.equal(r.snapshotRefreshed, false);
    assert.equal(log.includes('promote'), false);
    assert.equal(log.includes('extractSnapshot'), false); // never even extract on mismatch
  });

  await it('timeout / not-authed → human_action_required, no promote, context closed, lock released', async () => {
    const { deps, log } = makeDeps({ authed: false, authHealth: 'captcha_required' });
    const r = await runLoginAndPromote(deps);
    assert.equal(r.health, 'captcha_required');
    assert.equal(r.humanActionRequired, true);
    assert.equal(r.snapshotRefreshed, false);
    assert.equal(log.includes('promote'), false);
    assert.equal(r.contextClosed, true);
    assert.equal(r.lockReleased, true);
  });

  await it('browser closes ONLY after final result (both success and failure)', async () => {
    for (const over of [{}, { probeOk: false }, { authed: false as const, authHealth: 'authentication_required' }]) {
      const { deps, log } = makeDeps(over as any);
      await runLoginAndPromote(deps);
      assert.equal(log.filter(x => x === 'closeContext').length, 1);
      assert.ok(log.indexOf('closeContext') > log.indexOf('openContext'));
    }
  });

  await it('lock always releases on any completed run; NOT released when never acquired', async () => {
    for (const over of [{}, { probeOk: false }, { promoted: false }, { authed: false as const }]) {
      const { deps, log } = makeDeps(over as any);
      const r = await runLoginAndPromote(deps);
      assert.equal(r.lockReleased, true, JSON.stringify(over));
      assert.ok(log.includes('releaseLock'));
    }
    const { deps, log } = makeDeps({ lockOk: false });
    const r = await runLoginAndPromote(deps);
    assert.equal(r.health, 'profile_locked');
    assert.equal(r.lockReleased, false);
    assert.equal(log.includes('openContext'), false); // never opened if we didn't get the lock
    assert.equal(log.includes('releaseLock'), false); // don't release a lock we don't own
  });

  await it('CRITICAL: no secret cookie value leaks into the result', async () => {
    const { deps } = makeDeps();
    const r = await runLoginAndPromote(deps);
    assert.equal(JSON.stringify(r).includes(OCSESSID_SECRET), false);
    assert.equal(JSON.stringify(r).includes('devZZ'), false);
  });

  await it('Pickup/Dropship isolation intact (config paths distinct)', async () => {
    const p = sourceConfig('pickup', '/repo'), d = sourceConfig('dropship', '/repo');
    assert.notEqual(p.snapshotPath, d.snapshotPath);
    assert.notEqual(p.profileDir, d.profileDir);
  });

  console.log(`\n${passed} passed`);
}
main();
