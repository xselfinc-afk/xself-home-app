/**
 * Durable supplier-browser CLI (single shared implementation; source-parameterized). Future
 * XOne controls can invoke these. Commands are bounded, lock-protected (via the manager),
 * idempotent, rerun-safe, non-secret-logging, and explicit about exit status.
 *
 *   npm run supplier:profile:init   -- --source=pickup|dropship
 *   npm run supplier:health         -- --source=pickup|dropship
 *   npm run supplier:session:refresh-- --source=pickup|dropship [--probe-sku=<SKU>]
 *   npm run supplier:session:login  -- --source=pickup|dropship --probe-sku=<SKU> [--timeout-min=<n>]
 *   npm run supplier:browser:open   -- --source=pickup|dropship
 *
 * session:login is the single-session flow: it opens ONE headed browser, waits (default 20 min)
 * for a human login detected via a background checker tab (never the visible login tab), then —
 * in the SAME live context — verifies identity, runs a bounded warehouse probe, backs up, and
 * atomically promotes the snapshot. No browser restart between login and promotion.
 *
 * Exit codes: 0 healthy/ok · 10 human_action_required (login/CAPTCHA/MFA) · 1 other failure.
 */
import { resolveSource, sourceConfig } from './lib/supplierSession/sources';
import { requiresHumanAction } from './lib/supplierSession/health';
import { buildReport, writeReport, assertNoSecrets } from './lib/supplierSession/report';
import { writeHealthState } from './lib/supplierSession/scanGate';
import * as manager from './supplierBrowser';
import type { SessionOpResult } from './supplierBrowser';
import type { LoginPromoteResult } from './lib/supplierSession/loginPromote';

const EXIT_OK = 0, EXIT_HUMAN = 10, EXIT_FAIL = 1;
export const DEFAULT_LOGIN_TIMEOUT_MIN = 20;

/** Pure `--name=value` flag reader (exported for tests; multi-`=` values are preserved). */
export function parseFlag(argv: string[], name: string): string | undefined {
  return argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

/** Parse --timeout-min minutes; falls back to the 20-minute default on absent/invalid/non-positive input. */
export function parseTimeoutMin(raw: string | undefined, def: number = DEFAULT_LOGIN_TIMEOUT_MIN): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return n;
}

/** Canonical supplier CLI commands. `session:login` is the single-session loginAndPromote path. */
export type SupplierCommand = 'profile:init' | 'browser:open' | 'session:login' | 'session:refresh' | 'health' | 'unknown';

/** Pure command dispatcher (exported for tests): proves which handler a raw argv[2] selects. */
export function resolveCommand(cmd: string | undefined): SupplierCommand {
  switch (cmd) {
    case 'profile:init':
    case 'browser:open':
    case 'session:login':
    case 'session:refresh':
    case 'health':
      return cmd;
    default:
      return 'unknown';
  }
}

const argVal = (name: string) => parseFlag(process.argv, name);

function log(msg: string): void { console.log(`[supplier] ${msg}`); }

async function main(): Promise<number> {
  const kind = resolveCommand(process.argv[2]);
  const source = resolveSource(argVal('source'));
  const cfg = sourceConfig(source);
  const startedAt = new Date().toISOString();
  const runId = `supplier-${source}-${startedAt.replace(/[:.]/g, '-')}-${process.pid}`;

  if (kind === 'profile:init' || kind === 'browser:open') {
    log(`opening dedicated headed browser for '${source}' (profile: ${cfg.profileDir})`);
    log('Log in ONCE in the opened window. Do NOT copy cookies. Leave it open; Ctrl-C when done, then run supplier:session:refresh.');
    const r = await manager.initProfileHeaded(source);
    log(`profile initialized=${r.initialized} opened=${r.opened} profileId=${r.source}`);
    if (!r.opened) { log('could not open (profile locked?)'); return EXIT_FAIL; }
    await new Promise<void>(() => { /* keep process alive so the browser stays open for login */ });
    return EXIT_OK; // unreachable
  }

  let op: SessionOpResult | (LoginPromoteResult & { source: typeof source }) | null = null;
  if (kind === 'session:login') {
    const probeSku = argVal('probe-sku');
    if (!probeSku) { log('session:login requires --probe-sku=<SKU> (a bounded warehouse probe must confirm before promotion)'); return EXIT_FAIL; }
    const timeoutMin = parseTimeoutMin(argVal('timeout-min'));
    log(`single-session login (loginAndPromote path) for '${source}' (profile: ${cfg.profileDir}).`);
    log(`A dedicated headed browser opens. Log in ONCE in the VISIBLE tab. A background checker tab (never your login tab, ≥5s apart) polls for up to ${timeoutMin} min; do NOT copy cookies.`);
    log('The SAME live context is reused through identity → probe → promote (no browser restart).');
    op = await manager.loginAndPromote(source, { probeSku, timeoutMs: timeoutMin * 60_000 });
  } else if (kind === 'session:refresh') {
    op = await manager.refreshSession(source, { probeSku: argVal('probe-sku') });
  } else if (kind === 'health') {
    op = await manager.healthCheck(source);
  }

  if (!op) { log(`unknown command "${process.argv[2] ?? ''}". Use: profile:init | health | session:refresh | session:login | browser:open`); return EXIT_FAIL; }

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
  writeHealthState(cfg.healthPath, source, op.health); // scanner gate consumes this

  log(`source=${source} health=${op.health} identityVerified=${op.identityVerified} snapshotRefreshed=${op.snapshotRefreshed} backedUp=${op.previousBackedUp} probe=${op.probeClassification ?? '-'} humanAction=${op.humanActionRequired}`);
  if ('buyerIdConfirmed' in op) log(`buyerIdConfirmed=${op.buyerIdConfirmed} (expected Buyer 76938981 for pickup; confirmed only when the id is visible on the account page)`);
  log(`report → ${p}`);
  if (op.humanActionRequired || requiresHumanAction(op.health)) { log('HUMAN ACTION REQUIRED (login/CAPTCHA/MFA) — the dedicated browser is left open at the required screen.'); return EXIT_HUMAN; }
  return op.health === 'healthy' ? EXIT_OK : EXIT_FAIL;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => { console.error('[supplier] fatal:', err instanceof Error ? err.message : err); process.exit(EXIT_FAIL); });
}
