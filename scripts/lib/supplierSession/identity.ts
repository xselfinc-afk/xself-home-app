/**
 * Source-specific account IDENTITY verification (pure). Confirms the authenticated account
 * matches the expected SOURCE role (pickup vs dropship) and, when a stored identity hash is
 * available, that it matches. NO raw email/credentials are read, returned, or logged — only
 * a truncated sha256 hash is ever persisted.
 */
import * as crypto from 'crypto';
import type { HealthState } from './health';

export interface AccountEvidence {
  accountId?: string | null;
  maskedEmail?: string | null;      // e.g. "j***@e***.com" — already masked by the page
  role?: 'pickup' | 'dropship' | null;
  savedItemsListId?: string | null;
}

export interface ExpectedIdentity {
  role: 'pickup' | 'dropship';
  accountIdHash?: string | null;    // previously-persisted safe hash, if known
}

export interface IdentityResult {
  ok: boolean;
  state: HealthState;               // 'healthy' | 'account_mismatch' | 'unknown_failure'
  identityVerified: boolean;
  safeId: string | null;            // truncated sha256, safe to persist/report
  reason?: string;
}

/** Truncated sha256 — safe to persist; not reversible to the raw identifier. */
export function hashIdentifier(id: string): string {
  return crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);
}

export function verifyIdentity(evidence: AccountEvidence, expected: ExpectedIdentity): IdentityResult {
  const rawId = evidence.accountId ?? evidence.maskedEmail ?? evidence.savedItemsListId ?? null;
  const safeId = rawId ? hashIdentifier(rawId) : null;

  // No evidence at all → cannot confirm identity (never assume it is correct).
  if (!evidence.accountId && !evidence.maskedEmail && !evidence.role && !evidence.savedItemsListId) {
    return { ok: false, state: 'unknown_failure', identityVerified: false, safeId: null, reason: 'no_identity_evidence' };
  }
  // Role disagreement → hard mismatch (e.g. the dropship account showing under the pickup source).
  if (evidence.role && evidence.role !== expected.role) {
    return { ok: false, state: 'account_mismatch', identityVerified: false, safeId, reason: `role ${evidence.role} != expected ${expected.role}` };
  }
  // Known expected identity hash must match.
  if (expected.accountIdHash && safeId && expected.accountIdHash !== safeId) {
    return { ok: false, state: 'account_mismatch', identityVerified: false, safeId, reason: 'account_id_hash_mismatch' };
  }
  return { ok: true, state: 'healthy', identityVerified: true, safeId };
}
