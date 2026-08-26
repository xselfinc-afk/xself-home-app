import type { PickupWindow } from '../services/pickupDateService';

// ── Fulfillment fees ─────────────────────────────────────────────────────────
// Delivery fee is computed dynamically server-side from GIGA product/price/v1
// (plan-fulfillment → deliveryFeeCents). The old hardcoded $99 placeholder was REMOVED —
// there is intentionally no client-side Delivery fee constant. See docs/delivery-architecture.md.

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
  /** Server-authoritative Delivery fee (cents) from GIGA product/price/v1; null when unavailable. */
  deliveryFeeCents: number | null;
  /** Stripe Tax preview (cents) from plan-fulfillment. DISPLAY ONLY — create-checkout-order
   *  recalculates and charges its own authoritative figure. null = not calculated. */
  taxCents?: number | null;
  /** True when the server returned a usable Delivery fee. When false, Delivery checkout is blocked. */
  deliveryAvailable: boolean;
  /** Server-authoritative: whether Warehouse Pickup is OFFERED for this order (within the
   *  per-state radius + supports_pickup), INDEPENDENT of whether the current plan is currently
   *  using pickup (usePickup). Drives the Pickup selector's visibility, so choosing Delivery
   *  never hides an available Pickup option. Mirrors plan-fulfillment's `pickupAvailable`. */
  pickupAvailable: boolean;
  /** Diagnostic reason when Delivery is unavailable (credentials_missing / api_error / sku_unavailable / no_fee / …). */
  deliveryUnavailableReason?: string | null;
  isSingleWarehouse: boolean;
  /** true if inventory data was unavailable and this is a distance-only fallback */
  isFallback: boolean;
};
