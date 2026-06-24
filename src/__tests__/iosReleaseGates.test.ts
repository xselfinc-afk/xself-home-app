/**
 * iOS release gate tests — pure; no I/O, no build, no secrets.
 * The planner is import-safe (require.main guard), so importing it does not read files or exit.
 * Run: npx tsx src/__tests__/iosReleaseGates.test.ts
 */
import assert from 'node:assert/strict';
import { evaluateGates, compareSemver, recommendNextBuild, parseSemver, type ReleaseState } from '../../scripts/iosReleasePlan';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }
const hasFail = (rs: ReturnType<typeof evaluateGates>, id?: string) => rs.some(r => r.level === 'fail' && (!id || r.id === id));

// A fully-consistent baseline (mirrors a clean 1.0.10 / build 31 tree).
function good(): ReleaseState {
  return {
    appVersion: '1.0.10', appBuild: '31', runtimeVersion: '1.0.10',
    updatesUrl: 'https://u.expo.dev/abc',
    marketingVersions: ['1.0.10', '1.0.10'], currentProjectVersions: ['31', '31'],
    plistRuntime: '1.0.10', plistUrl: 'https://u.expo.dev/abc', plistChannel: 'production',
    easChannel: 'production', easAppVersionSource: 'local', easSubmitAscAppIdPresent: true,
  };
}

console.log('iOS release gate tests');

// 2) Matching runtime + all consistent → no hard failures
it('all-consistent state passes (no hard failures)', () => {
  const rs = evaluateGates(good(), { version: '1.0.10' });
  assert.equal(hasFail(rs), false);
});

// 1) Runtime mismatch fails (app 1.0.10 vs plist 1.0.9 — the real current-tree bug)
it('runtime mismatch fails (plist 1.0.9 vs app 1.0.10)', () => {
  const s = good(); s.plistRuntime = '1.0.9';
  const rs = evaluateGates(s, { version: '1.0.10' });
  assert.equal(hasFail(rs, 'runtime_match'), true);
});

// 3) pbxproj marketing/build mismatch fails
it('pbxproj MARKETING_VERSION mismatch fails', () => {
  const s = good(); s.marketingVersions = ['1.0.10', '1.0.9'];
  assert.equal(hasFail(evaluateGates(s, { version: '1.0.10' }), 'pbxproj_marketing'), true);
});
it('pbxproj CURRENT_PROJECT_VERSION mismatch fails', () => {
  const s = good(); s.currentProjectVersions = ['31', '30'];
  assert.equal(hasFail(evaluateGates(s, { version: '1.0.10' }), 'pbxproj_build'), true);
});

// 4) runtimeVersion policy object (not a string) fails
it('runtimeVersion policy object fails the type gate', () => {
  const s = good(); s.runtimeVersion = { policy: 'appVersion' } as unknown as string;
  assert.equal(hasFail(evaluateGates(s, { version: '1.0.10' }), 'runtime_type'), true);
});

// 5) production channel mismatch fails (eas + plist)
it('eas channel != production fails', () => {
  const s = good(); s.easChannel = 'preview';
  assert.equal(hasFail(evaluateGates(s, { version: '1.0.10' }), 'eas_channel'), true);
});
it('Expo.plist channel != production fails', () => {
  const s = good(); s.plistChannel = 'staging';
  assert.equal(hasFail(evaluateGates(s, { version: '1.0.10' }), 'plist_channel'), true);
});

// extra hard gates
it('appVersionSource != local fails', () => {
  const s = good(); s.easAppVersionSource = 'remote';
  assert.equal(hasFail(evaluateGates(s, { version: '1.0.10' }), 'eas_version_source'), true);
});
it('updates url mismatch fails', () => {
  const s = good(); s.plistUrl = 'https://u.expo.dev/different';
  assert.equal(hasFail(evaluateGates(s, { version: '1.0.10' }), 'updates_url'), true);
});
it('downgrade target fails; equal/greater do not', () => {
  assert.equal(hasFail(evaluateGates(good(), { version: '1.0.9' }), 'version_monotonic'), true);
  assert.equal(hasFail(evaluateGates(good(), { version: '1.0.10' })), false); // equal = re-plan
  assert.equal(hasFail(evaluateGates(good(), { version: '1.0.11' })), false); // greater = new release
});

// 6) build/version consistency helpers
it('compareSemver + recommendNextBuild + parseSemver work', () => {
  assert.equal(compareSemver('1.0.11', '1.0.10'), 1);
  assert.equal(compareSemver('1.0.10', '1.0.10'), 0);
  assert.equal(compareSemver('1.0.9', '1.0.10'), -1);
  assert.ok(Number.isNaN(compareSemver('1.0', '1.0.10')));
  assert.equal(recommendNextBuild('31'), 32);
  assert.ok(Number.isNaN(recommendNextBuild('abc')));
  assert.deepEqual(parseSemver('1.0.10'), [1, 0, 10]);
  assert.equal(parseSemver('1.0'), null);
});

console.log(`\n${passed} iOS release gate assertions passed.`);
