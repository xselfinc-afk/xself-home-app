/**
 * Project verified supplier evidence onto the two display fields on `standardized_products`
 * (`inventory_status`, `total_available_qty`) — pure, deterministic, side-effect free.
 *
 * WHY THIS EXISTS
 * ---------------
 * `product_availability_current` already holds the authoritative answer, and `sellable_products`
 * already hides a product the moment that answer says so. But the two *numeric* fields customers
 * and operators read come from a different pipeline: the website-scrape sync writes
 * `inventory_cache` and calls `refresh_product_inventory_status()`. The Open API path never
 * touched either, so the numbers drifted from the evidence.
 *
 * This module does NOT write `inventory_cache`. `20260802_open_api_availability.sql` refused to,
 * on the grounds that the price endpoint returns a bare boolean and filling in a warehouse code or
 * quantity would be fabricated evidence. That reasoning still holds and is preserved here: a
 * quantity is only ever copied from a channel that actually reported one.
 *
 * THE RULE THAT MATTERS
 * ---------------------
 * A failure is not a zero. When no channel reliably reports stock, this function declines to write
 * at all (`should_write: false`) and the previous reliable values stand. Nothing in here can
 * produce a `0` except two independent channels both explicitly saying "unavailable".
 */

/** One account's answer about one SKU. `pickup` / `dropship` for targeted reads, `open_api` for the scan. */
export interface InventoryChannelObservation {
  channel: string;
  /** Did the read complete? False for api_failed, network_error, favorites_not_synchronized, code=0, … */
  read_ok: boolean;
  /** Only meaningful when read_ok. null means the channel answered without a usable flag. */
  available: boolean | null;
  /** Only meaningful when read_ok && available. null means the channel reported no quantity. */
  quantity: number | null;
  /** Non-sensitive note kept for the report; never used in a decision. */
  failure_reason?: string | null;
}

export interface StandardizedInventoryProjectionInput {
  channels: readonly InventoryChannelObservation[];
  currentInventoryStatus: string | null;
  currentTotalAvailableQty: number | null;
  /** When the evidence was observed. Echoed so the caller can stamp `inventory_last_synced_at`. */
  evidenceCheckedAt: string;
}

export type QuantityStrategy =
  | 'max_reliable_channel_quantity'
  | 'zero_confirmed_out_of_stock'
  | 'preserve_previous_reliable_quantity'
  | 'no_write';

export type ProjectionReason =
  | 'reliable_channel_in_stock'
  | 'available_without_reliable_quantity'
  | 'confirmed_out_of_stock_both_channels'
  | 'insufficient_channels_for_out_of_stock'
  | 'no_reliable_evidence'
  | 'no_change';

export interface StandardizedInventoryProjection {
  next_inventory_status: string | null;
  next_total_available_qty: number | null;
  should_write: boolean;
  reason: ProjectionReason;
  /** Channels whose read completed. Ordering follows the input. */
  reliable_channels: string[];
  /** Channels whose read failed, with the reason, so a partial failure stays visible. */
  failed_channels: Array<{ channel: string; reason: string | null }>;
  quantity_strategy: QuantityStrategy;
  evidence_checked_at: string;
}

export const IN_STOCK = 'in_stock';
export const OUT_OF_STOCK = 'out_of_stock';

/**
 * A zero requires corroboration. One channel saying "unavailable" is an observation; two
 * independent channels saying it is a fact. The full scan reads a single channel and therefore
 * can raise a product to `in_stock` but can never, on its own, write a zero.
 */
export const MIN_CHANNELS_FOR_ZERO = 2;

/** A quantity is usable only if it is a finite, positive number the channel actually reported. */
function usableQuantity(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function normalizedCurrentQty(value: number | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function deriveStandardizedInventoryProjection(
  input: StandardizedInventoryProjectionInput,
): StandardizedInventoryProjection {
  const currentStatus = input.currentInventoryStatus ?? null;
  const currentQty = normalizedCurrentQty(input.currentTotalAvailableQty);

  const reliable = input.channels.filter((c) => c.read_ok);
  const failed = input.channels.filter((c) => !c.read_ok);
  const inStock = reliable.filter((c) => c.available === true);

  const base = {
    reliable_channels: reliable.map((c) => c.channel),
    failed_channels: failed.map((c) => ({ channel: c.channel, reason: c.failure_reason ?? null })),
    evidence_checked_at: input.evidenceCheckedAt,
  };

  const preserve = (reason: ProjectionReason): StandardizedInventoryProjection => ({
    ...base,
    next_inventory_status: currentStatus,
    next_total_available_qty: currentQty,
    should_write: false,
    reason,
    quantity_strategy: 'no_write',
  });

  let projected: StandardizedInventoryProjection;

  if (inStock.length > 0) {
    // Rule A / C: any reliable channel with stock wins, and a failure elsewhere cannot demote it.
    const quantities = inStock.map((c) => usableQuantity(c.quantity)).filter((q): q is number => q !== null);
    if (quantities.length > 0) {
      // Rule A: the LARGEST single channel, never the sum — the channels see overlapping
      // warehouses, so adding them would invent stock that does not exist.
      projected = {
        ...base,
        next_inventory_status: IN_STOCK,
        next_total_available_qty: Math.max(...quantities),
        should_write: true,
        reason: 'reliable_channel_in_stock',
        quantity_strategy: 'max_reliable_channel_quantity',
      };
    } else {
      // Rule E: known available, unknown how many. Keep the last reliable number rather than guess.
      projected = {
        ...base,
        next_inventory_status: IN_STOCK,
        next_total_available_qty: currentQty,
        should_write: true,
        reason: 'available_without_reliable_quantity',
        quantity_strategy: 'preserve_previous_reliable_quantity',
      };
    }
  } else if (
    failed.length === 0
    && reliable.length >= MIN_CHANNELS_FOR_ZERO
    && reliable.every((c) => c.available === false)
  ) {
    // Rule B: every channel read cleanly and every one of them said no.
    projected = {
      ...base,
      next_inventory_status: OUT_OF_STOCK,
      next_total_available_qty: 0,
      should_write: true,
      reason: 'confirmed_out_of_stock_both_channels',
      quantity_strategy: 'zero_confirmed_out_of_stock',
    };
  } else if (failed.length > 0 || reliable.some((c) => c.available === null)) {
    // Rule D: something failed or answered unusably. Never a zero, never `unknown` — just leave it.
    return preserve('no_reliable_evidence');
  } else {
    // Everything read cleanly and said unavailable, but from too few channels to be a fact.
    return preserve('insufficient_channels_for_out_of_stock');
  }

  // Rule: never issue an UPDATE that changes nothing.
  if (
    projected.next_inventory_status === currentStatus
    && projected.next_total_available_qty === currentQty
  ) {
    return { ...projected, should_write: false, reason: 'no_change', quantity_strategy: 'no_write' };
  }

  return projected;
}

/** Columns this projection is ever allowed to touch. Anything else is a bug, not a feature. */
export const STANDARDIZED_INVENTORY_WRITABLE_COLUMNS = [
  'inventory_status',
  'total_available_qty',
  'inventory_last_synced_at',
] as const;

export interface StandardizedInventoryUpdatePayload {
  inventory_status: string;
  total_available_qty: number | null;
  inventory_last_synced_at: string;
  [column: string]: unknown;
}

/**
 * Build the update payload, and refuse to build one that could change publication or any other
 * field. This is the structural counterpart to `assertNoPublicationWrite` on the evidence path.
 */
export function buildStandardizedInventoryUpdate(
  projection: StandardizedInventoryProjection,
): StandardizedInventoryUpdatePayload {
  if (!projection.should_write || projection.next_inventory_status === null) {
    throw new Error('standardized_inventory_update_not_permitted');
  }
  const payload: StandardizedInventoryUpdatePayload = {
    inventory_status: projection.next_inventory_status,
    total_available_qty: projection.next_total_available_qty,
    inventory_last_synced_at: projection.evidence_checked_at,
  };
  assertNoPublicationWrite(payload);
  return payload;
}

const FORBIDDEN_COLUMNS = [
  'published', 'delist_reason', 'selling_price', 'price', 'original_price',
  'product_title', 'optimized_title', 'primary_image', 'product_family_key',
];

/** Throws rather than letting a publication or catalog field ride along with an inventory update. */
export function assertNoPublicationWrite(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_COLUMNS.includes(key)) {
      throw new Error(`standardized_inventory_forbidden_column:${key}`);
    }
    if (!STANDARDIZED_INVENTORY_WRITABLE_COLUMNS.includes(key as never)) {
      throw new Error(`standardized_inventory_unexpected_column:${key}`);
    }
  }
}

export interface StandardizedInventoryWriteResult {
  standardized_inventory_write_attempted: boolean;
  standardized_inventory_write_succeeded: boolean;
  previous_inventory_status: string | null;
  next_inventory_status: string | null;
  previous_total_available_qty: number | null;
  next_total_available_qty: number | null;
  quantity_strategy: QuantityStrategy;
  reason: ProjectionReason;
  reliable_channels: string[];
  failed_channels: Array<{ channel: string; reason: string | null }>;
  rows_written: number;
  error: string | null;
}

/** Minimal shape of the Supabase client, so this module stays dependency-free and testable. */
export interface StandardizedInventoryWriter {
  from(table: string): {
    update(payload: Record<string, unknown>): {
      eq(column: string, value: unknown): {
        select(columns: string): Promise<{ data: unknown[] | null; error: { message: string } | null }>;
      };
    };
  };
}

/**
 * Apply one projection to exactly one `standardized_products` row.
 *
 * Matched on `sku_custom` (the XSelf SKU) with an exact equality filter — never a pattern, never a
 * title, never a stale supplier id. The write is required to affect exactly one row; anything else
 * is reported as a failure rather than accepted, so a broadened filter can never pass silently.
 */
export async function applyStandardizedInventoryProjection(
  client: StandardizedInventoryWriter,
  xselfSku: string,
  projection: StandardizedInventoryProjection,
  currentStatus: string | null,
  currentQty: number | null,
): Promise<StandardizedInventoryWriteResult> {
  const base = {
    previous_inventory_status: currentStatus,
    next_inventory_status: projection.next_inventory_status,
    previous_total_available_qty: currentQty,
    next_total_available_qty: projection.next_total_available_qty,
    quantity_strategy: projection.quantity_strategy,
    reason: projection.reason,
    reliable_channels: projection.reliable_channels,
    failed_channels: projection.failed_channels,
  };

  if (!projection.should_write) {
    // Rules D / E-with-no-change / no_change all land here: the previous values stand untouched.
    return {
      ...base,
      standardized_inventory_write_attempted: false,
      standardized_inventory_write_succeeded: false,
      next_inventory_status: currentStatus,
      next_total_available_qty: currentQty,
      rows_written: 0,
      error: null,
    };
  }

  let payload: StandardizedInventoryUpdatePayload;
  try {
    payload = buildStandardizedInventoryUpdate(projection);
  } catch (error) {
    return {
      ...base,
      standardized_inventory_write_attempted: false,
      standardized_inventory_write_succeeded: false,
      rows_written: 0,
      error: error instanceof Error ? error.message : 'payload_build_failed',
    };
  }

  const { data, error } = await client.from('standardized_products')
    .update(payload)
    .eq('sku_custom', xselfSku)
    .select('supplier_product_id');

  const rows = (data ?? []).length;
  if (error || rows !== 1) {
    return {
      ...base,
      standardized_inventory_write_attempted: true,
      standardized_inventory_write_succeeded: false,
      rows_written: rows,
      error: error?.message ?? `expected exactly 1 row, updated ${rows}`,
    };
  }

  return {
    ...base,
    standardized_inventory_write_attempted: true,
    standardized_inventory_write_succeeded: true,
    rows_written: 1,
    error: null,
  };
}

/** Channel observation built from one targeted account read (pickup / dropship). */
export function channelFromAccountFacts(
  channel: string,
  facts: { available?: unknown; total_available_qty?: unknown } | null,
  failureReason?: string | null,
): InventoryChannelObservation {
  if (!facts) {
    return { channel, read_ok: false, available: null, quantity: null, failure_reason: failureReason ?? null };
  }
  const qty = Number(facts.total_available_qty);
  return {
    channel,
    read_ok: true,
    available: facts.available === true ? true : facts.available === false ? false : null,
    quantity: Number.isFinite(qty) ? qty : null,
    failure_reason: null,
  };
}
