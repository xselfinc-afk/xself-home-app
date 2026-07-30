/**
 * Redacted audit report for supplier-session operations. By construction it contains ONLY
 * safe fields (health, booleans, a hashed safe id, a redacted snapshot summary, a profile
 * path IDENTIFIER — never contents). assertNoSecrets is an extra guard used by tests.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface SessionReport {
  runId: string;
  source: string;
  startedAt: string;
  completedAt: string;
  health: string;
  accountIdentityVerified: boolean;
  profilePathId: string;            // e.g. "pickup" — NOT the absolute path or its contents
  snapshotRefreshed: boolean;
  previousSnapshotBackedUp: boolean;
  probeResult: string | null;
  humanActionRequired: boolean;
  failureCategory: string | null;
  safeId: string | null;            // truncated hash only
  redactedSnapshot?: { cookieCount: number; domains: string[]; cookieNames: string[]; hasDeviceId: boolean };
}

export function buildReport(input: Omit<SessionReport, 'startedAt' | 'completedAt' | 'runId'> & { runId: string; startedAt: string }): SessionReport {
  return { ...input, completedAt: new Date().toISOString() };
}

export function writeReport(reportDir: string, report: SessionReport): string {
  fs.mkdirSync(reportDir, { recursive: true });
  const p = path.join(reportDir, `${report.runId}.json`);
  fs.writeFileSync(p, JSON.stringify(report, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(reportDir, `latest-${report.source}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  return p;
}

/** Throw if any forbidden secret value appears anywhere in the report (defence-in-depth). */
export function assertNoSecrets(report: unknown, forbiddenValues: string[]): void {
  const s = JSON.stringify(report);
  for (const v of forbiddenValues) {
    if (v && v.length >= 6 && s.includes(v)) throw new Error('secret value leaked into supplier-session report');
  }
  // Also refuse obviously-sensitive key shapes.
  if (/"cookieHeader"|"password"|"storageState"\s*:\s*{/.test(s)) throw new Error('sensitive field present in supplier-session report');
}
