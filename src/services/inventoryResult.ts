/**
 * Canonical inventory RESULT model (Phase 1 — pure, no I/O, no side effects).
 *
 * PRIMARY SAFETY INVARIANT: a failed lookup, expired login, "Login To See Price",
 * CAPTCHA/challenge, network error, missing warehouse selector, or parse error must
 * NEVER be represented as quantity=0 or `confirmed_out_of_stock`. Only an AFFIRMATIVE
 * supplier zero signal (e.g. a rendered "0 Available", or an authenticated+parseable
 * response with zero across all warehouses) is `confirmed_out_of_stock`. Everything
 * else that isn't a trustworthy confirmation is a distinct non-authoritative status.
 *
 * This module is the single source of the inventory status vocabulary; the state
 * machine, the dry-run runner, the CA-priority classifier, and the checkout gate all
 * consume it. It performs no network, DB, or browser work — `classify*` are pure.
 */

/** Where the reading came from. */
export type InventorySource = 'giga_pickup' | 'giga_dropship' | 'cache' | 'unknown';
/** Supplier account role behind the reading. */
export type SupplierAccountType = 'pickup' | 'dropship' | 'unknown';

/** The canonical, mutually-exclusive inventory result statuses. */
export type InventoryResultStatus =
  | 'confirmed_in_stock_ca'
  | 'confirmed_in_stock_out_of_state'
  | 'confirmed_out_of_stock'
  | 'inventory_unknown'
  | 'authentication_required'
  | 'captcha_required'
  | 'parse_failed'
  | 'network_failed'
  | 'supplier_unavailable'
  | 'stale';

export const ALL_INVENTORY_STATUSES: readonly InventoryResultStatus[] = [
  'confirmed_in_stock_ca', 'confirmed_in_stock_out_of_state', 'confirmed_out_of_stock',
  'inventory_unknown', 'authentication_required', 'captcha_required', 'parse_failed',
  'network_failed', 'supplier_unavailable', 'stale',
];

/** Trustworthy confirmations from the supplier (the only statuses that may move workflow state). */
export const CONFIRMED_STATUSES: ReadonlySet<InventoryResultStatus> = new Set<InventoryResultStatus>([
  'confirmed_in_stock_ca', 'confirmed_in_stock_out_of_state', 'confirmed_out_of_stock',
]);

/** Hard failures where we could not obtain a trustworthy reading — NEVER zero, NEVER mutate publication. */
export const FAILURE_STATUSES: ReadonlySet<InventoryResultStatus> = new Set<InventoryResultStatus>([
  'authentication_required', 'captcha_required', 'parse_failed', 'network_failed', 'supplier_unavailable',
]);

/** Non-authoritative statuses (failures + unknown + stale) — must never be read as zero stock. */
export const NON_AUTHORITATIVE_STATUSES: ReadonlySet<InventoryResultStatus> = new Set<InventoryResultStatus>([
  ...FAILURE_STATUSES, 'inventory_unknown', 'stale',
]);

export const isConfirmed = (s: InventoryResultStatus): boolean => CONFIRMED_STATUSES.has(s);
export const isFailure = (s: InventoryResultStatus): boolean => FAILURE_STATUSES.has(s);
export const isConfirmedInStock = (s: InventoryResultStatus): boolean =>
  s === 'confirmed_in_stock_ca' || s === 'confirmed_in_stock_out_of_state';
/** The ONLY status that counts as a real zero-stock confirmation. */
export const countsAsConfirmedZero = (s: InventoryResultStatus): boolean => s === 'confirmed_out_of_stock';

/** Per-warehouse detail preserved when available (no field is fabricated). */
export interface WarehouseStock {
  warehouseId?: string | null;
  warehouseCode?: string | null;
  warehouseName?: string | null;
  warehouseCity?: string | null;
  warehouseState?: string | null;
  quantity?: number | null;
  supportsPickup?: boolean | null;
  supportsShipping?: boolean | null;
}

/** Bumped whenever parsing/classification semantics change, so old results are attributable. */
export const INVENTORY_PARSER_VERSION = 'p1-2026-07-30';

/** The canonical result record. `warehouses`/`totalQuantity` are only meaningful for confirmed statuses. */
export interface InventoryResult {
  status: InventoryResultStatus;
  source: InventorySource;
  accountType: SupplierAccountType;
  supplierProductId: string;
  sku?: string | null;
  warehouses: WarehouseStock[];
  totalQuantity: number | null;
  hasCaStock: boolean;
  hasShippableStock: boolean;
  pickupEligible: boolean | null;
  shippingEligible: boolean | null;
  checkedAt: string;              // ISO8601
  parserVersion: string;
  failureReason: string | null;
  sessionId: string | null;       // source/session identifier (never a secret value)
}

/**
 * Explicit raw signals from a fetch/parse attempt. Deliberately verbose so that the
 * ABSENCE of parsed stock is never silently read as zero — the caller states exactly
 * what it observed (network, auth, captcha, parseability, an affirmative zero, etc.).
 */
export interface RawInventorySignals {
  // transport
  networkError?: boolean;             // timeout / DNS / connection reset
  httpStatus?: number | null;         // 200, 401, 403, 5xx …
  // page / response classification
  isLoginPage?: boolean;              // redirected to login / logged-out markers
  isCaptcha?: boolean;                // WAF / challenge / CAPTCHA page
  loginToSeePrice?: boolean;          // price-gated "Login To See Price"
  supplierErrorCode?: string | null;  // e.g. GIGA business code (B20003, non-200 envelope)
  bodyParseable?: boolean;            // could the response body be parsed at all
  warehouseSelectorPresent?: boolean; // 'Specified Warehouse' radio/options rendered (scrape path)
  affirmativeZeroSignal?: boolean;    // an EXPLICIT rendered "0 Available" / supplier zero
  parsedWarehouses?: WarehouseStock[];// per-warehouse rows, trusted only after the guards pass
  // freshness (for cache reads)
  ageMs?: number | null;
  staleThresholdMs?: number | null;
}

export interface ClassifyMeta {
  source: InventorySource;
  accountType: SupplierAccountType;
  supplierProductId: string;
  sku?: string | null;
  checkedAt: string;
  sessionId?: string | null;
}

const CA = (w: WarehouseStock): boolean => (w.warehouseState ?? '').toUpperCase() === 'CA';
const positive = (w: WarehouseStock): boolean => typeof w.quantity === 'number' && Number.isFinite(w.quantity) && w.quantity > 0;
/** Permission/auth-shaped supplier error codes (GIGA B20003 = "no permission"). */
const AUTH_ERROR_CODE = /b20003|401|403|forbidden|unauthor|permission|not\s*login|no\s*permission/i;

/**
 * Pure classification. Order matters: the most decisive FAILURE guards run first so a
 * broken/blocked/unauthenticated read can never fall through to a stock verdict. Only a
 * clean, authenticated, parseable response is allowed to yield a confirmed status, and a
 * zero verdict requires an AFFIRMATIVE zero signal (never mere absence of rows).
 */
export function classifyInventoryResult(signals: RawInventorySignals, meta: ClassifyMeta): InventoryResult {
  const base = {
    source: meta.source, accountType: meta.accountType, supplierProductId: meta.supplierProductId,
    sku: meta.sku ?? null, checkedAt: meta.checkedAt, parserVersion: INVENTORY_PARSER_VERSION,
    sessionId: meta.sessionId ?? null,
  };
  const result = (status: InventoryResultStatus, extra: Partial<InventoryResult> = {}): InventoryResult => ({
    ...base, status, warehouses: [], totalQuantity: null, hasCaStock: false, hasShippableStock: false,
    pickupEligible: null, shippingEligible: null, failureReason: null, ...extra,
  });

  // 1. Transport failure — cannot conclude anything.
  if (signals.networkError) return result('network_failed', { failureReason: 'network_error' });

  // 2. Authentication / session — 401/403, login redirect, or price-gated page.
  if (signals.httpStatus === 401 || signals.httpStatus === 403)
    return result('authentication_required', { failureReason: `http_${signals.httpStatus}` });
  if (signals.isLoginPage) return result('authentication_required', { failureReason: 'login_page' });
  if (signals.loginToSeePrice) return result('authentication_required', { failureReason: 'login_to_see_price' });

  // 3. CAPTCHA / challenge.
  if (signals.isCaptcha) return result('captcha_required', { failureReason: 'captcha_or_challenge' });

  // 4. Supplier business error envelope.
  if (signals.supplierErrorCode) {
    if (AUTH_ERROR_CODE.test(signals.supplierErrorCode))
      return result('authentication_required', { failureReason: `supplier_${signals.supplierErrorCode}` });
    return result('supplier_unavailable', { failureReason: `supplier_${signals.supplierErrorCode}` });
  }

  // 5. Server unavailable.
  if (typeof signals.httpStatus === 'number' && signals.httpStatus >= 500)
    return result('supplier_unavailable', { failureReason: `http_${signals.httpStatus}` });

  // 6. Body not parseable, or the warehouse selector never rendered → cannot determine.
  if (signals.bodyParseable === false) return result('parse_failed', { failureReason: 'body_unparseable' });
  if (signals.warehouseSelectorPresent === false) return result('parse_failed', { failureReason: 'missing_warehouse_selector' });

  // 7. Stale cache read — trustworthy source, but too old to assert current stock.
  if (typeof signals.ageMs === 'number' && typeof signals.staleThresholdMs === 'number' && signals.ageMs > signals.staleThresholdMs)
    return result('stale', { failureReason: `age_ms_${signals.ageMs}` });

  // 8. Clean, authenticated, parseable read → derive stock from per-warehouse rows.
  const whs = signals.parsedWarehouses ?? [];
  const hasCaStock = whs.some(w => CA(w) && positive(w));
  const hasShippableStock = whs.some(w => !CA(w) && positive(w));
  const totalQuantity = whs.reduce((s, w) => s + (positive(w) ? (w.quantity as number) : 0), 0);
  const anyPositive = hasCaStock || hasShippableStock;

  if (anyPositive) {
    return result(hasCaStock ? 'confirmed_in_stock_ca' : 'confirmed_in_stock_out_of_state', {
      warehouses: whs, totalQuantity, hasCaStock, hasShippableStock,
      pickupEligible: whs.some(w => positive(w) && w.supportsPickup === true) || hasCaStock,
      shippingEligible: whs.some(w => positive(w) && w.supportsShipping !== false) && hasShippableStock,
    });
  }

  // 9. No positive stock. Only an AFFIRMATIVE zero is out-of-stock; otherwise UNKNOWN (never zero).
  if (signals.affirmativeZeroSignal === true)
    return result('confirmed_out_of_stock', { warehouses: whs, totalQuantity: 0, failureReason: null });
  return result('inventory_unknown', { warehouses: whs, failureReason: 'no_positive_rows_no_affirmative_zero' });
}

/**
 * Convenience adapter for the GIGA authenticated XHR endpoint
 * (/product/info/price/warehouse) response envelope. Encodes the audited safety fix:
 * an empty `stock_distributions` on a clean 200 is UNKNOWN, NOT confirmed zero, and a
 * missing/non-200 envelope is a failure, never zero.
 */
export function xhrSignalsFromEnvelope(input: {
  networkError?: boolean;
  httpStatus?: number | null;
  json?: { code?: number | string | null; msg?: string | null; data?: { stock_distributions?: Array<Record<string, unknown>> | null } | null } | null;
  warehouseStateOf?: (code: string) => string | null;   // reuse existing prefix->state mapper
}): RawInventorySignals {
  if (input.networkError) return { networkError: true };
  const status = input.httpStatus ?? null;
  if (status === 401 || status === 403) return { httpStatus: status };
  if (typeof status === 'number' && status >= 500) return { httpStatus: status };
  if (!input.json) return { httpStatus: status, bodyParseable: false };
  const code = input.json.code;
  const codeOk = code === 200 || code === '200' || code == null; // some envelopes omit code on success
  if (!codeOk) return { httpStatus: status, supplierErrorCode: String(code ?? input.json.msg ?? 'non_200') };
  const dists = input.json.data?.stock_distributions;
  if (dists == null) return { httpStatus: status, bodyParseable: true, warehouseSelectorPresent: true, parsedWarehouses: [] }; // clean but empty → UNKNOWN
  const parsedWarehouses: WarehouseStock[] = dists.map(d => {
    const wcode = String((d.warehouse_code ?? d.code ?? '') as string);
    return {
      warehouseId: (d.wh_id ?? null) as string | null,
      warehouseCode: wcode || null,
      warehouseState: input.warehouseStateOf ? input.warehouseStateOf(wcode) : null,
      quantity: Number((d.qty ?? d.quantity ?? 0) as number),
      supportsShipping: null, supportsPickup: null,
    };
  });
  return { httpStatus: status, bodyParseable: true, warehouseSelectorPresent: true, parsedWarehouses };
}
