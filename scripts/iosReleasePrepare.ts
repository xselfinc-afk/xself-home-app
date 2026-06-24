/**
 * iosReleasePrepare.ts — iOS release PREPARE (Phase 2).
 *
 * Makes the release-version files internally consistent for a target version, re-verifies with the
 * SAME gates as release:ios:plan, and commits a focused release-prep diff. It does NOT build or submit
 * or publish OTA. Only the release files may change: app.json, ios/<proj>.xcodeproj/project.pbxproj,
 * ios/.../Expo.plist. Version is never auto-bumped — require an explicit --version (and --build to
 * change the build number).
 *
 *   npm run release:ios:prepare -- --version 1.0.10 [--build 32] [--no-commit]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { gatherState, evaluateGates, compareSemver, type ReleaseState } from './iosReleasePlan';

// ── PURE: prepare edit computation + targeted string transforms (testable) ──────────────────────────
export interface PrepareEdit { id: string; file: 'app.json' | 'pbxproj' | 'plist'; from: string; to: string; }
export interface PrepareTarget { version: string; build: string; runtime: string; }

/** What must change to make `state` consistent with `target`. Empty array = already prepared. Pure. */
export function computePrepareEdits(state: ReleaseState, target: PrepareTarget): PrepareEdit[] {
  const e: PrepareEdit[] = [];
  const uniq = (a: string[]) => [...new Set(a)].join('/') || '(none)';
  if (state.appVersion !== target.version) e.push({ id: 'app_version', file: 'app.json', from: state.appVersion, to: target.version });
  if (state.appBuild !== target.build) e.push({ id: 'app_build', file: 'app.json', from: state.appBuild, to: target.build });
  if (typeof state.runtimeVersion === 'string' && state.runtimeVersion !== target.runtime)
    e.push({ id: 'app_runtime', file: 'app.json', from: String(state.runtimeVersion), to: target.runtime });
  if (state.marketingVersions.some(v => v !== target.version))
    e.push({ id: 'pbx_marketing', file: 'pbxproj', from: uniq(state.marketingVersions), to: target.version });
  if (state.currentProjectVersions.some(v => v !== target.build))
    e.push({ id: 'pbx_build', file: 'pbxproj', from: uniq(state.currentProjectVersions), to: target.build });
  if (state.plistRuntime !== target.runtime)
    e.push({ id: 'plist_runtime', file: 'plist', from: String(state.plistRuntime), to: target.runtime });
  return e;
}

/** Refuse to operate on a policy-object runtimeVersion. Returns a reason string, or null if OK. Pure. */
export function runtimePolicyReason(runtimeVersion: unknown): string | null {
  return typeof runtimeVersion === 'string'
    ? null
    : `app.json runtimeVersion is a ${typeof runtimeVersion} (policy object?) — bare workflow requires a string; refusing to auto-convert`;
}

/** Refuse if any MODIFIED/STAGED TRACKED file is outside the release allowlist. Untracked (??) ignored. Pure. */
export function checkDirtyTrackedAllowlist(porcelainLines: string[], allowlist: string[]): { ok: boolean; offending: string[] } {
  const offending: string[] = [];
  for (const line of porcelainLines) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (status === '??') continue;                 // untracked WIP — left alone
    if (!allowlist.includes(file)) offending.push(file);
  }
  return { ok: offending.length === 0, offending };
}

export function editPlistRuntime(xml: string, to: string): string {
  return xml.replace(/(<key>EXUpdatesRuntimeVersion<\/key>\s*<string>)([^<]*)(<\/string>)/, `$1${to}$3`);
}
/** Replace the FIRST `"key": "..."` string value. Pure. */
export function setJsonStringValue(text: string, key: string, to: string): string {
  return text.replace(new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`), `$1${to}$2`);
}
/** Replace ALL `KEY = value;` occurrences in a pbxproj. Pure. */
export function setPbxValue(text: string, key: string, to: string): string {
  return text.replace(new RegExp(`(${key}\\s*=\\s*)[^;]+(;)`, 'g'), `$1${to}$2`);
}

// ── IMPURE: orchestration ───────────────────────────────────────────────────────────────────────────
function die(msg: string): never { console.error(`RELEASE_PREPARE_ERROR: ${msg}`); process.exit(1); }
function sh(c: string): string { return execSync(c, { encoding: 'utf8' }).trim(); }

function pbxPath(root: string): string {
  const dir = path.join(root, 'ios');
  const proj = fs.readdirSync(dir).find(d => d.endsWith('.xcodeproj'));
  return proj ? path.join(dir, proj, 'project.pbxproj') : '';
}
function plistPath(root: string): string {
  return ['ios/XselfHome/Supporting/Expo.plist', 'ios/Supporting/Expo.plist']
    .map(p => path.join(root, p)).find(p => fs.existsSync(p))
    ?? sh('find ios -name Expo.plist').split('\n')[0].trim();
}

function parseArgs(argv: string[]): { version?: string; build?: string; noCommit: boolean } {
  const out: { version?: string; build?: string; noCommit: boolean } = { noCommit: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') out.version = argv[++i];
    else if (argv[i] === '--build') out.build = argv[++i];
    else if (argv[i] === '--no-commit') out.noCommit = true;
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version) die('usage: npm run release:ios:prepare -- --version <x.y.z> [--build <n>] [--no-commit]');
  const root = process.cwd();
  const APP = path.join(root, 'app.json');
  const PBX = pbxPath(root);
  const PLIST = plistPath(root);
  const relAllow = [APP, PBX, PLIST].map(p => path.relative(root, p));

  const state = gatherState();

  // Refuse policy-object runtimeVersion.
  const policyReason = runtimePolicyReason(state.runtimeVersion);
  if (policyReason) die(policyReason);

  // Build number: explicit --build, else keep current. Never auto-bump.
  const target: PrepareTarget = { version: args.version, build: args.build ?? state.appBuild, runtime: args.version };
  const cmp = compareSemver(target.version, state.appVersion);
  if (Number.isNaN(cmp)) die(`invalid semver: target=${target.version} current=${state.appVersion}`);
  if (cmp < 0) die(`target ${target.version} < current ${state.appVersion} (downgrade refused)`);
  if (cmp > 0 && !args.build) console.warn(`RELEASE_PREPARE_WARN: new version ${target.version} without --build; keeping buildNumber ${target.build} (pass --build to change it)`);

  // Refuse if a TRACKED file outside the release allowlist is modified (don't fold unrelated work into the release commit).
  const dirty = checkDirtyTrackedAllowlist(sh('git status --porcelain').split('\n'), relAllow);
  if (!dirty.ok) die(`tracked files modified outside the release allowlist: ${dirty.offending.join(', ')} — commit/stash them first`);

  // Compute + apply edits (only what's needed).
  const edits = computePrepareEdits(state, target);
  const changed: string[] = [];
  const applyFile = (abs: string, transform: (s: string) => string) => {
    const before = fs.readFileSync(abs, 'utf8'); const after = transform(before);
    if (after !== before) { fs.writeFileSync(abs, after); const rel = path.relative(root, abs); if (!changed.includes(rel)) changed.push(rel); }
  };
  for (const ed of edits) {
    if (ed.file === 'app.json') {
      const key = ed.id === 'app_version' ? 'version' : ed.id === 'app_build' ? 'buildNumber' : 'runtimeVersion';
      applyFile(APP, t => setJsonStringValue(t, key, ed.to));
    } else if (ed.file === 'pbxproj') {
      const key = ed.id === 'pbx_marketing' ? 'MARKETING_VERSION' : 'CURRENT_PROJECT_VERSION';
      applyFile(PBX, t => setPbxValue(t, key, ed.to));
    } else if (ed.file === 'plist') {
      applyFile(PLIST, t => editPlistRuntime(t, ed.to));
    }
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log(` iOS RELEASE PREPARE — target ${target.version} (build ${target.build})`);
  console.log('═══════════════════════════════════════════════════════════');
  if (edits.length === 0) console.log('  Already consistent — no edits needed.');
  else for (const ed of edits) console.log(`  edit ${ed.id} (${ed.file}): ${ed.from} → ${ed.to}`);

  // Re-verify with the SAME gates as plan.
  const post = gatherState();
  const gates = evaluateGates(post, { version: target.version });
  const fails = gates.filter(g => g.level === 'fail');
  if (fails.length) {
    for (const f of fails) console.error(`  ✗ ${f.id}: ${f.message}`);
    die(`${fails.length} gate(s) still failing after prepare — not committing`);
  }
  console.log('  Gates: PASS');

  if (changed.length === 0) { console.log('RELEASE_PREPARE_RESULT=NOOP (nothing to change)'); return; }

  // Safety: every changed file must be in the release allowlist.
  const outside = changed.filter(c => !relAllow.includes(c));
  if (outside.length) die(`refusing: changed files outside release allowlist: ${outside.join(', ')}`);
  console.log(`  Changed files: ${changed.join(', ')}`);

  if (args.noCommit) { console.log('RELEASE_PREPARE_RESULT=PREPARED (--no-commit; not committed)'); return; }

  // Commit ONLY the changed release files (never the untracked WIP).
  sh(`git add ${changed.map(c => `'${c}'`).join(' ')}`);
  const staged = sh('git diff --cached --name-only').split('\n').filter(Boolean);
  const stagedOutside = staged.filter(s => !relAllow.includes(s));
  if (stagedOutside.length) die(`staged files outside allowlist: ${stagedOutside.join(', ')} — aborting commit`);
  sh(`git commit -m 'chore(release): prepare iOS ${target.version} runtime metadata' -m 'release:ios:prepare — ${changed.join(', ')} (${edits.map(e => e.id).join(', ')}). No build/submit/OTA.' -m 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'`);
  console.log(`  Committed: ${sh('git rev-parse --short HEAD')}`);
  console.log('RELEASE_PREPARE_RESULT=COMMITTED');
}

if (require.main === module) main();
