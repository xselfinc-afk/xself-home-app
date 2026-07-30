/**
 * Interstitial ad manager (browse-break V1) — imperative, non-blocking, fail-safe.
 * Mirrors appOpenAdManager's shape and reuses the EXISTING ad plumbing:
 *   - ads.ts resolveInterstitialAdUnitId (TestIds.INTERSTITIAL in dev/testMode, prod otherwise)
 *   - adsConfigService AdConfig (single remote-config pipeline — no duplicate)
 *   - the pure interstitialAdEligibility core (single frequency engine — no duplicate)
 *
 * Behavior: shows at most ONE interstitial per session, only when the user RETURNS from a
 * ProductDetail to an eligible browse surface after >= N detail views, past a warm-up and a
 * minimum interval. Preloads safely; prevents duplicate loads/shows; records the impression
 * ONLY on the real display (OPENED) event; resets the detail-view counter after a display;
 * swallows every load/show error; NEVER blocks navigation.
 *
 * Default OFF: with adsEnabled/interstitialEnabled false (the defaults) every entry point is
 * a no-op, so wiring this in changes no user-visible behavior until the remote-config rows
 * are explicitly set. Never touches Cart / Checkout / Stripe / orders / inventory / pricing.
 */

import { InterstitialAd, AdEventType } from 'react-native-google-mobile-ads';
import { resolveInterstitialAdUnitId } from '../config/ads';
import {
  computeInterstitialEligibility,
  isEligibleBrowseReturn,
  RETURN_FROM_ROUTE,
} from './interstitialAdEligibility';
import type { AdConfig } from './adsConfigService';

/** Minimal surface we use from the SDK ad object (cast at the boundary). */
type FullScreenAd = {
  addAdEventListener: (type: string, listener: (payload?: unknown) => void) => void;
  load: () => void;
  show: (opts?: unknown) => Promise<void>;
  removeAllListeners: () => void;
};

let cfg: AdConfig | null = null;
let ad: FullScreenAd | null = null;
let loaded = false;
let loading = false;
let showing = false;

// Per-session state (module lifetime == app session).
let sessionStartMs = 0;
let lastImpressionMs = 0;
let impressionsThisSession = 0;
let detailViews = 0;

// Deepest active route tracking, fed by the navigation lifecycle.
let prevRouteName: string | undefined | null = null;
let prevRouteKey: string | undefined | null = null;

function warn(msg: string, e?: unknown): void {
  if (__DEV__) console.warn(`[Interstitial] ${msg}`, e instanceof Error ? e.message : e ?? '');
}
function nowMs(): number { return Date.now(); }

/** Master ads switch AND interstitial per-format switch. */
function enabledNow(): boolean {
  return !!cfg && cfg.adsEnabled && cfg.interstitialEnabled;
}

/** Set/refresh remote config + start the session clock once. Non-destructive to counters. */
export function configure(config: AdConfig): void {
  cfg = config;
  if (sessionStartMs === 0) sessionStartMs = nowMs();
}

function teardown(): void {
  try { ad?.removeAllListeners(); } catch { /* ignore */ }
  ad = null;
  loaded = false;
}

/** Non-blocking preload; no-op unless enabled and not already loaded/loading. */
export function load(): void {
  try {
    if (!enabledNow()) return;
    if (loading || loaded) return;
    loading = true;
    const unitId = resolveInterstitialAdUnitId(cfg!.interstitialTestMode);
    const next = InterstitialAd.createForAdRequest(unitId, {
      requestNonPersonalizedAdsOnly: true,
    }) as unknown as FullScreenAd;
    next.addAdEventListener(AdEventType.LOADED, () => { loaded = true; loading = false; });
    next.addAdEventListener(AdEventType.ERROR, (e?: unknown) => { loaded = false; loading = false; warn('load error', e); });
    next.addAdEventListener(AdEventType.OPENED, () => {
      // Real display event → record the impression + reset the detail-view counter.
      showing = true;
      lastImpressionMs = nowMs();
      impressionsThisSession += 1;
      detailViews = 0;
    });
    next.addAdEventListener(AdEventType.CLOSED, () => {
      showing = false;
      teardown();
      load(); // preload the next one for later in the session (still gated by enabledNow)
    });
    ad = next;
    next.load();
  } catch (e) {
    loading = false;
    warn('load threw', e);
  }
}

function buildState(currentRoute: string | undefined | null, previousRoute: string | undefined | null) {
  return {
    enabled: enabledNow(),
    currentRoute,
    previousRoute,
    sessionStartMs,
    nowMs: nowMs(),
    lastImpressionMs,
    impressionsThisSession,
    detailViewsThisSession: detailViews,
    adLoaded: loaded,
    adBusy: showing || loading,
    minSessionSec: cfg?.interstitialMinSessionSec ?? 180,
    minIntervalSec: cfg?.interstitialMinIntervalSec ?? 600,
    maxPerSession: cfg?.interstitialMaxPerSession ?? 1,
    minDetailViews: cfg?.interstitialMinDetailViews ?? 3,
  };
}

/** Show iff eligible; otherwise warm a load for later. NEVER blocks navigation. */
export function maybeShow(currentRoute: string | undefined | null, previousRoute: string | undefined | null): void {
  try {
    if (!enabledNow()) return;
    const { eligible } = computeInterstitialEligibility(buildState(currentRoute, previousRoute));
    if (!eligible) {
      if (!loaded && !loading) load(); // warm for the next opportunity
      return;
    }
    if (!ad) { load(); return; }
    showing = true; // re-entrancy guard; the OPENED event confirms the real display
    ad.show().catch((e: unknown) => { showing = false; warn('show rejected', e); });
  } catch (e) {
    warn('maybeShow threw', e);
  }
}

/**
 * Single narrow hook from the navigation lifecycle (NavigationContainer onStateChange).
 * Fed the DEEPEST active route (name + key) on every state change. Counts fresh
 * ProductDetail entries and, on a ProductDetail → eligible-browse return, attempts a show.
 * Never throws; never blocks navigation.
 */
export function handleRouteChange(routeName: string | undefined | null, routeKey?: string | undefined | null): void {
  try {
    const prevName = prevRouteName;
    const prevKey = prevRouteKey;
    // Count each fresh ProductDetail entry (new route, or a pushed sibling with a new key).
    if (routeName === RETURN_FROM_ROUTE && (prevName !== RETURN_FROM_ROUTE || routeKey !== prevKey)) {
      detailViews += 1;
    }
    if (isEligibleBrowseReturn(prevName, routeName)) {
      maybeShow(routeName, prevName); // the only trigger point
    } else if (enabledNow() && !loaded && !loading) {
      load(); // opportunistically warm a load while browsing (no-op if disabled)
    }
    prevRouteName = routeName;
    prevRouteKey = routeKey;
  } catch (e) {
    warn('handleRouteChange threw', e);
  }
}

/** Test/debug only — reset all module state. */
export function _reset(): void {
  teardown();
  loading = false;
  showing = false;
  cfg = null;
  sessionStartMs = 0;
  lastImpressionMs = 0;
  impressionsThisSession = 0;
  detailViews = 0;
  prevRouteName = null;
  prevRouteKey = null;
}
