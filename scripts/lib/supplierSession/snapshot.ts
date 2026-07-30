/**
 * Session SNAPSHOT safety (fs). The snapshot is a DERIVED artifact for the XHR fetcher, NOT
 * the login authority (that is the persistent browser profile). Promotion is atomic and
 * fail-safe: a new snapshot is only promoted after a confirmed bounded probe, and ANY
 * failure preserves the previous known-good snapshot. No secret values are ever logged —
 * redactStorageState returns names/domains/counts only.
 */
import * as fs from 'fs';

export interface Cookie { name: string; value: string; domain: string; path?: string; expires?: number; }
export interface StorageState { cookies: Cookie[]; origins?: unknown[]; }

export interface ShapeResult { ok: boolean; reason?: string; }

export function validateSnapshotShape(json: unknown): ShapeResult {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'not_object' };
  const s = json as { cookies?: unknown };
  if (!Array.isArray(s.cookies)) return { ok: false, reason: 'cookies_not_array' };
  for (const c of s.cookies as Array<Record<string, unknown>>) {
    if (typeof c?.name !== 'string' || typeof c?.value !== 'string' || typeof c?.domain !== 'string') {
      return { ok: false, reason: 'malformed_cookie' };
    }
  }
  return { ok: true };
}

export function hasRequiredCookies(state: StorageState, domainRe: RegExp = /(^|\.)gigab2b\.com$/): boolean {
  return (state.cookies ?? []).some(c => domainRe.test(c.domain));
}

/** Redacted summary for reports/logs — NEVER cookie values / tokens / storage values. */
export function redactStorageState(state: StorageState): { cookieCount: number; domains: string[]; cookieNames: string[]; hasDeviceId: boolean } {
  const cookies = state.cookies ?? [];
  return {
    cookieCount: cookies.length,
    domains: Array.from(new Set(cookies.map(c => c.domain))),
    cookieNames: cookies.map(c => c.name),
    hasDeviceId: cookies.some(c => c.name === 'gmd_device_id'),
  };
}

export interface PromotePaths { snapshotPath: string; backupPath: string; }
export interface PromoteResult { promoted: boolean; backedUp: boolean; reason?: string; }

/**
 * Atomically promote a new snapshot. Preconditions (any failure → previous snapshot untouched):
 *   1. probeOk === true (a bounded API probe confirmed the snapshot works)
 *   2. valid JSON shape
 *   3. at least one required-domain cookie
 * Then: write temp (0600) → round-trip validate → back up prior known-good → atomic rename.
 */
export function promoteSnapshot(paths: PromotePaths, newState: StorageState, opts: { probeOk: boolean }): PromoteResult {
  if (!opts.probeOk) return { promoted: false, backedUp: false, reason: 'probe_not_confirmed' };
  const shape = validateSnapshotShape(newState);
  if (!shape.ok) return { promoted: false, backedUp: false, reason: `invalid_shape:${shape.reason}` };
  if (!hasRequiredCookies(newState)) return { promoted: false, backedUp: false, reason: 'missing_required_cookies' };

  const tmp = `${paths.snapshotPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(newState), { mode: 0o600 });
    const roundtrip = validateSnapshotShape(JSON.parse(fs.readFileSync(tmp, 'utf8')));
    if (!roundtrip.ok) { safeUnlink(tmp); return { promoted: false, backedUp: false, reason: 'tmp_roundtrip_failed' }; }
    let backedUp = false;
    if (fs.existsSync(paths.snapshotPath)) { fs.copyFileSync(paths.snapshotPath, paths.backupPath); backedUp = true; }
    fs.renameSync(tmp, paths.snapshotPath); // atomic within the same directory
    try { fs.chmodSync(paths.snapshotPath, 0o600); } catch { /* best effort */ }
    return { promoted: true, backedUp };
  } catch (e) {
    safeUnlink(tmp);
    return { promoted: false, backedUp: false, reason: `promote_error:${(e as Error)?.message ?? 'unknown'}` };
  }
}

/** Restore the previous known-good snapshot from backup. */
export function rollbackSnapshot(paths: PromotePaths): boolean {
  if (!fs.existsSync(paths.backupPath)) return false;
  fs.copyFileSync(paths.backupPath, paths.snapshotPath);
  return true;
}

function safeUnlink(p: string): void { try { fs.unlinkSync(p); } catch { /* ignore */ } }
