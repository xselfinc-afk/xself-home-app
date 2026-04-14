import React, { createContext, useContext, useReducer } from 'react';
import { Product } from '../data/products';

export interface CartItem {
  id: number;
  name: string;
  price: number;
  img: string;
  qty: number;
}

type CartAction =
  | { type: 'ADD_ITEM'; product: Product; qty: number }
  | { type: 'REMOVE_ITEM'; id: number }
  | { type: 'UPDATE_QTY'; id: number; qty: number };

function cartReducer(state: CartItem[], action: CartAction): CartItem[] {
  switch (action.type) {
    case 'ADD_ITEM': {
      const existing = state.find(item => item.id === action.product.id);
      if (existing) {
        return state.map(item =>
          item.id === action.product.id
            ? { ...item, qty: item.qty + action.qty }
            : item
        );
      }
      return [
        ...state,
        {
          id: action.product.id,
          name: action.product.name,
          price: action.product.price,
          img: action.product.img,
          qty: action.qty,
        },
      ];
    }
    case 'REMOVE_ITEM':
      return state.filter(item => item.id !== action.id);
    case 'UPDATE_QTY':
      if (action.qty <= 0) return state.filter(item => item.id !== action.id);
      return state.map(item =>
        item.id === action.id ? { ...item, qty: action.qty } : item
      );
    default:
      return state;
  }
}

interface CartContextValue {
  cart: CartItem[];
  totalItems: number;
  addItem: (product: Product, qty: number) => void;
  removeItem: (id: number) => void;
  updateQty: (id: number, qty: number) => void;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [cart, dispatch] = useReducer(cartReducer, []);

  const addItem = (product: Product, qty: number) =>
    dispatch({ type: 'ADD_ITEM', product, qty });

  const removeItem = (id: number) =>
    dispatch({ type: 'REMOVE_ITEM', id });

  const updateQty = (id: number, qty: number) =>
    dispatch({ type: 'UPDATE_QTY', id, qty });

  const totalItems = cart.reduce((sum, item) => sum + item.qty, 0);

  return (
    <CartContext.Provider value={{ cart, totalItems, addItem, removeItem, updateQty }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside CartProvider');
  return ctx;
}
