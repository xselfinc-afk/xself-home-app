import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Built-in Supabase env vars — always present in Edge Functions
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// Set via: supabase secrets set GOOGLE_MAPS_API_KEY=<your-key>
const GOOGLE_MAPS_API_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY') ?? '';

const STALE_THRESHOLD_HOURS = 24;
const SHIPPING_FEE = 99;
const PICKUP_THRESHOLD_MILES = 30;
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
  deliveryEligible?: boolean;
  usePickup?: boolean;
  shipping?: number;
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

/** Estimated delivery string — mirrors fulfillmentPlanner.ts */
function estimatedDelivery(distanceMiles: number): string {
  if (distanceMiles <= 30) return 'Pickup available in 2–5 days, 10:00 AM – 2:00 PM';
  if (distanceMiles <= 100) return '1–2 business days';
  if (distanceMiles <= 300) return '2–4 business days';
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
    let body: { items?: CartItem[]; address?: AddressInput; preferredMethod?: 'pickup' | 'delivery' | null };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ valid: false, error: 'Invalid JSON body' }, 400);
    }

    const { items, address, preferredMethod } = body;

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

    // ── 1. Load fresh scraped inventory from inventory_cache ─────────────────
    const { data: inventoryRows, error: inventoryErr } = await supabase
      .from('inventory_cache')
      .select('product_id, warehouse_code, quantity, last_synced_at')
      .in('product_id', productIds)
      .eq('source_type', 'website_scrape')
      .eq('sync_status', 'ok')
      .gte('last_synced_at', staleThreshold);

    if (inventoryErr) {
      console.error('[plan-fulfillment] inventory_cache error:', inventoryErr.message);
      return invalidResponse('inventory_unavailable', 'Could not read inventory data');
    }

    if (!inventoryRows || inventoryRows.length === 0) {
      return invalidResponse('no_inventory', 'No fresh scraped inventory for these products');
    }

    // productId → warehouseCode → qty
    const productWarehouseMap = new Map<string, Map<string, number>>();
    for (const row of inventoryRows) {
      const pid = row.product_id as string;
      const wh = row.warehouse_code as string;
      const qty = Math.max(0, Number(row.quantity ?? 0));
      if (!productWarehouseMap.has(pid)) productWarehouseMap.set(pid, new Map());
      productWarehouseMap.get(pid)!.set(wh, qty);
    }

    // Validate each item has sufficient total inventory somewhere
    for (const item of items) {
      const whMap = productWarehouseMap.get(item.productId);
      if (!whMap) {
        return invalidResponse('no_inventory', 'One or more items are not currently available');
      }
      const totalAvailable = Array.from(whMap.values()).reduce((sum, q) => sum + q, 0);
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

    // ── 6. Helpers for stock checks ──────────────────────────────────────────
    function warehouseHasAllStock(warehouseCode: string): boolean {
      for (const item of items) {
        const whMap = productWarehouseMap.get(item.productId);
        const qty = whMap?.get(warehouseCode) ?? 0;
        if (qty < item.qty) return false;
      }
      return true;
    }

    function totalAvailableAtWarehouse(warehouseCode: string): number {
      return items.reduce((sum, item) => {
        const qty = productWarehouseMap.get(item.productId)?.get(warehouseCode) ?? 0;
        return sum + qty;
      }, 0);
    }

    // ── 7. Attempt single-warehouse fulfillment ──────────────────────────────
    // Pickup candidates (within 30mi + supports_pickup) first, then shipping.
    const pickupCandidates = ranked.filter(
      (r) => r.distanceMiles <= PICKUP_THRESHOLD_MILES && r.warehouse.supports_pickup,
    );
    const shippingCandidates = ranked.filter(
      (r) => !(r.distanceMiles <= PICKUP_THRESHOLD_MILES && r.warehouse.supports_pickup) && r.warehouse.supports_shipping,
    );

    let selectedEntry: (typeof ranked)[0] | null = null;
    for (const candidate of [...pickupCandidates, ...shippingCandidates]) {
      if (warehouseHasAllStock(candidate.warehouse.code)) {
        selectedEntry = candidate;
        console.log(`[plan-fulfillment] Single-warehouse: ${candidate.warehouse.code} (${candidate.distanceMiles.toFixed(1)}mi)`);
        break;
      }
    }

    // ── 8. Multi-warehouse split if no single warehouse ──────────────────────
    if (!selectedEntry) {
      console.log('[plan-fulfillment] No single warehouse — attempting multi-warehouse split');
      // For now: use nearest warehouse that has stock for at least one item.
      // Full multi-warehouse response format TBD in Phase 3.1.
      for (const candidate of ranked) {
        if (!candidate.warehouse.supports_shipping && candidate.distanceMiles > PICKUP_THRESHOLD_MILES) continue;
        const anyStock = items.some((item) => {
          const qty = productWarehouseMap.get(item.productId)?.get(candidate.warehouse.code) ?? 0;
          return qty >= item.qty;
        });
        if (anyStock) {
          selectedEntry = candidate;
          console.log(`[plan-fulfillment] Split best-effort: ${candidate.warehouse.code} (${candidate.distanceMiles.toFixed(1)}mi)`);
          break;
        }
      }
    }

    if (!selectedEntry) {
      return invalidResponse('no_eligible_warehouse', 'No warehouse has sufficient stock to fulfill this order');
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
      deliveryEligible,
      usePickup,
      shipping: usePickup ? 0 : SHIPPING_FEE,
      estimatedDelivery: estimatedDelivery(selectedEntry.distanceMiles),
      pickupWindow,
      availableQty: totalAvailableAtWarehouse(selectedEntry.warehouse.code),
      inventoryFreshness: 'fresh',
      inventoryTimestamp: new Date().toISOString(),
    };

    console.log(
      `[plan-fulfillment] Plan: ${plan.selectedWarehouse!.code} ${plan.distanceMiles}mi` +
        ` pickup=${plan.pickupEligible} delivery=${plan.deliveryEligible} shipping=$${plan.shipping}`,
    );

    return jsonResponse(plan);
  } catch (err) {
    console.error('[plan-fulfillment] Unexpected error:', err);
    return jsonResponse({ valid: false, error: 'Internal server error' }, 500);
  }
});
