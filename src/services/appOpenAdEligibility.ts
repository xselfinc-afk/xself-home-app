/**
 * Pure eligibility logic for the App Open ad — no I/O, no SDK, no clock.
 * The impure manager (appOpenAdManager.ts) supplies the current state (now,
 * lastShown, loaded, route, config) and this module decides whether a show is
 * allowed. Kept pure so every gate can be unit-tested deterministically.
 *
 * Phase B0: default OFF (both adsEnabled and appOpenEnabled must be true).
 */

/**
 * Routes where an App Open ad must NEVER appear — the purchase/transaction
 * funnel. Critically this covers Checkout: Apple Pay / Affirm background the
 * app during payment, and on foreground the route is still 'Checkout', so the
 * route gate suppresses the ad without touching any checkout/Stripe code.
 */
export const SUPPRESSED_ROUTES: ReadonlySet<string> = new Set<string>([
  'Checkout',
  'OrderSuccess',
  'Cart',
  'CartMain',
]);

export function isSuppressedRoute(routeName: string | undefined | null): boolean {
  return !!routeName && SUPPRESSED_ROUTES.has(routeName);
}

export type EligibilityState = {
  /** Master ads kill-switch (remote config). */
  adsEnabled: boolean;
  /** App Open per-format switch (remote config). */
  appOpenEnabled: boolean;
  /** Is a loaded ad currently available to show? */
  adLoaded: boolean;
  /** Current navigation route name (undefined if nav not ready). */
  currentRoute: string | undefined | null;
  /** Wall clock (ms). Injected for determinism. */
  nowMs: number;
  /** When the last ad was shown (ms). 0 = never shown. */
  lastShownMs: number;
  /** When the current ad finished loading (ms). 0 = not loaded. */
  loadedAtMs: number;
  /** Frequency cap: minimum seconds between shows. */
  minIntervalSec: number;
  /** Ad expiry window (ms) — App Open ads go stale (~4h). */
  expiryMs: number;
  /** Is an ad currently being shown? */
  isShowing: boolean;
};

export type EligibilityReason =
  | 'ok'
  | 'ads_disabled'
  | 'app_open_disabled'
  | 'already_showing'
  | 'not_loaded'
  | 'suppressed_route'
  | 'expired'
  | 'frequency_capped';

export type Eligibility = { eligible: boolean; reason: EligibilityReason };

/**
 * Decide whether an App Open ad may be shown right now. Order matters: the
 * cheapest/most-decisive gates first. Every branch returns a reason so the
 * manager (and tests) can see exactly why a show was skipped.
 */
export function computeEligibility(s: EligibilityState): Eligibility {
  if (!s.adsEnabled) return { eligible: false, reason: 'ads_disabled' };
  if (!s.appOpenEnabled) return { eligible: false, reason: 'app_open_disabled' };
  if (s.isShowing) return { eligible: false, reason: 'already_showing' };
  if (!s.adLoaded) return { eligible: false, reason: 'not_loaded' };
  if (isSuppressedRoute(s.currentRoute)) return { eligible: false, reason: 'suppressed_route' };
  if (s.loadedAtMs > 0 && s.nowMs - s.loadedAtMs >= s.expiryMs) {
    return { eligible: false, reason: 'expired' };
  }
  if (s.lastShownMs > 0 && s.nowMs - s.lastShownMs < s.minIntervalSec * 1000) {
    return { eligible: false, reason: 'frequency_capped' };
  }
  return { eligible: true, reason: 'ok' };
}
