/**
 * iOS release gate tests — pure; no I/O, no build, no secrets.
 * The planner is import-safe (require.main guard), so importing it does not read files or exit.
 * Run: npx tsx src/__tests__/iosReleaseGates.test.ts
 */
import assert from 'node:assert/strict';
import { evaluateGates, compareSemver, recommendNextBuild, parseSemver, type ReleaseState } from '../../scripts/iosReleasePlan';
import { computePrepareEdits, runtimePolicyReason, checkDirtyTrackedAllowlist, editPlistRuntime, setJsonStringValue, setPbxValue } from '../../scripts/iosReleasePrepare';

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

// ── Phase 2: prepare helpers ──
const target = { version: '1.0.10', build: '31', runtime: '1.0.10' };

// 1) prepare changes plist runtime when app runtime is newer than the plist
it('computePrepareEdits: plist runtime stale → emits plist_runtime edit (1.0.9 → 1.0.10)', () => {
  const s = good(); s.plistRuntime = '1.0.9';
  const edits = computePrepareEdits(s, target);
  const pl = edits.find(e => e.id === 'plist_runtime');
  assert.ok(pl, 'expected a plist_runtime edit');
  assert.equal(pl!.from, '1.0.9'); assert.equal(pl!.to, '1.0.10');
});

// 2) prepare does not change already-matching state
it('computePrepareEdits: fully-consistent state → no edits', () => {
  assert.deepEqual(computePrepareEdits(good(), target), []);
});

// also covers version/build/pbxproj edit emission
it('computePrepareEdits: version+build+pbxproj diffs all emit edits', () => {
  const s = good(); s.appVersion = '1.0.9'; s.appBuild = '30'; s.runtimeVersion = '1.0.9';
  s.marketingVersions = ['1.0.9', '1.0.9']; s.currentProjectVersions = ['30', '30']; s.plistRuntime = '1.0.9';
  const ids = computePrepareEdits(s, target).map(e => e.id).sort();
  assert.deepEqual(ids, ['app_build', 'app_runtime', 'app_version', 'pbx_build', 'pbx_marketing', 'plist_runtime'].sort());
});

// 3) prepare refuses runtimeVersion policy object
it('runtimePolicyReason: object → reason; string → null', () => {
  assert.ok(runtimePolicyReason({ policy: 'appVersion' }));
  assert.equal(runtimePolicyReason('1.0.10'), null);
});

// 4) prepare refuses unexpected dirty TRACKED files; allows untracked + allowlisted
it('checkDirtyTrackedAllowlist: tracked file outside allowlist → not ok; untracked/allowlisted → ok', () => {
  const allow = ['app.json', 'ios/XselfHome.xcodeproj/project.pbxproj', 'ios/XselfHome/Supporting/Expo.plist'];
  const bad = checkDirtyTrackedAllowlist([' M src/App.tsx', ' M app.json'], allow);
  assert.equal(bad.ok, false); assert.deepEqual(bad.offending, ['src/App.tsx']);
  const okCase = checkDirtyTrackedAllowlist([' M app.json', '?? scripts/whatever.ts', '?? docs/x.md'], allow);
  assert.equal(okCase.ok, true); assert.deepEqual(okCase.offending, []);
});

// 5) pure string transforms
it('editPlistRuntime / setJsonStringValue / setPbxValue are correct, minimal transforms', () => {
  const plist = '<key>EXUpdatesRuntimeVersion</key>\n    <string>1.0.9</string>';
  assert.ok(editPlistRuntime(plist, '1.0.10').includes('<string>1.0.10</string>'));
  assert.equal(editPlistRuntime(plist, '1.0.10').includes('1.0.9'), false);
  assert.equal(setJsonStringValue('"buildNumber": "31"', 'buildNumber', '32'), '"buildNumber": "32"');
  assert.equal(setPbxValue('MARKETING_VERSION = 1.0.9;\nMARKETING_VERSION = 1.0.9;', 'MARKETING_VERSION', '1.0.10'),
    'MARKETING_VERSION = 1.0.10;\nMARKETING_VERSION = 1.0.10;');
});

console.log(`\n${passed} iOS release gate assertions passed.`);
