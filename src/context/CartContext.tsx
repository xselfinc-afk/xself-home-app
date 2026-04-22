import React, { createContext, useContext, useReducer, useState } from 'react';

export interface CartItem {
  sku: string;
  productId: string;
  name: string;
  price: number;
  img: string;
  qty: number;
  color: string;
  size: string;
}

type CartAction =
  | { type: 'ADD_ITEM'; item: Omit<CartItem, 'qty'>; qty: number }
  | { type: 'REMOVE_ITEM'; sku: string }
  | { type: 'UPDATE_QTY'; sku: string; qty: number }
  | { type: 'CLEAR_CART' };

function cartReducer(state: CartItem[], action: CartAction): CartItem[] {
  switch (action.type) {
    case 'ADD_ITEM': {
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

  const clearCart = () => dispatch({ type: 'CLEAR_CART' });

  const totalItems = cart.reduce((sum, item) => sum + item.qty, 0);

  return (
    <CartContext.Provider value={{ cart, totalItems, badgeVersion, reserveExpiry, addItem, removeItem, updateQty, clearCart }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be inside CartProvider');
  return ctx;
}
