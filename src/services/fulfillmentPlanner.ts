import { geocodeAddress, Coords } from './geocodingService';
import { warehouses, Warehouse } from '../data/warehouses';
import { getDistanceMiles } from '../utils/distance';
import type { SkuInventory } from './gigaInventoryService';
import { getPickupWindow, PickupWindow } from './pickupDateService';

export const SHIPPING_FEE = 99;
export const PICKUP_THRESHOLD_MILES = 30;

/** Mirrors the Edge Function supportsPickup() — only CA-prefixed warehouses support pickup. */
function warehouseSupportsPickup(code: string): boolean {
  return /^CA/i.test(code);
}

export type FulfillmentGroup = {
  warehouse: Warehouse;
  distanceMiles: number;
  isPickup: boolean;   // true if distanceMiles <= 30
  shipping: number;    // 0 for pickup, SHIPPING_FEE for ship
  items: { sku: string; name: string; qty: number; price: number; img: string }[];
  estimatedDelivery: string;
  /** Calculated pickup window — only present when isPickup=true */
  pickupWindow?: PickupWindow;
};

export type FulfillmentPlan = {
  groups: FulfillmentGroup[];
  totalShipping: number;
  isSingleWarehouse: boolean;
  /** true if inventory data was unavailable and this is a distance-only fallback */
  isFallback: boolean;
};

// Module-level warehouse coord cache
const warehouseCoordCache = new Map<string, Coords>();

async function getWarehouseCoords(w: Warehouse): Promise<Coords | null> {
  if (warehouseCoordCache.has(w.code)) return warehouseCoordCache.get(w.code)!;
  try {
    const coords = await geocodeAddress(w.address);
    warehouseCoordCache.set(w.code, coords);
    return coords;
  } catch {
    return null;
  }
}

function estimatedDelivery(distanceMiles: number): string {
  if (distanceMiles <= 30) return 'Pickup available in 2–5 days, between 10:00 AM – 2:00 PM';
  if (distanceMiles <= 100) return '1–2 business days';
  if (distanceMiles <= 300) return '2–4 business days';
  return '3–7 business days';
}

type CartLike = { sku: string; productId: string; name: string; price: number; img: string; qty: number };

/**
 * Build a ranked list of (warehouse, distanceMiles) for all geocodeable warehouses.
 */
async function rankWarehousesByDistance(
  userCoords: Coords,
): Promise<{ warehouse: Warehouse; distanceMiles: number }[]> {
  const results = await Promise.all(
    warehouses.map(async w => {
      const coords = await getWarehouseCoords(w);
      if (!coords) return null;
      const distanceMiles = getDistanceMiles(userCoords.lat, userCoords.lng, coords.lat, coords.lng);
      return { warehouse: w, distanceMiles };
    }),
  );
  return results
    .filter((r): r is { warehouse: Warehouse; distanceMiles: number } => r !== null)
    .sort((a, b) => a.distanceMiles - b.distanceMiles);
}

/**
 * Primary fulfillment planner — uses real GIGA warehouse inventory.
 *
 * Strategy:
 *   1. Single-warehouse: find the nearest warehouse that has all SKUs in stock.
 *      Prefer pickup (<= 30 mi) over shipping.
 *   2. Multi-warehouse split: assign each item to the nearest warehouse that
 *      has stock for that SKU.
 */
export async function planFulfillment(
  cart: CartLike[],
  userAddressString: string,
  inventory: SkuInventory[],
): Promise<FulfillmentPlan> {
  console.log('[Fulfillment] Planning for', cart.length, 'item(s)');
  console.log('[Fulfillment] Inventory entries received:', inventory.length);

  const userCoords = await geocodeAddress(userAddressString);
  console.log('[Fulfillment] User coords:', userCoords);

  const ranked = await rankWarehousesByDistance(userCoords);
  console.log('[Fulfillment] Ranked warehouses (top 5):', ranked.slice(0, 5).map(r => `${r.warehouse.code}(${r.distanceMiles.toFixed(0)}mi)`).join(', '));

  // Build lookup: sku → warehouseCode → qty
  const stockMap = new Map<string, Map<string, number>>();
  for (const inv of inventory) {
    const byWarehouse = new Map<string, number>();
    for (const ws of inv.warehouseStock) {
      byWarehouse.set(ws.warehouseCode, ws.availableQty);
    }
    stockMap.set(inv.sku, byWarehouse);
  }

  // Helper: does warehouse have enough stock for all items?
  function warehouseHasAllStock(warehouseCode: string): boolean {
    for (const item of cart) {
      const skuMap = stockMap.get(item.sku) ?? stockMap.get(item.productId);
      if (!skuMap) {
        // No inventory data for this SKU — treat as unavailable (strict, per project rules)
        console.log(`[Fulfillment] No inventory data for SKU ${item.sku} (productId: ${item.productId}) — treating as out of stock`);
        return false;
      }
      const qty = skuMap.get(warehouseCode) ?? 0;
      if (qty < item.qty) return false;
    }
    return true;
  }

  // ── Attempt 1: single warehouse (nearest that stocks everything) ──────────
  // Prefer pickup warehouses first, then any warehouse
  const pickupCandidates = ranked.filter(r => r.distanceMiles <= PICKUP_THRESHOLD_MILES && warehouseSupportsPickup(r.warehouse.code));
  const shippingCandidates = ranked.filter(r => !(r.distanceMiles <= PICKUP_THRESHOLD_MILES && warehouseSupportsPickup(r.warehouse.code)));

  const orderedCandidates = [...pickupCandidates, ...shippingCandidates];

  for (const candidate of orderedCandidates) {
    if (warehouseHasAllStock(candidate.warehouse.code)) {
      const isPickup = candidate.distanceMiles <= PICKUP_THRESHOLD_MILES && warehouseSupportsPickup(candidate.warehouse.code);
      console.log(
        `[Fulfillment] Single-warehouse: ${candidate.warehouse.code} (${candidate.distanceMiles.toFixed(1)} mi) — ${isPickup ? 'PICKUP' : 'SHIPPING'}`,
      );
      return {
        groups: [
          {
            warehouse: candidate.warehouse,
            distanceMiles: candidate.distanceMiles,
            isPickup,
            shipping: isPickup ? 0 : SHIPPING_FEE,
            items: cart.map(item => ({
              sku: item.sku,
              name: item.name,
              qty: item.qty,
              price: item.price,
              img: item.img,
            })),
            estimatedDelivery: estimatedDelivery(candidate.distanceMiles),
            pickupWindow: isPickup ? getPickupWindow() : undefined,
          },
        ],
        totalShipping: isPickup ? 0 : SHIPPING_FEE,
        isSingleWarehouse: true,
        isFallback: false,
      };
    }
  }

  // ── Attempt 2: multi-warehouse split ─────────────────────────────────────
  console.log('[Fulfillment] No single warehouse for all items — attempting split fulfillment');

  // Assign each item to nearest warehouse with stock
  const groupMap = new Map<string, { warehouseEntry: { warehouse: Warehouse; distanceMiles: number }; items: CartLike[] }>();

  for (const item of cart) {
    const skuMap = stockMap.get(item.sku) ?? stockMap.get(item.productId);

    let assigned = false;
    if (skuMap) {
      for (const candidate of ranked) {
        const qty = skuMap.get(candidate.warehouse.code) ?? 0;
        if (qty >= item.qty) {
          const key = candidate.warehouse.code;
          if (!groupMap.has(key)) {
            groupMap.set(key, { warehouseEntry: candidate, items: [] });
          }
          groupMap.get(key)!.items.push(item);
          assigned = true;
          console.log(`[Fulfillment] Split: ${item.sku} → ${candidate.warehouse.code} (${candidate.distanceMiles.toFixed(1)} mi)`);
          break;
        }
      }
    }

    if (!assigned) {
      // No stock found anywhere — assign to nearest warehouse (optimistic)
      const nearest = ranked[0];
      if (nearest) {
        const key = nearest.warehouse.code;
        if (!groupMap.has(key)) {
          groupMap.set(key, { warehouseEntry: nearest, items: [] });
        }
        groupMap.get(key)!.items.push(item);
        console.log(`[Fulfillment] Split fallback (no stock data): ${item.sku} → ${nearest.warehouse.code}`);
      }
    }
  }

  const groups: FulfillmentGroup[] = Array.from(groupMap.values())
    .sort((a, b) => a.warehouseEntry.distanceMiles - b.warehouseEntry.distanceMiles)
    .map(({ warehouseEntry, items }) => {
    const isPickup = warehouseEntry.distanceMiles <= PICKUP_THRESHOLD_MILES && warehouseSupportsPickup(warehouseEntry.warehouse.code);
    return {
      warehouse: warehouseEntry.warehouse,
      distanceMiles: warehouseEntry.distanceMiles,
      isPickup,
      shipping: isPickup ? 0 : SHIPPING_FEE,
      items: items.map(item => ({
        sku: item.sku,
        name: item.name,
        qty: item.qty,
        price: item.price,
        img: item.img,
      })),
      estimatedDelivery: estimatedDelivery(warehouseEntry.distanceMiles),
      pickupWindow: isPickup ? getPickupWindow() : undefined,
    };
  });

  const totalShipping = groups.reduce((sum, g) => sum + g.shipping, 0);
  console.log(`[Fulfillment] Split plan: ${groups.length} group(s), totalShipping=$${totalShipping}`);

  return {
    groups,
    totalShipping,
    isSingleWarehouse: groups.length === 1,
    isFallback: false,
  };
}

/**
 * Fallback fulfillment plan when inventory data is unavailable.
 * Uses nearest warehouse by geography alone (same logic as old warehouseService).
 */
export async function planFulfillmentFallback(
  cart: CartLike[],
  userAddressString: string,
): Promise<FulfillmentPlan> {
  console.log('[Fulfillment] Using fallback (geography-only) plan');
  const userCoords = await geocodeAddress(userAddressString);
  const ranked = await rankWarehousesByDistance(userCoords);

  if (ranked.length === 0) {
    throw new Error('[Fulfillment] Could not geocode any warehouse addresses');
  }

  const nearest = ranked[0];
  const isPickup = nearest.distanceMiles <= PICKUP_THRESHOLD_MILES && warehouseSupportsPickup(nearest.warehouse.code);
  console.log(`[Fulfillment] Fallback nearest: ${nearest.warehouse.code} ${nearest.distanceMiles.toFixed(1)} mi — ${isPickup ? 'PICKUP' : 'SHIPPING'}`);

  return {
    groups: [
      {
        warehouse: nearest.warehouse,
        distanceMiles: nearest.distanceMiles,
        isPickup,
        shipping: isPickup ? 0 : SHIPPING_FEE,
        items: cart.map(item => ({
          sku: item.sku,
          name: item.name,
          qty: item.qty,
          price: item.price,
          img: item.img,
        })),
        estimatedDelivery: estimatedDelivery(nearest.distanceMiles),
        pickupWindow: isPickup ? getPickupWindow() : undefined,
      },
    ],
    totalShipping: isPickup ? 0 : SHIPPING_FEE,
    isSingleWarehouse: true,
    isFallback: true,
  };
}
