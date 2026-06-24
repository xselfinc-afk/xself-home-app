/**
 * iosReleaseSubmit.ts — iOS release SUBMIT stage (Phase 5).
 *
 * Submits ONE specific, recorded EAS build id (from reports/release/ios-release-state.json) to App
 * Store Connect — never "latest". It re-checks the release gates, verifies the recorded release
 * matches the current prepared app.json/pbxproj, and verifies the EAS build artifact's version/build
 * before submitting. It does NOT build, bump, deploy, or publish OTA.
 *
 *   npm run release:ios:submit -- --confirm-submit            # real submit of the recorded build id
 *   npm run release:ios:submit -- --confirm-submit --dry-run  # preview the exact submit command; NO submit
 *
 * Replaces the deprecated one-shot scripts/releaseIosProduction.sh (kept as reference, alias repointed).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { gatherState, evaluateGates, type GateResult } from './iosReleasePlan';
import { RELEASE_STATE_PATH } from './iosReleaseBuild';

// ── PURE: helpers (testable; no I/O, no EAS) ────────────────────────────────────────────────────────
export interface ReleaseStateFile {
  version?: string; build?: string; runtimeVersion?: unknown; channel?: string | null;
  profile?: string; eas_build_id?: string | null; eas_build_url?: string | null;
  git_commit?: string | null; built_at?: string | null; status?: string;
}

/** The exact `eas` argv to submit ONE specific build id. Pure — used to construct, NOT execute, in tests. */
export function buildSubmitArgs(buildId: string, profile = 'production'): string[] {
  return ['submit', '--platform', 'ios', '--profile', profile, '--id', buildId, '--non-interactive'];
}

/** Compare EAS build metadata to the expected version/build. Pure. */
export function verifyArtifactMatch(
  meta: { appVersion?: string | null; buildNumber?: string | number | null } | null,
  expected: { version: string; build: string },
): { ok: boolean; reason: string } {
  if (!meta) return { ok: false, reason: 'no EAS build metadata returned' };
  const v = meta.appVersion != null ? String(meta.appVersion) : null;
  const b = meta.buildNumber != null ? String(meta.buildNumber) : null;
  if (v !== expected.version || b !== expected.build)
    return { ok: false, reason: `EAS artifact ${v ?? '?'}/${b ?? '?'} != expected ${expected.version}/${expected.build}` };
  return { ok: true, reason: `EAS artifact matches ${expected.version}/${expected.build}` };
}

/** Decide whether submit may proceed. Pure — combines confirm flag + release-state + gates + match. */
export function evaluateSubmitPreflight(input: {
  confirmSubmit: boolean;
  releaseState: ReleaseStateFile | null;
  current: { version: string; build: string };
  gates: GateResult[];
}): { proceed: boolean; refusals: string[]; buildId: string | null } {
  const refusals: string[] = [];
  if (!input.confirmSubmit) refusals.push('missing --confirm-submit (refusing to submit without explicit confirmation)');
  if (!input.releaseState) refusals.push(`missing release-state file (${RELEASE_STATE_PATH}) — run release:ios:build first`);
  const buildId = input.releaseState?.eas_build_id ?? null;
  if (input.releaseState && !buildId) refusals.push('no EAS build id recorded in release-state — run a real release:ios:build first');
  const gateFails = input.gates.filter(g => g.level === 'fail');
  if (gateFails.length) refusals.push(`release gates failed: ${gateFails.map(g => g.id).join(', ')} — run release:ios:plan / release:ios:prepare`);
  if (input.releaseState && (input.releaseState.version !== input.current.version || input.releaseState.build !== input.current.build))
    refusals.push(`recorded release ${input.releaseState.version}/${input.releaseState.build} != current prepared ${input.current.version}/${input.current.build} — re-run release:ios:build after prepare`);
  return { proceed: refusals.length === 0, refusals, buildId };
}

// ── IMPURE: orchestration ─────────────────────────────────────────────────────────────────────────
function sh(c: string): string { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch { return ''; } }
function readReleaseState(root: string): ReleaseStateFile | null {
  const p = path.join(root, RELEASE_STATE_PATH);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function parseArgs(argv: string[]): { confirmSubmit: boolean; dryRun: boolean; profile: string } {
  const out = { confirmSubmit: false, dryRun: process.env.DRY_RUN === '1', profile: 'production' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--confirm-submit') out.confirmSubmit = true;
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--profile') out.profile = argv[++i];
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const releaseState = readReleaseState(root);
  const state = gatherState();
  const current = { version: state.appVersion, build: state.appBuild };
  const gates = evaluateGates(state, { version: current.version });
  const pre = evaluateSubmitPreflight({ confirmSubmit: args.confirmSubmit, releaseState, current, gates });

  console.log('═══════════════════════════════════════════════════════════');
  console.log(` iOS RELEASE SUBMIT — ${current.version} / build ${current.build}${args.dryRun ? '  [DRY RUN]' : ''}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  release-state    : ${releaseState ? `${RELEASE_STATE_PATH} (build ${releaseState.version}/${releaseState.build}, eas_build_id=${releaseState.eas_build_id ?? 'none'})` : 'MISSING'}`);
  console.log(`  release gates    : ${gates.some(g => g.level === 'fail') ? 'FAIL' : 'PASS'}`);

  if (args.dryRun) {
    console.log('\n── Dry run (no submit) ──');
    console.log(`  would_run: eas ${buildSubmitArgs(pre.buildId ?? '<no-build-id>', args.profile).join(' ')}`);
    console.log(`  (a real run first verifies the artifact via 'eas build:view <id> --json' before submitting that exact id)`);
    console.log(`  preflight_proceed=${pre.proceed}`);
    if (!pre.proceed) for (const r of pre.refusals) console.log(`    ✗ ${r}`);
    console.log('RELEASE_SUBMIT_RESULT=DRY_RUN (no EAS submit executed)');
    return;
  }

  // ── REAL submit path ──
  if (!pre.proceed || !pre.buildId) {
    console.error('\n── Refusing to submit ──');
    for (const r of pre.refusals) console.error(`  ✗ ${r}`);
    console.error('RELEASE_SUBMIT_RESULT=REFUSED');
    process.exit(1);
  }

  // Verify the EAS build artifact's version/build BEFORE submitting (mirrors the legacy script's verify step).
  console.log(`\n── Verifying EAS build ${pre.buildId} (eas build:view --json) ──`);
  const view = spawnSync('eas', ['build:view', pre.buildId, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (view.status !== 0) { console.error('RELEASE_SUBMIT_RESULT=REFUSED (could not read EAS build metadata)'); process.exit(1); }
  let meta: { appVersion?: string | null; buildNumber?: string | number | null } | null = null;
  try {
    const j = JSON.parse(view.stdout || '{}');
    const b = Array.isArray(j) ? j[0] : j;
    meta = { appVersion: b?.appVersion ?? null, buildNumber: b?.appBuildVersion ?? b?.buildNumber ?? null };
  } catch { meta = null; }
  const match = verifyArtifactMatch(meta, { version: current.version, build: current.build });
  console.log(`  ${match.reason}`);
  if (!match.ok) { console.error('RELEASE_SUBMIT_RESULT=REFUSED (artifact version/build mismatch)'); process.exit(1); }

  // Submit THAT specific build id.
  console.log(`\n── eas ${buildSubmitArgs(pre.buildId, args.profile).join(' ')} ──`);
  const sub = spawnSync('eas', buildSubmitArgs(pre.buildId, args.profile), { stdio: 'inherit' });
  if (sub.status !== 0) { console.error('RELEASE_SUBMIT_RESULT=SUBMIT_FAILED'); process.exit(3); }

  try {
    const p = path.join(root, RELEASE_STATE_PATH);
    const st = readReleaseState(root) ?? {};
    fs.writeFileSync(p, JSON.stringify({ ...st, status: 'submitted', submitted_at: new Date().toISOString(), submitted_commit: sh('git rev-parse HEAD') || null }, null, 2));
  } catch { /* non-fatal */ }
  console.log(`  Submitted build ${pre.buildId} for ${current.version}/${current.build}.`);
  console.log('RELEASE_SUBMIT_RESULT=SUBMITTED');
}

if (require.main === module) main();
