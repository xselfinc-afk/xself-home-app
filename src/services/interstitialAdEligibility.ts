/**
 * Pure eligibility logic for the Interstitial ad (browse-break, V1) — no I/O, no SDK,
 * no clock. The impure manager (interstitialAdManager.ts) supplies the current state
 * (routes, timers, counters, config) and this module decides whether a show is allowed.
 * Kept pure so every gate is unit-tested deterministically — mirrors the App Open
 * eligibility design (appOpenAdEligibility.ts); no duplicate frequency engine elsewhere.
 *
 * V1 rule: at most ONE interstitial per session, shown ONLY when the user RETURNS from a
 * ProductDetail to an eligible browse surface AFTER >= N detail views, past a session
 * warm-up and a minimum interval. Never in the purchase funnel. Default OFF (enabled is
 * the AND of remote config ads_enabled + ads_interstitial_enabled, supplied by the manager).
 */

/**
 * Browse surfaces where a browse-break interstitial may appear — matched against the
 * DEEPEST active route name (navigationRef.getCurrentRoute().name). Deliberately small:
 * the flag-gated CommerceBrowse/CommerceResults taxonomy screens are excluded from V1.
 */
export const ELIGIBLE_BROWSE_ROUTES: ReadonlySet<string> = new Set<string>([
  'Home',
  'Discover',
  'Search',
  'Collection',
]);

/** The only route a qualifying return may come FROM. */
export const RETURN_FROM_ROUTE = 'ProductDetail';

/** True only for a ProductDetail -> eligible-browse-surface transition. */
export function isEligibleBrowseReturn(
  previousRoute: string | undefined | null,
  currentRoute: string | undefined | null,
): boolean {
  return previousRoute === RETURN_FROM_ROUTE && !!currentRoute && ELIGIBLE_BROWSE_ROUTES.has(currentRoute);
}

export type InterstitialEligibilityState = {
  /** Master ads switch AND interstitial per-format switch, already AND-combined by the manager. */
  enabled: boolean;
  /** Deepest active route name now. */
  currentRoute: string | undefined | null;
  /** Deepest active route name immediately before this transition. */
  previousRoute: string | undefined | null;
  /** Session start (ms). */
  sessionStartMs: number;
  /** Wall clock (ms). Injected for determinism. */
  nowMs: number;
  /** When the last interstitial was shown (ms). 0 = never this session. */
  lastImpressionMs: number;
  /** Interstitials already shown this session. */
  impressionsThisSession: number;
  /** ProductDetail views so far this session. */
  detailViewsThisSession: number;
  /** Is a loaded ad available to show? */
  adLoaded: boolean;
  /** Is an ad currently loading or showing? (prevents duplicate loads/shows) */
  adBusy: boolean;
  /** Config: no ad during the first N seconds of a session. */
  minSessionSec: number;
  /** Config: minimum seconds between impressions. */
  minIntervalSec: number;
  /** Config: max impressions per session. */
  maxPerSession: number;
  /** Config: minimum ProductDetail views before eligibility. */
  minDetailViews: number;
};

export type InterstitialEligibilityReason =
  | 'ok'
  | 'disabled'
  | 'not_loaded'
  | 'ad_busy'
  | 'session_capped'
  | 'session_warmup'
  | 'frequency_capped'
  | 'insufficient_browsing'
  | 'not_browse_return';

export type InterstitialEligibility = { eligible: boolean; reason: InterstitialEligibilityReason };

/**
 * Decide whether an interstitial may be shown right now. Order matters: cheapest/most-
 * decisive gates first, and every branch returns a reason so the manager (and tests) can
 * see exactly why a show was skipped. testMode is intentionally NOT an input — it only
 * selects the ad UNIT (manager concern) and must never change eligibility.
 */
export function computeInterstitialEligibility(s: InterstitialEligibilityState): InterstitialEligibility {
  if (!s.enabled) return { eligible: false, reason: 'disabled' };
  if (!s.adLoaded) return { eligible: false, reason: 'not_loaded' };
  if (s.adBusy) return { eligible: false, reason: 'ad_busy' };
  if (s.impressionsThisSession >= s.maxPerSession) return { eligible: false, reason: 'session_capped' };
  if (s.nowMs - s.sessionStartMs < s.minSessionSec * 1000) return { eligible: false, reason: 'session_warmup' };
  if (s.lastImpressionMs > 0 && s.nowMs - s.lastImpressionMs < s.minIntervalSec * 1000) {
    return { eligible: false, reason: 'frequency_capped' };
  }
  if (s.detailViewsThisSession < s.minDetailViews) return { eligible: false, reason: 'insufficient_browsing' };
  if (!isEligibleBrowseReturn(s.previousRoute, s.currentRoute)) return { eligible: false, reason: 'not_browse_return' };
  return { eligible: true, reason: 'ok' };
}
