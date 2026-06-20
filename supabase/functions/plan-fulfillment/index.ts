import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { deliveryProductPrice } from '../_shared/gigaDeliveryClient.ts';
import { computeDeliveryFee, LEGACY_DELIVERY_FEE_DOLLARS, type DeliveryFeeResult, type GigaPriceRow } from '../_shared/deliveryFee.ts';

// Built-in Supabase env vars — always present in Edge Functions
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// Set via: supabase secrets set GOOGLE_MAPS_API_KEY=<your-key>
const GOOGLE_MAPS_API_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY') ?? '';

const STALE_THRESHOLD_HOURS = 24;
// Delivery fee is computed dynamically from GIGA product/price/v1 — never hardcoded.
// SUPPLIER_DELIVERY_PRICE_ENV selects which Delivery-account (Buyer 82482447) credentials
// the read-only price lookup uses ('sandbox' default | 'production'). Pickup stays free ($0).
const DELIVERY_PRICE_ENV: 'sandbox' | 'production' =
  Deno.env.get('SUPPLIER_DELIVERY_PRICE_ENV') === 'production' ? 'production' : 'sandbox';
// Customers within this distance may CHOOSE pickup or delivery; beyond it,
// pickup is hidden and only delivery is offered. Bumped from 30 → 100 to give
// nearby customers the option without forcing pickup on them.
const PICKUP_THRESHOLD_MILES = 100;
const MAX_CART_ITEMS = 20;
const MAX_QTY_PER_ITEM = 99;
const MAX_FIELD_LENGTH = 200;
const SKU_PATTERN = /^[A-Za-z0-9_-]{1,60}$/;
const US_STATE_PATTERN = /^[A-Z]{2}$/;
const ZIP_PATTERN = /^\d{5}(-\d{4})?$/;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface CartItem {
  /** supplier_product_id — canonical key into inventory_cache */
  productId: string;
  /** Display SKU (sku_custom) — used in error messages only */
  sku: string;
  qty: number;
}

interface AddressInput {
  line1: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
}

interface Coords {
  lat: number;
  lng: number;
}

interface WarehouseRow {
  code: string;
  label: string;
  address: string;
  state: string;
  city: string | null;
  lat: number | null;
  lng: number | null;
  supports_pickup: boolean;
  supports_shipping: boolean;
}

type FulfillmentStatus =
  | 'ok'
  | 'no_inventory'
  | 'insufficient_qty'
  | 'stale_inventory'
  | 'no_eligible_warehouse'
  | 'geocode_failed'
  | 'inventory_unavailable'
  | 'warehouse_data_unavailable';

interface PlanResponse {
  valid: boolean;
  fulfillmentStatus: FulfillmentStatus;
  reason?: string;
  selectedWarehouse?: {
    code: string;
    label: string;
    address: string;
    state: string;
    city: string | null;
  };
  distanceMiles?: number;
  pickupEligible?: boolean;
  /** Alias of pickupEligible — whether Warehouse Pickup is offered (≤100 mi + supports_pickup). Independent of Delivery. */
  pickupAvailable?: boolean;
  deliveryEligible?: boolean;
  usePickup?: boolean;
  shipping?: number | null;
  /** Server-authoritative Delivery fee (cents) from GIGA product/price/v1. null = unavailable → client blocks Delivery (no $99 fallback). */
  deliveryFeeCents?: number | null;
  deliveryAvailable?: boolean;
  deliveryFeeBreakdown?: {
    shippingFeeCents: number | null;
    packingFeeCents: number | null;
    feeMinCents: number | null;
    feeMaxCents: number | null;
    isRange: boolean;
    currency: string;
  } | null;
  deliveryQuoteSource?: string;
  deliveryFeeFetchedAt?: string;
  deliveryUnavailableSkus?: string[] | null;
  /** Why Delivery is unavailable (diagnostic): credentials_missing | api_error | sku_not_found | sku_unavailable | no_fee | currency_mismatch | no_items. null when available. */
  deliveryUnavailableReason?: string | null;
  estimatedDelivery?: string;
  pickupWindow?: { earliest: string; latest: string } | null;
  availableQty?: number;
  inventoryFreshness?: 'fresh' | 'stale' | 'unknown';
  inventoryTimestamp?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Haversine distance in miles — mirrors src/utils/distance.ts */
function getDistanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Geocode an address string using Google Maps Geocoding API. */
async function geocodeAddress(address: string): Promise<Coords> {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('GOOGLE_MAPS_API_KEY not configured — run: supabase secrets set GOOGLE_MAPS_API_KEY=<key>');
  }
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 'OK' || !json.results?.length) {
    throw new Error(`Geocoding failed (${json.status}) for: "${address}"`);
  }
  return json.results[0].geometry.location as Coords;
}

/** Estimated delivery / pickup string — mirrors fulfillmentPlanner.ts.
 *  When the order is being fulfilled by pickup, returns the pickup window.
 *  Otherwise, returns a distance-based delivery ETA. We gate on usePickup
 *  (not distance) so a delivery-mode order at 50mi correctly shows
 *  "1–2 business days" rather than a pickup window. */
function estimatedDelivery(distanceMiles: number, usePickup: boolean): string {
  if (usePickup)              return 'Pickup available in 2–5 days, 10:00 AM – 2:00 PM';
  if (distanceMiles <= 100)   return '1–2 business days';
  if (distanceMiles <= 300)   return '2–4 business days';
  return '3–7 business days';
}

/** Add business days (Mon–Fri), skipping weekends. */
function addBusinessDays(date: Date, n: number): Date {
  const result = new Date(date);
  let added = 0;
  while (added < n) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return result;
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function jsonResponse(body: PlanResponse | { valid: boolean; error: string }, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function invalidResponse(fulfillmentStatus: FulfillmentStatus, reason: string): Response {
  return jsonResponse({ valid: false, fulfillmentStatus, reason });
}

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  try {
    // ── Parse + validate input ───────────────────────────────────────────────
    let body: { items?: CartItem[]; address?: AddressInput; preferredMethod?: 'pickup' | 'delivery' | null; clientSupportsDynamicDelivery?: boolean };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ valid: false, error: 'Invalid JSON body' }, 400);
    }

    const { items, address, preferredMethod } = body;
    // 🔒 Client-capability version gate. Only NEW builds send this flag. Old shipped builds
    // (and create-checkout-order's internal call on behalf of an old client) omit it and get
    // the legacy-compatible response. See docs/delivery-architecture.md + deliveryGate.test.ts.
    const clientSupportsDynamicDelivery = body.clientSupportsDynamicDelivery === true;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return jsonResponse({ valid: false, error: 'items array is required' }, 400);
    }
    if (items.length > MAX_CART_ITEMS) {
      return jsonResponse({ valid: false, error: `Cart cannot exceed ${MAX_CART_ITEMS} items` }, 400);
    }
    if (!address) {
      return jsonResponse({ valid: false, error: 'address is required' }, 400);
    }
    if (!address.line1 || !address.city || !address.state || !address.zip) {
      return jsonResponse({ valid: false, error: 'address must include line1, city, state, and zip' }, 400);
    }
    if (address.line1.length > MAX_FIELD_LENGTH || address.city.length > MAX_FIELD_LENGTH) {
      return jsonResponse({ valid: false, error: 'Address fields are too long' }, 400);
    }
    if (!US_STATE_PATTERN.test(address.state)) {
      return jsonResponse({ valid: false, error: 'state must be a 2-letter US state code (e.g. CA)' }, 400);
    }
    if (!ZIP_PATTERN.test(address.zip)) {
      return jsonResponse({ valid: false, error: 'zip must be a valid US ZIP code (e.g. 90210)' }, 400);
    }
    for (const item of items) {
      if (!item.productId || typeof item.qty !== 'number' || item.qty < 1) {
        return jsonResponse({ valid: false, error: 'Each item must have productId and qty >= 1' }, 400);
      }
      if (!SKU_PATTERN.test(item.productId)) {
        return jsonResponse({ valid: false, error: 'Invalid product ID format' }, 400);
      }
      if (item.qty > MAX_QTY_PER_ITEM) {
        return jsonResponse({ valid: false, error: `Quantity cannot exceed ${MAX_QTY_PER_ITEM} per item` }, 400);
      }
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_HOURS * 60 * 60 * 1000).toISOString();
    const productIds = [...new Set(items.map((i) => i.productId))];

    // ── 1. Load scraped inventory from inventory_cache ───────────────────────
    // Previously we required last_synced_at >= now - 24h and failed-closed
    // when that produced no rows. That blocked ALL customers whenever the GIGA
    // sync paused. We now accept ANY per-warehouse rows (regardless of age)
    // and flag freshness in the response. Per-warehouse binding is preserved
    // (CAX1 cannot recur because warehouse assignment is still bound to a real
    // row), and out-of-stock protection still runs via the qty checks below.
    const { data: inventoryRows, error: inventoryErr } = await supabase
      .from('inventory_cache')
      .select('product_id, warehouse_code, quantity, last_synced_at')
      .in('product_id', productIds)
      .in('source_type', ['website_scrape', 'official_api'])
      .eq('sync_status', 'ok');

    if (inventoryErr) {
      console.error('[plan-fulfillment] inventory_cache error:', inventoryErr.message);
      return invalidResponse('inventory_unavailable', 'Could not read inventory data');
    }

    if (!inventoryRows || inventoryRows.length === 0) {
      // Truly no per-warehouse data at all. Refuse the order — we have no
      // basis to bind a reservation to a warehouse.
      return invalidResponse('inventory_unavailable', 'No per-warehouse inventory data available');
    }

    // productId → warehouseCode → { qty, syncedAt }. syncedAt is per-row so we
    // can compute freshness against ONLY the rows tied to the warehouse we end
    // up selecting — using an aggregate "oldest across all rows" overweights
    // far-away warehouses that the scraper barely re-touches and produces
    // false-positive fallback banners.
    const productWarehouseMap = new Map<string, Map<string, { qty: number; syncedAt: string | null }>>();
    for (const row of inventoryRows) {
      const pid = row.product_id as string;
      const wh = row.warehouse_code as string;
      const qty = Math.max(0, Number(row.quantity ?? 0));
      const syncedAt = (row.last_synced_at as string | null) ?? null;
      if (!productWarehouseMap.has(pid)) productWarehouseMap.set(pid, new Map());
      productWarehouseMap.get(pid)!.set(wh, { qty, syncedAt });
    }

    // Each item must have a fresh per-warehouse row AND sufficient aggregate
    // stock somewhere. No standardized_products fallback — see comment above.
    for (const item of items) {
      const whMap = productWarehouseMap.get(item.productId);
      if (!whMap) {
        return invalidResponse('inventory_unavailable', 'One or more items have no fresh inventory data');
      }
      const totalAvailable = Array.from(whMap.values()).reduce((sum, v) => sum + v.qty, 0);
      if (totalAvailable < item.qty) {
        return invalidResponse('insufficient_qty', 'One or more items have insufficient available stock');
      }
    }

    // ── 2. Load warehouses from Supabase warehouses table ───────────────────
    const { data: warehouseRows, error: warehouseErr } = await supabase
      .from('warehouses')
      .select('code, label, address, state, city, lat, lng, supports_pickup, supports_shipping')
      .eq('active', true);

    if (warehouseErr || !warehouseRows?.length) {
      console.error('[plan-fulfillment] warehouses error:', warehouseErr?.message);
      return invalidResponse('warehouse_data_unavailable', 'Could not load warehouse data');
    }

    // ── 3. Geocode customer address (server-side) ─────────────────────────────
    const addrString = [
      address.line1,
      address.city,
      `${address.state} ${address.zip}`,
      address.country ?? 'US',
    ].join(', ');

    let userCoords: Coords;
    try {
      userCoords = await geocodeAddress(addrString);
      console.log('[plan-fulfillment] Customer coords:', userCoords);
    } catch (err) {
      console.error('[plan-fulfillment] Customer geocode failed:', (err as Error).message);
      return invalidResponse('geocode_failed', 'Could not geocode the provided address');
    }

    // ── 4. Geocode warehouses (lazy — writes back to DB for future requests) ──
    // Warehouses with pre-cached lat/lng skip the API call.
    // First-time request geocodes all nulls and caches them (one-time overhead).
    type ResolvedWarehouse = WarehouseRow & { resolvedLat: number; resolvedLng: number };

    const geocodeResults = await Promise.allSettled(
      warehouseRows.map(async (w): Promise<ResolvedWarehouse | null> => {
        if (w.lat !== null && w.lng !== null) {
          return { ...w, resolvedLat: Number(w.lat), resolvedLng: Number(w.lng) };
        }
        try {
          const coords = await geocodeAddress(w.address);
          // Cache back to DB — non-fatal if it fails
          supabase.from('warehouses')
            .update({ lat: coords.lat, lng: coords.lng })
            .eq('code', w.code)
            .then(({ error }) => {
              if (error) console.warn('[plan-fulfillment] Could not cache coords for', w.code, error.message);
            });
          return { ...w, resolvedLat: coords.lat, resolvedLng: coords.lng };
        } catch {
          console.warn('[plan-fulfillment] Could not geocode warehouse', w.code, '— skipping');
          return null;
        }
      }),
    );

    const resolvedWarehouses: ResolvedWarehouse[] = geocodeResults
      .filter((r): r is PromiseFulfilledResult<ResolvedWarehouse | null> => r.status === 'fulfilled' && r.value !== null)
      .map((r) => r.value!);

    if (resolvedWarehouses.length === 0) {
      return invalidResponse('geocode_failed', 'No warehouses could be geocoded');
    }

    // ── 5. Rank warehouses by distance from customer ─────────────────────────
    const ranked = resolvedWarehouses
      .map((w) => ({
        warehouse: w,
        distanceMiles: getDistanceMiles(userCoords.lat, userCoords.lng, w.resolvedLat, w.resolvedLng),
      }))
      .sort((a, b) => a.distanceMiles - b.distanceMiles);

    console.log(
      '[plan-fulfillment] Ranked top 5:',
      ranked.slice(0, 5).map((r) => `${r.warehouse.code}(${r.distanceMiles.toFixed(0)}mi)`).join(', '),
    );

    // ── 6. Helpers for stock + freshness checks ──────────────────────────────
    function warehouseHasAllStock(warehouseCode: string): boolean {
      for (const item of items) {
        const whMap = productWarehouseMap.get(item.productId);
        const qty = whMap?.get(warehouseCode)?.qty ?? 0;
        if (qty < item.qty) return false;
      }
      return true;
    }

    function warehouseHasAllFreshStock(warehouseCode: string): boolean {
      for (const item of items) {
        const row = productWarehouseMap.get(item.productId)?.get(warehouseCode);
        if (!row) return false;
        if (row.qty < item.qty) return false;
        if (!row.syncedAt || row.syncedAt < staleThreshold) return false;
      }
      return true;
    }

    function totalAvailableAtWarehouse(warehouseCode: string): number {
      return items.reduce((sum, item) => {
        const qty = productWarehouseMap.get(item.productId)?.get(warehouseCode)?.qty ?? 0;
        return sum + qty;
      }, 0);
    }

    // ── 7. Attempt single-warehouse fulfillment ──────────────────────────────
    // Pickup candidates (within PICKUP_THRESHOLD_MILES + supports_pickup) first, then shipping.
    const pickupCandidates = ranked.filter(
      (r) => r.distanceMiles <= PICKUP_THRESHOLD_MILES && r.warehouse.supports_pickup,
    );
    const shippingCandidates = ranked.filter(
      (r) => !(r.distanceMiles <= PICKUP_THRESHOLD_MILES && r.warehouse.supports_pickup) && r.warehouse.supports_shipping,
    );
    const orderedCandidates = [...pickupCandidates, ...shippingCandidates];

    let selectedEntry: (typeof ranked)[0] | null = null;
    let selectionPath: 'fresh-single' | 'stale-single' | 'fresh-split' | 'stale-split' | null = null;

    // Pass 1: nearest warehouse with FRESH per-warehouse inventory for every item.
    // We prefer fresh rows over proximity so a stale near-warehouse never blocks
    // a fresh farther-warehouse — fixes the case where checkout shows a stale
    // banner despite a fresh alternative existing.
    for (const candidate of orderedCandidates) {
      if (warehouseHasAllFreshStock(candidate.warehouse.code)) {
        selectedEntry = candidate;
        selectionPath = 'fresh-single';
        console.log(`[plan-fulfillment] Single-warehouse FRESH: ${candidate.warehouse.code} (${candidate.distanceMiles.toFixed(1)}mi)`);
        break;
      }
    }

    // Pass 2: nearest warehouse with any sufficient stock (rows may be stale).
    // Only reached when no fresh warehouse exists; the banner stays on.
    if (!selectedEntry) {
      for (const candidate of orderedCandidates) {
        if (warehouseHasAllStock(candidate.warehouse.code)) {
          selectedEntry = candidate;
          selectionPath = 'stale-single';
          console.log(`[plan-fulfillment] Single-warehouse STALE fallback: ${candidate.warehouse.code} (${candidate.distanceMiles.toFixed(1)}mi)`);
          break;
        }
      }
    }

    // ── 8. Multi-warehouse split if no single warehouse ──────────────────────
    if (!selectedEntry) {
      console.log('[plan-fulfillment] No single warehouse — attempting multi-warehouse split');
      // Pass 3a: prefer split candidate whose row for the first matching item is fresh
      for (const candidate of ranked) {
        if (!candidate.warehouse.supports_shipping && candidate.distanceMiles > PICKUP_THRESHOLD_MILES) continue;
        const freshAny = items.some((item) => {
          const row = productWarehouseMap.get(item.productId)?.get(candidate.warehouse.code);
          return !!row && row.qty >= item.qty && !!row.syncedAt && row.syncedAt >= staleThreshold;
        });
        if (freshAny) {
          selectedEntry = candidate;
          selectionPath = 'fresh-split';
          console.log(`[plan-fulfillment] Split FRESH best-effort: ${candidate.warehouse.code} (${candidate.distanceMiles.toFixed(1)}mi)`);
          break;
        }
      }
    }

    if (!selectedEntry) {
      // Pass 3b: any stock, freshness-blind. Last resort to keep checkout open
      // when the scraper has lapsed entirely.
      for (const candidate of ranked) {
        if (!candidate.warehouse.supports_shipping && candidate.distanceMiles > PICKUP_THRESHOLD_MILES) continue;
        const anyStock = items.some((item) => {
          const qty = productWarehouseMap.get(item.productId)?.get(candidate.warehouse.code)?.qty ?? 0;
          return qty >= item.qty;
        });
        if (anyStock) {
          selectedEntry = candidate;
          selectionPath = 'stale-split';
          console.log(`[plan-fulfillment] Split STALE fallback: ${candidate.warehouse.code} (${candidate.distanceMiles.toFixed(1)}mi)`);
          break;
        }
      }
    }

    if (!selectedEntry) {
      return invalidResponse('no_eligible_warehouse', 'No warehouse has sufficient stock to fulfill this order');
    }

    // Compute freshness against the rows tied to the chosen warehouse for the
    // items in this cart. With prefer-fresh-first selection above, this should
    // only flag 'stale' when no fresh warehouse was available anywhere.
    const selectedWarehouseSyncTimes: string[] = [];
    for (const item of items) {
      const row = productWarehouseMap.get(item.productId)?.get(selectedEntry.warehouse.code);
      if (row?.syncedAt) selectedWarehouseSyncTimes.push(row.syncedAt);
    }
    const oldestSelectedSync = selectedWarehouseSyncTimes.length === 0
      ? null
      : selectedWarehouseSyncTimes.reduce((min, t) => (t < min ? t : min));
    const inventoryFreshness: 'fresh' | 'stale' | 'unknown' =
      oldestSelectedSync === null ? 'unknown' :
      oldestSelectedSync >= staleThreshold ? 'fresh' : 'stale';

    // Per-item diagnostic — surfaces exactly why each item's selected-warehouse
    // row is fresh or stale. Real-device QA logs cross-reference this when the
    // banner appears unexpectedly.
    for (const item of items) {
      const row = productWarehouseMap.get(item.productId)?.get(selectedEntry.warehouse.code);
      const syncedAt = row?.syncedAt ?? null;
      const isFresh = !!syncedAt && syncedAt >= staleThreshold;
      const reason = !row
        ? 'no-row-for-warehouse'
        : row.qty < item.qty
          ? 'insufficient-qty'
          : !syncedAt
            ? 'null-synced-at'
            : isFresh
              ? 'within-24h'
              : 'older-than-24h';
      console.log(
        `[plan-fulfillment] diag product_id=${item.productId} ` +
        `selected_warehouse=${selectedEntry.warehouse.code} ` +
        `selected_row_synced_at=${syncedAt ?? 'null'} ` +
        `qty_at_warehouse=${row?.qty ?? 0} requested_qty=${item.qty} ` +
        `freshness=${isFresh ? 'fresh' : 'stale'} reason=${reason}`,
      );
    }

    const freshnessReason =
      selectionPath === 'fresh-single' ? 'fresh-single-warehouse' :
      selectionPath === 'fresh-split'  ? 'fresh-split-warehouse'  :
      selectionPath === 'stale-single' ? 'no-fresh-warehouse-available' :
      selectionPath === 'stale-split'  ? 'no-fresh-warehouse-available-split' :
      'unknown';

    console.log(
      `[plan-fulfillment] freshness decision: warehouse=${selectedEntry.warehouse.code} ` +
      `oldest_synced_at=${oldestSelectedSync ?? 'unknown'} threshold=${staleThreshold} ` +
      `freshness=${inventoryFreshness} reason=${freshnessReason} selection_path=${selectionPath}`,
    );

    if (inventoryFreshness !== 'fresh') {
      console.warn(
        `[plan-fulfillment] STALE INVENTORY for selected warehouse ${selectedEntry.warehouse.code} ` +
        `(freshness=${inventoryFreshness}, oldestSync=${oldestSelectedSync ?? 'unknown'}, reason=${freshnessReason}) — ` +
        `no fresh alternative existed; serving with isFallback so ops can verify before shipment.`,
      );
    }

    // ── 9. Determine pickup / delivery eligibility ───────────────────────────
    const pickupEligible = selectedEntry.distanceMiles <= PICKUP_THRESHOLD_MILES && selectedEntry.warehouse.supports_pickup;
    const deliveryEligible = selectedEntry.warehouse.supports_shipping;

    // Respect preferredMethod if provided
    let usePickup = pickupEligible; // default: pickup when eligible
    if (preferredMethod === 'delivery') usePickup = false;
    if (preferredMethod === 'pickup') usePickup = pickupEligible; // can't force pickup if ineligible

    const pickupWindow = pickupEligible
      ? {
          earliest: toISODate(addBusinessDays(new Date(), 1)),
          latest: toISODate(addBusinessDays(new Date(), 4)),
        }
      : null;

    // ── Server-authoritative Delivery fee (GIGA product/price/v1) ────────────
    // Read-only price lookup via the Delivery account (SUPPLIER_DELIVERY_*). Never uses
    // Pickup credentials, never calls an order/dropship endpoint. Fail-closed: on ANY
    // error or missing fee the Delivery fee is null and the client blocks Delivery
    // checkout — there is NO $99 fallback. Pickup is unaffected (free).
    // Delivery fee is computed for NEW (dynamic-capable) clients ONLY, and INDEPENDENTLY of
    // Pickup (usePickup never gates it). Old clients skip the GIGA call entirely and receive
    // the legacy numeric shipping with NO dynamic fields.
    let deliveryFee: DeliveryFeeResult | null = null;
    let deliveryErrorReason: string | null = null;
    if (clientSupportsDynamicDelivery) {
      try {
        const priceResp = (await deliveryProductPrice(
          items.map((i) => i.productId),
          DELIVERY_PRICE_ENV,
        )) as { data?: GigaPriceRow[] } | null;
        const rows = Array.isArray(priceResp?.data) ? (priceResp!.data as GigaPriceRow[]) : [];
        deliveryFee = computeDeliveryFee(rows, items.map((i) => ({ sku: i.productId, qty: i.qty })));
      } catch (feeErr) {
        const msg = (feeErr as Error).message ?? '';
        // gigaDeliveryClient throws "[gigaDelivery] missing SUPPLIER_DELIVERY_*" when creds absent.
        deliveryErrorReason = /SUPPLIER_DELIVERY/.test(msg) ? 'credentials_missing' : 'api_error';
        console.error(`[plan-fulfillment] delivery fee lookup failed (fail-closed, reason=${deliveryErrorReason}):`, msg);
        deliveryFee = null;
      }
    }
    const deliveryAvailable = clientSupportsDynamicDelivery && !!deliveryFee?.available;
    const deliveryFeeCents = deliveryAvailable ? deliveryFee!.deliveryFeeCents : null;
    const deliveryUnavailableReason = !clientSupportsDynamicDelivery
      ? null
      : (deliveryAvailable ? null : (deliveryErrorReason ?? deliveryFee?.reason ?? 'api_error'));

    const plan: PlanResponse = {
      valid: true,
      fulfillmentStatus: 'ok',
      selectedWarehouse: {
        code: selectedEntry.warehouse.code,
        label: selectedEntry.warehouse.label,
        address: selectedEntry.warehouse.address,
        state: selectedEntry.warehouse.state,
        city: selectedEntry.warehouse.city,
      },
      distanceMiles: Math.round(selectedEntry.distanceMiles * 10) / 10,
      pickupEligible,
      pickupAvailable: pickupEligible,
      deliveryEligible,
      usePickup,
      // Pickup = free ($0). NEW clients: dynamic GIGA fee (dollars) or null when unavailable.
      // OLD clients: legacy numeric fee (never null) so old builds don't break. (Pickup-lock
      // guard requires the `usePickup ? 0 :` ternary to remain.)
      shipping: usePickup
        ? 0
        : (clientSupportsDynamicDelivery
            ? (deliveryFeeCents != null ? deliveryFeeCents / 100 : null)
            : LEGACY_DELIVERY_FEE_DOLLARS),
      // Dynamic Delivery fields go to NEW clients ONLY; `undefined` is omitted from JSON, so the
      // legacy response shape is preserved exactly for old clients.
      deliveryFeeCents: clientSupportsDynamicDelivery ? deliveryFeeCents : undefined,
      deliveryAvailable: clientSupportsDynamicDelivery ? deliveryAvailable : undefined,
      deliveryFeeBreakdown: clientSupportsDynamicDelivery
        ? (deliveryAvailable && deliveryFee
            ? {
                shippingFeeCents: deliveryFee.shippingFeeCents,
                packingFeeCents: deliveryFee.packingFeeCents,
                feeMinCents: deliveryFee.feeMinCents,
                feeMaxCents: deliveryFee.feeMaxCents,
                isRange: deliveryFee.isRange,
                currency: deliveryFee.currency,
              }
            : null)
        : undefined,
      deliveryQuoteSource: clientSupportsDynamicDelivery ? 'giga_openapi_price_v1' : undefined,
      deliveryFeeFetchedAt: clientSupportsDynamicDelivery ? new Date().toISOString() : undefined,
      deliveryUnavailableSkus: clientSupportsDynamicDelivery ? (deliveryFee?.unavailableSkus ?? null) : undefined,
      deliveryUnavailableReason: clientSupportsDynamicDelivery ? deliveryUnavailableReason : undefined,
      estimatedDelivery: estimatedDelivery(selectedEntry.distanceMiles, usePickup),
      pickupWindow,
      availableQty: totalAvailableAtWarehouse(selectedEntry.warehouse.code),
      inventoryFreshness,
      inventoryTimestamp: oldestSelectedSync ?? new Date().toISOString(),
    };

    console.log(
      `[plan-fulfillment] Plan: ${plan.selectedWarehouse!.code} ${plan.distanceMiles}mi` +
        ` dynamicClient=${clientSupportsDynamicDelivery} pickupAvailable=${plan.pickupEligible}` +
        ` deliveryAvailable=${deliveryAvailable} deliveryFeeCents=${deliveryFeeCents}` +
        ` reason=${deliveryUnavailableReason ?? 'none'} shipping=${plan.shipping} env=${DELIVERY_PRICE_ENV}`,
    );

    return jsonResponse(plan);
  } catch (err) {
    console.error('[plan-fulfillment] Unexpected error:', err);
    return jsonResponse({ valid: false, error: 'Internal server error' }, 500);
  }
});
