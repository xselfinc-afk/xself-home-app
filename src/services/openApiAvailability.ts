/**
 * GIGA Open API availability adapter — pure, deterministic, side-effect free.
 *
 * The Open API is the ONLY signal this module consumes. It is credential-signed and browser-free:
 * `/b2b-overseas-api/v1/buyer/product/price/v1` returns a `skuAvailable` boolean per SKU. There is
 * no warehouse, quantity, or California field in any Open API response, and this module never
 * invents one — see `docs/product-supply/INVENTORY_LIFECYCLE_CAPABILITY_AUDIT.md`.
 *
 * THE ONE RULE THAT MATTERS
 * -------------------------
 * Only an explicit `skuAvailable === false` is a zero. Every failure mode — transport error,
 * HTTP error, `code: 0` envelope, rate limit, malformed body, SKU absent from the response — maps
 * to a NON-authoritative status that can never decrement stock, never delist, and never relist.
 * A supplier we could not reach is not a supplier that said "no".
 *
 * Results are expressed in the EXISTING `InventoryResultStatus` vocabulary
 * (`src/services/inventoryResult.ts`) so the existing state machine consumes them unchanged.
 */
import {
  type InventoryResultStatus,
  isFailure,
  countsAsConfirmedZero,
} from './inventoryResult';

/** Availability outcomes specific to the Open API transport. */
export type ApiAvailabilityStatus =
  | 'confirmed_available'
  | 'confirmed_out_of_stock'
  | 'api_failed'
  | 'rate_limited'
  | 'network_failed'
  | 'malformed_response'
  | 'missing_sku'
  | 'supplier_unavailable';

/** Statuses that represent a trustworthy supplier answer. Everything else is a non-answer. */
export const API_CONFIRMED_STATUSES: ReadonlySet<ApiAvailabilityStatus> =
  new Set<ApiAvailabilityStatus>(['confirmed_available', 'confirmed_out_of_stock']);

export const isApiConfirmed = (s: ApiAvailabilityStatus): boolean => API_CONFIRMED_STATUSES.has(s);
export const isApiFailure = (s: ApiAvailabilityStatus): boolean => !API_CONFIRMED_STATUSES.has(s);

/**
 * Map an Open API outcome onto the existing inventory vocabulary the state machine already speaks.
 *
 * `confirmed_available` becomes `confirmed_in_stock_out_of_state` deliberately: the Open API proves
 * the supplier considers the SKU available, but proves NOTHING about which warehouse holds it.
 * Claiming `confirmed_in_stock_ca` here would fabricate California stock — the exact thing Scope H
 * forbids. California remains the warehouse feed's business.
 */
export function toInventoryResultStatus(s: ApiAvailabilityStatus): InventoryResultStatus {
  switch (s) {
    case 'confirmed_available': return 'confirmed_in_stock_out_of_state';
    case 'confirmed_out_of_stock': return 'confirmed_out_of_stock';
    case 'rate_limited': return 'supplier_unavailable';
    case 'supplier_unavailable': return 'supplier_unavailable';
    case 'network_failed': return 'network_failed';
    case 'malformed_response': return 'parse_failed';
    case 'api_failed': return 'supplier_unavailable';
    // A SKU the supplier simply did not return is unknown — not absent, not zero.
    case 'missing_sku': return 'inventory_unknown';
  }
}

export interface AvailabilityResult {
  sku: string;
  status: ApiAvailabilityStatus;
  /** true / false only when confirmed; null for every failure mode. */
  available: boolean | null;
  /** Existing-vocabulary status, for the state machine. */
  inventoryStatus: InventoryResultStatus;
  /** Short, non-sensitive explanation. Never contains credentials or raw bodies. */
  reason: string;
}

/** One row as returned by the price endpoint. Only the fields this module reads are typed. */
export interface ApiPriceRow {
  sku?: string;
  skuCode?: string;
  skuAvailable?: unknown;
}

/** Transport-level outcome of a single batch call. */
export type BatchOutcome =
  | { kind: 'ok'; rows: unknown }
  | { kind: 'network_error'; message: string }
  | { kind: 'rate_limited'; message?: string }
  | { kind: 'api_error'; message: string }
  | { kind: 'malformed'; message: string };

const truthy = (v: unknown): boolean => v === true || v === 'true' || v === 1 || v === '1';
const falsy = (v: unknown): boolean => v === false || v === 'false' || v === 0 || v === '0';

/** Redact anything that looks like a key/token/signature before it reaches a report or log. */
export function redactReason(input: unknown): string {
  return String((input as { message?: string })?.message ?? input ?? '')
    .replace(/[A-Za-z0-9_+/=-]{20,}/g, '[REDACTED]')
    .replace(/("?(?:sign|secret|token|key|appKey|clientId|client-id)"?\s*[:=]\s*)("[^"]*"|\S+)/gi, '$1[REDACTED]')
    .slice(0, 160);
}

/**
 * Normalise whatever the client returned into an array of rows. The Open API has been observed
 * returning a bare array, `{data: [...]}` and `{data: {list: [...]}}`; anything else is malformed.
 */
export function extractRows(payload: unknown): ApiPriceRow[] | null {
  if (Array.isArray(payload)) return payload as ApiPriceRow[];
  const d = (payload as { data?: unknown })?.data;
  if (Array.isArray(d)) return d as ApiPriceRow[];
  const list = (d as { list?: unknown })?.list ?? (payload as { list?: unknown })?.list;
  if (Array.isArray(list)) return list as ApiPriceRow[];
  return null;
}

/**
 * Detect the GIGA "success-shaped failure": HTTP 200 carrying `code: 0` and an error message.
 * Treating this as data would silently mark the whole batch unavailable.
 */
export function isApiErrorEnvelope(payload: unknown): boolean {
  const p = payload as { code?: unknown; error?: unknown; msg?: unknown } | null;
  if (!p || typeof p !== 'object') return false;
  const hasError = typeof p.error === 'string' && p.error.length > 0;
  return p.code === 0 && hasError;
}

/**
 * Classify one batch. `requestedSkus` drives the output so a SKU the supplier omitted is reported
 * as `missing_sku` rather than silently disappearing from the run.
 */
export function classifyBatch(
  requestedSkus: readonly string[],
  outcome: BatchOutcome,
  /**
   * Optional `/detailInfo/v1` rows, consulted ONLY when the price row carries no usable
   * `skuAvailable`. Some products answer the availability flag on the detail endpoint and omit it
   * on price; without this they were reported `malformed_response` forever and never got an
   * evidence row, which kept them out of `sellable_products` while still published and in stock.
   * Same precedence the targeted read client already uses: price first, detail as fallback.
   */
  detailBySku?: ReadonlyMap<string, { skuAvailable?: unknown }>,
): AvailabilityResult[] {
  const fail = (status: ApiAvailabilityStatus, reason: string): AvailabilityResult[] =>
    requestedSkus.map(sku => ({
      sku,
      status,
      available: null,
      inventoryStatus: toInventoryResultStatus(status),
      reason: redactReason(reason),
    }));

  if (outcome.kind === 'network_error') return fail('network_failed', outcome.message);
  if (outcome.kind === 'rate_limited') return fail('rate_limited', outcome.message ?? 'rate limited');
  if (outcome.kind === 'api_error') return fail('api_failed', outcome.message);
  if (outcome.kind === 'malformed') return fail('malformed_response', outcome.message);

  if (isApiErrorEnvelope(outcome.rows)) return fail('api_failed', 'api error envelope (code=0)');

  const rows = extractRows(outcome.rows);
  if (!rows) return fail('malformed_response', 'unrecognised response shape');

  const bySku = new Map<string, ApiPriceRow>();
  for (const r of rows) {
    const k = r?.sku ?? r?.skuCode;
    if (typeof k === 'string' && k) bySku.set(k, r);
  }

  return requestedSkus.map(sku => {
    const row = bySku.get(sku);
    if (!row) {
      return { sku, status: 'missing_sku', available: null, inventoryStatus: toInventoryResultStatus('missing_sku'), reason: 'sku absent from response' };
    }
    const raw = row.skuAvailable;
    if (truthy(raw)) {
      return { sku, status: 'confirmed_available', available: true, inventoryStatus: toInventoryResultStatus('confirmed_available'), reason: 'skuAvailable=true' };
    }
    if (falsy(raw)) {
      return { sku, status: 'confirmed_out_of_stock', available: false, inventoryStatus: toInventoryResultStatus('confirmed_out_of_stock'), reason: 'skuAvailable=false' };
    }

    // The price row carries no usable flag. Before calling the response malformed, ask the detail
    // endpoint — for some products that is simply where the supplier reports the flag.
    const detail = detailBySku?.get(sku);
    if (detail) {
      const detailRaw = detail.skuAvailable;
      if (truthy(detailRaw)) {
        return { sku, status: 'confirmed_available', available: true, inventoryStatus: toInventoryResultStatus('confirmed_available'), reason: 'detail skuAvailable=true (price omitted)' };
      }
      if (falsy(detailRaw)) {
        return { sku, status: 'confirmed_out_of_stock', available: false, inventoryStatus: toInventoryResultStatus('confirmed_out_of_stock'), reason: 'detail skuAvailable=false (price omitted)' };
      }
    }

    // Neither endpoint gave a usable flag — unknown, never zero.
    return { sku, status: 'malformed_response', available: null, inventoryStatus: toInventoryResultStatus('malformed_response'), reason: 'skuAvailable missing or non-boolean' };
  });
}

export interface RunTally {
  total: number;
  confirmedAvailable: number;
  confirmedOutOfStock: number;
  failures: number;
  byStatus: Record<string, number>;
  failurePercent: number;
}

export function tally(results: readonly AvailabilityResult[]): RunTally {
  const byStatus: Record<string, number> = {};
  let confirmedAvailable = 0, confirmedOutOfStock = 0, failures = 0;
  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.status === 'confirmed_available') confirmedAvailable++;
    else if (r.status === 'confirmed_out_of_stock') confirmedOutOfStock++;
    else failures++;
  }
  const total = results.length;
  return {
    total,
    confirmedAvailable,
    confirmedOutOfStock,
    failures,
    byStatus,
    failurePercent: total === 0 ? 0 : +((failures / total) * 100).toFixed(2),
  };
}

/**
 * Cross-check: the adapter's own statuses must agree with the shared vocabulary about what counts
 * as a zero and what counts as a failure. Exported so the suite can assert the two never drift.
 */
export function agreesWithSharedVocabulary(r: AvailabilityResult): boolean {
  const zeroHere = r.status === 'confirmed_out_of_stock';
  const zeroThere = countsAsConfirmedZero(r.inventoryStatus);
  if (zeroHere !== zeroThere) return false;
  if (isApiFailure(r.status) && r.available !== null) return false;
  // `missing_sku` maps to inventory_unknown, which is non-authoritative but not a hard failure.
  if (isFailure(r.inventoryStatus) && !isApiFailure(r.status)) return false;
  return true;
}

export const OPEN_API_SOURCE = 'open_api' as const;
