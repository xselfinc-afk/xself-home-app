/**
 * iOS release BUILD-stage tests — pure; no I/O, no EAS, no secrets.
 * The build command is import-safe (require.main guard), so importing it runs no build and reads no files.
 * Run: npx tsx src/__tests__/iosReleaseBuild.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildEasArgs, buildListJsonArgs, buildStatusBanner, ascCheckpointText, evaluateBuildPreflight, RELEASE_STATE_PATH } from '../../scripts/iosReleaseBuild';
import type { GateResult } from '../../scripts/iosReleasePlan';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }
const okDirty = { ok: true, offending: [] as string[] };
const passingGates: GateResult[] = [{ id: 'runtime_match', level: 'pass', message: 'ok' }];
const failingGates: GateResult[] = [{ id: 'runtime_match', level: 'fail', message: 'OTA mismatch' }];

console.log('iOS release build-stage tests');

// 1) refuses without --confirm-build
it('refuses without --confirm-build', () => {
  const r = evaluateBuildPreflight({ confirmBuild: false, gates: passingGates, dirty: okDirty });
  assert.equal(r.proceed, false);
  assert.ok(r.refusals.some(x => /confirm-build/.test(x)));
});

// 2) refuses if release gates fail (even with --confirm-build)
it('refuses if release gates fail', () => {
  const r = evaluateBuildPreflight({ confirmBuild: true, gates: failingGates, dirty: okDirty });
  assert.equal(r.proceed, false);
  assert.ok(r.refusals.some(x => /gates failed/.test(x)));
});

// 3) constructs the expected EAS commands WITHOUT executing them
it('buildEasArgs is streamed (no --json) for live progress', () => {
  assert.deepEqual(buildEasArgs('production'), ['build', '--platform', 'ios', '--profile', 'production', '--non-interactive']);
  assert.equal(buildEasArgs('production').includes('--json'), false);
  assert.deepEqual(buildEasArgs('preview'), ['build', '--platform', 'ios', '--profile', 'preview', '--non-interactive']);
});
it('buildListJsonArgs captures the latest build as JSON (for id capture after a streamed build)', () => {
  assert.deepEqual(buildListJsonArgs(), ['build:list', '--platform', 'ios', '--limit', '1', '--json', '--non-interactive']);
});
it('buildStatusBanner gives status + fallback command + no-duplicate help', () => {
  const b = buildStatusBanner('production');
  assert.ok(/Starting EAS build/.test(b));
  assert.ok(/QUIET/.test(b));
  assert.ok(/eas build:list --platform ios --limit 5/.test(b));
  assert.ok(/do NOT re-run|DUPLICATE/i.test(b));
});

// 4) ASC build-number checkpoint text present + actionable
it('ascCheckpointText names the version/build and the bump command', () => {
  const t = ascCheckpointText('1.0.10', '31');
  assert.ok(/1\.0\.10/.test(t));
  assert.ok(/build 31/.test(t));
  assert.ok(/release:ios:prepare -- --version 1\.0\.10 --build 32/.test(t));
  assert.ok(/App Store Connect/i.test(t));
});

// 5) dirty tracked files outside allowlist → refuse
it('refuses on modified tracked files outside the release allowlist', () => {
  const r = evaluateBuildPreflight({ confirmBuild: true, gates: passingGates, dirty: { ok: false, offending: ['src/App.tsx'] } });
  assert.equal(r.proceed, false);
  assert.ok(r.refusals.some(x => /src\/App\.tsx/.test(x)));
});

// pass case + state path
it('proceeds when confirmed + gates pass + clean tree; release-state path is local', () => {
  const r = evaluateBuildPreflight({ confirmBuild: true, gates: passingGates, dirty: okDirty });
  assert.equal(r.proceed, true);
  assert.deepEqual(r.refusals, []);
  assert.equal(RELEASE_STATE_PATH, 'reports/release/ios-release-state.json');
});

// durable channel fix: app.json carries the production channel header so prebuild preserves it
it('app.json carries the production channel header (durable Expo.plist channel fix)', () => {
  const app = JSON.parse(readFileSync('app.json', 'utf8')).expo;
  assert.equal(app.updates?.requestHeaders?.['expo-channel-name'], 'production');
  assert.equal(app.runtimeVersion, '1.0.10');            // unchanged
  assert.equal(typeof app.runtimeVersion, 'string');      // not a policy object
  assert.equal(app.updates?.url, 'https://u.expo.dev/3d5a36de-d144-4e6c-ac40-c336e8a8aac2'); // url unchanged
});

console.log(`\n${passed} iOS release build-stage assertions passed.`);
