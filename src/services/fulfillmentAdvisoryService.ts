/**
 * Client advisory fulfillment eligibility — calls the shared server endpoint
 * `fulfillment-eligibility` for the SELECTED child SKU + buyer ZIP and returns a non-binding
 * {state, canPickup, canShip}. The server is the single authority (dual-radius pickup + the
 * authoritative delivery-fee validator); the client NEVER computes warehouse/distance/radius.
 * Checkout re-validates authoritatively.
 *
 * Cache: 5-minute in-memory, keyed by (childSku + normalized ZIP), so switching color or ZIP is
 * a distinct entry and a stale sibling result is never reused. On any failure the state is
 * 'unknown' (caller shows conservative "Delivery options confirmed at checkout" — never "unavailable").
 */
import { supabase } from '../lib/supabase';

export type FulfillmentState =
  | 'pickup_and_shipping'
  | 'pickup_only'
  | 'shipping_only'
  | 'unavailable'
  | 'unknown';

export interface FulfillmentAdvisory {
  status: 'resolved' | 'unknown' | 'error';
  state: FulfillmentState;
  canPickup: boolean;
  canShip: boolean;
  qualifyingWarehouse?: string | null;
  warehouseState?: string | null;
  distanceMiles?: number | null;
  radiusMiles?: number | null;
  evaluatedAt?: string;
  reason?: string | null;
}

/** Customer-facing copy per resolved state. 'unknown' is the conservative fallback. */
export const FULFILLMENT_COPY: Record<FulfillmentState, string> = {
  pickup_and_shipping: 'Pickup & shipping available',
  pickup_only: 'Pickup available',
  shipping_only: 'Shipping available',
  unavailable: 'Currently unavailable',
  unknown: 'Delivery options confirmed at checkout',
};

const UNKNOWN: FulfillmentAdvisory = { status: 'unknown', state: 'unknown', canPickup: false, canShip: false };
const TTL_MS = 5 * 60 * 1000;
const normalizeZip = (zip?: string | null): string => (zip ?? '').trim().slice(0, 5);

export function advisoryCacheKey(sku: string, zip?: string | null): string {
  return `${sku}|${normalizeZip(zip)}`;
}

const cache = new Map<string, { at: number; value: FulfillmentAdvisory }>();

/** Fetch (cached) advisory eligibility for one child SKU + buyer ZIP. Never throws. */
export async function fetchFulfillmentAdvisory(sku: string, zip?: string | null): Promise<FulfillmentAdvisory> {
  if (!sku) return UNKNOWN;
  const key = advisoryCacheKey(sku, zip);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const z = normalizeZip(zip);
    const { data, error } = await supabase.functions.invoke('fulfillment-eligibility', {
      body: { sku, zip: z || undefined },
    });
    if (error || !data || typeof (data as any).state !== 'string') return UNKNOWN;
    const value = data as FulfillmentAdvisory;
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return UNKNOWN;
  }
}
