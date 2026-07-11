/**
 * AdMob ad-unit configuration.
 *
 * Phase A: SDK-only — no ad is requested or rendered anywhere in the app yet.
 * Ad display ships in a later phase and is gated behind remote config
 * (see src/services/adsConfigService.ts — ads_enabled defaults to false).
 *
 * DEV builds ALWAYS use Google's official test ad units. Never request the
 * production ad unit in development (AdMob policy / account-safety).
 */

import { TestIds } from 'react-native-google-mobile-ads';

/** Production Native Advanced ad unit (Discover feed) — release builds only, later phase. */
const PROD_NATIVE_AD_UNIT_ID = 'ca-app-pub-3519409408954811/5157498456';

/** The Native Advanced ad unit to request: Google test unit in dev, production unit in release. */
export const NATIVE_AD_UNIT_ID = __DEV__ ? TestIds.NATIVE : PROD_NATIVE_AD_UNIT_ID;

/**
 * Resolve the Native ad unit to request given the remote `ads_native_test_mode`
 * flag. Always TEST ads in dev (AdMob policy / account safety); TEST ads in
 * release too while testMode is true; the production unit ONLY when testMode is
 * explicitly false. Defaults keep testMode=true, so production ads are never
 * requested until that flag is deliberately turned off.
 */
export function resolveNativeAdUnitId(testMode: boolean): string {
  return __DEV__ || testMode ? TestIds.NATIVE : PROD_NATIVE_AD_UNIT_ID;
}

/** Production App Open ad unit — release builds only. Gated behind remote config
 *  (ads_enabled + ads_app_open_enabled, both default false), so setting a real
 *  unit id here does NOT enable ads on its own. */
const PROD_APP_OPEN_AD_UNIT_ID = 'ca-app-pub-3519409408954811/2111641093';

/** The App Open ad unit to request: Google test unit in dev, production unit in release. */
export const APP_OPEN_AD_UNIT_ID = __DEV__ ? TestIds.APP_OPEN : PROD_APP_OPEN_AD_UNIT_ID;
