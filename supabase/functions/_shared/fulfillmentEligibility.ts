// Shared, PURE fulfillment-eligibility resolver (Phase 0 — NOT yet wired to any call site).
//
// Computes {canPickup, canShip} for the CURRENTLY SELECTED child SKU against a buyer
// location, using the approved dual-radius pickup rule (CA 100 mi / non-CA 50 mi). It has
// NO I/O, NO Deno/Node globals, NO network, NO Supabase — just math over explicit inputs —
// so it can be reused by plan-fulfillment (authoritative, at checkout) and by a thin advisory
// endpoint (PDP/Cart) later WITHOUT duplicating warehouse/distance logic in the client.
//
// canShip is NOT re-implemented here. The caller passes the result of the existing
// authoritative delivery-fee validator (computeDeliveryFee / computeDeliveryFeeFromCache in
// ./deliveryFee.ts); this resolver only reads its `available` flag. A valid $0 fee therefore
// counts as shippable (validator returns available=true), while missing rows / no_cached_fee /
// currency mismatch / parse errors that leave charged_fee_cents null do NOT (available=false).
//
// The resolver distinguishes RESOLVED from UNKNOWN: pickup is UNKNOWN when the buyer location
// is unknown (geocode failure), shipping is UNKNOWN when the fee lookup errored. Only a fully
// RESOLVED canPickup=false & canShip=false yields 'unavailable' ("Currently unavailable"); any
// unknown dimension yields 'unknown' (caller shows conservative "confirmed at checkout" copy).

/** Miles radius within which a warehouse of the given state offers customer pickup. */
export const PICKUP_RADIUS_MILES_BY_STATE: Readonly<Record<string, number>> = { CA: 100 };
export const DEFAULT_PICKUP_RADIUS_MILES = 50;

/** CA warehouses: 100 mi. Every other (out-of-state) warehouse: 50 mi. */
export function pickupRadiusMiles(state: string | null | undefined): number {
  const s = (state ?? '').trim().toUpperCase();
  return PICKUP_RADIUS_MILES_BY_STATE[s] ?? DEFAULT_PICKUP_RADIUS_MILES;
}

/** Haversine great-circle distance in miles. Mirrors getDistanceMiles (plan-fulfillment) and
 *  haversineDistance (deliveryEligibility) — identical R = 3958.8. Phase 1 consolidates those
 *  onto this shared copy (same formula, no behavior change). */
export function distanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface Coords { lat: number; lng: number; }

export interface WarehouseInput {
  code: string;
  state: string | null;
  lat: number | null;
  lng: number | null;
  active: boolean;
  supportsPickup: boolean;
}

/** Inventory rows already scoped to the SELECTED child SKU (one per warehouse it stocks). */
export interface InventoryInput { warehouseCode: string; quantity: number; }

/** Minimal structural shape of the authoritative delivery-fee result (see ./deliveryFee.ts
 *  DeliveryFeeResult). Only `available` is read. Pass 'error' when the fee lookup itself failed
 *  (network/DB) as distinct from a resolved-unavailable fee. */
export type DeliveryAvailability = { available: boolean } | 'error';

export type FulfillmentDisplay =
  | 'pickup_and_shipping'
  | 'pickup_only'
  | 'shipping_only'
  | 'unavailable'
  | 'unknown';

/** Copy shown for each state. 'unknown' is the conservative fallback (never asserts a definite
 *  state) used on geocode/network/endpoint failure. */
export const FULFILLMENT_COPY: Readonly<Record<FulfillmentDisplay, string>> = {
  pickup_and_shipping: 'Pickup & shipping available',
  pickup_only: 'Pickup available',
  shipping_only: 'Shipping available',
  unavailable: 'Currently unavailable',
  unknown: 'Delivery options confirmed at checkout',
};

export interface FulfillmentEligibility {
  canPickup: boolean;
  canShip: boolean;
  /** false when buyer location is unknown → pickup could not be evaluated. */
  pickupResolved: boolean;
  /** false when the fee lookup errored → shipping could not be evaluated. */
  shipResolved: boolean;
  /** true only when BOTH dimensions were resolved; false ⇒ display 'unknown'. */
  resolved: boolean;
  display: FulfillmentDisplay;
  /** Warehouse codes that made pickup eligible (audit/debug). */
  qualifyingPickupWarehouses: string[];
}

export interface ResolveInput {
  childSku: string;
  /** null ⇒ buyer ZIP unknown / geocode failed ⇒ pickup UNKNOWN (never assumed false). */
  buyerCoords: Coords | null;
  /** Inventory rows for THIS child SKU only. */
  inventory: InventoryInput[];
  warehouses: WarehouseInput[];
  /** Authoritative delivery-fee result for THIS child SKU, or 'error' if the lookup failed. */
  delivery: DeliveryAvailability;
}

/**
 * Resolve pickup/shipping for one selected child SKU. Pickup order (exactly as approved):
 *   inventory rows for this SKU → quantity > 0 → active warehouse → supports_pickup=true →
 *   valid coordinates → distance → CA 100 / non-CA 50 → canPickup if ANY warehouse qualifies.
 * Never selects a globally-nearest warehouse before filtering by this SKU's inventory.
 */
export function resolveFulfillmentEligibility(input: ResolveInput): FulfillmentEligibility {
  // ── Pickup ──────────────────────────────────────────────────────────────
  const pickupResolved = input.buyerCoords !== null;
  const qualifyingPickupWarehouses: string[] = [];
  let canPickup = false;

  if (pickupResolved) {
    const buyer = input.buyerCoords as Coords;
    // Stock for THIS SKU, summed per warehouse code (filter to qty > 0 comes below).
    const stockByWarehouse = new Map<string, number>();
    for (const row of input.inventory) {
      if (!row || typeof row.warehouseCode !== 'string') continue;
      stockByWarehouse.set(row.warehouseCode, (stockByWarehouse.get(row.warehouseCode) ?? 0) + (Number(row.quantity) || 0));
    }
    for (const w of input.warehouses) {
      if (!w.active) continue;                       // active warehouse
      if (!w.supportsPickup) continue;               // supports_pickup = true
      if (w.lat == null || w.lng == null) continue;  // valid coordinates
      if ((stockByWarehouse.get(w.code) ?? 0) <= 0) continue; // this SKU stocked here, qty > 0
      const d = distanceMiles(buyer.lat, buyer.lng, Number(w.lat), Number(w.lng));
      if (d <= pickupRadiusMiles(w.state)) {         // CA 100 / non-CA 50
        canPickup = true;
        qualifyingPickupWarehouses.push(w.code);
      }
    }
  }

  // ── Shipping (authoritative validator result, reused verbatim) ───────────
  const shipResolved = input.delivery !== 'error';
  const canShip = shipResolved && (input.delivery as { available: boolean }).available === true;

  // ── State ────────────────────────────────────────────────────────────────
  const resolved = pickupResolved && shipResolved;
  let display: FulfillmentDisplay;
  if (!resolved) display = 'unknown';                // any unknown dimension → conservative fallback
  else if (canPickup && canShip) display = 'pickup_and_shipping';
  else if (canPickup) display = 'pickup_only';
  else if (canShip) display = 'shipping_only';
  else display = 'unavailable';                      // ONLY resolved neither-available shows unavailable

  return { canPickup, canShip, pickupResolved, shipResolved, resolved, display, qualifyingPickupWarehouses };
}
