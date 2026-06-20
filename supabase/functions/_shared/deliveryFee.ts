// Pure Delivery-fee normalization — shared by the Deno edge (plan-fulfillment) and the
// Node tsx unit test (src/__tests__/deliveryFee.test.ts). NO Deno/Node globals, NO network,
// NO secrets — just math over a GIGA product/price/v1 response. See docs/delivery-architecture.md.
//
// Source fields (GIGA /buyer/product/price/v1): `shippingFee` (shipping only) and
// `shippingFeeRange{minAmount,maxAmount}` (shipping INCLUDING packing). We charge the
// packing-inclusive MAX so we never undercharge; packing = fee − shipping (derived).

export interface GigaPriceRow {
  sku: string;
  currency?: string | null;
  shippingFee?: number | null;
  shippingFeeRange?: { minAmount?: number | null; maxAmount?: number | null } | null;
  skuAvailable?: boolean | null;
}

export interface DeliveryFeeLine {
  sku: string;
  qty: number;
  available: boolean;
  shippingFeeCents: number | null;
  packingFeeCents: number | null;
  feeCents: number | null;       // packing-inclusive, per the whole line (× qty)
  feeMinCents: number | null;
  feeMaxCents: number | null;
  isRange: boolean;
}

export interface DeliveryFeeResult {
  available: boolean;            // false if ANY line is unavailable (no partial delivery)
  currency: string;
  deliveryFeeCents: number | null;
  shippingFeeCents: number | null;
  packingFeeCents: number | null;
  feeMinCents: number | null;
  feeMaxCents: number | null;
  isRange: boolean;
  lines: DeliveryFeeLine[];
  unavailableSkus: string[];
  /** Why unavailable: 'no_items'|'sku_not_found'|'sku_unavailable'|'no_fee'|'currency_mismatch'|'no_cached_fee'. null when available. */
  reason: string | null;
  source: 'giga_openapi_price_v1' | 'giga_portal_price_list_cache';
}

const c = (dollars: number): number => Math.round(dollars * 100);

/** Normalize a product/price/v1 `data[]` array + cart items into a server-authoritative fee. */
export function computeDeliveryFee(
  rows: GigaPriceRow[],
  items: { sku: string; qty: number }[],
  expectedCurrency = 'USD',
): DeliveryFeeResult {
  const bySku = new Map<string, GigaPriceRow>();
  for (const r of rows ?? []) if (r && typeof r.sku === 'string') bySku.set(r.sku, r);

  const lines: DeliveryFeeLine[] = [];
  const unavailableSkus: string[] = [];
  let firstReason: string | null = null;

  for (const item of items) {
    const row = bySku.get(item.sku);
    const qty = Math.max(1, Math.floor(item.qty || 0));
    const range = row?.shippingFeeRange ?? null;
    const shipping = typeof row?.shippingFee === 'number' ? row.shippingFee : null;
    const rangeMax = typeof range?.maxAmount === 'number' ? range.maxAmount : null;
    const rangeMin = typeof range?.minAmount === 'number' ? range.minAmount : null;

    const currencyOk = !row?.currency || row.currency === expectedCurrency;
    // The packing-inclusive fee we would charge (max of the range, else shipping).
    const unitFee = rangeMax ?? shipping;
    let lineReason: string | null = null;
    if (!row) lineReason = 'sku_not_found';
    else if (row.skuAvailable === false) lineReason = 'sku_unavailable';
    else if (!currencyOk) lineReason = 'currency_mismatch';
    else if (unitFee == null) lineReason = 'no_fee';

    if (lineReason !== null) {
      if (!firstReason) firstReason = lineReason;
      unavailableSkus.push(item.sku);
      lines.push({
        sku: item.sku, qty, available: false,
        shippingFeeCents: null, packingFeeCents: null, feeCents: null,
        feeMinCents: null, feeMaxCents: null, isRange: false,
      });
      continue;
    }

    const unitShipping = shipping ?? unitFee;            // if shipping not broken out, treat fee as shipping
    const unitPacking = Math.max(0, unitFee - unitShipping);
    const unitMin = rangeMin ?? unitFee;
    const unitMax = rangeMax ?? unitFee;

    lines.push({
      sku: item.sku, qty, available: true,
      shippingFeeCents: c(unitShipping) * qty,
      packingFeeCents: c(unitPacking) * qty,
      feeCents: c(unitFee) * qty,
      feeMinCents: c(unitMin) * qty,
      feeMaxCents: c(unitMax) * qty,
      isRange: unitMin !== unitMax,
    });
  }

  const available = items.length > 0 && unavailableSkus.length === 0;
  if (!available) {
    return {
      available: false, currency: expectedCurrency,
      deliveryFeeCents: null, shippingFeeCents: null, packingFeeCents: null,
      feeMinCents: null, feeMaxCents: null, isRange: false,
      lines, unavailableSkus,
      reason: items.length === 0 ? 'no_items' : (firstReason ?? 'unavailable'),
      source: 'giga_openapi_price_v1',
    };
  }

  const sum = (sel: (l: DeliveryFeeLine) => number | null): number =>
    lines.reduce((s, l) => s + (sel(l) ?? 0), 0);

  const feeMinCents = sum((l) => l.feeMinCents);
  const feeMaxCents = sum((l) => l.feeMaxCents);

  return {
    available: true,
    currency: expectedCurrency,
    deliveryFeeCents: sum((l) => l.feeCents),
    shippingFeeCents: sum((l) => l.shippingFeeCents),
    packingFeeCents: sum((l) => l.packingFeeCents),
    feeMinCents,
    feeMaxCents,
    isRange: feeMinCents !== feeMaxCents || lines.some((l) => l.isRange),
    lines,
    unavailableSkus: [],
    reason: null,
    source: 'giga_openapi_price_v1',
  };
}

// ── Cached portal fee (interim source while OpenAPI product/price/v1 is B20003-blocked) ──────
// A row from public.giga_delivery_fee_cache. charged_fee_cents is the customer-facing fee
// (raw Fulfillment Fee + 8% buffer, rounded up) — PER UNIT.
export interface GigaCacheRow {
  supplier_product_id: string;
  charged_fee_cents?: number | null;
  currency?: string | null;
  packing_fee_cents?: number | null;
  shipping_fee_cents?: number | null;
  fulfillment_fee_cents?: number | null;
}

/**
 * Build a server-authoritative Delivery fee from cached giga_delivery_fee_cache rows.
 * Keyed by supplier_product_id (= cart item.sku here). charged_fee_cents is PER UNIT → ×qty.
 * A missing row or null charged_fee_cents makes the whole result unavailable (reason
 * 'no_cached_fee', with the offending SKUs in unavailableSkus). Fee AGE/staleness is
 * intentionally IGNORED — cached fees never hard-expire. NO GIGA calls, NO Supabase writes.
 */
export function computeDeliveryFeeFromCache(
  rows: GigaCacheRow[],
  items: { sku: string; qty: number }[],
  expectedCurrency = 'USD',
): DeliveryFeeResult {
  const bySku = new Map<string, GigaCacheRow>();
  for (const r of rows ?? []) if (r && typeof r.supplier_product_id === 'string') bySku.set(r.supplier_product_id, r);

  const lines: DeliveryFeeLine[] = [];
  const unavailableSkus: string[] = [];
  let firstReason: string | null = null;

  for (const item of items) {
    const row = bySku.get(item.sku);
    const qty = Math.max(1, Math.floor(item.qty || 0));
    const charged = typeof row?.charged_fee_cents === 'number' ? row.charged_fee_cents : null;
    const currencyOk = !row?.currency || row.currency === expectedCurrency;

    let lineReason: string | null = null;
    if (!row || charged == null) lineReason = 'no_cached_fee';       // missing row OR no stored fee
    else if (!currencyOk) lineReason = 'currency_mismatch';

    if (lineReason !== null) {
      if (!firstReason) firstReason = lineReason;
      unavailableSkus.push(item.sku);
      lines.push({
        sku: item.sku, qty, available: false,
        shippingFeeCents: null, packingFeeCents: null, feeCents: null,
        feeMinCents: null, feeMaxCents: null, isRange: false,
      });
      continue;
    }

    const lineCharged = charged! * qty;                              // charged_fee_cents is per-unit
    const packing = typeof row!.packing_fee_cents === 'number' ? row!.packing_fee_cents * qty : null;
    const shipping = typeof row!.shipping_fee_cents === 'number' ? row!.shipping_fee_cents * qty : null;
    lines.push({
      sku: item.sku, qty, available: true,
      // breakdown reflects the RAW per-unit packing/shipping (pre-buffer); feeCents is the buffered charge.
      shippingFeeCents: shipping, packingFeeCents: packing,
      feeCents: lineCharged, feeMinCents: lineCharged, feeMaxCents: lineCharged, isRange: false,
    });
  }

  const available = items.length > 0 && unavailableSkus.length === 0;
  if (!available) {
    return {
      available: false, currency: expectedCurrency,
      deliveryFeeCents: null, shippingFeeCents: null, packingFeeCents: null,
      feeMinCents: null, feeMaxCents: null, isRange: false,
      lines, unavailableSkus,
      reason: items.length === 0 ? 'no_items' : (firstReason ?? 'no_cached_fee'),
      source: 'giga_portal_price_list_cache',
    };
  }

  const sum = (sel: (l: DeliveryFeeLine) => number | null): number =>
    lines.reduce((s, l) => s + (sel(l) ?? 0), 0);

  return {
    available: true, currency: expectedCurrency,
    deliveryFeeCents: sum((l) => l.feeCents),                        // Σ(charged_fee_cents × qty)
    shippingFeeCents: sum((l) => l.shippingFeeCents),
    packingFeeCents: sum((l) => l.packingFeeCents),
    feeMinCents: sum((l) => l.feeMinCents),
    feeMaxCents: sum((l) => l.feeMaxCents),
    isRange: false,
    lines, unavailableSkus: [], reason: null,
    source: 'giga_portal_price_list_cache',
  };
}

// ── Client-capability version gate (pure; canonical spec for the two edge functions) ─────────
// 🔒 LEGACY ONLY — old shipped app builds expect a numeric Delivery fee and the old behavior.
// This value is NEVER applied to new (clientSupportsDynamicDelivery) clients; they get the
// dynamic GIGA fee or a blocked checkout. See src/__tests__/deliveryGate.test.ts.
export const LEGACY_DELIVERY_FEE_DOLLARS = 99;

/**
 * plan-fulfillment `shipping` (dollars). OLD clients ALWAYS get a numeric, non-null value
 * (legacy compat — never null). NEW clients get the dynamic fee, or null when unavailable.
 */
export function resolvePlanShippingDollars(opts: {
  usePickup: boolean;
  clientSupportsDynamicDelivery: boolean;
  deliveryFeeCents: number | null;
}): number | null {
  if (opts.usePickup) return 0;                                                  // Pickup always free
  if (!opts.clientSupportsDynamicDelivery) return LEGACY_DELIVERY_FEE_DOLLARS;   // legacy old-client only
  return opts.deliveryFeeCents != null ? opts.deliveryFeeCents / 100 : null;     // new: dynamic or null
}

/**
 * create-checkout-order shippingCents. Returns { block } ONLY for NEW clients with no fee.
 * OLD clients are never blocked and always get a numeric fee (legacy compat).
 */
export function resolveCheckoutShippingCents(opts: {
  usePickup: boolean;
  clientSupportsDynamicDelivery: boolean;
  deliveryAvailable: boolean;
  deliveryFeeCents: number | null;
  legacyShippingDollars: number | null;
}): { cents: number } | { block: 'delivery_fee_unavailable' } {
  if (opts.usePickup) return { cents: 0 };                                       // Pickup always free
  if (opts.clientSupportsDynamicDelivery) {
    if (typeof opts.deliveryFeeCents === 'number' && opts.deliveryAvailable) return { cents: opts.deliveryFeeCents };
    return { block: 'delivery_fee_unavailable' };                               // new: fail-closed, no $99
  }
  const dollars = typeof opts.legacyShippingDollars === 'number' ? opts.legacyShippingDollars : LEGACY_DELIVERY_FEE_DOLLARS;
  return { cents: Math.round(dollars * 100) };                                  // legacy old-client only
}
