#!/usr/bin/env node
/**
 * syncIosNativeVersion.js — make Xcode's pbxproj match app.json.
 *
 * Xcode embeds MARKETING_VERSION and CURRENT_PROJECT_VERSION inside
 * project.pbxproj. Expo prebuild writes them on the FIRST prebuild but does
 * NOT update them on subsequent app.json edits — meaning a build can ship
 * "1.0.4 (25)" in app.json while the actual .ipa metadata is "1.0.1 (4)".
 *
 * This script rewrites every MARKETING_VERSION and CURRENT_PROJECT_VERSION
 * line in pbxproj to match the current app.json values. Idempotent.
 *
 * Manual run:
 *   npm run sync:ios-version
 *
 * Exit codes:
 *   0  one or more replacements made (or values already matched)
 *   1  could not read app.json / pbxproj, or no MARKETING_VERSION /
 *      CURRENT_PROJECT_VERSION lines found to update
 */

const fs   = require('fs');
const path = require('path');

const REPO_ROOT     = path.resolve(__dirname, '..');
const APP_JSON_PATH = path.join(REPO_ROOT, 'app.json');
const PBX_PATH      = path.join(REPO_ROOT, 'ios', 'XselfHome.xcodeproj', 'project.pbxproj');

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(APP_JSON_PATH)) die(`app.json not found at ${APP_JSON_PATH}`);
if (!fs.existsSync(PBX_PATH))      die(`project.pbxproj not found at ${PBX_PATH}`);

let appJson;
try {
  appJson = JSON.parse(fs.readFileSync(APP_JSON_PATH, 'utf8'));
} catch (e) {
  die(`failed to parse app.json: ${e.message}`);
}

const version     = appJson?.expo?.version;
const buildNumber = appJson?.expo?.ios?.buildNumber;
if (!version)     die('app.json expo.version is missing');
if (!buildNumber) die('app.json expo.ios.buildNumber is missing');

const pbxBefore = fs.readFileSync(PBX_PATH, 'utf8');

const MARKETING_RE = /MARKETING_VERSION\s*=\s*([^;]+);/g;
const PROJECT_RE   = /CURRENT_PROJECT_VERSION\s*=\s*([^;]+);/g;

const oldMarketing = new Set();
const oldProject   = new Set();
let mv;
while ((mv = MARKETING_RE.exec(pbxBefore)) !== null) oldMarketing.add(mv[1].trim());
let pv;
while ((pv = PROJECT_RE.exec(pbxBefore)) !== null) oldProject.add(pv[1].trim());

if (oldMarketing.size === 0 && oldProject.size === 0) {
  die(`no MARKETING_VERSION or CURRENT_PROJECT_VERSION lines found in ${PBX_PATH}`);
}

let pbxAfter = pbxBefore;
let marketingReplacements = 0;
let projectReplacements   = 0;

pbxAfter = pbxAfter.replace(/MARKETING_VERSION\s*=\s*[^;]+;/g, () => {
  marketingReplacements++;
  return `MARKETING_VERSION = ${version};`;
});
pbxAfter = pbxAfter.replace(/CURRENT_PROJECT_VERSION\s*=\s*[^;]+;/g, () => {
  projectReplacements++;
  return `CURRENT_PROJECT_VERSION = ${buildNumber};`;
});

if (marketingReplacements === 0 && projectReplacements === 0) {
  die('regex matched zero replacements (this should not happen — pbxproj structure is unexpected)');
}

if (pbxAfter !== pbxBefore) {
  fs.writeFileSync(PBX_PATH, pbxAfter);
}

console.log('iOS native version sync:');
console.log(`  app.json expo.version         : ${version}`);
console.log(`  app.json expo.ios.buildNumber : ${buildNumber}`);
console.log(`  MARKETING_VERSION         (${marketingReplacements}x) : ${
  [...oldMarketing].join(', ')} → ${version}`);
console.log(`  CURRENT_PROJECT_VERSION   (${projectReplacements}x) : ${
  [...oldProject].join(', ')} → ${buildNumber}`);
console.log(pbxAfter === pbxBefore
  ? '  (no changes — pbxproj already in sync)'
  : '  ✓ pbxproj updated.');
