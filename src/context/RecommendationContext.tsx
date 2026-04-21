import React, { createContext, useCallback, useContext, useState } from 'react';
import { products, Product } from '../data/products';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface ScoredProduct {
  id: string;
  reviewCount: number;
  rating: number;
  isFeatured?: boolean;
  originalPrice?: number;
  isNew?: boolean;
  isBestSeller?: boolean;
  stock: number;
  discountPercent?: number;
  category: string;
  price?: number;
  tags?: { style?: string[]; room?: string[]; material?: string[] };
}

export interface UserProfile {
  /** Accumulated interaction weight per category (view×1, click×2, add×5, buy×10) */
  categoryWeights: Record<string, number>;
  /** Accumulated interaction weight per style tag */
  styleWeights: Record<string, number>;
  /** Rolling average of interacted product prices, or null if no data */
  avgPrice: number | null;
}

interface RecommendationContextValue {
  trackView: (productId: string) => void;
  trackClick: (productId: string) => void;
  trackAddToCart: (productId: string) => void;
  trackPurchase: (productId: string) => void;
  scoreProduct: (product: ScoredProduct) => number;
  /** Products from same category or matching tags, ranked by behavioral score */
  getRelatedProducts: (
    productId: string,
    category: string,
    tags?: Product['tags'],
    limit?: number,
  ) => Product[];
  /** Products from categories NOT in the cart — for cross-sell / Complete Your Space */
  getComplementaryProducts: (
    cartProductIds: string[],
    cartCategories: string[],
    limit?: number,
  ) => Product[];
  /** Increments on every add-to-cart — use as `key` or in `useEffect` to re-render sections */
  refreshToken: number;
  /** Last 5 added product IDs, newest first */
  recentlyAdded: string[];
  userProfile: UserProfile;
}

// ── Base score (product metadata only, no user history) ───────────────────────

function baseScore(p: ScoredProduct): number {
  return (
    (p.isBestSeller ? 5 : 0) +
    (p.isNew ? 3 : 0) +
    (p.rating >= 4.5 ? 3 : 0) +
    ((p.discountPercent ?? 0) > 0 ? 2 : 0) +
    ((p.stock ?? 1) > 0 ? 2 : 0) +
    (p.isFeatured ? 2 : 0)
  );
}

// ── Diversity pass ────────────────────────────────────────────────────────────

export function diversify<T extends { category: string }>(items: T[], maxConsecutive = 3): T[] {
  if (items.length === 0) return items;
  const result: T[] = [];
  const pool = [...items];

  while (pool.length > 0) {
    const tail = result.slice(-maxConsecutive).map(p => p.category);
    const blocked =
      tail.length === maxConsecutive && tail.every(c => c === tail[0]) ? tail[0] : null;
    let idx = blocked ? pool.findIndex(p => p.category !== blocked) : 0;
    if (idx === -1) idx = 0;
    result.push(...pool.splice(idx, 1));
  }

  return result;
}

// ── Context ───────────────────────────────────────────────────────────────────

const RecommendationContext = createContext<RecommendationContextValue | null>(null);

export function RecommendationProvider({ children }: { children: React.ReactNode }) {
  // Per-product event counters
  const [views, setViews] = useState<Record<string, number>>({});
  const [clicks, setClicks] = useState<Record<string, number>>({});
  const [carts, setCarts] = useState<Record<string, number>>({});
  const [purchases, setPurchases] = useState<Record<string, number>>({});

  // User preference profile
  const [categoryWeights, setCategoryWeights] = useState<Record<string, number>>({});
  const [styleWeights, setStyleWeights] = useState<Record<string, number>>({});
  const [priceSum, setPriceSum] = useState(0);
  const [priceCount, setPriceCount] = useState(0);

  // Feed refresh signal
  const [refreshToken, setRefreshToken] = useState(0);
  const [recentlyAdded, setRecentlyAdded] = useState<string[]>([]);

  // ── Profile updater — called by all tracking functions ────────────────────
  const applyProfileWeight = useCallback((productId: string, weight: number, updatePrice: boolean) => {
    const p = products.find(pr => pr.id === productId);
    if (!p) return;

    setCategoryWeights(prev => ({ ...prev, [p.category]: (prev[p.category] ?? 0) + weight }));

    const styles = p.tags?.style ?? [];
    if (styles.length > 0) {
      setStyleWeights(prev => {
        const next = { ...prev };
        styles.forEach(s => { next[s] = (next[s] ?? 0) + weight; });
        return next;
      });
    }

    if (updatePrice) {
      setPriceSum(prev => prev + p.price);
      setPriceCount(prev => prev + 1);
    }
  }, []);

  // ── Event trackers ────────────────────────────────────────────────────────

  const trackView = useCallback((productId: string) => {
    setViews(prev => ({ ...prev, [productId]: (prev[productId] ?? 0) + 1 }));
    applyProfileWeight(productId, 1, false);
  }, [applyProfileWeight]);

  const trackClick = useCallback((productId: string) => {
    setClicks(prev => ({ ...prev, [productId]: (prev[productId] ?? 0) + 1 }));
    applyProfileWeight(productId, 2, false);
  }, [applyProfileWeight]);

  const trackAddToCart = useCallback((productId: string) => {
    setCarts(prev => ({ ...prev, [productId]: (prev[productId] ?? 0) + 1 }));
    setRefreshToken(t => t + 1);
    setRecentlyAdded(prev => [productId, ...prev.filter(id => id !== productId)].slice(0, 5));
    applyProfileWeight(productId, 5, true);
  }, [applyProfileWeight]);

  const trackPurchase = useCallback((productId: string) => {
    setPurchases(prev => ({ ...prev, [productId]: (prev[productId] ?? 0) + 1 }));
    applyProfileWeight(productId, 10, true);
  }, [applyProfileWeight]);

  // ── Scoring — base + behavioral + profile affinity ────────────────────────

  const scoreProduct = useCallback(
    (product: ScoredProduct): number => {
      const base = baseScore(product);

      // Behavioral signals (event weights)
      const behavioral =
        (views[product.id] ?? 0) * 1 +
        (clicks[product.id] ?? 0) * 2 +
        (carts[product.id] ?? 0) * 5 +
        (purchases[product.id] ?? 0) * 10;

      // Category affinity — capped to avoid overshadowing base
      const catAffinity = Math.min((categoryWeights[product.category] ?? 0) * 0.4, 8);

      // Style affinity — sum of matching style tag weights
      const styleAffinity = Math.min(
        (product.tags?.style ?? []).reduce((sum, s) => sum + (styleWeights[s] ?? 0) * 0.3, 0),
        6,
      );

      // Price affinity — bonus when product is near user's typical price range
      let priceAffinity = 0;
      if (priceCount > 0 && product.price != null) {
        const avg = priceSum / priceCount;
        const diff = Math.abs(product.price - avg) / avg;
        priceAffinity = diff < 0.25 ? 3 : diff < 0.5 ? 1.5 : 0;
      }

      return base + behavioral + catAffinity + styleAffinity + priceAffinity;
    },
    [views, clicks, carts, purchases, categoryWeights, styleWeights, priceSum, priceCount],
  );

  // ── Helper: related products ──────────────────────────────────────────────

  const getRelatedProducts = useCallback(
    (
      productId: string,
      category: string,
      tags?: Product['tags'],
      limit = 6,
    ): Product[] => {
      const pool = products.filter(p => p.id !== productId && p.images.length > 0);

      // Relevant = same category OR matching style/room tags
      const relevant = pool.filter(p => {
        if (p.category === category) return true;
        const styleMatch = (tags?.style ?? []).some(s => (p.tags?.style ?? []).includes(s));
        const roomMatch = (tags?.room ?? []).some(r => (p.tags?.room ?? []).includes(r));
        return styleMatch || roomMatch;
      });

      const source = relevant.length >= 4 ? relevant : pool;
      return diversify(source.sort((a, b) => scoreProduct(b) - scoreProduct(a))).slice(0, limit);
    },
    [scoreProduct],
  );

  // ── Helper: complementary products (for cart / bundle) ───────────────────

  const getComplementaryProducts = useCallback(
    (cartProductIds: string[], cartCategories: string[], limit = 4): Product[] => {
      const excludeIds = new Set(cartProductIds);
      const cartCatSet = new Set(cartCategories);

      const pool = products.filter(p => p.images.length > 0 && !excludeIds.has(p.id));

      // Prefer different categories (true cross-sell)
      const complementary = pool.filter(p => !cartCatSet.has(p.category));
      const source = complementary.length >= 2 ? complementary : pool;

      return source.sort((a, b) => scoreProduct(b) - scoreProduct(a)).slice(0, limit);
    },
    [scoreProduct],
  );

  // ── Derived profile ───────────────────────────────────────────────────────

  const userProfile: UserProfile = {
    categoryWeights,
    styleWeights,
    avgPrice: priceCount > 0 ? priceSum / priceCount : null,
  };

  return (
    <RecommendationContext.Provider
      value={{
        trackView,
        trackClick,
        trackAddToCart,
        trackPurchase,
        scoreProduct,
        getRelatedProducts,
        getComplementaryProducts,
        refreshToken,
        recentlyAdded,
        userProfile,
      }}
    >
      {children}
    </RecommendationContext.Provider>
  );
}

export function useRecommendations(): RecommendationContextValue {
  const ctx = useContext(RecommendationContext);
  if (!ctx) throw new Error('useRecommendations must be inside RecommendationProvider');
  return ctx;
}
