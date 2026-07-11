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
};

export const AD_CONFIG_DEFAULTS: AdConfig = {
  adsEnabled: false,
  discoverInterval: 24,
  firstOffset: 24,
  appOpenEnabled: false,
  appOpenMinIntervalSec: 14400, // 4h — matches the App Open ad expiry window
};

const KEY_MAP: Record<string, keyof AdConfig> = {
  ads_enabled: 'adsEnabled',
  ads_discover_interval: 'discoverInterval',
  ads_first_offset: 'firstOffset',
  ads_app_open_enabled: 'appOpenEnabled',
  ads_app_open_min_interval_sec: 'appOpenMinIntervalSec',
};

/** Parse a raw config row value onto the typed config. Exported for tests. */
export function applyAdConfigRow(cfg: AdConfig, key: string, value: string | null | undefined): AdConfig {
  const field = KEY_MAP[key];
  if (!field || value == null || value === '') return cfg;
  if (field === 'adsEnabled' || field === 'appOpenEnabled') {
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
