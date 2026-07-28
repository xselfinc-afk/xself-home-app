// Advisory fulfillment eligibility for PDP / Cart. Given a selected child SKU + buyer ZIP,
// returns a NON-binding {canPickup, canShip, state} using the SAME shared authority as
// checkout: ../_shared/fulfillmentEligibility.ts (dual-radius pickup) + the existing
// authoritative delivery-fee validator (computeDeliveryFeeFromCache) + the shared geocoder.
// Reads the SAME tables as plan-fulfillment (inventory_cache, warehouses, giga_delivery_fee_cache)
// — NO second warehouse/inventory/distance/geocode pipeline. Checkout re-runs the resolver
// authoritatively; this endpoint never creates orders and exposes no raw inventory/fee internals.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  resolveFulfillmentEligibility,
  pickupRadiusMiles,
  distanceMiles,
  type WarehouseInput,
} from '../_shared/fulfillmentEligibility.ts';
import { computeDeliveryFeeFromCache, type GigaCacheRow } from '../_shared/deliveryFee.ts';
import { geocodeAddress } from '../_shared/geocode.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GOOGLE_MAPS_API_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY') ?? '';

const SKU_PATTERN = /^[A-Za-z0-9_-]{1,60}$/;
const ZIP_PATTERN = /^\d{5}(-\d{4})?$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ status: 'error', reason: 'method_not_allowed' }, 405);

  let body: { sku?: string; productId?: string; zip?: string };
  try { body = await req.json(); } catch { return json({ status: 'error', reason: 'bad_json' }, 400); }

  const sku = String(body.sku ?? body.productId ?? '').trim();
  const zip = String(body.zip ?? '').trim();
  if (!SKU_PATTERN.test(sku)) return json({ status: 'error', reason: 'invalid_sku' }, 400);
  // ZIP is optional — without it, pickup is UNKNOWN (never falsely "unavailable").
  const zipOk = zip === '' || ZIP_PATTERN.test(zip);
  if (!zipOk) return json({ status: 'error', reason: 'invalid_zip' }, 400);

  const evaluatedAt = new Date().toISOString();
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Inventory for THIS exact SKU (per-warehouse), same source gate as plan-fulfillment.
    const { data: invRows, error: invErr } = await supabase
      .from('inventory_cache')
      .select('warehouse_code, quantity')
      .eq('product_id', sku)
      .in('source_type', ['website_scrape', 'official_api'])
      .eq('sync_status', 'ok');
    if (invErr) return json({ status: 'error', reason: 'inventory_unavailable', evaluatedAt }, 200);
    const inventory = (invRows ?? []).map((r) => ({ warehouseCode: r.warehouse_code as string, quantity: Number(r.quantity ?? 0) }));

    // Active warehouses (coords already stored; resolver excludes any null-coord row).
    const { data: whRows, error: whErr } = await supabase
      .from('warehouses')
      .select('code, state, lat, lng, active, supports_pickup')
      .eq('active', true);
    if (whErr || !whRows) return json({ status: 'error', reason: 'warehouse_data_unavailable', evaluatedAt }, 200);
    const warehouses: WarehouseInput[] = whRows.map((w) => ({
      code: w.code as string, state: (w.state as string) ?? null,
      lat: w.lat === null ? null : Number(w.lat), lng: w.lng === null ? null : Number(w.lng),
      active: !!w.active, supportsPickup: !!w.supports_pickup,
    }));

    // Shipping via the EXISTING authoritative validator (never cents>0). 'error' on lookup failure.
    let delivery: { available: boolean } | 'error';
    try {
      const { data: feeRows, error: feeErr } = await supabase
        .from('giga_delivery_fee_cache')
        .select('supplier_product_id, charged_fee_cents, currency')
        .eq('supplier_product_id', sku);
      delivery = feeErr ? 'error' : computeDeliveryFeeFromCache((feeRows ?? []) as GigaCacheRow[], [{ sku, qty: 1 }]);
    } catch { delivery = 'error'; }

    // Buyer location (shared geocoder). Failure → coords null → pickup UNKNOWN (conservative).
    let buyerCoords: { lat: number; lng: number } | null = null;
    if (zip !== '') {
      try { buyerCoords = await geocodeAddress(`${zip}, US`, GOOGLE_MAPS_API_KEY); } catch { buyerCoords = null; }
    }

    const elig = resolveFulfillmentEligibility({ childSku: sku, buyerCoords, inventory, warehouses, delivery });

    // Derive display fields for the nearest QUALIFYING pickup warehouse (shared distanceMiles).
    let qualifyingWarehouse: string | null = null;
    let warehouseState: string | null = null;
    let distance: number | null = null;
    let radius: number | null = null;
    if (elig.canPickup && buyerCoords) {
      let best: { code: string; state: string | null; d: number; r: number } | null = null;
      for (const code of elig.qualifyingPickupWarehouses) {
        const w = warehouses.find((x) => x.code === code);
        if (!w || w.lat == null || w.lng == null) continue;
        const d = distanceMiles(buyerCoords.lat, buyerCoords.lng, w.lat, w.lng);
        if (!best || d < best.d) best = { code, state: w.state, d, r: pickupRadiusMiles(w.state) };
      }
      if (best) { qualifyingWarehouse = best.code; warehouseState = best.state; distance = Math.round(best.d * 10) / 10; radius = best.r; }
    }

    return json({
      status: elig.resolved ? 'resolved' : 'unknown',
      sku,
      canPickup: elig.canPickup,
      canShip: elig.canShip,
      state: elig.display,               // pickup_and_shipping | pickup_only | shipping_only | unavailable | unknown
      qualifyingWarehouse,
      warehouseState,
      distanceMiles: distance,
      radiusMiles: radius,
      evaluatedAt,
      reason: elig.resolved ? null : (buyerCoords === null ? 'buyer_location_unknown' : 'shipping_lookup_error'),
    });
  } catch (e) {
    // Never surface "unavailable" on an internal error — the client shows conservative copy.
    return json({ status: 'error', reason: 'internal_error', message: String((e as Error)?.message ?? e).slice(0, 160), evaluatedAt }, 200);
  }
});
