/**
 * Pure, unit-testable helpers for inserting Native Advanced ad slots into a
 * product feed (Discover browse grid and Search results). No I/O, no SDK, no
 * React — just deterministic list math.
 *
 * Rules:
 *   - No ad unless `enabled` (adsEnabled && <placement>Enabled) is true.
 *   - Insert one ad after every `interval` products (first after `interval`).
 *   - At most `max` ads total (Discover = 2, Search = 1).
 *   - Never before the first `interval` products.
 *   - Never a trailing/orphan ad (only insert when a product still follows it).
 *   - Deterministic + stable keys → refresh/re-render never duplicates a slot.
 *   - Product order is never changed.
 *
 * `groupIntoRows` chunks the flat feed into render rows so an ad becomes ONE
 * full-width row spanning all product columns (3 in Discover, 2 in Search).
 */

import type { Product } from '../data/products';

export const DEFAULT_NATIVE_INTERVAL = 24;
export const DEFAULT_NATIVE_MAX = 2;

export type NativeFeedConfig = {
  /** Effective gate: adsEnabled && <placement>Enabled. When false, no ads are inserted. */
  enabled: boolean;
  /** Products between ads. Malformed/non-positive → DEFAULT_NATIVE_INTERVAL. */
  interval: number;
  /** Maximum ads in the whole feed. Malformed/non-positive → DEFAULT_NATIVE_MAX. */
  max: number;
};

export type DiscoverFeedItem =
  | { type: 'product'; product: Product; key: string }
  | { type: 'ad'; key: string; slot: number };

export type DiscoverRow =
  | { type: 'products'; items: Product[]; key: string }
  | { type: 'ad'; key: string; slot: number };

/** Sanitize the configured interval: positive integer, else the safe default. */
export function resolveInterval(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return DEFAULT_NATIVE_INTERVAL;
  const n = Math.floor(raw);
  return n > 0 ? n : DEFAULT_NATIVE_INTERVAL;
}

/** Sanitize the configured max ad count: positive integer, else the safe default. */
export function resolveMax(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return DEFAULT_NATIVE_MAX;
  const n = Math.floor(raw);
  return n > 0 ? n : DEFAULT_NATIVE_MAX;
}

/**
 * Build the flat feed with Native ad markers inserted per the rules. Products are
 * emitted in their original order; ad markers get stable `native-ad-<slot>` keys
 * (slot = 1,2,3…) so positions are deterministic across refresh.
 */
export function buildDiscoverFeed(products: Product[], config: NativeFeedConfig): DiscoverFeedItem[] {
  const productItem = (p: Product): DiscoverFeedItem => ({ type: 'product', product: p, key: `product-${p.id}` });

  if (!config.enabled) return products.map(productItem);

  const interval = resolveInterval(config.interval);
  const maxAds = resolveMax(config.max);
  const total = products.length;
  const out: DiscoverFeedItem[] = [];
  let slot = 0;

  for (let i = 0; i < total; i++) {
    out.push(productItem(products[i]));
    const emitted = i + 1; // products emitted so far
    // Ad after every `interval` products, capped at `maxAds`, only if a product
    // still follows (never a trailing orphan, never before the first `interval`).
    if (emitted % interval === 0 && emitted < total && slot < maxAds) {
      slot += 1;
      out.push({ type: 'ad', key: `native-ad-${slot}`, slot });
    }
  }
  return out;
}

/**
 * Chunk the flat feed into render rows for a single-column FlatList:
 *   - up to `columns` products per product-row,
 *   - each ad marker becomes its own full-width row (flushing any partial
 *     product row first, so the ad always starts a fresh row).
 * Keys are stable (product row keyed by its first product id; ad row by slot).
 */
export function groupIntoRows(feed: DiscoverFeedItem[], columns = 3): DiscoverRow[] {
  const rows: DiscoverRow[] = [];
  let bucket: Product[] = [];

  const flush = (): void => {
    if (bucket.length > 0) {
      rows.push({ type: 'products', items: bucket, key: `row-${bucket[0].id}` });
      bucket = [];
    }
  };

  for (const item of feed) {
    if (item.type === 'ad') {
      flush();
      rows.push({ type: 'ad', key: item.key, slot: item.slot });
    } else {
      bucket.push(item.product);
      if (bucket.length === columns) flush();
    }
  }
  flush();
  return rows;
}
