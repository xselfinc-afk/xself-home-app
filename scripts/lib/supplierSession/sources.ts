/**
 * Durable supplier-browser SOURCE configuration (pure, no I/O). Defines exactly two
 * isolated sources — pickup and dropship — each with a dedicated persistent browser
 * profile (owned by the automation, NOT the user's Chrome), a dedicated snapshot target,
 * backup, lock, and report dir. No source's profile or snapshot may ever overwrite the
 * other's — enforced by embedding the source in every path and asserted by tests.
 */
import * as os from 'os';
import * as path from 'path';

export type SupplierSource = 'pickup' | 'dropship';
export const SUPPLIER_SOURCES: readonly SupplierSource[] = ['pickup', 'dropship'];

/** Dedicated persistent-profile root, OUTSIDE the repo and OUTSIDE the user's Chrome. */
export const PROFILE_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'XSelfSupplierBrowser');
/** A harmless authenticated page used only to let the supplier refresh its own session. */
const GIGA_ACCOUNT_URL = 'https://www.gigab2b.com/index.php?route=account/account';

export interface SourceConfig {
  source: SupplierSource;
  role: 'pickup' | 'dropship';
  /** Dedicated persistent user-data dir (never the user's normal Chrome profile). */
  profileDir: string;
  /** Derived session snapshot for the XHR inventory fetcher. */
  snapshotPath: string;
  /** Previous known-good snapshot (rollback target). */
  backupPath: string;
  /** Per-source profile lock. */
  lockPath: string;
  /** Per-source health-state file (read by the scanner gate). */
  healthPath: string;
  reportDir: string;
  landingUrl: string;
  accountUrl: string;
  /** macOS Keychain lookup (values never read into logs). */
  keychainService: string;
  keychainAccount: string;
  /** Safe human-readable role label (NOT a secret; no raw email). */
  expectedRoleLabel: string;
}

export function isSupplierSource(s: unknown): s is SupplierSource {
  return s === 'pickup' || s === 'dropship';
}

/** Validate a CLI --source value; throw a clear error otherwise. */
export function resolveSource(s: string | undefined | null): SupplierSource {
  if (!isSupplierSource(s)) throw new Error(`Invalid --source "${s ?? ''}". Use one of: ${SUPPLIER_SOURCES.join(', ')}`);
  return s;
}

export function sourceConfig(
  source: SupplierSource,
  repoRoot: string = process.cwd(),
  profileRoot: string = PROFILE_ROOT,
): SourceConfig {
  const scriptsDir = path.join(repoRoot, 'scripts');
  return {
    source,
    role: source,
    profileDir: path.join(profileRoot, source),
    snapshotPath: path.join(scriptsDir, `.giga-session-${source}.json`),
    backupPath: path.join(scriptsDir, `.giga-session-${source}.backup.json`),
    lockPath: path.join(scriptsDir, `.giga-session-${source}.lock`),
    healthPath: path.join(scriptsDir, `.giga-session-${source}.health.json`),
    reportDir: path.join(repoRoot, 'reports', 'supplier-session'),
    landingUrl: GIGA_ACCOUNT_URL,
    accountUrl: GIGA_ACCOUNT_URL,
    keychainService: `xself-giga-${source}`,
    keychainAccount: `xself-supplier-${source}`,
    // Safe labels only — the real account numbers live in supplierAccounts docs; NO email/creds here.
    expectedRoleLabel: source === 'pickup' ? 'Pickup account' : 'Dropship / one-click fulfillment account',
  };
}
