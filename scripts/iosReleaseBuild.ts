/**
 * iosReleaseBuild.ts — iOS release BUILD stage (Phase 4).
 *
 * Runs an EAS *production* build ONLY after the release gates pass and the operator explicitly
 * confirms. It does NOT submit, does NOT bump versions, does NOT publish OTA. Reuses the SAME gates
 * as release:ios:plan (single source of truth) + the clean-tree check from release:ios:prepare.
 *
 *   npm run release:ios:build -- --confirm-build            # real EAS production build
 *   npm run release:ios:build -- --dry-run                  # preview gates + the exact eas command; NO build
 *   npm run release:ios:build -- --confirm-build --dry-run  # preview that a real run would proceed
 *
 * On a real build it records the produced EAS build id to reports/release/ios-release-state.json for
 * the future submit stage. Build and submit are intentionally separate.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { gatherState, evaluateGates, type GateResult } from './iosReleasePlan';
import { checkDirtyTrackedAllowlist } from './iosReleasePrepare';

export const RELEASE_STATE_PATH = 'reports/release/ios-release-state.json';

// ── PURE: helpers (testable; no I/O, no EAS) ────────────────────────────────────────────────────────
/** The exact `eas` argv for a production iOS build. Pure — used to construct, NOT execute, in tests. */
export function buildEasArgs(profile = 'production'): string[] {
  return ['build', '--platform', 'ios', '--profile', profile, '--non-interactive', '--json'];
}

/** App Store Connect build-number checkpoint text (no credentials, no network). Pure. */
export function ascCheckpointText(version: string, build: string): string {
  const n = Number.parseInt(build, 10);
  const next = Number.isFinite(n) ? String(n + 1) : '<n+1>';
  return [
    'App Store Connect build-number checkpoint (manual):',
    `  • This release is ${version} / build ${build}.`,
    `  • Confirm in App Store Connect / TestFlight that ${version} (build ${build}) is NOT already uploaded.`,
    `  • If it already exists, STOP and bump the build first:`,
    `      npm run release:ios:prepare -- --version ${version} --build ${next}`,
    '  • Passing --confirm-build asserts you have confirmed the build number is free.',
  ].join('\n');
}

/** Decide whether a build may proceed. Pure — combines confirm flag + gate results + clean-tree. */
export function evaluateBuildPreflight(input: {
  confirmBuild: boolean;
  gates: GateResult[];
  dirty: { ok: boolean; offending: string[] };
}): { proceed: boolean; refusals: string[] } {
  const refusals: string[] = [];
  if (!input.confirmBuild) refusals.push('missing --confirm-build (refusing to build without explicit confirmation)');
  const gateFails = input.gates.filter(g => g.level === 'fail');
  if (gateFails.length) refusals.push(`release gates failed: ${gateFails.map(g => g.id).join(', ')} — run release:ios:plan / release:ios:prepare`);
  if (!input.dirty.ok) refusals.push(`modified tracked files outside the release allowlist: ${input.dirty.offending.join(', ')} — commit/stash first`);
  return { proceed: refusals.length === 0, refusals };
}

// ── IMPURE: orchestration ─────────────────────────────────────────────────────────────────────────
function sh(c: string): string { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch { return ''; } }
function pbxPath(root: string): string {
  const dir = path.join(root, 'ios');
  const proj = fs.readdirSync(dir).find(d => d.endsWith('.xcodeproj'));
  return proj ? path.join(dir, proj, 'project.pbxproj') : '';
}
function plistPath(root: string): string {
  return ['ios/XselfHome/Supporting/Expo.plist', 'ios/Supporting/Expo.plist']
    .map(p => path.join(root, p)).find(p => fs.existsSync(p)) ?? '';
}

function parseArgs(argv: string[]): { confirmBuild: boolean; dryRun: boolean; profile: string; version?: string } {
  const out = { confirmBuild: false, dryRun: process.env.DRY_RUN === '1', profile: 'production', version: undefined as string | undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--confirm-build') out.confirmBuild = true;
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--profile') out.profile = argv[++i];
    else if (argv[i] === '--version') out.version = argv[++i];
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const relAllow = [path.join(root, 'app.json'), pbxPath(root), plistPath(root)].map(p => path.relative(root, p));

  const state = gatherState();
  const targetVersion = args.version ?? state.appVersion;
  const gates = evaluateGates(state, { version: targetVersion });
  const dirty = checkDirtyTrackedAllowlist(sh('git status --porcelain').split('\n'), relAllow);
  const pre = evaluateBuildPreflight({ confirmBuild: args.confirmBuild, gates, dirty });

  const aheadStr = sh('git rev-list --count @{u}..HEAD');
  const untracked = sh('git status --porcelain').split('\n').filter(l => l.startsWith('??')).length;

  console.log('═══════════════════════════════════════════════════════════');
  console.log(` iOS RELEASE BUILD — ${state.appVersion} / build ${state.appBuild} (profile ${args.profile})${args.dryRun ? '  [DRY RUN]' : ''}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('── Gate results ──');
  for (const g of gates) console.log(`  [${g.level === 'pass' ? ' OK ' : g.level === 'fail' ? 'FAIL' : 'WARN'}] ${g.id}: ${g.message}`);
  console.log('\n' + ascCheckpointText(state.appVersion, state.appBuild));

  const warns: string[] = [];
  if (untracked > 0) warns.push(`${untracked} untracked WIP file(s) — not staged, not built (EAS builds the committed project)`);
  if (/^\d+$/.test(aheadStr) && Number(aheadStr) > 0) warns.push(`branch is ${aheadStr} commit(s) ahead of origin (unpushed) — push + tag before a real build`);
  else if (!/^\d+$/.test(aheadStr)) warns.push('branch has no upstream — not pushed');
  if (warns.length) { console.log('\n── Warnings ──'); for (const w of warns) console.log(`  [WARN] ${w}`); }

  if (args.dryRun) {
    console.log('\n── Dry run (no build) ──');
    console.log(`  would_run: eas ${buildEasArgs(args.profile).join(' ')}`);
    console.log(`  release_state would be written to: ${RELEASE_STATE_PATH} (with the real EAS build id, on a real build)`);
    console.log(`  guard:prod: NOT run in dry-run (it is a HARD gate in a real build)`);
    console.log(`  preflight_proceed=${pre.proceed}${pre.proceed ? ' (a real run would then require guard:prod to pass)' : ''}`);
    if (!pre.proceed) for (const r of pre.refusals) console.log(`    ✗ ${r}`);
    console.log('RELEASE_BUILD_RESULT=DRY_RUN (no EAS build executed)');
    return;
  }

  // ── REAL build path ──
  if (!pre.proceed) {
    console.error('\n── Refusing to build ──');
    for (const r of pre.refusals) console.error(`  ✗ ${r}`);
    console.error('RELEASE_BUILD_RESULT=REFUSED');
    process.exit(1);
  }

  // HARD gate: production guardrails must pass before a real build.
  console.log('\n── Running production guardrails (npm run guard:prod) ──');
  const guard = spawnSync('npm', ['run', 'guard:prod'], { stdio: 'inherit' });
  if (guard.status !== 0) { console.error('RELEASE_BUILD_RESULT=REFUSED (guard:prod failed)'); process.exit(1); }

  // Execute the production build and capture the EAS build id (never fabricated).
  console.log(`\n── eas ${buildEasArgs(args.profile).join(' ')} ──`);
  const r = spawnSync('eas', buildEasArgs(args.profile), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) { console.error('RELEASE_BUILD_RESULT=BUILD_FAILED'); process.exit(2); }
  let buildId: string | null = null, buildUrl: string | null = null;
  try {
    const arr = JSON.parse(r.stdout || '[]');
    const b = Array.isArray(arr) ? arr[0] : arr;
    buildId = b?.id ?? null; buildUrl = b?.artifacts?.buildUrl ?? b?.buildUrl ?? null;
  } catch { /* leave null — never fabricate */ }

  fs.mkdirSync(path.join(root, 'reports', 'release'), { recursive: true });
  const stateOut = {
    version: state.appVersion, build: state.appBuild, runtimeVersion: state.runtimeVersion,
    channel: state.easChannel, profile: args.profile,
    eas_build_id: buildId, eas_build_url: buildUrl,
    git_commit: sh('git rev-parse HEAD') || null, built_at: new Date().toISOString(), status: buildId ? 'built' : 'built_no_id',
  };
  fs.writeFileSync(path.join(root, RELEASE_STATE_PATH), JSON.stringify(stateOut, null, 2));
  console.log(`  recorded ${RELEASE_STATE_PATH} (eas_build_id=${buildId ?? 'unknown'})`);
  console.log('RELEASE_BUILD_RESULT=BUILT (submit is a separate step: release:ios:submit -- --confirm-submit)');
}

if (require.main === module) main();
