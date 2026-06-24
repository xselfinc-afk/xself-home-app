/**
 * iOS release SUBMIT-stage tests — pure; no I/O, no EAS, no secrets.
 * The submit command is import-safe (require.main guard) — importing it submits nothing and reads no files.
 * Run: npx tsx src/__tests__/iosReleaseSubmit.test.ts
 */
import assert from 'node:assert/strict';
import { buildSubmitArgs, verifyArtifactMatch, evaluateSubmitPreflight, type ReleaseStateFile } from '../../scripts/iosReleaseSubmit';
import { RELEASE_STATE_PATH } from '../../scripts/iosReleaseBuild';
import type { GateResult } from '../../scripts/iosReleasePlan';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }
const passingGates: GateResult[] = [{ id: 'runtime_match', level: 'pass', message: 'ok' }];
const failingGates: GateResult[] = [{ id: 'runtime_match', level: 'fail', message: 'mismatch' }];
const current = { version: '1.0.10', build: '31' };
const goodState: ReleaseStateFile = { version: '1.0.10', build: '31', eas_build_id: 'aaaa-bbbb-cccc', status: 'built' };

console.log('iOS release submit-stage tests');

// 1) refuses without --confirm-submit
it('refuses without --confirm-submit', () => {
  const r = evaluateSubmitPreflight({ confirmSubmit: false, releaseState: goodState, current, gates: passingGates });
  assert.equal(r.proceed, false);
  assert.ok(r.refusals.some(x => /confirm-submit/.test(x)));
});

// 2) refuses when release-state file missing
it('refuses when release-state file is missing', () => {
  const r = evaluateSubmitPreflight({ confirmSubmit: true, releaseState: null, current, gates: passingGates });
  assert.equal(r.proceed, false);
  assert.ok(r.refusals.some(x => /missing release-state/.test(x)));
});

// 3) refuses when no EAS build id recorded
it('refuses when no EAS build id is recorded', () => {
  const r = evaluateSubmitPreflight({ confirmSubmit: true, releaseState: { version: '1.0.10', build: '31', eas_build_id: null }, current, gates: passingGates });
  assert.equal(r.proceed, false);
  assert.ok(r.refusals.some(x => /no EAS build id/.test(x)));
});

// 4) constructs the expected EAS submit command (specific id, never "latest") WITHOUT executing it
it('buildSubmitArgs targets a specific build id', () => {
  assert.deepEqual(buildSubmitArgs('aaaa-bbbb-cccc', 'production'),
    ['submit', '--platform', 'ios', '--profile', 'production', '--id', 'aaaa-bbbb-cccc', '--non-interactive']);
  assert.ok(buildSubmitArgs('x').includes('--id'));               // always pins an id
  assert.equal(buildSubmitArgs('x').includes('--latest'), false); // never "latest"
});

// 5) refuses on version/build mismatch (recorded vs current prepared)
it('refuses when recorded release version/build != current prepared', () => {
  const stale: ReleaseStateFile = { version: '1.0.9', build: '31', eas_build_id: 'aaaa', status: 'built' };
  const r = evaluateSubmitPreflight({ confirmSubmit: true, releaseState: stale, current, gates: passingGates });
  assert.equal(r.proceed, false);
  assert.ok(r.refusals.some(x => /!=.*current prepared/.test(x)));
});

// gates-fail refusal + happy path + buildId surfaced
it('refuses when gates fail; proceeds + surfaces buildId when all good', () => {
  assert.equal(evaluateSubmitPreflight({ confirmSubmit: true, releaseState: goodState, current, gates: failingGates }).proceed, false);
  const ok = evaluateSubmitPreflight({ confirmSubmit: true, releaseState: goodState, current, gates: passingGates });
  assert.equal(ok.proceed, true);
  assert.deepEqual(ok.refusals, []);
  assert.equal(ok.buildId, 'aaaa-bbbb-cccc');
});

// artifact verification (the wrong-build guard)
it('verifyArtifactMatch: matching ok; mismatch / missing → not ok', () => {
  assert.equal(verifyArtifactMatch({ appVersion: '1.0.10', buildNumber: 31 }, current).ok, true);
  assert.equal(verifyArtifactMatch({ appVersion: '1.0.10', buildNumber: 30 }, current).ok, false);
  assert.equal(verifyArtifactMatch({ appVersion: '1.0.9', buildNumber: 31 }, current).ok, false);
  assert.equal(verifyArtifactMatch(null, current).ok, false);
});

// release-state path is the same local artifact written by build
it('reads the build-stage release-state path', () => {
  assert.equal(RELEASE_STATE_PATH, 'reports/release/ios-release-state.json');
});

console.log(`\n${passed} iOS release submit-stage assertions passed.`);
