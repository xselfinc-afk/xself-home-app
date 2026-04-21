import { geocodeAddress, Coords } from './geocodingService';
import { warehouses, Warehouse } from '../data/warehouses';
import { getDistanceMiles } from '../utils/distance';

export type NearestWarehouseResult = {
  warehouse: Warehouse;
  distanceMiles: number;
};

// Module-level coordinate cache — populated lazily, valid for the app session.
const coordCache = new Map<string, Coords>();

async function getCachedCoords(key: string, address: string): Promise<Coords | null> {
  if (coordCache.has(key)) return coordCache.get(key)!;
  try {
    const coords = await geocodeAddress(address);
    coordCache.set(key, coords);
    return coords;
  } catch (err) {
    console.log(`[Warehouse] Failed to geocode ${key}:`, (err as Error).message);
    return null;
  }
}

/**
 * Geocode the user's address and all warehouses (cached after first call),
 * then return the nearest warehouse and distance in miles.
 */
export async function findNearestWarehouse(
  userAddressString: string,
): Promise<NearestWarehouseResult> {
  console.log('[Warehouse] Resolving nearest warehouse for:', userAddressString);

  const userCoords = await geocodeAddress(userAddressString);
  console.log('[Warehouse] User coordinates:', userCoords);

  // Geocode all warehouses in parallel (results are cached after the first call)
  const candidates = await Promise.all(
    warehouses.map(async w => {
      const coords = await getCachedCoords(w.code, w.address);
      if (!coords) return null;
      const distanceMiles = getDistanceMiles(
        userCoords.lat,
        userCoords.lng,
        coords.lat,
        coords.lng,
      );
      return { warehouse: w, distanceMiles };
    }),
  );

  const valid = candidates.filter(
    (r): r is NearestWarehouseResult => r !== null,
  );

  if (valid.length === 0) {
    throw new Error('[Warehouse] Could not geocode any warehouse addresses');
  }

  const nearest = valid.reduce((a, b) =>
    a.distanceMiles < b.distanceMiles ? a : b,
  );

  console.log(
    `[Warehouse] Nearest: ${nearest.warehouse.code} — ${nearest.distanceMiles.toFixed(1)} mi`,
  );
  return nearest;
}
