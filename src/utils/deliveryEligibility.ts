import { WAREHOUSES, PICKUP_RADIUS_MILES, Warehouse } from '../config/delivery';

export type DeliveryMode = 'PICKUP' | 'SHIPPING' | 'UNKNOWN';

export interface DeliveryEligibility {
  mode: DeliveryMode;
  distanceMiles: number | null;
  label: string;
  detail: string;
}

/** Haversine formula — distance between two lat/lng points in miles. */
function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Return the nearest active warehouse to the given coordinates. */
function findNearestWarehouse(buyerLat: number, buyerLng: number): Warehouse {
  return WAREHOUSES
    .filter(w => w.active)
    .reduce((nearest, w) => {
      const d  = haversineDistance(buyerLat, buyerLng, w.lat, w.lng);
      const dn = haversineDistance(buyerLat, buyerLng, nearest.lat, nearest.lng);
      return d < dn ? w : nearest;
    });
}

/** Geocode a US ZIP code to lat/lng via OpenStreetMap Nominatim (free, no API key). */
async function geocodeZip(zip: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(zip)}&countrycodes=us&format=json&limit=1`,
      { headers: { 'User-Agent': 'XselfHomeApp/1.0 (xselfinc@gmail.com)' } },
    );
    const data: any[] = await res.json();
    if (data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch {
    // Network error or unrecognised ZIP — caller treats as UNKNOWN
  }
  return null;
}

/** Check fulfillment eligibility for a US ZIP code. Returns UNKNOWN on any failure. */
export async function checkDeliveryByZip(zip: string): Promise<DeliveryEligibility> {
  const coords = await geocodeZip(zip);
  if (!coords) {
    return {
      mode: 'UNKNOWN',
      distanceMiles: null,
      label: "Couldn't verify fulfillment options",
      detail:
        "We couldn't verify fulfillment options right now. Pickup and shipping are still available.",
    };
  }
  const warehouse = findNearestWarehouse(coords.lat, coords.lng);
  const distanceMiles = haversineDistance(coords.lat, coords.lng, warehouse.lat, warehouse.lng);
  if (distanceMiles <= PICKUP_RADIUS_MILES) {
    return {
      mode: 'PICKUP',
      distanceMiles,
      label: 'Pickup available',
      detail: `Your area is ${Math.round(distanceMiles)} mi from our nearest warehouse. Pickup is available.`,
    };
  }
  return {
    mode: 'SHIPPING',
    distanceMiles,
    label: 'Shipping available',
    detail: `Your area is ${Math.round(distanceMiles)} mi from our nearest warehouse. Shipping is available.`,
  };
}

/** Generic fulfillment policy shown when buyer location is unknown. */
export const GENERIC_DELIVERY_INFO = {
  lines: [
    { icon: 'storefront-outline' as const, text: `Pickup available within ${PICKUP_RADIUS_MILES} miles` },
    { icon: 'cube-outline' as const,       text: 'Shipping available for other areas' },
  ],
};

// ── Session cache ─────────────────────────────────────────────────────────────
// In-memory only. Persists for the lifetime of the app session.
// Replace with AsyncStorage when offline persistence is needed.

let _cachedZip: string | null = null;
let _cachedEligibility: DeliveryEligibility | null = null;

export function saveCachedDelivery(zip: string, eligibility: DeliveryEligibility): void {
  _cachedZip = zip;
  _cachedEligibility = eligibility;
}

export function getCachedDelivery(): { zip: string; eligibility: DeliveryEligibility } | null {
  if (!_cachedZip || !_cachedEligibility) return null;
  return { zip: _cachedZip, eligibility: _cachedEligibility };
}
