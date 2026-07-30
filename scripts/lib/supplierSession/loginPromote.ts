/**
 * Single-session login→extract→probe→promote orchestrator (pure; no Playwright, no fs, no
 * network — all effects injected). This exists because GIGA's OCSESSID is a SESSION cookie
 * that does NOT survive a browser restart: the login, snapshot extraction, identity check,
 * bounded probe, and promotion MUST all happen inside the SAME live context (openContext is
 * invoked exactly once; extractSnapshot reads that same context; the context is closed only
 * once, AFTER the final result). The lock is always released; no secret values are returned.
 */
import type { HealthState } from './health';
import { verifyIdentity, hashIdentifier, type AccountEvidence } from './identity';
import { validateSnapshotShape, redactStorageState, type StorageState, type PromoteResult } from './snapshot';

export interface AuthWaitResult { authed: boolean; health: HealthState; evidence: AccountEvidence; }
export interface ProbeOutcome { probeOk: boolean; classification: string; }

export interface LoginPromoteDeps {
  expectedRole: 'pickup' | 'dropship';
  expectedBuyerId?: string | null;   // e.g. '76938981' for pickup
  probeSku: string;
  timeoutMs: number;
  acquireLock: () => boolean;                                   // false → already held (fresh)
  releaseLock: () => void;
  openContext: () => Promise<void>;                             // launch persistent profile + open account page (ONCE)
  waitForAuth: (timeoutMs: number) => Promise<AuthWaitResult>;  // poll the SAME context until authed or timeout
  extractSnapshot: () => Promise<StorageState>;                 // storageState from the SAME live context
  probe: (snapshot: StorageState, sku: string) => Promise<ProbeOutcome>;
  promote: (snapshot: StorageState) => PromoteResult;           // probe already confirmed
  persistHealth: (h: HealthState) => void;
  closeContext: () => Promise<void>;                            // closed ONCE, after the final result
}

export interface LoginPromoteResult {
  health: HealthState;
  identityVerified: boolean;
  buyerIdConfirmed: boolean;
  safeId: string | null;
  snapshotRefreshed: boolean;
  previousBackedUp: boolean;
  probeClassification: string | null;
  humanActionRequired: boolean;
  failureCategory: string | null;
  contextClosed: boolean;
  lockReleased: boolean;
  redactedSnapshot?: ReturnType<typeof redactStorageState>;
}

export async function runLoginAndPromote(deps: LoginPromoteDeps): Promise<LoginPromoteResult> {
  const r: LoginPromoteResult = {
    health: 'unknown_failure', identityVerified: false, buyerIdConfirmed: false, safeId: null,
    snapshotRefreshed: false, previousBackedUp: false, probeClassification: null,
    humanActionRequired: false, failureCategory: null, contextClosed: false, lockReleased: false,
  };

  if (!deps.acquireLock()) { r.health = 'profile_locked'; r.failureCategory = 'profile_locked'; return r; }

  let opened = false;
  try {
    await deps.openContext(); opened = true;

    // 4-5. Wait for authenticated state in the SAME live context (leaves window open on CAPTCHA/MFA).
    const auth = await deps.waitForAuth(deps.timeoutMs);
    if (!auth.authed) { r.health = auth.health; r.humanActionRequired = true; r.failureCategory = auth.health; return r; }

    // 6. Identity: expected role + (if known) expected Buyer id hash.
    const expectedHash = deps.expectedBuyerId ? hashIdentifier(deps.expectedBuyerId) : null;
    const id = verifyIdentity(auth.evidence, { role: deps.expectedRole, accountIdHash: expectedHash });
    r.safeId = id.safeId;
    r.buyerIdConfirmed = !!(expectedHash && id.safeId && expectedHash === id.safeId);
    if (!id.ok) { r.health = id.state; r.failureCategory = id.state; return r; }   // e.g. account_mismatch → no promote
    r.identityVerified = true;

    // 7-8. Extract snapshot from the SAME context, validate shape.
    const snap = await deps.extractSnapshot();
    r.redactedSnapshot = redactStorageState(snap);
    const shape = validateSnapshotShape(snap);
    if (!shape.ok) { r.health = 'unknown_failure'; r.failureCategory = `invalid_shape:${shape.reason}`; return r; }

    // 9-10. Bounded probe requiring a CONFIRMED inventory classification.
    const probe = await deps.probe(snap, deps.probeSku);
    r.probeClassification = probe.classification;
    if (!probe.probeOk) { r.health = 'unknown_failure'; r.failureCategory = `probe_not_confirmed:${probe.classification}`; return r; }

    // 11. Backup + atomic promotion (promote() itself backs up + renames).
    const promo = deps.promote(snap);
    r.snapshotRefreshed = promo.promoted; r.previousBackedUp = promo.backedUp;
    if (promo.promoted) { r.health = 'healthy'; }
    else { r.health = 'unknown_failure'; r.failureCategory = promo.reason ?? 'promote_failed'; }
    return r;
  } finally {
    // 13. Close the SAME context ONCE, only after the final result; persist health; release lock.
    if (opened) { try { await deps.closeContext(); r.contextClosed = true; } catch { /* best effort */ } }
    try { deps.persistHealth(r.health); } catch { /* best effort */ }
    try { deps.releaseLock(); r.lockReleased = true; } catch { /* best effort */ }
  }
}
