// Single source of truth for warehouse locations and fulfillment rules.
// Add warehouses here as the network grows. The nearest active warehouse
// is selected automatically when checking buyer eligibility.

export interface Warehouse {
  id: string;
  name: string;
  lat: number;
  lng: number;
  city: string;
  state: string;
  active: boolean;
}

export const WAREHOUSES: Warehouse[] = [
  {
    id: 'wh_sf',
    name: 'SF Warehouse',
    lat: 37.7749,
    lng: -122.4194,
    city: 'San Francisco',
    state: 'CA',
    active: true,
  },
];

// 🔒 LOCKED PICKUP RULE — pickup radius is 100 miles. Do NOT change while redesigning
// Delivery. Must stay in sync with PICKUP_THRESHOLD_MILES (100) in
// supabase/functions/plan-fulfillment/index.ts (sync is enforced by
// scripts/productionGuardrails.ts). See docs/fulfillment-rules.md.
//
// Buyers within this radius of the nearest warehouse can use pickup.
// Buyers beyond this radius are offered shipping instead (shipping is never blocked
// by distance). Customer-facing messaging/eligibility radius — kept in sync with the
// authoritative checkout planner's PICKUP_THRESHOLD_MILES (100) in
// supabase/functions/plan-fulfillment/index.ts.
export const PICKUP_RADIUS_MILES = 100;
