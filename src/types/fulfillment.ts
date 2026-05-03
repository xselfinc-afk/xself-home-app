import type { PickupWindow } from '../services/pickupDateService';

export const SHIPPING_FEE = 99;

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
