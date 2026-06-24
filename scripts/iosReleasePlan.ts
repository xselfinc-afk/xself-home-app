/**
 * iosReleasePlan.ts — READ-ONLY iOS release planner (Phase 1).
 *
 * Inspects the current release state (app.json, ios pbxproj, Expo.plist, eas.json, git) and evaluates
 * release gates. Writes NOTHING — no version bump, no build, no submit, no OTA. Exits non-zero if any
 * HARD gate fails so it can front a future prepare/build/submit flow.
 *
 *   npm run release:ios:plan -- --version 1.0.10 [--build 32]
 *
 * Bare-workflow note: app.json alone is not authoritative. The SHIPPED binary's OTA runtime comes from
 * ios/.../Expo.plist (EXUpdatesRuntimeVersion); the store version/build come from pbxproj
 * (MARKETING_VERSION / CURRENT_PROJECT_VERSION). This planner cross-checks all of them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

// ── PURE: semver + build helpers ──────────────────────────────────────────────────────────────────
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** -1 if a<b, 0 if equal, 1 if a>b, NaN if either is not a clean x.y.z semver. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa || !pb) return NaN;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}
/** Next build number = current + 1 (NaN if current is not an integer). Never mutates anything. */
export function recommendNextBuild(currentBuild: string | number): number {
  const n = parseInt(String(currentBuild), 10);
  return Number.isFinite(n) ? n + 1 : NaN;
}

// ── PURE: gate evaluation ─────────────────────────────────────────────────────────────────────────
export type GateLevel = 'pass' | 'fail' | 'warn';
export interface GateResult { id: string; level: GateLevel; message: string; }
export interface ReleaseState {
  appVersion: string;
  appBuild: string;                 // app.json expo.ios.buildNumber (string)
  runtimeVersion: unknown;          // app.json expo.runtimeVersion (string expected; object = policy)
  updatesUrl: string | null;        // app.json expo.updates.url
  marketingVersions: string[];      // pbxproj MARKETING_VERSION occurrences
  currentProjectVersions: string[]; // pbxproj CURRENT_PROJECT_VERSION occurrences
  plistRuntime: string | null;      // Expo.plist EXUpdatesRuntimeVersion
  plistUrl: string | null;          // Expo.plist EXUpdatesURL
  plistChannel: string | null;      // Expo.plist expo-channel-name
  easChannel: string | null;        // eas.json build.production.channel
  easAppVersionSource: string | null; // eas.json cli.appVersionSource
  easSubmitAscAppIdPresent: boolean;   // eas.json submit.production.ios.ascAppId present (value never printed)
}

/** Evaluate all HARD gates (+ version-target classification). Pure — no I/O. */
export function evaluateGates(state: ReleaseState, target: { version: string }): GateResult[] {
  const r: GateResult[] = [];
  const fail = (id: string, message: string) => r.push({ id, level: 'fail', message });
  const pass = (id: string, message: string) => r.push({ id, level: 'pass', message });
  const uniq = (a: string[]) => [...new Set(a)].join('/') || '(none)';

  const rtIsString = typeof state.runtimeVersion === 'string';
  if (!rtIsString) fail('runtime_type', `runtimeVersion must be a STRING for bare workflow; got ${typeof state.runtimeVersion} (policy object not allowed here)`);
  else pass('runtime_type', `runtimeVersion is a string ("${state.runtimeVersion}")`);

  if (rtIsString) {
    if (state.plistRuntime !== state.runtimeVersion)
      fail('runtime_match', `OTA mismatch: Expo.plist EXUpdatesRuntimeVersion=${state.plistRuntime ?? 'null'} !== app.json runtimeVersion=${state.runtimeVersion}`);
    else pass('runtime_match', `Expo.plist runtime matches app.json (${state.runtimeVersion})`);
  }

  if (state.marketingVersions.length === 0) fail('pbxproj_marketing', 'no MARKETING_VERSION found in pbxproj');
  else if (state.marketingVersions.some(v => v !== state.appVersion))
    fail('pbxproj_marketing', `pbxproj MARKETING_VERSION=${uniq(state.marketingVersions)} !== app.json version=${state.appVersion}`);
  else pass('pbxproj_marketing', `pbxproj MARKETING_VERSION all = ${state.appVersion}`);

  if (state.currentProjectVersions.length === 0) fail('pbxproj_build', 'no CURRENT_PROJECT_VERSION found in pbxproj');
  else if (state.currentProjectVersions.some(v => v !== state.appBuild))
    fail('pbxproj_build', `pbxproj CURRENT_PROJECT_VERSION=${uniq(state.currentProjectVersions)} !== app.json ios.buildNumber=${state.appBuild}`);
  else pass('pbxproj_build', `pbxproj CURRENT_PROJECT_VERSION all = ${state.appBuild}`);

  if (state.updatesUrl !== state.plistUrl)
    fail('updates_url', `app.json updates.url !== Expo.plist EXUpdatesURL`);
  else pass('updates_url', 'updates URL matches (app.json ↔ Expo.plist)');

  if (state.plistChannel !== 'production') fail('plist_channel', `Expo.plist expo-channel-name=${state.plistChannel ?? 'null'} !== production`);
  else pass('plist_channel', 'Expo.plist channel = production');

  if (state.easChannel !== 'production') fail('eas_channel', `eas.json production.channel=${state.easChannel ?? 'null'} !== production`);
  else pass('eas_channel', 'eas.json production channel = production');

  if (state.easAppVersionSource !== 'local') fail('eas_version_source', `eas.json appVersionSource=${state.easAppVersionSource ?? 'null'} !== local`);
  else pass('eas_version_source', 'eas.json appVersionSource = local');

  if (!state.easSubmitAscAppIdPresent) fail('eas_submit_ascappid', 'eas.json submit.production.ios.ascAppId missing');
  else pass('eas_submit_ascappid', 'eas.json submit ascAppId present');

  const cmp = compareSemver(target.version, state.appVersion);
  if (Number.isNaN(cmp)) fail('version_target', `invalid semver (target=${target.version} current=${state.appVersion})`);
  else if (cmp < 0) fail('version_monotonic', `target ${target.version} < current ${state.appVersion} (downgrade refused)`);
  else pass('version_target', cmp === 0
    ? `target ${target.version} == current (re-plan of the in-progress release)`
    : `target ${target.version} > current ${state.appVersion} (new release; prepare will bump)`);

  return r;
}

// ── IMPURE: read current state from files (read-only) ───────────────────────────────────────────────
function plistString(xml: string, key: string): string | null {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  return m ? m[1] : null;
}
function gatherState(): ReleaseState {
  const root = process.cwd();
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))?.expo ?? {};
  const eas = JSON.parse(fs.readFileSync(path.join(root, 'eas.json'), 'utf8')) ?? {};

  const pbxPath = (() => {
    const dir = path.join(root, 'ios');
    const proj = fs.readdirSync(dir).find(d => d.endsWith('.xcodeproj'));
    return proj ? path.join(dir, proj, 'project.pbxproj') : '';
  })();
  const pbx = pbxPath && fs.existsSync(pbxPath) ? fs.readFileSync(pbxPath, 'utf8') : '';
  const grabAll = (re: RegExp) => { const out: string[] = []; let m; while ((m = re.exec(pbx))) out.push(m[1].trim()); return out; };
  const marketingVersions = grabAll(/MARKETING_VERSION\s*=\s*([^;]+);/g);
  const currentProjectVersions = grabAll(/CURRENT_PROJECT_VERSION\s*=\s*([^;]+);/g);

  const plistPath = ['ios/XselfHome/Supporting/Expo.plist', 'ios/Supporting/Expo.plist']
    .map(p => path.join(root, p)).find(p => fs.existsSync(p))
    ?? (() => { try { return execSync('find ios -name Expo.plist', { encoding: 'utf8' }).split('\n')[0].trim(); } catch { return ''; } })();
  const plistXml = plistPath && fs.existsSync(plistPath) ? fs.readFileSync(plistPath, 'utf8') : '';

  return {
    appVersion: String(app.version ?? ''),
    appBuild: String(app.ios?.buildNumber ?? ''),
    runtimeVersion: app.runtimeVersion,
    updatesUrl: app.updates?.url ?? null,
    marketingVersions,
    currentProjectVersions,
    plistRuntime: plistString(plistXml, 'EXUpdatesRuntimeVersion'),
    plistUrl: plistString(plistXml, 'EXUpdatesURL'),
    plistChannel: plistString(plistXml, 'expo-channel-name'),
    easChannel: eas.build?.production?.channel ?? null,
    easAppVersionSource: eas.cli?.appVersionSource ?? null,
    easSubmitAscAppIdPresent: Boolean(eas.submit?.production?.ios?.ascAppId),
  };
}

function gitInfo(): { branch: string; head: string; untracked: number; ahead: number | null } {
  const sh = (c: string) => { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch { return ''; } };
  const branch = sh('git rev-parse --abbrev-ref HEAD') || '(unknown)';
  const head = sh('git rev-parse --short HEAD') || '(unknown)';
  const untracked = (sh('git status --porcelain') || '').split('\n').filter(l => l.startsWith('??')).length;
  const aheadStr = sh('git rev-list --count @{u}..HEAD');
  const ahead = /^\d+$/.test(aheadStr) ? Number(aheadStr) : null;
  return { branch, head, untracked, ahead };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): { version?: string; build?: string } {
  const out: { version?: string; build?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') out.version = argv[++i];
    else if (argv[i] === '--build') out.build = argv[++i];
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version) { console.error('release:ios:plan — usage: npm run release:ios:plan -- --version <x.y.z> [--build <n>]'); process.exit(2); }

  const state = gatherState();
  const git = gitInfo();
  const gates = evaluateGates(state, { version: args.version });
  const fails = gates.filter(g => g.level === 'fail');
  const nextBuild = recommendNextBuild(state.appBuild);

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' iOS RELEASE PLAN (read-only — no files changed, no build)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('── Current release state ──');
  console.log(`  git              : ${git.branch} @ ${git.head}`);
  console.log(`  app.json version : ${state.appVersion}   buildNumber: ${state.appBuild}   runtimeVersion: ${JSON.stringify(state.runtimeVersion)}`);
  console.log(`  pbxproj          : MARKETING_VERSION=${[...new Set(state.marketingVersions)].join('/') || '(none)'}  CURRENT_PROJECT_VERSION=${[...new Set(state.currentProjectVersions)].join('/') || '(none)'}`);
  console.log(`  Expo.plist       : runtime=${state.plistRuntime ?? 'null'}  channel=${state.plistChannel ?? 'null'}  url=${state.plistUrl ? 'set' : 'null'}`);
  console.log(`  eas.json         : channel=${state.easChannel ?? 'null'}  appVersionSource=${state.easAppVersionSource ?? 'null'}  submit.ascAppId=${state.easSubmitAscAppIdPresent ? 'present' : 'MISSING'}`);
  console.log(`  target requested : ${args.version}   (recommended next buildNumber: ${Number.isNaN(nextBuild) ? '?' : nextBuild})`);

  console.log('\n── Gate results ──');
  for (const g of gates) console.log(`  [${g.level === 'pass' ? ' OK ' : g.level === 'fail' ? 'FAIL' : 'WARN'}] ${g.id}: ${g.message}`);

  const warns: string[] = [];
  if (git.untracked > 0) warns.push(`working tree has ${git.untracked} untracked file(s) — review/clean before a release build`);
  if (git.ahead == null) warns.push('branch has no upstream — not pushed');
  else if (git.ahead > 0) warns.push(`branch is ${git.ahead} commit(s) ahead of origin (unpushed) — push + tag before building`);
  warns.push('OTA: do NOT publish an OTA update for a new runtimeVersion until the matching App Store build is live');
  console.log('\n── Warnings ──');
  for (const w of warns) console.log(`  [WARN] ${w}`);

  if (fails.length) {
    console.log('\n── Hard failures ──');
    for (const f of fails) console.log(`  ✗ ${f.id}: ${f.message}`);
    console.log(`\nNEXT STEP: resolve the ${fails.length} hard failure(s) above (Phase-2 \`release:ios:prepare\` would fix the version/runtime files), then re-run this plan. Not safe to build.`);
    console.log(`RELEASE_PLAN_RESULT=FAIL hard_failures=${fails.length}`);
    process.exit(1);
  }
  console.log('\nNEXT STEP: gates pass. When prepare/build/submit stages exist: `release:ios:build -- --confirm-build`.');
  console.log('RELEASE_PLAN_RESULT=PASS');
}

if (require.main === module) main();
