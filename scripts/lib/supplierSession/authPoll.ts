/**
 * Pure authentication poller (no Playwright, no real timers — now/sleep/openChecker are all
 * injected). CRITICAL invariant: this loop NEVER touches the human's visible login tab. It
 * observes authentication ONLY through a SEPARATE background "checker" page in the same
 * browser context. Because the supplier session cookie (OCSESSID) is context-wide, the
 * checker sees the authenticated state the instant the human finishes logging in — without
 * navigating, reloading, or closing the login / CAPTCHA / MFA tab. The checker page is opened
 * lazily, reused across polls, and always cleaned up in a finally. No secret values leave here.
 */
import { classifyPageHealth, type HealthState, type HealthSignals } from './health';
import type { AccountEvidence } from './identity';
import type { AuthWaitResult } from './loginPromote';

/** A single observation read from the background checker page (never from the login tab). */
export interface CheckerObservation {
  networkError: boolean;
  httpStatus: number | null;
  url: string;
  text: string;
}

/** A background checker page in the SAME context as the visible login tab. */
export interface CheckerPage {
  /** Navigate ONLY this checker page to the harmless authenticated landing URL and read markers. */
  gotoAndRead: (url: string) => Promise<CheckerObservation>;
  /** Safe cleanup of the checker page (must never throw). */
  close: () => Promise<void>;
}

/** Non-secret instrumentation emitted once per poll (URLs only — never cookies/tokens/fields). */
export interface AuthPollInstrument {
  attempt: number;
  visibleUrlBefore: string;
  visibleUrlAfter: string;
  checkerUrl: string;
  authed: boolean;
}

/** Recommended minimum interval between checker polls (≥5s so the checker is unobtrusive). */
export const LOGIN_POLL_INTERVAL_MS = 5000;

export interface AuthPollDeps {
  landingUrl: string;
  expectedBuyerId: string;
  otherBuyerId: string;
  role: 'pickup' | 'dropship';
  timeoutMs: number;
  pollMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Open (or lazily create) the background checker page in the SAME context as the login tab. */
  openChecker: () => Promise<CheckerPage>;
  /** READ-ONLY current URL of the visible login tab (instrumentation/assertion; never navigates it). */
  visibleUrl?: () => Promise<string>;
  /** Return focus to the visible login tab (bringToFront) — undoes any focus theft by the checker. */
  keepVisibleInFront?: () => Promise<void>;
  /** Non-secret per-poll instrumentation sink. */
  onInstrument?: (e: AuthPollInstrument) => void;
}

const RE_LOGIN_URL = /login|sign[-_]?in/i;
const RE_LOGIN_TEXT = /\b(log\s*in|sign\s*in|password required)\b/i;
const RE_CAPTCHA = /captcha|slider|安全验证|安全检查|verify to continue|aliyun|\bwaf\b|challenge/i;
const RE_MFA = /verification code|two[-\s]?factor|one[-\s]?time|otp|sms code|authenticator/i;
const RE_AUTHED = /\b(log\s*out|sign\s*out|my\s*account|dashboard|buyer)\b/i;
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Derive health signals from a checker observation (same markers the manager used before). */
export function deriveSignals(obs: CheckerObservation): HealthSignals {
  const isLoginPage = RE_LOGIN_URL.test(obs.url) || RE_LOGIN_TEXT.test(obs.text);
  const isCaptcha = RE_CAPTCHA.test(obs.text);
  const isMfa = RE_MFA.test(obs.text);
  const authenticatedMarkersPresent = RE_AUTHED.test(obs.text) && !isLoginPage;
  const layoutMarkersMissing = !obs.networkError && !isLoginPage && !authenticatedMarkersPresent && !isCaptcha && !isMfa;
  return { networkError: obs.networkError, httpStatus: obs.httpStatus, isLoginPage, isCaptcha, isMfa, authenticatedMarkersPresent, layoutMarkersMissing };
}

/** Build best-effort identity evidence from checker text (raw stays local; only hashed later). */
export function buildEvidence(text: string, opts: { expectedBuyerId: string; otherBuyerId: string; role: 'pickup' | 'dropship' }): AccountEvidence {
  const accountId = text.includes(opts.expectedBuyerId) ? opts.expectedBuyerId : (text.includes(opts.otherBuyerId) ? opts.otherBuyerId : null);
  const emailMatch = text.match(RE_EMAIL);
  return { accountId, maskedEmail: emailMatch ? emailMatch[0] : null, role: opts.role, savedItemsListId: null };
}

/**
 * Poll for authenticated state via the background checker ONLY. Polls at least once (so an
 * already-authenticated context is detected immediately), then sleeps pollMs between attempts
 * until `now() >= deadline`. Returns the last observed non-healthy health on timeout. The
 * checker page is always closed in the finally; the visible login tab is never referenced.
 */
export async function pollForAuthentication(deps: AuthPollDeps): Promise<AuthWaitResult> {
  const deadline = deps.now() + deps.timeoutMs;
  let lastHealth: HealthState = 'authentication_required';
  let checker: CheckerPage | null = null;
  let attempt = 0;
  try {
    for (;;) {
      attempt++;
      const visibleUrlBefore = deps.visibleUrl ? await deps.visibleUrl() : '';
      if (!checker) {
        checker = await deps.openChecker();
        // Opening a tab steals foreground focus in headed Chromium — give it straight back.
        if (deps.keepVisibleInFront) await deps.keepVisibleInFront();
      }
      const obs = await checker.gotoAndRead(deps.landingUrl);
      // Keep the human's login tab in front after every check; the checker stays in the background.
      if (deps.keepVisibleInFront) await deps.keepVisibleInFront();
      const visibleUrlAfter = deps.visibleUrl ? await deps.visibleUrl() : '';
      const health = classifyPageHealth(deriveSignals(obs));
      const authed = health === 'healthy';
      deps.onInstrument?.({ attempt, visibleUrlBefore, visibleUrlAfter, checkerUrl: obs.url, authed });
      if (authed) return { authed: true, health: 'healthy', evidence: buildEvidence(obs.text, deps) };
      lastHealth = health;
      if (deps.now() >= deadline) return { authed: false, health: lastHealth, evidence: {} };
      await deps.sleep(deps.pollMs);
    }
  } finally {
    if (checker) { try { await checker.close(); } catch { /* best-effort cleanup, never throws */ } }
  }
}
