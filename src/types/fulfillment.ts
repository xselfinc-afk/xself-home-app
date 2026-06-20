import type { PickupWindow } from '../services/pickupDateService';

// ── Fulfillment fees ─────────────────────────────────────────────────────────
// SHIPPING_FEE is the DELIVERY (home-delivery / "shipping") fee. Delivery is being
// redesigned separately and this value may change with that work.
export const SHIPPING_FEE = 99;

// 🔒 LOCKED PICKUP RULE — warehouse pickup is always FREE ($0). Do NOT change while
// redesigning Delivery. The server enforces this independently in
// supabase/functions/create-checkout-order (usePickup ? 0). Guarded by
// scripts/productionGuardrails.ts + src/__tests__/pickupRules.test.ts.
// See docs/fulfillment-rules.md.
export const PICKUP_FEE = 0;

export type Warehouse = {
  code: string;
  label: string;
  address: string;
  state?: string | null;
  city?: string | null;
};

export type FulfillmentGroup = {
  warehouse: Warehouse;
  distanceMiles: number;
  isPickup: boolean;
  shipping: number;
  items: { sku: string; name: string; qty: number; price: number; img: string }[];
  estimatedDelivery: string;
  pickupWindow?: PickupWindow;
};

export type FulfillmentPlan = {
  groups: FulfillmentGroup[];
  totalShipping: number;
  isSingleWarehouse: boolean;
  /** true if inventory data was unavailable and this is a distance-only fallback */
  isFallback: boolean;
};
