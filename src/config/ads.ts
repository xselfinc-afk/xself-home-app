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
 * Production App Open ad unit. TODO(Phase B2): create a dedicated App Open unit
 * in AdMob and paste it here. Left EMPTY intentionally — the appOpenAdManager
 * treats an empty unit id as "not configured" and will NOT request an ad in
 * release, so a real ad can never be requested with the wrong (Native) unit.
 */
const PROD_APP_OPEN_AD_UNIT_ID = '';

/** The App Open ad unit to request: Google test unit in dev, production unit in release. */
export const APP_OPEN_AD_UNIT_ID = __DEV__ ? TestIds.APP_OPEN : PROD_APP_OPEN_AD_UNIT_ID;
