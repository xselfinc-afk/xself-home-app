/**
 * Scanner GATE (pure/fs). Persists the last per-source health and refuses to let an
 * inventory scan run unless that health is 'healthy' AND fresh. A non-healthy or stale
 * session must PREVENT scanning and is NEVER treated as zero inventory (it throws).
 */
import * as fs from 'fs';
import { assertScannable, type HealthState } from './health';

export interface PersistedHealth { source: string; health: HealthState; checkedAt: string; }

export function writeHealthState(healthPath: string, source: string, health: HealthState, now: number = Date.now()): void {
  fs.writeFileSync(healthPath, JSON.stringify({ source, health, checkedAt: new Date(now).toISOString() }), { mode: 0o600 });
}

export function readHealthState(healthPath: string): PersistedHealth | null {
  try {
    const j = JSON.parse(fs.readFileSync(healthPath, 'utf8')) as PersistedHealth;
    if (typeof j.health === 'string' && typeof j.checkedAt === 'string') return j;
  } catch { /* absent/malformed */ }
  return null;
}

export interface PreflightOpts { healthPath: string; now?: number; maxAgeMs?: number; }
export const DEFAULT_HEALTH_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Throws UnhealthySessionError unless the persisted health is 'healthy' AND within maxAgeMs.
 * Missing file → not_initialized (throws); stale file → unknown_failure (throws).
 */
export function preflightScannable(source: string, opts: PreflightOpts): void {
  const st = readHealthState(opts.healthPath);
  if (!st) { assertScannable(source, 'not_initialized'); return; }
  const age = (opts.now ?? Date.now()) - new Date(st.checkedAt).getTime();
  if (age > (opts.maxAgeMs ?? DEFAULT_HEALTH_MAX_AGE_MS)) { assertScannable(source, 'unknown_failure'); return; }
  assertScannable(source, st.health); // throws unless 'healthy'
}
