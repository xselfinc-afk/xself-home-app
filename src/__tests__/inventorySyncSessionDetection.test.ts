/**
 * Regression tests for the false session-expiry detection defect. A resolve miss whose error
 * text embeds a SKU id containing 401/403/login/session/cookie must NOT be classified as a
 * session/auth failure (the original bug aborted a whole batch on "W1162P190403" because it
 * contains "403"). Genuine auth signals must still abort.
 * Run: npx tsx src/__tests__/inventorySyncSessionDetection.test.ts
 */
import assert from 'node:assert/strict';
import { classifySyncError, isAuthAbortStatus } from '../../scripts/syncGigaInventoryXhr';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const resolveMiss = (sku: string) => `Could not resolve SKU "${sku}" to numeric product_id via search`;

function main() {
  // ── The exact reported defect ──
  it('the reported case: resolve miss for W1162P190403 (contains "403") → resolve_failed, NOT session_auth', () => {
    assert.equal(classifySyncError(resolveMiss('W1162P190403')), 'resolve_failed');
  });

  it('resolve miss for a SKU containing 401 → resolve_failed (never session_auth)', () => {
    assert.equal(classifySyncError(resolveMiss('W1321P401530')), 'resolve_failed');
    assert.equal(classifySyncError(resolveMiss('N401P123403K')), 'resolve_failed');
  });

  it('resolve miss for a SKU containing "login"/"session"/"cookie" → resolve_failed', () => {
    assert.equal(classifySyncError(resolveMiss('XLOGIN0403')), 'resolve_failed');
    assert.equal(classifySyncError(resolveMiss('SESSION401X')), 'resolve_failed');
    assert.equal(classifySyncError(resolveMiss('COOKIE403Z')), 'resolve_failed');
  });

  it('a non-resolve error that merely embeds the SKU W1162P190403 → NOT session_auth (word boundary blocks it)', () => {
    // 403 sits inside "190403" with no word boundary → must not trip HTTP-auth matching.
    assert.equal(classifySyncError('unexpected failure processing W1162P190403 in batch'), 'other');
    assert.equal(classifySyncError('timeout for product W1321P401530'), 'other');
  });

  // ── Genuine auth signals STILL abort ──
  it('explicit HTTP 401 → session_auth', () => {
    assert.equal(classifySyncError('HTTP 401 Unauthorized'), 'session_auth');
    assert.equal(classifySyncError('request failed with status code 401'), 'session_auth');
  });

  it('explicit HTTP 403 → session_auth', () => {
    assert.equal(classifySyncError('403 Forbidden'), 'session_auth');
    assert.equal(classifySyncError('server returned 403'), 'session_auth');
  });

  it('"Login To See Price" → session_auth', () => {
    assert.equal(classifySyncError('Login To See Price'), 'session_auth');
  });

  it('explicit session/cookie/sign-in phrases → session_auth', () => {
    assert.equal(classifySyncError('session expired, please sign in'), 'session_auth');
    assert.equal(classifySyncError('cookie invalid'), 'session_auth');
    assert.equal(classifySyncError('please log in to continue'), 'session_auth');
    assert.equal(classifySyncError('unauthorized'), 'session_auth');
  });

  it('canonical auth statuses in the message → session_auth', () => {
    assert.equal(classifySyncError('classified authentication_required'), 'session_auth');
    assert.equal(classifySyncError('captcha_required challenge'), 'session_auth');
  });

  it('ordinary non-auth failure text → other (per-SKU, fail-closed, continue)', () => {
    assert.equal(classifySyncError('ETIMEDOUT connecting to host'), 'other');
    assert.equal(classifySyncError('socket hang up'), 'other');
  });

  // ── Structured (preferred) auth detection from the canonical classifier ──
  it('isAuthAbortStatus: only authentication_required / captcha_required / mfa_required abort', () => {
    for (const s of ['authentication_required', 'captcha_required', 'mfa_required']) assert.equal(isAuthAbortStatus(s), true, s);
    for (const s of ['inventory_unknown', 'network_failed', 'parse_failed', 'supplier_unavailable', 'confirmed_in_stock_ca', 'confirmed_out_of_stock', 'stale']) assert.equal(isAuthAbortStatus(s), false, s);
  });

  // ── The two batch behaviors the fix guarantees ──
  it('resolve_failed and no-rows(inventory_unknown) never abort; auth statuses do (batch-decision surface)', () => {
    // resolve miss → resolve_failed → the loop continues (not session_auth)
    assert.notEqual(classifySyncError(resolveMiss('W1162P190403')), 'session_auth');
    // a real auth AFTER earlier successes: isAuthAbortStatus drives the structured break
    assert.equal(isAuthAbortStatus('authentication_required'), true);
    // inventory_unknown (empty distributions) is NOT an auth abort → fail-closed continue
    assert.equal(isAuthAbortStatus('inventory_unknown'), false);
  });

  console.log(`\n${passed} passed`);
}
main();
