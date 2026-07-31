import { createHash } from 'node:crypto';

export const XONE_PRODUCT_READER_SCHEMA_VERSION = '1.0' as const;

export type CustomerServiceProductAvailability =
  | 'sellable'
  | 'out_of_stock'
  | 'stale'
  | 'expired'
  | 'unknown'
  | 'unpublished';

export type CostCompleteness = 'complete' | 'partial' | 'insufficient' | 'unknown';

export type StandardizedProductRow = {
  id?: unknown;
  sku_custom?: unknown;
  product_title?: unknown;
  selling_price?: unknown;
  price?: unknown;
  inventory_status?: unknown;
  total_available_qty?: unknown;
  inventory_last_synced_at?: unknown;
  fulfillment_buffer?: unknown;
  estimated_payment_fee?: unknown;
  estimated_net_profit?: unknown;
  estimated_net_margin?: unknown;
  primary_image?: unknown;
  specifications_json?: unknown;
  key_features_json?: unknown;
  published?: unknown;
  normalization_status?: unknown;
};

export interface CustomerServiceProductSnapshot {
  sku: string;
  product_id: string;
  title: string;
  selling_price: number | null;
  inventory_status: string;
  inventory_availability: CustomerServiceProductAvailability;
  total_available_qty: number | null;
  inventory_last_synced_at: string | null;
  inventory_freshness: 'fresh' | 'stale' | 'expired' | 'missing';
  purchase_cost: number | null;
  fulfillment_buffer: number | null;
  estimated_payment_fee: number | null;
  estimated_net_profit: number | null;
  estimated_net_margin: number | null;
  main_image: string | null;
  specification_summary: string[];
  source: 'production.standardized_products';
  source_environment: string;
  source_snapshot_at: string;
  payload_hash: string;
  cost_completeness: CostCompleteness;
  missing_cost_fields: string[];
  is_production_data: true;
}

export interface CustomerServiceProductSearchResult {
  sku: string;
  product_id: string;
  title: string;
  selling_price: number | null;
  availability: CustomerServiceProductAvailability;
  inventory_freshness: CustomerServiceProductSnapshot['inventory_freshness'];
  exact_sku_match: boolean;
  title_relevance: number;
  has_sku_conflict: boolean;
}

const REQUIRED_COST_FIELDS = [
  'purchase_cost',
  'fulfillment_cost',
  'packaging_and_operations_cost',
  'platform_payment_cost',
  'after_sales_reserve',
] as const;

export function buildCustomerServiceProductSnapshot(
  row: StandardizedProductRow,
  options: { now: Date; sourceEnvironment: string; inSellableView: boolean },
): CustomerServiceProductSnapshot {
  const productId = requiredText(row.id, 'product_id');
  const sku = requiredText(row.sku_custom, 'sku');
  const title = requiredText(row.product_title, 'title');
  const inventoryLastSyncedAt = optionalTimestamp(row.inventory_last_synced_at);
  const inventoryFreshness = calculateInventoryFreshness(inventoryLastSyncedAt, options.now);
  const inventoryStatus = optionalText(row.inventory_status) ?? 'unknown';
  const quantity = optionalNumber(row.total_available_qty);
  const published = row.published === true;
  const availability = classifyAvailability({
    published,
    inventoryStatus,
    quantity,
    inventoryFreshness,
    inSellableView: options.inSellableView,
  });
  const purchaseCost = optionalNumber(row.price);
  const fulfillmentBuffer = optionalNumber(row.fulfillment_buffer);
  const estimatedPaymentFee = optionalNumber(row.estimated_payment_fee);
  const missingCostFields = [
    ...(purchaseCost == null ? ['purchase_cost'] : []),
    ...(fulfillmentBuffer == null ? ['fulfillment_cost'] : []),
    'packaging_and_operations_cost',
    ...(estimatedPaymentFee == null ? ['platform_payment_cost'] : []),
    'after_sales_reserve',
  ];
  const costCompleteness = determineCostCompleteness({
    purchaseCost,
    fulfillmentBuffer,
    estimatedPaymentFee,
  });
  const content = {
    sku,
    product_id: productId,
    title,
    selling_price: optionalNumber(row.selling_price),
    inventory_status: inventoryStatus,
    inventory_availability: availability,
    total_available_qty: quantity,
    inventory_last_synced_at: inventoryLastSyncedAt,
    inventory_freshness: inventoryFreshness,
    purchase_cost: purchaseCost,
    fulfillment_buffer: fulfillmentBuffer,
    estimated_payment_fee: estimatedPaymentFee,
    estimated_net_profit: optionalNumber(row.estimated_net_profit),
    estimated_net_margin: optionalNumber(row.estimated_net_margin),
    main_image: optionalText(row.primary_image),
    specification_summary: buildSpecificationSummary(
      row.specifications_json,
      row.key_features_json,
    ),
    source: 'production.standardized_products' as const,
    source_environment: options.sourceEnvironment,
    cost_completeness: costCompleteness,
    missing_cost_fields: [...new Set(missingCostFields)],
    is_production_data: true as const,
  };
  return {
    ...content,
    source_snapshot_at: options.now.toISOString(),
    payload_hash: sha256(stableStringify(content)),
  };
}

export function buildSearchResults(
  snapshots: CustomerServiceProductSnapshot[],
  query: string,
): CustomerServiceProductSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  const counts = new Map<string, number>();
  for (const snapshot of snapshots) {
    counts.set(snapshot.sku, (counts.get(snapshot.sku) ?? 0) + 1);
  }
  return snapshots
    .map((snapshot) => ({
      sku: snapshot.sku,
      product_id: snapshot.product_id,
      title: snapshot.title,
      selling_price: snapshot.selling_price,
      availability: snapshot.inventory_availability,
      inventory_freshness: snapshot.inventory_freshness,
      exact_sku_match: snapshot.sku.toLowerCase() === normalizedQuery,
      title_relevance: titleRelevance(snapshot.title, normalizedQuery),
      has_sku_conflict: (counts.get(snapshot.sku) ?? 0) > 1,
    }))
    .sort((left, right) => {
      const sellableDelta = availabilityRank(left.availability) - availabilityRank(right.availability);
      if (sellableDelta !== 0) return sellableDelta;
      if (left.exact_sku_match !== right.exact_sku_match) return left.exact_sku_match ? -1 : 1;
      if (left.title_relevance !== right.title_relevance) return right.title_relevance - left.title_relevance;
      return left.sku.localeCompare(right.sku) || left.product_id.localeCompare(right.product_id);
    });
}

export function calculateInventoryFreshness(
  inventoryLastSyncedAt: string | null,
  now: Date,
): CustomerServiceProductSnapshot['inventory_freshness'] {
  if (!inventoryLastSyncedAt) return 'missing';
  const milliseconds = Date.parse(inventoryLastSyncedAt);
  if (!Number.isFinite(milliseconds)) return 'missing';
  const age = now.getTime() - milliseconds;
  if (age <= 24 * 60 * 60 * 1000) return 'fresh';
  if (age <= 7 * 24 * 60 * 60 * 1000) return 'stale';
  return 'expired';
}

export function determineCostCompleteness(input: {
  purchaseCost: number | null;
  fulfillmentBuffer: number | null;
  estimatedPaymentFee: number | null;
}): CostCompleteness {
  const known = [input.purchaseCost, input.fulfillmentBuffer, input.estimatedPaymentFee]
    .filter((value) => value != null).length;
  if (known === 0) return 'unknown';
  if (input.purchaseCost == null) return 'insufficient';
  return 'partial';
}

export function sourceEnvironmentFingerprint(url: string): string {
  const clean = url.trim().replace(/\/+$/, '');
  return clean ? `supabase:${sha256(clean).slice(0, 12)}` : 'supabase:unconfigured';
}

export function validateReaderQuery(value: unknown): string {
  if (typeof value !== 'string') throw new Error('INVALID_QUERY');
  const clean = value.trim();
  if (!clean || clean.length > 100 || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new Error('INVALID_QUERY');
  }
  return clean;
}

export function validateSku(value: unknown): string {
  if (typeof value !== 'string') throw new Error('INVALID_SKU');
  const clean = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(clean)) throw new Error('INVALID_SKU');
  return clean;
}

function classifyAvailability(input: {
  published: boolean;
  inventoryStatus: string;
  quantity: number | null;
  inventoryFreshness: CustomerServiceProductSnapshot['inventory_freshness'];
  inSellableView: boolean;
}): CustomerServiceProductAvailability {
  if (!input.published) return 'unpublished';
  if (input.inventoryStatus === 'out_of_stock' || (input.quantity != null && input.quantity <= 0)) {
    return 'out_of_stock';
  }
  if (input.inventoryFreshness === 'stale') return 'stale';
  if (input.inventoryFreshness === 'expired') return 'expired';
  if (
    input.inSellableView
    && input.inventoryStatus === 'in_stock'
    && (input.quantity ?? 0) > 0
    && input.inventoryFreshness === 'fresh'
  ) return 'sellable';
  return 'unknown';
}

function buildSpecificationSummary(specifications: unknown, features: unknown): string[] {
  const result: string[] = [];
  if (specifications && typeof specifications === 'object' && !Array.isArray(specifications)) {
    for (const [key, value] of Object.entries(specifications as Record<string, unknown>)) {
      if (result.length >= 8) break;
      if (typeof value === 'string' || typeof value === 'number') result.push(`${key}: ${value}`);
    }
  }
  if (Array.isArray(features)) {
    for (const value of features) {
      if (result.length >= 8) break;
      if (typeof value === 'string' && value.trim()) result.push(value.trim());
    }
  }
  return result;
}

function titleRelevance(title: string, query: string): number {
  if (!query) return 0;
  const normalized = title.toLowerCase();
  if (normalized === query) return 100;
  if (normalized.startsWith(query)) return 80;
  if (normalized.includes(query)) return 60;
  const tokens = query.split(/\s+/).filter(Boolean);
  return tokens.reduce((score, token) => score + (normalized.includes(token) ? 10 : 0), 0);
}

function availabilityRank(value: CustomerServiceProductAvailability): number {
  return {
    sellable: 0,
    out_of_stock: 1,
    stale: 2,
    expired: 3,
    unknown: 4,
    unpublished: 5,
  }[value];
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredText(value: unknown, label: string): string {
  const result = optionalText(value);
  if (!result) throw new Error(`INVALID_${label.toUpperCase()}`);
  return result;
}

function optionalTimestamp(value: unknown): string | null {
  const text = optionalText(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export const customerServiceRequiredCostFields = REQUIRED_COST_FIELDS;
