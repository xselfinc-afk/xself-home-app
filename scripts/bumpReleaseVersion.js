#!/usr/bin/env node
/**
 * bumpReleaseVersion.js — increment app.json + ios buildNumber for a release.
 *
 *   expo.version (semver patch) : 1.0.4 → 1.0.5
 *   expo.ios.buildNumber        : 25    → 26 (or +1 from whatever was there)
 *
 * Then runs syncIosNativeVersion.js so pbxproj follows immediately.
 *
 * Usage:
 *   npm run version:bump
 *   node scripts/bumpReleaseVersion.js --dry-run     # report only, no writes
 *
 * Exit codes:
 *   0  bumped (or dry-run completed successfully)
 *   1  could not parse version / buildNumber / app.json
 *   2  sync:ios-version failed after the bump
 */

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT     = path.resolve(__dirname, '..');
const APP_JSON_PATH = path.join(REPO_ROOT, 'app.json');

const DRY_RUN = process.argv.includes('--dry-run');

function die(msg, code = 1) {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
}

if (!fs.existsSync(APP_JSON_PATH)) die(`app.json not found at ${APP_JSON_PATH}`);

const raw = fs.readFileSync(APP_JSON_PATH, 'utf8');
let appJson;
try { appJson = JSON.parse(raw); } catch (e) { die(`failed to parse app.json: ${e.message}`); }

const oldVersion = appJson?.expo?.version;
const oldBuild   = appJson?.expo?.ios?.buildNumber;
if (!oldVersion) die('app.json expo.version missing');
if (!oldBuild)   die('app.json expo.ios.buildNumber missing');

const m = String(oldVersion).match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!m) die(`expo.version must be semver MAJOR.MINOR.PATCH, got: ${oldVersion}`);
const newVersion = `${m[1]}.${m[2]}.${parseInt(m[3], 10) + 1}`;

const buildInt = parseInt(String(oldBuild), 10);
if (!Number.isFinite(buildInt)) die(`expo.ios.buildNumber must be an integer string, got: ${oldBuild}`);
const newBuild = String(buildInt + 1);

console.log('Release version bump:');
console.log(`  expo.version         : ${oldVersion} → ${newVersion}`);
console.log(`  expo.ios.buildNumber : ${oldBuild} → ${newBuild}`);

if (DRY_RUN) {
  console.log('\n(dry-run — app.json was NOT modified, sync:ios-version was NOT invoked)');
  process.exit(0);
}

appJson.expo.version           = newVersion;
appJson.expo.ios.buildNumber   = newBuild;

// Preserve 2-space indentation and trailing newline to match the existing file.
const trailingNewline = raw.endsWith('\n') ? '\n' : '';
fs.writeFileSync(APP_JSON_PATH, JSON.stringify(appJson, null, 2) + trailingNewline);
console.log('  ✓ app.json written.');

// Run the native sync so pbxproj matches immediately.
const r = spawnSync('node', [path.join(__dirname, 'syncIosNativeVersion.js')], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});
if (r.status !== 0) die(`sync:ios-version exited with code ${r.status}`, 2);
