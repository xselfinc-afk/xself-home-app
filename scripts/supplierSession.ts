/**
 * Durable supplier-browser CLI (single shared implementation; source-parameterized). Future
 * XOne controls can invoke these. Commands are bounded, lock-protected (via the manager),
 * idempotent, rerun-safe, non-secret-logging, and explicit about exit status.
 *
 *   npm run supplier:profile:init   -- --source=pickup|dropship
 *   npm run supplier:health         -- --source=pickup|dropship
 *   npm run supplier:session:refresh-- --source=pickup|dropship [--probe-sku=<SKU>]
 *   npm run supplier:browser:open   -- --source=pickup|dropship
 *
 * Exit codes: 0 healthy/ok · 10 human_action_required (login/CAPTCHA/MFA) · 1 other failure.
 */
import { resolveSource, sourceConfig } from './lib/supplierSession/sources';
import { requiresHumanAction } from './lib/supplierSession/health';
import { buildReport, writeReport, assertNoSecrets } from './lib/supplierSession/report';
import * as manager from './supplierBrowser';

const EXIT_OK = 0, EXIT_HUMAN = 10, EXIT_FAIL = 1;
const argVal = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

function log(msg: string): void { console.log(`[supplier] ${msg}`); }

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const source = resolveSource(argVal('source'));
  const cfg = sourceConfig(source);
  const startedAt = new Date().toISOString();
  const runId = `supplier-${source}-${startedAt.replace(/[:.]/g, '-')}-${process.pid}`;

  if (cmd === 'profile:init' || cmd === 'browser:open') {
    log(`opening dedicated headed browser for '${source}' (profile: ${cfg.profileDir})`);
    log('Log in ONCE in the opened window. Do NOT copy cookies. Leave it open; Ctrl-C when done, then run supplier:session:refresh.');
    const r = await manager.initProfileHeaded(source);
    log(`profile initialized=${r.initialized} opened=${r.opened} profileId=${r.source}`);
    if (!r.opened) { log('could not open (profile locked?)'); return EXIT_FAIL; }
    await new Promise<void>(() => { /* keep process alive so the browser stays open for login */ });
    return EXIT_OK; // unreachable
  }

  const op = cmd === 'session:refresh'
    ? await manager.refreshSession(source, { probeSku: argVal('probe-sku') })
    : cmd === 'health'
      ? await manager.healthCheck(source)
      : null;

  if (!op) { log(`unknown command "${cmd ?? ''}". Use: profile:init | health | session:refresh | browser:open`); return EXIT_FAIL; }

  const report = buildReport({
    runId, source, startedAt,
    health: op.health,
    accountIdentityVerified: op.identityVerified,
    profilePathId: source, // identifier only, never the absolute path or contents
    snapshotRefreshed: op.snapshotRefreshed,
    previousSnapshotBackedUp: op.previousBackedUp,
    probeResult: op.probeClassification,
    humanActionRequired: op.humanActionRequired,
    failureCategory: op.failureCategory,
    safeId: op.safeId,
    redactedSnapshot: op.redactedSnapshot,
  });
  assertNoSecrets(report, []); // by-construction redacted; guard anyway
  const p = writeReport(cfg.reportDir, report);

  log(`source=${source} health=${op.health} identityVerified=${op.identityVerified} snapshotRefreshed=${op.snapshotRefreshed} backedUp=${op.previousBackedUp} probe=${op.probeClassification ?? '-'} humanAction=${op.humanActionRequired}`);
  log(`report → ${p}`);
  if (op.humanActionRequired || requiresHumanAction(op.health)) { log('HUMAN ACTION REQUIRED (login/CAPTCHA/MFA) — the dedicated browser is left open at the required screen.'); return EXIT_HUMAN; }
  return op.health === 'healthy' ? EXIT_OK : EXIT_FAIL;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => { console.error('[supplier] fatal:', err instanceof Error ? err.message : err); process.exit(EXIT_FAIL); });
}
