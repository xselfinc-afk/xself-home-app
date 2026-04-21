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

// Buyers within this radius of the nearest warehouse can use pickup.
// Buyers beyond this radius are offered shipping instead.
export const PICKUP_RADIUS_MILES = 30;
