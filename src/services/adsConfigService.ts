/**
 * Remote ad configuration (Phase A: defaults only — ads are OFF).
 *
 * Mirrors homeContentService: reads key/value rows from Supabase
 * `home_content_config` (screen='ads', is_active=true) and falls back to safe
 * DEFAULTS on any error. Because ads_enabled defaults to false and no DB rows
 * exist yet, no user sees ads until the rows are explicitly created server-side.
 */

import { supabase } from '../lib/supabase';

export type AdConfig = {
  /** Master kill-switch. Ads render only when the server explicitly sets 'true'. */
  adsEnabled: boolean;
  /** Discover feed: one ad slot per this many products (later phase). */
  discoverInterval: number;
  /** Discover feed: number of products shown before the first ad slot (later phase). */
  firstOffset: number;
  /** App Open ad per-format switch. Requires adsEnabled too. Default false. */
  appOpenEnabled: boolean;
  /** App Open ad: minimum seconds between shows (frequency cap). */
  appOpenMinIntervalSec: number;
  /** Native Advanced (Discover feed) per-format switch. Requires adsEnabled too. Default false. */
  nativeEnabled: boolean;
  /** Native Discover: insert one full-width ad row after every N products. Default 21. */
  nativeInterval: number;
  /** Native Discover: when true, request Google TEST native ads even in release. Default true. */
  nativeTestMode: boolean;
  /** Discover: max Native ads in the whole feed. Default 2. */
  discoverMax: number;
  /** Search results: Native ad per-placement switch. Requires adsEnabled too. Default false. */
  searchEnabled: boolean;
  /** Search results: products before/between ads. Default 24. */
  searchInterval: number;
  /** Search results: max Native ads in the whole result set. Default 1. */
  searchMax: number;
  /** Product Detail: single inline Native ad per-placement switch. Requires adsEnabled too. Default false. */
  detailEnabled: boolean;
};

export const AD_CONFIG_DEFAULTS: AdConfig = {
  adsEnabled: false,
  discoverInterval: 24,
  firstOffset: 24,
  appOpenEnabled: false,
  appOpenMinIntervalSec: 14400, // 4h — matches the App Open ad expiry window
  nativeEnabled: false,
  nativeInterval: 30,
  nativeTestMode: true, // fail-safe to TEST native ads unless explicitly turned off
  discoverMax: 2,
  searchEnabled: false,
  searchInterval: 24,
  searchMax: 1,
  detailEnabled: false,
};

const KEY_MAP: Record<string, keyof AdConfig> = {
  ads_enabled: 'adsEnabled',
  ads_discover_interval: 'discoverInterval',
  ads_first_offset: 'firstOffset',
  ads_app_open_enabled: 'appOpenEnabled',
  ads_app_open_min_interval_sec: 'appOpenMinIntervalSec',
  ads_native_enabled: 'nativeEnabled',
  ads_native_interval: 'nativeInterval',
  ads_native_test_mode: 'nativeTestMode',
  ads_discover_max: 'discoverMax',
  ads_search_enabled: 'searchEnabled',
  ads_search_interval: 'searchInterval',
  ads_search_max: 'searchMax',
  ads_detail_enabled: 'detailEnabled',
};

/** Parse a raw config row value onto the typed config. Exported for tests. */
export function applyAdConfigRow(cfg: AdConfig, key: string, value: string | null | undefined): AdConfig {
  const field = KEY_MAP[key];
  if (!field || value == null || value === '') return cfg;
  if (
    field === 'adsEnabled' || field === 'appOpenEnabled' || field === 'nativeEnabled' ||
    field === 'nativeTestMode' || field === 'searchEnabled' || field === 'detailEnabled'
  ) {
    return { ...cfg, [field]: value === 'true' || value === '1' };
  }
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) return cfg;
  return { ...cfg, [field]: n };
}

export async function loadAdConfig(): Promise<AdConfig> {
  try {
    const { data, error } = await supabase
      .from('home_content_config')
      .select('key, value')
      .eq('screen', 'ads')
      .eq('is_active', true);

    if (error || !data) return AD_CONFIG_DEFAULTS;

    let cfg: AdConfig = { ...AD_CONFIG_DEFAULTS };
    for (const row of data) cfg = applyAdConfigRow(cfg, row.key, row.value);
    return cfg;
  } catch {
    return AD_CONFIG_DEFAULTS;
  }
}
