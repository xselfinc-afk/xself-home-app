/**
 * Local persistence of the last successful Home payload, so the user never
 * sees an empty Home or "No products available yet" placeholder while
 * Supabase is loading on a slow / cold start.
 *
 * Stored shape — the *raw* Supabase rows (not the post-adapted Product
 * objects) so future changes to adaptStandardizedRow() automatically apply
 * to cached data on read.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { HomeSectionTitles } from './homeContentService';

// Bumped 2026-05-14: previous cached snapshots held stale `optimized_title`
// values containing supplier prefixes (e.g. "K&K"). v2 invalidates them so
// the app refetches fresh rows after the DB cleanup.
const CACHE_KEY = 'xself_home_cache_v2';

export interface HomeCachePayload {
  v: 2;
  /** Unix ms when the payload was written */
  timestamp: number;
  /** Raw rows from `select sellable_products order by created_at desc` */
  rows: unknown[];
  sectionTitles?: HomeSectionTitles;
}

export async function readHomeCache(): Promise<HomeCachePayload | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 2 || !Array.isArray(parsed.rows)) return null;
    return parsed as HomeCachePayload;
  } catch (err) {
    if (__DEV__) console.warn('[homeCache] read failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function writeHomeCache(rows: unknown[], sectionTitles?: HomeSectionTitles): Promise<void> {
  try {
    const payload: HomeCachePayload = {
      v: 2,
      timestamp: Date.now(),
      rows,
      sectionTitles,
    };
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch (err) {
    if (__DEV__) console.warn('[homeCache] write failed:', err instanceof Error ? err.message : err);
  }
}

export async function clearHomeCache(): Promise<void> {
  try { await AsyncStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
}
