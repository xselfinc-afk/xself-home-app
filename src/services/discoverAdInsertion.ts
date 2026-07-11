/**
 * Pure, unit-testable helpers for inserting Native Advanced ad slots into the
 * Discover product feed. No I/O, no SDK, no React — just deterministic list math.
 *
 * Rules (Phase N1):
 *   - No ad unless `enabled` (adsEnabled && nativeEnabled) is true.
 *   - Insert one ad after every `interval` products (first after `interval`).
 *   - Never before the first `interval` products.
 *   - Never a trailing/orphan ad (only insert when a product follows it).
 *   - Deterministic + stable keys → refresh/re-render never duplicates a slot.
 *   - Product order is never changed.
 *
 * The Discover grid is 3 columns; `groupIntoRows` chunks the flat feed into
 * render rows so an ad becomes ONE full-width row spanning all 3 columns.
 */

import type { Product } from '../data/products';

export const DEFAULT_NATIVE_INTERVAL = 21;

export type NativeFeedConfig = {
  /** Effective gate: adsEnabled && nativeEnabled. When false, no ads are inserted. */
  enabled: boolean;
  /** Products between ads. Malformed/non-positive → DEFAULT_NATIVE_INTERVAL. */
  interval: number;
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

/**
 * Build the flat Discover feed with Native ad markers inserted per the rules.
 * Products are emitted in their original order; ad markers get stable
 * `native-ad-<slot>` keys (slot = 1,2,3…) so positions are deterministic.
 */
export function buildDiscoverFeed(products: Product[], config: NativeFeedConfig): DiscoverFeedItem[] {
  const productItem = (p: Product): DiscoverFeedItem => ({ type: 'product', product: p, key: `product-${p.id}` });

  if (!config.enabled) return products.map(productItem);

  const interval = resolveInterval(config.interval);
  const total = products.length;
  const out: DiscoverFeedItem[] = [];
  let slot = 0;

  for (let i = 0; i < total; i++) {
    out.push(productItem(products[i]));
    const emitted = i + 1; // products emitted so far
    // Ad after every `interval` products, but only if a product still follows
    // (never a trailing orphan, never before the first `interval`).
    if (emitted % interval === 0 && emitted < total) {
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
