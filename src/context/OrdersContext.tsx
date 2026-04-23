import React, { createContext, useContext, useState } from 'react';

export interface PlacedOrderItem {
  sku: string;
  name: string;
  img: string;
  price: number;
  qty: number;
  color?: string;
  size?: string;
  /** Warehouse code this item was assigned to at checkout */
  warehouseCode?: string;
}

/** Snapshot of the customer's shipping address at time of order */
export interface OrderAddressSnapshot {
  firstName: string;
  lastName: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

/** One fulfillment group — a single warehouse responsible for a subset of items */
export interface OrderFulfillmentGroup {
  warehouseCode: string;
  warehouseLabel: string;
  warehouseAddress: string;
  distanceMiles: number;
  isPickup: boolean;
  shippingFee: number;
  items: { sku: string; name: string; qty: number }[];
  /** Present for pickup groups — ISO YYYY-MM-DD strings */
  pickupWindow?: { earliest: string; latest: string };
}

/** Financial breakdown saved with the order */
export interface OrderFinancials {
  subtotal: number;
  shippingTotal: number;
  tax: number;
  total: number;
}

export interface PlacedOrder {
  orderId: string;
  orderNumber: string;
  date: string;
  total: number;
  status: 'processing' | 'shipped' | 'delivered' | 'pending_pickup' | 'ready_for_pickup' | 'picked_up';
  items: PlacedOrderItem[];
  /** Address snapshot captured at time of checkout */
  address?: OrderAddressSnapshot;
  /** Fulfillment groups with per-warehouse item assignment */
  fulfillmentGroups?: OrderFulfillmentGroup[];
  /** Full financial breakdown */
  financials?: OrderFinancials;
}

interface OrdersCtx {
  orders: PlacedOrder[];
  addOrder: (order: PlacedOrder) => void;
}

const OrdersContext = createContext<OrdersCtx>({ orders: [], addOrder: () => {} });

export function OrdersProvider({ children }: { children: React.ReactNode }) {
  const [orders, setOrders] = useState<PlacedOrder[]>([]);
  const addOrder = (order: PlacedOrder) => setOrders(prev => [order, ...prev]);
  return <OrdersContext.Provider value={{ orders, addOrder }}>{children}</OrdersContext.Provider>;
}

export const useOrders = () => useContext(OrdersContext);
