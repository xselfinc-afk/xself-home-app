/**
 * Per-source profile LOCK (fs-based). One operation holds a source's lock at a time.
 * Stale locks (dead PID, or older than staleMs) are safely reclaimed. This NEVER kills any
 * process — it only inspects PID liveness. Pure decision helpers are injectable for tests.
 */
import * as fs from 'fs';
import * as os from 'os';

export interface LockInfo { pid: number; source: string; acquiredAt: string; host: string; }
export interface LockDeps { now?: () => number; pidAlive?: (pid: number) => boolean; host?: string; }

export const DEFAULT_STALE_MS = 15 * 60 * 1000; // 15 min

/** PID liveness via signal 0 — EPERM means alive-but-not-ours (still alive). Never signals to kill. */
function defaultPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: unknown) { return (e as NodeJS.ErrnoException)?.code === 'EPERM'; }
}

export function readLock(lockPath: string): LockInfo | null {
  try {
    const j = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockInfo;
    if (typeof j.pid === 'number' && typeof j.source === 'string' && typeof j.acquiredAt === 'string') return j;
  } catch { /* absent or malformed */ }
  return null;
}

export function isStale(lock: LockInfo, deps: LockDeps = {}, staleMs: number = DEFAULT_STALE_MS): boolean {
  const now = (deps.now ?? Date.now)();
  const alive = (deps.pidAlive ?? defaultPidAlive)(lock.pid);
  const ageMs = now - new Date(lock.acquiredAt).getTime();
  return !alive || ageMs > staleMs; // dead PID OR older than the staleness window
}

export interface AcquireResult { ok: boolean; state?: 'profile_locked'; existing?: LockInfo; stoleStale?: boolean; }

export function acquireLock(lockPath: string, source: string, deps: LockDeps = {}, staleMs: number = DEFAULT_STALE_MS): AcquireResult {
  const existing = readLock(lockPath);
  let stoleStale = false;
  if (existing) {
    if (!isStale(existing, deps, staleMs)) return { ok: false, state: 'profile_locked', existing };
    stoleStale = true; // dead/old lock → safe to reclaim
  }
  const info: LockInfo = {
    pid: process.pid, source,
    acquiredAt: new Date((deps.now ?? Date.now)()).toISOString(),
    host: deps.host ?? os.hostname(),
  };
  fs.writeFileSync(lockPath, JSON.stringify(info), { mode: 0o600 });
  return { ok: true, stoleStale };
}

/** Release only if WE own the lock (same pid + source) — never removes another holder's lock. */
export function releaseLock(lockPath: string, source: string): void {
  const existing = readLock(lockPath);
  if (existing && existing.source === source && existing.pid === process.pid) {
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

/** Run fn while holding the source lock; always releases. Throws {profile_locked} if held fresh. */
export async function withLock<T>(lockPath: string, source: string, fn: () => Promise<T>, deps: LockDeps = {}, staleMs: number = DEFAULT_STALE_MS): Promise<T> {
  const a = acquireLock(lockPath, source, deps, staleMs);
  if (!a.ok) throw Object.assign(new Error(`profile_locked: ${source} (pid ${a.existing?.pid})`), { code: 'profile_locked', existing: a.existing });
  try { return await fn(); } finally { releaseLock(lockPath, source); }
}
