import React, { createContext, useContext, useReducer, useState } from 'react';

export interface CartItem {
  sku: string;
  productId: string;
  name: string;
  /** Effective unit price. For quoted lines this is the quoted_price (server
   *  re-validates and overrides at checkout — client price is advisory only). */
  price: number;
  img: string;
  qty: number;
  color: string;
  size: string;
  /** Server-stored redeem token when this line is a Special Offer claim.
   *  Forwarded to create-checkout-order so the server can re-validate the
   *  quote, override `unit_price_cents`, and atomically claim the row.  */
  quoteToken?: string;
  /** List price at the time the offer was added — used by the cart UI to
   *  render the strikethrough comparison. Never sent to the server. */
  originalPrice?: number;
}

/** Price/offer refresh payload for one existing cart line (matched by sku).
 *  `quoteToken`/`originalPrice` set to undefined explicitly CLEAR the fields
 *  (used when a previously-attached offer expired or was revoked). */
export interface CartLineUpdate {
  sku: string;
  price: number;
  quoteToken?: string;
  originalPrice?: number;
}

type CartAction =
  | { type: 'ADD_ITEM'; item: Omit<CartItem, 'qty'>; qty: number }
  | { type: 'REMOVE_ITEM'; sku: string }
  | { type: 'UPDATE_QTY'; sku: string; qty: number }
  | { type: 'REFRESH_LINES'; updates: CartLineUpdate[] }
  | { type: 'CLEAR_CART' };

function cartReducer(state: CartItem[], action: CartAction): CartItem[] {
  switch (action.type) {
    case 'ADD_ITEM': {
      // Quoted lines always REPLACE any prior same-sku row — the new quote
      // token, quoted price, and original price are authoritative. Merging
      // qty would keep the old non-quote price and break server-side quote
      // validation (qty > quote.max_qty).
      if (action.item.quoteToken) {
        const filtered = state.filter(i => i.sku !== action.item.sku);
        return [...filtered, { ...action.item, qty: action.qty }];
      }
      const existing = state.find(i => i.sku === action.item.sku);
      if (existing) {
        return state.map(i =>
          i.sku === action.item.sku ? { ...i, qty: i.qty + action.qty } : i
        );
      }
      return [...state, { ...action.item, qty: action.qty }];
    }
    case 'REMOVE_ITEM':
      return state.filter(i => i.sku !== action.sku);
    case 'UPDATE_QTY':
      if (action.qty <= 0) return state.filter(i => i.sku !== action.sku);
      return state.map(i =>
        i.sku === action.sku ? { ...i, qty: action.qty } : i
      );
    case 'REFRESH_LINES': {
      // Server-freshness sync: update price/offer fields on existing lines only.
      // Never adds/removes lines and never touches qty — display + advisory price
      // only (create-checkout-order remains the pricing authority at charge time).
      if (action.updates.length === 0) return state;
      const bySku = new Map(action.updates.map(u => [u.sku, u]));
      return state.map(i => {
        const u = bySku.get(i.sku);
        if (!u) return i;
        return { ...i, price: u.price, quoteToken: u.quoteToken, originalPrice: u.originalPrice };
      });
    }
    case 'CLEAR_CART':
      return [];
    default:
      return state;
  }
}

interface CartContextValue {
  cart: CartItem[];
  totalItems: number;
  /** Increments on every successful add — use to drive badge bounce animation */
  badgeVersion: number;
  /** Timestamp (ms) when the current cart reservation expires — resets to +10min on every add */
  reserveExpiry: number | null;
  addItem: (item: Omit<CartItem, 'qty'>, qty: number) => void;
  removeItem: (sku: string) => void;
  updateQty: (sku: string, qty: number) => void;
  /** Apply price/offer freshness updates to existing lines (see CartLineUpdate). */
  refreshLines: (updates: CartLineUpdate[]) => void;
  clearCart: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [cart, dispatch] = useReducer(cartReducer, []);
  const [badgeVersion, setBadgeVersion] = useState(0);
  const [reserveExpiry, setReserveExpiry] = useState<number | null>(null);

  const addItem = (item: Omit<CartItem, 'qty'>, qty: number) => {
    dispatch({ type: 'ADD_ITEM', item, qty });
    setBadgeVersion(v => v + 1);
    setReserveExpiry(Date.now() + 10 * 60 * 1000);
  };

  const removeItem = (sku: string) =>
    dispatch({ type: 'REMOVE_ITEM', sku });

  const updateQty = (sku: string, qty: number) =>
    dispatch({ type: 'UPDATE_QTY', sku, qty });

  const refreshLines = (updates: CartLineUpdate[]) =>
    dispatch({ type: 'REFRESH_LINES', updates });

  const clearCart = () => dispatch({ type: 'CLEAR_CART' });

  const totalItems = cart.reduce((sum, item) => sum + item.qty, 0);

  return (
    <CartContext.Provider value={{ cart, totalItems, badgeVersion, reserveExpiry, addItem, removeItem, updateQty, refreshLines, clearCart }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be inside CartProvider');
  return ctx;
}
