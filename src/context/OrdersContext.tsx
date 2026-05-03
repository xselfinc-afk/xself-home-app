import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase, supabaseConfigured } from '../lib/supabase';
import { useAuth } from './AuthContext';

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
  status:
    | 'pending'
    | 'processing'
    | 'shipped'
    | 'delivered'
    | 'pending_pickup'
    | 'ready_for_pickup'
    | 'picked_up'
    | 'failed'
    | 'cancelled';
  items: PlacedOrderItem[];
  /** Address snapshot captured at time of checkout */
  address?: OrderAddressSnapshot;
  /** Fulfillment groups with per-warehouse item assignment */
  fulfillmentGroups?: OrderFulfillmentGroup[];
  /** Full financial breakdown */
  financials?: OrderFinancials;
  /** Stripe payment status — 'paid' after successful PaymentSheet */
  payment_status?: 'paid' | 'pending' | 'failed';
  /** Stripe PaymentIntent ID for support/reconciliation */
  stripe_payment_intent_id?: string;
}

interface OrdersCtx {
  orders: PlacedOrder[];
  /** Legacy: adds a fully-formed order in one step. Kept for backward compatibility. */
  addOrder: (order: PlacedOrder) => Promise<void>;
  /**
   * Phase 1 — create a pending order before payment is confirmed.
   * Idempotent: if an order with the same orderId already exists, this is a no-op.
   * Throws on Supabase failure so the caller can block the Stripe call.
   */
  createPendingOrder: (order: PlacedOrder) => Promise<void>;
  /**
   * Phase 3 — mark an existing pending order as paid after Stripe confirms.
   * Derives final status from fulfillmentGroups (pickup vs. shipping).
   * Throws on Supabase failure so the caller can surface a recovery message.
   */
  confirmOrder: (orderId: string, paymentIntentId: string) => Promise<void>;
  /**
   * Cancel a pending order when payment fails or is abandoned.
   * Sets status to 'cancelled' (does NOT delete) so the record is preserved for auditing.
   */
  cancelOrder: (orderId: string) => Promise<void>;
  /** Re-fetch all orders for the current user from Supabase. No-op for guests or when Supabase is not configured. */
  refreshOrders: () => Promise<void>;
  /** Update an order's status directly — used for fulfillment lifecycle transitions (e.g. shipped, ready_for_pickup). */
  updateOrderStatus: (orderId: string, status: PlacedOrder['status']) => Promise<void>;
}

const OrdersContext = createContext<OrdersCtx>({
  orders: [],
  addOrder: async () => {},
  createPendingOrder: async () => {},
  confirmOrder: async () => {},
  cancelOrder: async () => {},
  refreshOrders: async () => {},
  updateOrderStatus: async () => {},
});

// ── Supabase row → PlacedOrder ────────────────────────────────────────────────
function rowToOrder(row: Record<string, unknown>): PlacedOrder {
  return {
    orderId: row.order_id as string,
    orderNumber: row.order_number as string,
    date: (row.date as string) ?? new Date(row.created_at as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    total: Number(row.total),
    status: row.status as PlacedOrder['status'],
    payment_status: row.payment_status as PlacedOrder['payment_status'],
    stripe_payment_intent_id: (row.stripe_payment_intent_id as string | null) ?? undefined,
    items: (row.items_json as PlacedOrderItem[]) ?? [],
    address: (row.address_json as OrderAddressSnapshot | null) ?? undefined,
    fulfillmentGroups: (row.fulfillment_groups_json as OrderFulfillmentGroup[] | null) ?? undefined,
    financials: row.subtotal != null
      ? {
          subtotal: Number(row.subtotal),
          shippingTotal: Number(row.shipping_total),
          tax: Number(row.tax),
          total: Number(row.total),
        }
      : undefined,
  };
}

// ── PlacedOrder → Supabase upsert payload ─────────────────────────────────────
function orderToRow(order: PlacedOrder, userId: string | null) {
  return {
    order_id: order.orderId,
    order_number: order.orderNumber,
    user_id: userId,
    status: order.status,
    payment_status: order.payment_status ?? 'pending',
    stripe_payment_intent_id: order.stripe_payment_intent_id ?? null,
    total: order.total,
    subtotal: order.financials?.subtotal ?? 0,
    shipping_total: order.financials?.shippingTotal ?? 0,
    tax: order.financials?.tax ?? 0,
    date: order.date,
    address_json: order.address ?? null,
    items_json: order.items,
    fulfillment_groups_json: order.fulfillmentGroups ?? [],
  };
}

export function OrdersProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [orders, setOrders] = useState<PlacedOrder[]>([]);

  // ── Shared fetch — used on mount and by refreshOrders ────────────────────
  const refreshOrders = async (): Promise<void> => {
    if (!user || !supabaseConfigured) return;
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) {
      console.log('[Orders] refreshOrders failed:', error.message);
      return;
    }
    setOrders((data ?? []).map(row => rowToOrder(row as Record<string, unknown>)));
  };

  // ── Load orders on auth change ────────────────────────────────────────────
  useEffect(() => {
    refreshOrders();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // ── Clear local orders on sign-out ────────────────────────────────────────
  useEffect(() => {
    if (!user) setOrders([]);
  }, [user]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  function applyLocalOptimistic(order: PlacedOrder) {
    setOrders(prev => {
      if (prev.some(o => o.orderId === order.orderId)) return prev;
      return [order, ...prev];
    });
  }

  function applyLocalUpdate(orderId: string, patch: Partial<PlacedOrder>) {
    setOrders(prev => prev.map(o => o.orderId === orderId ? { ...o, ...patch } : o));
  }

  // ── Context functions ─────────────────────────────────────────────────────

  const createPendingOrder = async (order: PlacedOrder): Promise<void> => {
    // Optimistic local update first
    applyLocalOptimistic(order);

    // Guest users have no auth session — Supabase RLS rejects null user_id inserts.
    // Keep the order in local state only; guests cannot retrieve past orders from the DB anyway.
    if (!user) {
      console.log('[Orders] Guest order kept locally; skipping Supabase write');
      return;
    }

    if (!supabaseConfigured) return;

    const { error } = await supabase
      .from('orders')
      .upsert(orderToRow(order, user.id), { onConflict: 'order_id', ignoreDuplicates: true });

    if (error) {
      // Roll back the optimistic update
      setOrders(prev => prev.filter(o => o.orderId !== order.orderId));
      console.log('[Orders] createPendingOrder failed:', error.message);
      throw new Error(error.message);
    }
  };

  const confirmOrder = async (orderId: string, paymentIntentId: string): Promise<void> => {
    const existing = orders.find(o => o.orderId === orderId);
    const isPickup = existing?.fulfillmentGroups?.some(g => g.isPickup) ?? false;
    const newStatus = isPickup ? 'pending_pickup' as const : 'processing' as const;

    // Optimistic local update
    applyLocalUpdate(orderId, {
      status: newStatus,
      payment_status: 'paid',
      stripe_payment_intent_id: paymentIntentId,
    });

    // Guest orders have no DB row to update — optimistic local update is the terminal action.
    if (!user) return;

    if (!supabaseConfigured) return;

    const { data, error } = await supabase
      .from('orders')
      .update({
        status: newStatus,
        payment_status: 'paid',
        stripe_payment_intent_id: paymentIntentId,
      })
      .eq('order_id', orderId)
      .select('order_id, status, payment_status, stripe_payment_intent_id');

    if (error || !data || data.length === 0) {
      // Roll back optimistic update — no row was actually written
      if (existing) {
        applyLocalUpdate(orderId, {
          status: existing.status,
          payment_status: existing.payment_status,
          stripe_payment_intent_id: existing.stripe_payment_intent_id,
        });
      }
      const msg = error?.message ?? 'Order confirmation did not update any record';
      console.log('[Orders] confirmOrder failed:', msg);
      throw new Error(msg);
    }
  };

  const cancelOrder = async (orderId: string): Promise<void> => {
    // Optimistic: mark cancelled locally (not removed — preserved for auditing)
    applyLocalUpdate(orderId, { status: 'cancelled', payment_status: 'failed' });

    if (!supabaseConfigured) return;

    const { error } = await supabase
      .from('orders')
      .update({ status: 'cancelled', payment_status: 'failed' })
      .eq('order_id', orderId);

    if (error) {
      console.log('[Orders] cancelOrder failed (non-fatal):', error.message);
      // Not re-throwing — cancel failure is non-fatal; the record stays locally cancelled
    }
  };

  const addOrder = async (order: PlacedOrder): Promise<void> => {
    applyLocalOptimistic(order);

    if (!supabaseConfigured) return;

    const { error } = await supabase
      .from('orders')
      .upsert(orderToRow(order, user?.id ?? null), { onConflict: 'order_id' });

    if (error) {
      console.log('[Orders] addOrder failed:', error.message);
      throw new Error(error.message);
    }
  };

  const updateOrderStatus = async (orderId: string, status: PlacedOrder['status']): Promise<void> => {
    const existing = orders.find(o => o.orderId === orderId);
    applyLocalUpdate(orderId, { status });

    if (!supabaseConfigured) return;

    const { error } = await supabase
      .from('orders')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('order_id', orderId);

    if (error) {
      if (existing) applyLocalUpdate(orderId, { status: existing.status });
      console.log('[Orders] updateOrderStatus failed:', error.message);
      throw new Error(error.message);
    }
  };

  return (
    <OrdersContext.Provider value={{ orders, addOrder, createPendingOrder, confirmOrder, cancelOrder, refreshOrders, updateOrderStatus }}>
      {children}
    </OrdersContext.Provider>
  );
}

export const useOrders = () => useContext(OrdersContext);
