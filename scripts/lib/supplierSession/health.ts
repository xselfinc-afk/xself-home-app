/**
 * Supplier-session HEALTH model (pure). A session is usable for inventory scanning ONLY
 * when it is `healthy` (authenticated + identity-verified + probe-confirmed). Every other
 * state must PREVENT scanning and must NEVER be interpreted as zero inventory.
 */
export type HealthState =
  | 'healthy'
  | 'not_initialized'
  | 'authentication_required'
  | 'captcha_required'
  | 'mfa_required'
  | 'account_mismatch'
  | 'profile_locked'
  | 'supplier_unavailable'
  | 'network_failed'
  | 'layout_changed'
  | 'rate_limited'
  | 'unknown_failure';

export const ALL_HEALTH_STATES: readonly HealthState[] = [
  'healthy', 'not_initialized', 'authentication_required', 'captcha_required', 'mfa_required',
  'account_mismatch', 'profile_locked', 'supplier_unavailable', 'network_failed', 'layout_changed',
  'rate_limited', 'unknown_failure',
];

export const isHealthy = (s: HealthState): boolean => s === 'healthy';

/** Only a fully healthy session may drive an inventory scan. */
export const canScan = (s: HealthState): boolean => s === 'healthy';

/** States that need a human at the dedicated browser (never auto-bypassed). */
export const requiresHumanAction = (s: HealthState): boolean =>
  s === 'captcha_required' || s === 'mfa_required' || s === 'authentication_required';

export class UnhealthySessionError extends Error {
  constructor(public readonly source: string, public readonly state: HealthState) {
    super(`inventory scan blocked: '${source}' session is '${state}', not healthy (never treated as zero stock)`);
    this.name = 'UnhealthySessionError';
  }
}

/**
 * Scanner gate: a non-healthy session must PREVENT scanning. Throws UnhealthySessionError
 * for any non-`healthy` state — the caller must fail closed, NOT record zero inventory.
 */
export function assertScannable(source: string, state: HealthState): void {
  if (!canScan(state)) throw new UnhealthySessionError(source, state);
}

/** Signals a browser/HTTP probe can observe on the supplier landing page. */
export interface HealthSignals {
  networkError?: boolean;
  httpStatus?: number | null;
  isLoginPage?: boolean;
  isCaptcha?: boolean;
  isMfa?: boolean;
  rateLimited?: boolean;
  supplierErrorCode?: string | null;
  authenticatedMarkersPresent?: boolean; // account/dashboard markers found
  layoutMarkersMissing?: boolean;        // expected page structure not found
}

const AUTH_CODE = /b20003|401|403|forbidden|unauthor|permission|not\s*login|no\s*permission/i;

/**
 * Classify the landing-page health BEFORE any identity check. Failure guards first; a
 * clean authenticated page with expected markers → healthy (identity verified separately).
 */
export function classifyPageHealth(s: HealthSignals): HealthState {
  if (s.networkError) return 'network_failed';
  if (s.httpStatus === 429 || s.rateLimited) return 'rate_limited';
  if (s.httpStatus === 401 || s.httpStatus === 403) return 'authentication_required';
  if (s.isCaptcha) return 'captcha_required';
  if (s.isMfa) return 'mfa_required';
  if (s.isLoginPage) return 'authentication_required';
  if (s.supplierErrorCode) return AUTH_CODE.test(s.supplierErrorCode) ? 'authentication_required' : 'supplier_unavailable';
  if (typeof s.httpStatus === 'number' && s.httpStatus >= 500) return 'supplier_unavailable';
  if (s.layoutMarkersMissing) return 'layout_changed';
  if (s.authenticatedMarkersPresent) return 'healthy';
  return 'unknown_failure';
}
