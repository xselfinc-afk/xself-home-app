/**
 * ProductLinkHandler — opens the app's ProductDetail from a shared PDP link.
 *
 *   https://xselfhome.com/products/{sku_custom}
 *
 * Deliberately separate from MetaCheckoutLinkHandler: that component owns the
 * high-consequence checkout bridge (it clears and restores the cart); browsing
 * a shared product must never share that blast radius. This handler is
 * read-only — it looks the SKU up in the same authoritative source the app
 * sells from (`sellable_products`) and navigates. Nothing else.
 *
 * Cold start uses the same navigation-ready retry approach the checkout
 * handler proved on device: the AuthGate navigator may be mounted for a long
 * time (customer reading the sign-in screen) before RootStack — and its
 * 'ProductDetail' route — exists, so we retry until navigation lands or the
 * window expires. A late arrival just opens a product page, which is far less
 * intrusive than a checkout, so the window is kept generous.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { Linking } from 'react-native';
import { supabase } from '../lib/supabase';
import { adaptStandardizedRow, LIST_SELECT } from '../services/detailProductAdapter';
import type { Product } from '../data/products';

/** Injected by App.tsx (same pattern as MetaCheckoutLinkHandler — avoids a
 *  circular import back into App.tsx). */
export interface ProductLinkNavigator {
  isReady: () => boolean;
  navigate: (screen: string, params?: object) => void;
  getCurrentRoute?: () => { name: string } | undefined;
}

const NAV_RETRY_INTERVAL_MS = 400;
const NAV_RETRY_TIMEOUT_MS = 180_000;

/** Accept the canonical share host (apex) and its www twin — nothing else. */
const PRODUCT_URL_RE = /^https?:\/\/(?:www\.)?xselfhome\.com\/products\/([^/?#]+)\/?(?:[?#]|$)/i;

/** Same shape rule the storefront route enforces. */
const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function parseProductLink(url: string): string | null {
  const m = PRODUCT_URL_RE.exec(url);
  if (!m) return null;
  let sku = '';
  try { sku = decodeURIComponent(m[1]).trim(); } catch { return null; }
  return SKU_PATTERN.test(sku) ? sku : null;
}

/** sku_custom → app Product, from the app's authoritative sellable view. */
async function loadProductBySkuCustom(skuCustom: string): Promise<Product | null> {
  const { data, error } = await supabase
    .from('sellable_products')
    .select(LIST_SELECT)
    .eq('sku_custom', skuCustom)
    .limit(1);
  if (error || !data || data.length === 0) return null;
  try { return adaptStandardizedRow(data[0] as never); } catch { return null; }
}

export default function ProductLinkHandler({ navigator }: { navigator: ProductLinkNavigator }) {
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Serialises links: a newer tapped link supersedes an older pending one. */
  const linkSeq = useRef(0);

  const openProduct = useCallback((product: Product, seq: number) => {
    const deadline = Date.now() + NAV_RETRY_TIMEOUT_MS;
    const attempt = () => {
      navTimer.current = null;
      if (linkSeq.current !== seq) return; // a newer link took over
      if (navigator.isReady()) {
        navigator.navigate('ProductDetail', { product });
        const current = navigator.getCurrentRoute?.();
        if (!navigator.getCurrentRoute || current?.name === 'ProductDetail') return;
      }
      if (Date.now() >= deadline) return;
      navTimer.current = setTimeout(attempt, NAV_RETRY_INTERVAL_MS);
    };
    attempt();
  }, [navigator]);

  const handleUrl = useCallback(async (url: string) => {
    const sku = parseProductLink(url);
    if (!sku) return; // not a product link — other handlers own it
    const seq = ++linkSeq.current;
    const product = await loadProductBySkuCustom(sku);
    if (!product) {
      // Not sellable right now (or unknown). Fail quiet: the customer landed
      // in the app, which is already a fine outcome — no alert wall.
      if (__DEV__) console.log('[ProductLink] sku not resolvable:', sku);
      return;
    }
    if (linkSeq.current !== seq) return;
    openProduct(product, seq);
  }, [openProduct]);

  useEffect(() => {
    // Cold start: the app was launched by this link.
    Linking.getInitialURL().then(url => { if (url) void handleUrl(url); }).catch(() => {});
    // Warm/foreground: link arrives while running.
    const sub = Linking.addEventListener('url', ({ url }) => { void handleUrl(url); });
    return () => {
      sub.remove();
      if (navTimer.current) clearTimeout(navTimer.current);
    };
  }, [handleUrl]);

  return null;
}
