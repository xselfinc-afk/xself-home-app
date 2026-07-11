/**
 * App Open ad manager (Phase B0) — imperative, non-blocking, fail-safe.
 *
 * Responsibilities:
 *   - load()      create + load an App Open ad (only when remote config enables it)
 *   - maybeShow() show iff eligible (see appOpenAdEligibility); else warm a load
 *   - reload after CLOSED, expiry handling (~4h), frequency cap, all via the pure
 *     eligibility core
 *   - swallow every load/show error — an ad must NEVER crash or block the app
 *
 * Decoupling: this module does NOT import navigationRef or AppState. App.tsx
 * owns those and passes the current route into maybeShow(), which keeps the
 * eligibility logic pure/testable and avoids an App.tsx <-> manager import cycle.
 *
 * Default OFF: with adsEnabled/appOpenEnabled false (the defaults) every entry
 * point is a no-op, so wiring this in changes no user-visible behavior until the
 * remote config rows are explicitly set.
 *
 * Never touches checkout / Stripe / orders / inventory / pricing.
 */

import { AppOpenAd, AdEventType } from 'react-native-google-mobile-ads';
import { APP_OPEN_AD_UNIT_ID } from '../config/ads';
import { computeEligibility, type EligibilityState } from './appOpenAdEligibility';
import type { AdConfig } from './adsConfigService';

/** App Open ads go stale after ~4h; reload past this window. */
const EXPIRY_MS = 4 * 60 * 60 * 1000;

/** Minimal surface we use from the SDK ad object (cast at the boundary). */
type FullScreenAd = {
  addAdEventListener: (type: string, listener: (payload?: unknown) => void) => void;
  load: () => void;
  show: (opts?: unknown) => Promise<void>;
  removeAllListeners: () => void;
  loaded: boolean;
};

let ad: FullScreenAd | null = null;
let loaded = false;
let loading = false;
let loadedAtMs = 0;
let lastShownMs = 0;
let isShowing = false;
let cfg: AdConfig | null = null;

function warn(msg: string, e?: unknown): void {
  if (__DEV__) console.warn(`[AppOpenAd] ${msg}`, e instanceof Error ? e.message : e ?? '');
}
function nowMs(): number { return Date.now(); }

function teardown(): void {
  try { ad?.removeAllListeners(); } catch { /* ignore */ }
  ad = null;
  loaded = false;
  loadedAtMs = 0;
}

/** Set/refresh the remote config the manager gates on. */
export function configure(config: AdConfig): void {
  cfg = config;
}

/** Non-blocking load; no-op unless remote config enables App Open + a unit id exists. */
export function load(): void {
  try {
    if (!cfg || !cfg.adsEnabled || !cfg.appOpenEnabled) return; // default OFF → no-op
    if (!APP_OPEN_AD_UNIT_ID) { warn('no App Open ad unit configured — skip load'); return; }
    if (loading || loaded) return;
    loading = true;
    const next = AppOpenAd.createForAdRequest(APP_OPEN_AD_UNIT_ID, {
      requestNonPersonalizedAdsOnly: true,
    }) as unknown as FullScreenAd;
    next.addAdEventListener(AdEventType.LOADED, () => {
      loaded = true; loadedAtMs = nowMs(); loading = false;
    });
    next.addAdEventListener(AdEventType.ERROR, (e?: unknown) => {
      loaded = false; loading = false; warn('load error', e);
    });
    next.addAdEventListener(AdEventType.CLOSED, () => {
      isShowing = false; teardown(); load(); // reload for next time
    });
    ad = next;
    next.load();
  } catch (e) {
    loading = false;
    warn('load threw', e);
  }
}

/** Show iff eligible; otherwise ensure an ad is (re)loading for the next opportunity. */
export function maybeShow(currentRoute: string | undefined | null): void {
  try {
    if (!cfg) return;
    const state: EligibilityState = {
      adsEnabled: cfg.adsEnabled,
      appOpenEnabled: cfg.appOpenEnabled,
      adLoaded: loaded,
      currentRoute,
      nowMs: nowMs(),
      lastShownMs,
      loadedAtMs,
      minIntervalSec: cfg.appOpenMinIntervalSec,
      expiryMs: EXPIRY_MS,
      isShowing,
    };
    const { eligible, reason } = computeEligibility(state);
    if (!eligible) {
      if (reason === 'expired') { teardown(); load(); }
      else if (!loaded && !loading) load(); // warm for next opportunity
      return;
    }
    if (!ad) return;
    isShowing = true;
    lastShownMs = nowMs();
    ad.show().catch((e: unknown) => { isShowing = false; warn('show rejected', e); });
  } catch (e) {
    isShowing = false;
    warn('maybeShow threw', e);
  }
}

/** Test/debug only — reset all module state. */
export function _reset(): void {
  teardown();
  loading = false;
  lastShownMs = 0;
  isShowing = false;
  cfg = null;
}
