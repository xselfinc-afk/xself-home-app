import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList, KeyboardAvoidingView,
  Platform, ActivityIndicator, AppState,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createSupportSession,
  sendSupportMessage,
  getSupportMessages,
  setSupportSessionMeta,
  sendSupportProductContext,
  SupportMessage,
} from '../services/supportService';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { Product, ProductVariant, formatPrice } from '../data/products';
import { variantUrl } from '../utils/imageVariant';
import { defaultCartItem } from '../utils/cartItem';
import { fetchActiveQuote, ActiveQuote } from '../services/quotesService';

// AsyncStorage key for the Crisp session id is namespaced by the
// signed-in customer's email so accounts cannot see each other's chat
// history on a shared device. `anon` is a sentinel for the unauthenticated
// case — those sessions are not shared with any signed-in account.
const SESSION_KEY_PREFIX = 'xself_support_session_id_v2';
function sessionStorageKey(email: string | null | undefined): string {
  const normalized = (email ?? '').trim().toLowerCase();
  return `${SESSION_KEY_PREFIX}:${normalized || 'anon'}`;
}
const POLL_INTERVAL_MS = 8000;

// Xself yellow — matches Product Detail Buy Now / Add to Cart (App.tsx:3125-3128).
const XSELF_YELLOW = '#EAB320';

// Outgoing user messages carry a UI-only delivery status. Server-fetched
// messages from Crisp have status === undefined (no indicator rendered).
type LocalSupportMessage = SupportMessage & {
  status?: 'sending' | 'sent' | 'failed';
};

// Coarse "Expires in Xd / Xh / Xm" label for the offer banner. Re-evaluated on
// every render — close enough for a banner without a live timer.
function expiresLabel(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'Expired';
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);
  if (days  >= 1) return `Expires in ${days}d`;
  if (hours >= 1) return `Expires in ${hours}h`;
  return `Expires in ${Math.max(mins, 1)}m`;
}

// Detects any **internal / system-generated** operator message that should
// never appear in the customer's chat thread. Covers four categories:
//   1. Admin-tool URLs (Netlify / Vercel / Pages / known offer-host names)
//      that may have leaked from misconfigured Crisp Message Shortcuts.
//   2. Product-context lead lines posted by support-chat's
//      `send_product_context` action ("Product inquiry: …"). These are sent
//      with stealth=true so Crisp normally hides them, but some plans /
//      clients still return them via getMessages — belt-and-suspenders.
//   3. The "Create Special Offer" markdown link helper note.
//   4. Any raw `mobile-create-quote.html` reference.
// Customer's own messages are never filtered — only `from: 'operator'` ones.
const ADMIN_URL_REGEX =
  /https?:\/\/[^\s]*(?:netlify\.app|vercel\.app|pages\.dev|gorgeous-mermaid-80b26a)[^\s]*/i;
const PRODUCT_INQUIRY_REGEX = /^\s*Product inquiry:/i;
const OFFER_LABEL_REGEX     = /Create Special Offer/i;
const ADMIN_HTML_REGEX      = /mobile-create-quote\.html/i;

function isInternalMessage(content: string): boolean {
  if (typeof content !== 'string') return false;
  return (
    ADMIN_URL_REGEX.test(content)       ||
    PRODUCT_INQUIRY_REGEX.test(content) ||
    OFFER_LABEL_REGEX.test(content)     ||
    ADMIN_HTML_REGEX.test(content)
  );
}

// Fixed brand avatar for every incoming Concierge message. Renders the
// Xself app icon (symbol-only mark on its native teal field) clipped to a
// circle with a thin Xself Gold ring.
const CONCIERGE_MARK = require('../../assets/icon.png');
function ConciergeAvatar() {
  return (
    <View style={styles.conciergeAvatar}>
      <Image
        source={CONCIERGE_MARK}
        style={styles.conciergeAvatarLogo}
        contentFit="cover"
        cachePolicy="memory-disk"
      />
    </View>
  );
}

export default function SupportScreen({ navigation, route }: any) {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { addItem } = useCart();

  const product: Product | undefined = route?.params?.product;
  const selectedVariant: ProductVariant | null = route?.params?.selectedVariant ?? null;
  const routeQty: number = route?.params?.qty ?? 1;
  const hasProductContext = !!product;

  // Variant-aware fields — same fallback chain as Product Detail handlers.
  const variantPrice  = selectedVariant?.price ?? product?.price ?? 0;
  const variantSku    = selectedVariant?.sku ?? product?.skuCustom ?? (product ? `product-${product.id}` : '');
  const variantImg    = selectedVariant?.images?.[0] ?? product?.images?.[0] ?? '';
  const variantColor  = selectedVariant?.color ?? '';
  const variantSize   = selectedVariant?.size ?? '';
  const variantStock  = selectedVariant?.stock ?? product?.stock ?? 0;
  const isOutOfStock  = variantStock <= 0;
  const maxQty        = Math.max(1, variantStock);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LocalSupportMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [bootError, setBootError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [sending, setSending] = useState(false);
  const [addedFlash, setAddedFlash] = useState(false);
  const [addedPermanent, setAddedPermanent] = useState(false);
  const [quote, setQuote] = useState<ActiveQuote | null>(null);

  const initialQty = Math.max(1, Math.min(routeQty || 1, maxQty));
  const [qty, setQty] = useState(initialQty);

  // Re-clamp local qty when the product/variant — and therefore stock — changes.
  useEffect(() => {
    setQty((q) => Math.max(1, Math.min(q, maxQty)));
  }, [maxQty]);

  // When a quote arrives, also clamp qty to its max_qty (typically 1).
  useEffect(() => {
    if (!quote) return;
    setQty((q) => Math.max(1, Math.min(q, quote.max_qty)));
  }, [quote?.max_qty]);

  const listRef = useRef<FlatList<LocalSupportMessage>>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastFingerprintRef = useRef<number>(0);
  const cancelledRef = useRef(false);
  // Tracks which product id we last pushed Crisp meta for. Resets when the
  // route's product changes, so revisiting chat with a different product
  // re-sends fresh metadata to the agent's side panel.
  const metaSentForProductIdRef = useRef<string | null>(null);
  // Tracks the last (product_id, supplier_sku) pair we posted a human-readable
  // product-context note into the Crisp timeline for. Used to dedupe so the
  // same product/variant doesn't post twice in a single screen session,
  // while a switch back to a previously seen product DOES re-post (matches
  // the brief's "Product A → B → A okay" rule because the ref only holds
  // the most recent key, not a full history).
  const lastSentContextKeyRef = useRef<string | null>(null);

  // ── Init: load or create session, scoped to the signed-in email ──────────
  // Re-runs on every email change so a logout/login on the same device
  // swaps to a per-account Crisp session id. Local state is cleared up
  // front so the previous user's messages cannot render during the
  // transition window before the new session id resolves.
  useEffect(() => {
    cancelledRef.current = false;
    setSessionId(null);
    setMessages([]);
    setQuote(null);
    lastFingerprintRef.current = 0;
    lastSentContextKeyRef.current = null;
    metaSentForProductIdRef.current = null;
    setBooting(true);
    setBootError(null);

    const storageKey = sessionStorageKey(user?.email);

    (async () => {
      try {
        let sid = await AsyncStorage.getItem(storageKey);
        if (!sid) {
          sid = await createSupportSession();
          await AsyncStorage.setItem(storageKey, sid);
        }
        if (cancelledRef.current) return;
        setSessionId(sid);
      } catch (err) {
        if (cancelledRef.current) return;
        setBootError(err instanceof Error ? err.message : 'Could not start a chat session.');
      } finally {
        if (!cancelledRef.current) setBooting(false);
      }
    })();
    return () => { cancelledRef.current = true; };
  }, [user?.email]);

  // ── Polling loop ─────────────────────────────────────────────────────────
  const refresh = useCallback(async (sid: string) => {
    try {
      const fresh = await getSupportMessages(sid);
      if (cancelledRef.current) return;
      setMessages((prev) => {
        const map = new Map<number, LocalSupportMessage>();
        for (const m of prev) map.set(m.id, m);
        for (const m of fresh) map.set(m.id, m);
        const merged = Array.from(map.values()).sort((a, b) => a.id - b.id);
        if (merged.length > 0) lastFingerprintRef.current = merged[merged.length - 1].id;
        return merged;
      });
    } catch {
      // Polling failure is silent — surface only first-load failures via bootError.
    }
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    refresh(sessionId);
    pollTimerRef.current = setInterval(() => refresh(sessionId), POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [sessionId, refresh]);

  // ── Crisp meta: push fresh product info whenever product id changes ──────
  useEffect(() => {
    if (!sessionId || !product) return;
    const pid = String(product.id);
    if (metaSentForProductIdRef.current === pid) return;
    metaSentForProductIdRef.current = pid;

    const segments: string[] = ['product-question', `sku:${variantSku}`];
    if (variantColor) segments.push(`color:${variantColor}`);
    if (variantSize)  segments.push(`size:${variantSize}`);

    const data: Record<string, string> = {
      product_title: product.name,
      product_sku:   variantSku,
      product_price: `$${variantPrice}`,
      product_id:    pid,
      product_stock: String(variantStock),
    };
    if (variantImg)   data.product_image = variantImg;
    if (variantColor) data.product_variant_color = variantColor;
    if (variantSize)  data.product_variant_size  = variantSize;

    setSupportSessionMeta(sessionId, {
      subject: `Product question: ${product.name}`,
      segments,
      data,
      nickname: user?.email ?? undefined,
      email:    user?.email ?? undefined,
    }).catch((err) => {
      if (__DEV__) console.warn('[SupportScreen] set_meta failed:', err instanceof Error ? err.message : err);
      metaSentForProductIdRef.current = null;
    });
  }, [
    sessionId, product, variantSku, variantPrice, variantImg,
    variantColor, variantSize, variantStock, user?.email,
  ]);

  // Post a human-readable product-context note into the Crisp timeline
  // whenever the customer opens Concierge for a new product (or a different
  // variant of the same product). Visible to the support agent in their
  // Crisp dashboard so they immediately know which product / SKU is being
  // discussed without parsing chat. Customer-facing chat is unaffected:
  // the underlying Edge Function posts with `stealth: true` so it's an
  // operator-only private note.
  useEffect(() => {
    if (!sessionId || !product) return;
    const key = `${String(product.id)}|${variantSku}`;
    if (lastSentContextKeyRef.current === key) return;
    lastSentContextKeyRef.current = key;

    const lines: string[] = ['Product inquiry:', product.name];
    if (variantSku)   lines.push(`SKU: ${variantSku}`);
    if (variantColor) lines.push(`Color: ${variantColor}`);
    if (variantSize)  lines.push(`Size: ${variantSize}`);
    lines.push(`Price: $${variantPrice}`);
    lines.push(`Stock: ${variantStock > 0 ? 'In stock' : 'Out of stock'}`);

    // Forward variantImg so the Crisp agent sees an inline product thumbnail
    // above the text note. Filename is sku-derived (sanitised) so each upload
    // is uniquely identified in the Crisp dashboard's file history.
    const safeSku = (variantSku || 'product').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
    sendSupportProductContext(sessionId, lines.join('\n'), {
      imageUrl:      variantImg || undefined,
      imageName:     `${safeSku}.jpg`,
      customerEmail: user?.email || undefined,
      productId:     String(product.id),
      sku:           variantSku || undefined,
      title:         product.name,
    }).catch((err) => {
      if (__DEV__) console.warn('[SupportScreen] product context post failed:', err instanceof Error ? err.message : err);
      // Allow retry on the next render observing the same key.
      lastSentContextKeyRef.current = null;
    });
  }, [sessionId, product, variantSku, variantColor, variantSize, variantPrice, variantStock, variantImg, user?.email]);

  // Reset the "Added" indicator when the route product changes.
  useEffect(() => {
    setAddedFlash(false);
    setAddedPermanent(false);
  }, [product?.id, selectedVariant?.sku]);

  // Fetch the customer's active quote (if any) for the current product.
  // MVP: requires the user to be signed in with an email — the edge function
  // gates by Bearer JWT and matches against quote.customer_email.
  useEffect(() => {
    if (!product?.id || !user?.email) { setQuote(null); return; }
    let cancelled = false;
    fetchActiveQuote(String(product.id)).then((q) => {
      if (!cancelled) setQuote(q);
    });
    return () => { cancelled = true; };
  }, [product?.id, user?.email]);

  // Live polling for new quotes while SupportScreen is mounted.
  //   - no current quote   → poll every 12s (fast — agent may create one)
  //   - current quote held → poll every 60s (slow — refresh status / used)
  // The dependency on `quote` causes the interval to switch automatically.
  useEffect(() => {
    if (!product?.id || !user?.email) return;
    let cancelled = false;
    const intervalMs = quote ? 60000 : 12000;
    const id = setInterval(async () => {
      if (cancelled) return;
      try {
        const q = await fetchActiveQuote(String(product.id));
        if (!cancelled) setQuote(q);
      } catch { /* network blips are silent — next tick will retry */ }
    }, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [product?.id, user?.email, quote]);

  // Re-fetch when the app returns to the foreground from background. Catches
  // the case where the customer left the app for a while and a quote may
  // have been created or expired in the interim.
  useEffect(() => {
    if (!product?.id || !user?.email) return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      fetchActiveQuote(String(product.id))
        .then((q) => setQuote(q))
        .catch(() => {});
    });
    return () => sub.remove();
  }, [product?.id, user?.email]);


  // ── Auto-scroll on new message ────────────────────────────────────────────
  useEffect(() => {
    if (messages.length === 0) return;
    const id = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(id);
  }, [messages.length]);

  // ── Send pipeline ────────────────────────────────────────────────────────
  // Customer's bubble shows ONLY what they typed. Product context lives in
  // Crisp meta (side panel only), never injected into the message body.
  // The local-only `status` field drives the per-bubble delivery indicator.
  const sendPipeline = useCallback(async (msg: LocalSupportMessage) => {
    if (!sessionId) return;
    try {
      const fingerprint = await sendSupportMessage(sessionId, msg.content, {
        nickname: user?.email ?? undefined,
        email:    user?.email ?? undefined,
      });
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? { ...m, id: fingerprint ?? m.id, status: 'sent' }
            : m,
        ),
      );
      // Pull any operator replies; dedup-by-id collapses the now-fingerprinted
      // optimistic bubble onto its server twin.
      refresh(sessionId);
    } catch (err) {
      if (__DEV__) console.warn('[SupportScreen] send failed:', err instanceof Error ? err.message : err);
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, status: 'failed' } : m)),
      );
    }
  }, [sessionId, user?.email, refresh]);

  const onSend = async () => {
    const text = draft.trim();
    if (!text || !sessionId || sending) return;
    setSending(true);
    setSendError(null);

    const optimisticId = -Date.now();
    const optimistic: LocalSupportMessage = {
      id: optimisticId,
      from: 'user',
      content: text,
      ts: Math.floor(Date.now() / 1000),
      nickname: null,
      status: 'sending',
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft('');

    try {
      await sendPipeline(optimistic);
    } finally {
      setSending(false);
    }
  };

  const onRetry = async (msg: LocalSupportMessage) => {
    if (!sessionId || msg.status !== 'failed') return;
    setMessages((prev) =>
      prev.map((m) => (m.id === msg.id ? { ...m, status: 'sending' } : m)),
    );
    await sendPipeline({ ...msg, status: 'sending' });
  };

  // ── Commerce actions ─────────────────────────────────────────────────────
  const onAddToCart = () => {
    if (!product || isOutOfStock) return;
    // Quote-eligible items must use Buy Now so the server can validate and
    // apply the negotiated price. Skip the cart entirely when a quote exists.
    if (quote) return;
    if (product.variants && selectedVariant) {
      addItem({
        sku: selectedVariant.sku,
        productId: product.id,
        name: product.name,
        price: selectedVariant.price,
        img: selectedVariant.images[0] ?? product.images[0],
        color: selectedVariant.color,
        size: selectedVariant.size,
      }, qty);
    } else {
      addItem(defaultCartItem(product), qty);
    }
    setAddedFlash(true);
    setTimeout(() => { setAddedFlash(false); setAddedPermanent(true); }, 1000);
  };

  const onBuyNow = () => {
    if (!product || isOutOfStock) return;
    navigation.navigate('Checkout', {
      mode: 'buy_now',
      product,
      qty,
      selectedVariant: selectedVariant ?? null,
      quoteToken: quote?.redeem_token,
    });
  };

  // Add the quoted line to the regular cart. The cart preserves the
  // redeem_token so checkout (`create-checkout-order`) can re-validate and
  // override the line's price server-side. Same "Added ✓ → View Cart"
  // affordance as the no-quote Add to Cart.
  const onOfferAddToCart = () => {
    if (!product || !quote || isOutOfStock) return;
    const offerPriceDollars    = quote.quoted_price_cents   / 100;
    const offerOriginalDollars = quote.original_price_cents / 100;
    if (product.variants && selectedVariant) {
      addItem({
        sku: selectedVariant.sku,
        productId: product.id,
        name: product.name,
        price: offerPriceDollars,
        originalPrice: offerOriginalDollars,
        img: selectedVariant.images[0] ?? product.images[0],
        color: selectedVariant.color,
        size: selectedVariant.size,
        quoteToken: quote.redeem_token,
      }, qty);
    } else {
      const base = defaultCartItem(product);
      addItem({
        ...base,
        price: offerPriceDollars,
        originalPrice: offerOriginalDollars,
        quoteToken: quote.redeem_token,
      }, qty);
    }
    setAddedFlash(true);
    setTimeout(() => { setAddedFlash(false); setAddedPermanent(true); }, 1000);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  // Hide historic admin-tool URL leaks before they reach the chat list.
  const visibleMessages = useMemo(
    () => messages.filter((m) => !(m.from === 'operator' && isInternalMessage(m.content))),
    [messages],
  );

  const empty = useMemo(
    () => (!booting && !bootError && visibleMessages.length === 0),
    [booting, bootError, visibleMessages.length],
  );

  const renderItem = ({ item, index }: { item: LocalSupportMessage; index: number }) => {
    const isUser = item.from === 'user';
    const isFailed = item.status === 'failed';
    const Wrapper: any = isFailed ? TouchableOpacity : View;
    // Show the avatar only on the last operator message in a consecutive
    // support-message group; earlier bubbles keep the same left-side spacer
    // so message widths and alignment stay constant.
    const next = messages[index + 1];
    const showAvatar = !isUser && (!next || next.from === 'user');
    return (
      <View style={[styles.row, isUser ? styles.rowRight : styles.rowLeft]}>
        {!isUser
          ? (showAvatar ? <ConciergeAvatar /> : <View style={styles.conciergeSpacer} />)
          : null}
        <View style={[styles.bubbleColumn, isUser ? styles.bubbleColumnUser : styles.bubbleColumnAgent]}>
          <Wrapper
            activeOpacity={isFailed ? 0.7 : 1}
            onPress={isFailed ? () => onRetry(item) : undefined}
            accessibilityRole={isFailed ? 'button' : undefined}
            accessibilityLabel={isFailed ? 'Tap to retry sending' : undefined}
          >
            <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAgent]}>
              {!isUser ? (
                <Text style={styles.bubbleAgentName}>Xself Concierge</Text>
              ) : null}
              <Text style={isUser ? styles.bubbleTextUser : styles.bubbleTextAgent}>
                {item.content}
              </Text>
            </View>
          </Wrapper>
          {isUser && item.status ? (
            <View style={styles.statusRow}>
              {item.status === 'sending' && (
                <>
                  <Ionicons name="time-outline" size={11} color="#9CA3AF" />
                  <Text style={styles.statusText}>Sending…</Text>
                </>
              )}
              {item.status === 'sent' && (
                <>
                  <Ionicons name="checkmark" size={12} color="#9CA3AF" />
                  <Text style={styles.statusText}>Sent</Text>
                </>
              )}
              {item.status === 'failed' && (
                <Text style={styles.statusFailed}>Failed. Tap to retry.</Text>
              )}
            </View>
          ) : null}
        </View>
      </View>
    );
  };

  const availabilityLabel = isOutOfStock ? 'Out of stock' : 'In stock';
  const availabilityDotColor = isOutOfStock ? '#9CA3AF' : '#059669';

  const hasActiveQuote = !!quote;
  const quotedPriceDollars   = quote ? quote.quoted_price_cents   / 100 : 0;
  const originalPriceDollars = quote ? quote.original_price_cents / 100 : 0;
  const savingsAmount  = Math.max(0, originalPriceDollars - quotedPriceDollars);
  const savingsPercent = originalPriceDollars > 0
    ? Math.round((savingsAmount / originalPriceDollars) * 100)
    : 0;
  // 1-second tick drives the live MM:SS countdown pill. The effect only
  // runs while a quote is active, so we don't burn render cycles otherwise.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!quote) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [quote]);

  // Auto-expire: when the quote crosses its `expires_at`, drop the local
  // state so the offer card unmounts and polling re-engages to look for a
  // fresh quote (if the agent issues one).
  useEffect(() => {
    if (!quote) return;
    const expiresAt = new Date(quote.expires_at).getTime();
    const delta = expiresAt - Date.now();
    if (delta <= 0) { setQuote(null); return; }
    const t = setTimeout(() => setQuote(null), delta);
    return () => clearTimeout(t);
  }, [quote]);

  // Countdown derivations — recomputed on every render (1s tick).
  const expiresAtMs   = quote ? new Date(quote.expires_at).getTime() : 0;
  const remainingMs   = expiresAtMs > 0 ? Math.max(0, expiresAtMs - Date.now()) : 0;
  const remainingSec  = Math.floor(remainingMs / 1000);
  const cdMm          = Math.floor(remainingSec / 60);
  const cdSs          = remainingSec % 60;
  const countdownText = remainingSec >= 3600
    ? `${Math.floor(remainingSec / 3600)}h ${Math.floor((remainingSec % 3600) / 60)}m`
    : `${cdMm.toString().padStart(2, '0')}:${cdSs.toString().padStart(2, '0')}`;
  const isUrgentExpiry = remainingMs > 0 && remainingMs <  5 * 60 * 1000;
  const isWarnExpiry   = remainingMs > 0 && remainingMs < 10 * 60 * 1000 && !isUrgentExpiry;

  const addToCartLabel = addedPermanent ? 'View Cart' : addedFlash ? 'Added ✓' : 'Add to Cart';
  const buyNowLabel    = isOutOfStock
    ? 'Unavailable'
    : hasActiveQuote
      ? `Buy Now · $${formatPrice(quotedPriceDollars)}`
      : 'Buy Now';
  const addCartDisabled = isOutOfStock || hasActiveQuote;

  const minusDisabled = qty <= 1 || isOutOfStock;
  const plusDisabled  = qty >= maxQty || isOutOfStock;
  // In offer mode, qty is also capped by the quote's max_qty (default 1).
  const offerMaxQty       = quote ? Math.max(1, Math.min(maxQty, quote.max_qty)) : maxQty;
  const offerPlusDisabled = qty >= offerMaxQty || isOutOfStock;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color="#1C1917" />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle}>Xself Concierge</Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            Ask us about this product
          </Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.divider} />

      {/* Body */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
      >
        {booting ? (
          <View style={styles.center}>
            <ActivityIndicator size="small" color="#1C1917" />
            <Text style={styles.centerLabel}>Connecting…</Text>
          </View>
        ) : bootError ? (
          <View style={styles.center}>
            <Ionicons name="cloud-offline-outline" size={28} color="#9CA3AF" />
            <Text style={styles.errorTitle}>Couldn't start chat</Text>
            <Text style={styles.errorBody}>{bootError}</Text>
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={async () => {
                setBootError(null);
                setBooting(true);
                try {
                  const sid = await createSupportSession();
                  await AsyncStorage.setItem(sessionStorageKey(user?.email), sid);
                  setSessionId(sid);
                } catch (err) {
                  setBootError(err instanceof Error ? err.message : 'Could not start a chat session.');
                } finally {
                  setBooting(false);
                }
              }}
            >
              <Text style={styles.retryBtnText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {/* Offer-aware product strip — replaces the regular strip when an
                active quote exists. Same compact card style as the no-quote
                state; the quote drives the price, badge, countdown, and CTAs. */}
            {hasProductContext && product && hasActiveQuote && quote && (
              <View style={styles.productStrip}>
                <View style={styles.stripRow}>
                  <View style={styles.imageWrap}>
                    {variantImg ? (
                      <Image
                        source={{ uri: variantUrl(variantImg, { width: 240 }) }}
                        style={styles.image}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        transition={120}
                      />
                    ) : (
                      <View style={[styles.image, styles.imageFallback]}>
                        <Ionicons name="cube-outline" size={16} color="#9CA3AF" />
                      </View>
                    )}
                  </View>

                  <View style={styles.info}>
                    {/* Single header row — gold pill on the left, inline flame
                        countdown on the right. No countdown background or border. */}
                    <View style={styles.offerHeaderRow}>
                      <View style={styles.offerBadge}>
                        <Ionicons name="sparkles" size={12} color="#92660A" />
                        <Text style={styles.offerBadgeText}>SPECIAL OFFER</Text>
                      </View>
                      <View style={styles.offerCountdownInline}>
                        <Ionicons name="flame" size={12} color="#DC2626" />
                        <Text style={styles.offerCountdownText}>
                          Expires in <Text style={styles.offerCountdownTime}>{countdownText}</Text>
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.title} numberOfLines={2} selectable>
                      {product.name}
                    </Text>
                    <Text style={styles.metaLine} numberOfLines={1} selectable>
                      {[
                        variantColor || null,
                        variantSku ? `SKU ${variantSku}` : null,
                      ].filter(Boolean).join(' · ')}
                    </Text>
                    <View style={styles.offerPriceLineRow}>
                      <Text style={styles.price}>${formatPrice(quotedPriceDollars)}</Text>
                      {originalPriceDollars > quotedPriceDollars && (
                        <Text style={styles.offerStripOriginal}>${formatPrice(originalPriceDollars)}</Text>
                      )}
                      <View style={styles.offerStripStockRow}>
                        <View style={[styles.stockDot, { backgroundColor: availabilityDotColor }]} />
                        <Text style={styles.stockLabel}>{availabilityLabel}</Text>
                      </View>
                    </View>
                    {savingsAmount > 0 && (
                      <Text style={styles.offerStripSavings}>
                        Save ${formatPrice(savingsAmount)}{savingsPercent > 0 ? ` · ${savingsPercent}% off` : ''}
                      </Text>
                    )}
                  </View>

                  {/* Quantity stepper — direct sibling of info, mirroring the
                      no-quote product strip. Countdown lives in the header now. */}
                  <View style={styles.qtyStepper}>
                    <TouchableOpacity
                      style={styles.qtyBtn}
                      onPress={() => setQty((q) => Math.max(1, q - 1))}
                      disabled={minusDisabled}
                      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                      accessibilityLabel="Decrease quantity"
                    >
                      <Ionicons name="remove" size={14} color={minusDisabled ? '#C4C0BA' : '#1C1917'} />
                    </TouchableOpacity>
                    <Text style={styles.qtyValue}>{qty}</Text>
                    <TouchableOpacity
                      style={styles.qtyBtn}
                      onPress={() => setQty((q) => Math.min(offerMaxQty, q + 1))}
                      disabled={offerPlusDisabled}
                      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                      accessibilityLabel="Increase quantity"
                    >
                      <Ionicons name="add" size={14} color={offerPlusDisabled ? '#C4C0BA' : '#1C1917'} />
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={[styles.addCartBtn, isOutOfStock && styles.ctaBtnDisabled]}
                    onPress={addedPermanent
                      ? () => navigation.navigate('Main', { screen: 'Cart' })
                      : onOfferAddToCart}
                    disabled={isOutOfStock}
                    activeOpacity={0.88}
                  >
                    <Text style={[styles.addCartText, isOutOfStock && styles.ctaBtnTextDisabled]}>
                      {addToCartLabel}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.buyNowBtn, isOutOfStock && styles.ctaBtnDisabled]}
                    onPress={onBuyNow}
                    disabled={isOutOfStock}
                    activeOpacity={0.88}
                  >
                    <Text style={[styles.buyNowText, isOutOfStock && styles.ctaBtnTextDisabled]}>
                      {isOutOfStock ? 'Unavailable' : `Buy Now · $${formatPrice(quotedPriceDollars)}`}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* DEAD: previous full-screen offer card content (kept for reference only) */}
            {false && quote && (
                    <View style={styles.offerCard}>
                      {/* Offer card content rendered inside the modal */}
                <View style={styles.offerCardHeader}>
                  <View style={styles.offerCardHeaderLeft}>
                    <Ionicons name="sparkles" size={14} color={XSELF_YELLOW} />
                    <View style={styles.offerCardHeaderTitleCol}>
                      <Text style={styles.offerCardHeaderTitle}>Special Offer</Text>
                      <Text style={styles.offerCardHeaderSub}>Limited-time price locked for you</Text>
                    </View>
                  </View>
                  <View style={[
                    styles.countdownPill,
                    isUrgentExpiry ? styles.countdownPillUrgent
                      : isWarnExpiry ? styles.countdownPillWarn
                      : styles.countdownPillCalm,
                  ]}>
                    <Ionicons
                      name="time-outline"
                      size={11}
                      color={isUrgentExpiry ? '#DC2626' : isWarnExpiry ? '#B45309' : '#6B7280'}
                    />
                    <Text style={[
                      styles.countdownPillText,
                      isUrgentExpiry ? styles.countdownPillTextUrgent
                        : isWarnExpiry ? styles.countdownPillTextWarn
                        : styles.countdownPillTextCalm,
                    ]}>
                      {countdownText}
                    </Text>
                  </View>
                </View>

                {/* Product row */}
                <View style={styles.offerCardProductRow}>
                  <View style={styles.offerCardImageWrap}>
                    {variantImg ? (
                      <Image
                        source={{ uri: variantUrl(variantImg, { width: 320 }) }}
                        style={styles.offerCardImage}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        transition={120}
                      />
                    ) : (
                      <View style={[styles.offerCardImage, styles.imageFallback]}>
                        <Ionicons name="cube-outline" size={18} color="#9CA3AF" />
                      </View>
                    )}
                  </View>
                  <View style={styles.offerCardProductInfo}>
                    <Text style={styles.offerCardProductTitle} numberOfLines={2}>
                      {product.name}
                    </Text>
                    <Text style={styles.offerCardProductMeta} numberOfLines={1}>
                      {[
                        variantColor || null,
                        variantSku ? `SKU ${variantSku}` : null,
                      ].filter(Boolean).join(' · ')}
                    </Text>
                    <View style={styles.offerCardStockRow}>
                      <View style={[styles.stockDot, { backgroundColor: availabilityDotColor }]} />
                      <Text style={styles.offerCardStockLabel}>{availabilityLabel}</Text>
                    </View>
                  </View>
                </View>

                {/* Price highlight — green-tinted container; "Price locked" on the right */}
                <View style={styles.priceHighlight}>
                  <View style={styles.priceHighlightLeft}>
                    <Text style={styles.priceHighlightEyebrow}>YOUR PRICE</Text>
                    <View style={styles.priceHighlightRow}>
                      <Text style={styles.priceHighlightPrice}>${formatPrice(quotedPriceDollars)}</Text>
                      {originalPriceDollars > quotedPriceDollars && (
                        <Text style={styles.priceHighlightOriginal}>${formatPrice(originalPriceDollars)}</Text>
                      )}
                    </View>
                    {savingsAmount > 0 && (
                      <View style={styles.savingsBadge}>
                        <Text style={styles.savingsBadgeText}>
                          Save ${formatPrice(savingsAmount)}{savingsPercent > 0 ? ` · ${savingsPercent}% off` : ''}
                        </Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.priceHighlightRight}>
                    <Ionicons name="shield-checkmark-outline" size={16} color="#059669" />
                    <Text style={styles.priceLockedText}>Price locked</Text>
                  </View>
                </View>

                {/* Action row — Add to Cart (outline) + Buy Now (filled gold).
                    Both apply the quoted price; server re-validates either path. */}
                <View style={styles.offerCardActionRow}>
                  <TouchableOpacity
                    style={[styles.offerCardAddCartBtn, isOutOfStock && styles.offerCardAddCartBtnDisabled]}
                    onPress={addedPermanent
                      ? () => navigation.navigate('Main', { screen: 'Cart' })
                      : onOfferAddToCart}
                    disabled={isOutOfStock}
                    activeOpacity={0.88}
                  >
                    <Text style={[styles.offerCardAddCartText, isOutOfStock && styles.offerCardAddCartTextDisabled]}>
                      {addToCartLabel}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.offerCardBuyNowBtn, isOutOfStock && styles.offerCardBuyNowBtnDisabled]}
                    onPress={onBuyNow}
                    disabled={isOutOfStock}
                    activeOpacity={0.88}
                  >
                    <Text style={[styles.offerCardBuyNowText, isOutOfStock && styles.offerCardBuyNowTextDisabled]}>
                      {isOutOfStock ? 'Unavailable' : `Buy Now · $${formatPrice(quotedPriceDollars)}`}
                    </Text>
                  </TouchableOpacity>
                </View>

                {/* Trust footer */}
                <View style={styles.offerCardTrustRow}>
                  <Ionicons name="lock-closed" size={11} color="#6B7280" />
                  <Text style={styles.offerCardTrustText}>Secure checkout · Price locked</Text>
                </View>
              </View>
            )}

            {hasProductContext && product && !hasActiveQuote && (
              <View style={styles.productStrip}>
                <View style={styles.stripRow}>
                  <View style={styles.imageWrap}>
                    {variantImg ? (
                      <Image
                        source={{ uri: variantUrl(variantImg, { width: 240 }) }}
                        style={styles.image}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        transition={120}
                      />
                    ) : (
                      <View style={[styles.image, styles.imageFallback]}>
                        <Ionicons name="cube-outline" size={16} color="#9CA3AF" />
                      </View>
                    )}
                  </View>

                  <View style={styles.info}>
                    <Text style={styles.title} numberOfLines={2} selectable>
                      {product.name}
                    </Text>
                    <Text style={styles.metaLine} numberOfLines={1} selectable>
                      {[
                        variantColor || null,
                        variantSize || null,
                        variantSku ? `SKU ${variantSku}` : null,
                      ].filter(Boolean).join(' · ')}
                    </Text>
                    <View style={styles.priceStockRow}>
                      <Text style={styles.price}>${formatPrice(variantPrice)}</Text>
                      <View style={styles.stockRow}>
                        <View style={[styles.stockDot, { backgroundColor: availabilityDotColor }]} />
                        <Text style={styles.stockLabel}>{availabilityLabel}</Text>
                      </View>
                    </View>
                  </View>

                  <View style={styles.qtyStepper}>
                    <TouchableOpacity
                      style={styles.qtyBtn}
                      onPress={() => setQty((q) => Math.max(1, q - 1))}
                      disabled={minusDisabled}
                      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                      accessibilityLabel="Decrease quantity"
                    >
                      <Ionicons name="remove" size={14} color={minusDisabled ? '#C4C0BA' : '#1C1917'} />
                    </TouchableOpacity>
                    <Text style={styles.qtyValue}>{qty}</Text>
                    <TouchableOpacity
                      style={styles.qtyBtn}
                      onPress={() => setQty((q) => Math.min(maxQty, q + 1))}
                      disabled={plusDisabled}
                      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                      accessibilityLabel="Increase quantity"
                    >
                      <Ionicons name="add" size={14} color={plusDisabled ? '#C4C0BA' : '#1C1917'} />
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={[styles.addCartBtn, addCartDisabled && styles.ctaBtnDisabled]}
                    onPress={addedPermanent
                      ? () => navigation.navigate('Main', { screen: 'Cart' })
                      : onAddToCart}
                    disabled={addCartDisabled}
                    activeOpacity={0.88}
                  >
                    <Text style={[styles.addCartText, addCartDisabled && styles.ctaBtnTextDisabled]}>
                      {addToCartLabel}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.buyNowBtn, isOutOfStock && styles.ctaBtnDisabled]}
                    onPress={onBuyNow}
                    disabled={isOutOfStock}
                    activeOpacity={0.88}
                  >
                    <Text style={[styles.buyNowText, isOutOfStock && styles.ctaBtnTextDisabled]}>
                      {buyNowLabel}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            <FlatList
              ref={listRef}
              data={visibleMessages}
              keyExtractor={(m) => String(m.id)}
              renderItem={renderItem}
              contentContainerStyle={[
                styles.listContent,
                empty && { flexGrow: 1, justifyContent: 'center' },
              ]}
              ListEmptyComponent={
                <View style={styles.emptyWrap}>
                  <View style={styles.emptyBadge}>
                    <Ionicons name="sparkles" size={16} color="#1C1917" />
                  </View>
                  <Text style={styles.emptyTitle}>Say hi</Text>
                  <Text style={styles.emptyBody}>
                    Our concierge team is on by 9 AM and replies within minutes during business hours.
                  </Text>
                </View>
              }
              onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
            />
          </>
        )}

        {/* Composer */}
        {!booting && !bootError && (
          <View style={[styles.composerWrap, { paddingBottom: Math.max(insets.bottom, 10) }]}>
            {sendError ? <Text style={styles.sendError}>{sendError}</Text> : null}
            <View style={styles.composerRow}>
              <TextInput
                style={styles.input}
                placeholder="Message Xself Concierge"
                placeholderTextColor="#9CA3AF"
                value={draft}
                onChangeText={setDraft}
                multiline
                maxLength={4000}
                editable={!sending}
                returnKeyType="default"
              />
              <TouchableOpacity
                onPress={onSend}
                disabled={!draft.trim() || sending}
                style={[
                  styles.sendBtn,
                  (!draft.trim() || sending) && styles.sendBtnDisabled,
                ]}
                accessibilityLabel="Send message"
              >
                {sending ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Ionicons name="arrow-up" size={18} color="#FFFFFF" />
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F3F1EB' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    gap: 12,
  },
  headerTitleWrap: { flex: 1 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#1C1917', letterSpacing: -0.2 },
  headerSubtitle: { fontSize: 12, color: '#6B7280', marginTop: 2, lineHeight: 16 },
  headerSpacer: { width: 22 },

  divider: { height: 1, backgroundColor: 'rgba(0,0,0,0.06)' },

  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 32, gap: 8,
  },
  centerLabel: { fontSize: 13, color: '#6B7280', marginTop: 8 },

  errorTitle: { fontSize: 15, fontWeight: '600', color: '#1C1917', marginTop: 8 },
  errorBody:  { fontSize: 12, color: '#6B7280', textAlign: 'center', marginTop: 4, lineHeight: 17 },
  retryBtn: {
    marginTop: 16, backgroundColor: '#1C1917',
    paddingVertical: 10, paddingHorizontal: 22, borderRadius: 22,
  },
  retryBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },

  // ── Special Offer card (rendered in place of the product strip when an
  //    active quote applies — single primary CTA, no Add to Cart). ────────
  offerCard: {
    marginHorizontal: 14,
    marginTop: 10,
    padding: 14,
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 3,
    elevation: 1,
  },
  offerCardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  offerCardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  offerCardHeaderTitleCol: {
    flex: 1,
    minWidth: 0,
  },
  offerCardHeaderTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1C1917',
    letterSpacing: -0.2,
    lineHeight: 18,
  },
  offerCardHeaderSub: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '500',
    marginTop: 2,
    lineHeight: 14,
  },
  // Countdown pill — calm/warn/urgent tiers. Rounded, subtle, mono-style.
  countdownPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  countdownPillCalm: {
    backgroundColor: 'rgba(0,0,0,0.04)',
    borderColor: 'rgba(0,0,0,0.06)',
  },
  countdownPillWarn: {
    backgroundColor: 'rgba(180,83,9,0.08)',
    borderColor: 'rgba(180,83,9,0.18)',
  },
  countdownPillUrgent: {
    backgroundColor: '#FEE2E2',
    borderColor: 'rgba(220,38,38,0.25)',
  },
  countdownPillText: {
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.2,
  },
  countdownPillTextCalm:   { color: '#1C1917' },
  countdownPillTextWarn:   { color: '#92400E' },
  countdownPillTextUrgent: { color: '#DC2626' },
  /* offerCardSub removed — subtitle now lives inside offerCardHeaderTitleCol */

  /* modal + pinned-banner styles removed — offer state is inline in productStrip */
  offerCardProductRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    marginTop: 16,
  },
  offerCardImageWrap: {
    width: 112,
    height: 112,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#F5F3EE',
  },
  offerCardImage: { width: 112, height: 112 },
  offerCardProductInfo: { flex: 1, minWidth: 0 },
  offerCardProductTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1C1917',
    lineHeight: 18,
  },
  offerCardProductMeta: {
    fontSize: 11,
    color: '#9CA3AF',
    fontWeight: '500',
    marginTop: 3,
  },
  offerCardStockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 5,
  },
  offerCardStockLabel: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '500',
  },
  // ── Price highlight — green-tinted container emphasising the negotiated value
  priceHighlight: {
    marginTop: 16,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(5,150,105,0.06)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(5,150,105,0.18)',
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  priceHighlightLeft: { flex: 1, minWidth: 0 },
  priceHighlightRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingTop: 2,
  },
  priceLockedText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#059669',
    letterSpacing: 0.1,
  },
  priceHighlightEyebrow: {
    fontSize: 10,
    fontWeight: '700',
    color: '#065F46',
    letterSpacing: 0.8,
  },
  priceHighlightRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
    marginTop: 4,
  },
  priceHighlightPrice: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1C1917',
    letterSpacing: -0.6,
  },
  priceHighlightOriginal: {
    fontSize: 14,
    fontWeight: '500',
    color: '#9CA3AF',
    textDecorationLine: 'line-through',
  },
  savingsBadge: {
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(5,150,105,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(5,150,105,0.22)',
  },
  savingsBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#065F46',
    letterSpacing: 0.1,
  },
  // Action row — equal-width, premium 52 px tall buttons.
  offerCardActionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
  },
  offerCardAddCartBtn: {
    flex: 1,
    height: 52,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: XSELF_YELLOW,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  offerCardAddCartBtnDisabled: {
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
  },
  offerCardAddCartText: {
    fontSize: 15,
    fontWeight: '700',
    color: XSELF_YELLOW,
    letterSpacing: 0.1,
  },
  offerCardAddCartTextDisabled: { color: '#9CA3AF' },
  offerCardBuyNowBtn: {
    flex: 1,
    height: 52,
    borderRadius: 16,
    backgroundColor: XSELF_YELLOW,
    alignItems: 'center',
    justifyContent: 'center',
  },
  offerCardBuyNowBtnDisabled: {
    backgroundColor: '#E5E7EB',
  },
  offerCardBuyNowText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.1,
  },
  offerCardBuyNowTextDisabled: {
    color: '#9CA3AF',
  },
  offerCardTrustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    marginTop: 10,
  },
  offerCardTrustText: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '500',
  },

  // ── Compact product strip ────────────────────────────────────────────────
  productStrip: {
    marginHorizontal: 14,
    marginTop: 10,
    padding: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
  },
  stripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  imageWrap: {
    width: 56,
    height: 56,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#F5F3EE',
  },
  image: { width: 56, height: 56 },
  imageFallback: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#F5F3EE',
  },

  // Left identity column — title + collapsed meta line (variant · SKU)
  info: { flex: 1 },
  title: { fontSize: 14, fontWeight: '600', color: '#1C1917', lineHeight: 18 },
  metaLine: { fontSize: 11, color: '#9CA3AF', fontWeight: '500', marginTop: 3 },

  // Price + stock sit left-aligned under the meta line, directly above buttons.
  priceStockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },

  // ── Offer-aware product strip additions ────────────────────────────────
  // Header row holds the SPECIAL OFFER text on the left and the inline flame
  // countdown on the right — one clean line above the product title.
  offerHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 2,
    gap: 8,
  },
  // SPECIAL OFFER — plain inline text, no pill / border / background.
  offerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  offerBadgeText: {
    fontSize: 13,
    fontWeight: '900',
    color: '#92660A',
    letterSpacing: 1.0,
  },
  // Inline flame countdown on the right — no background, no border, no pill.
  offerCountdownInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  offerCountdownText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#DC2626',
  },
  offerCountdownTime: {
    fontSize: 12,
    fontWeight: '800',
    color: '#DC2626',
    fontVariant: ['tabular-nums'],
  },
  // Offer price line: quoted price + strikethrough original + stock dot on one row.
  offerPriceLineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
    flexWrap: 'wrap',
  },
  offerStripOriginal: {
    fontSize: 11,
    fontWeight: '500',
    color: '#9CA3AF',
    textDecorationLine: 'line-through',
  },
  offerStripStockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginLeft: 'auto',
  },
  offerStripSavings: {
    fontSize: 11,
    fontWeight: '600',
    color: '#059669',
    marginTop: 3,
  },
  price: { fontSize: 15, fontWeight: '700', color: '#1C1917' },
  qtyStepper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F5F3EE',
    borderRadius: 999,
    paddingHorizontal: 2,
    height: 26,
    minWidth: 74,
  },
  qtyBtn: {
    width: 24, height: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  qtyValue: {
    minWidth: 18,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '600',
    color: '#1C1917',
  },
  stockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  stockDot: { width: 5, height: 5, borderRadius: 2.5 },
  stockLabel: { fontSize: 10, color: '#9CA3AF', fontWeight: '500' },

  // Action row — 32 px buttons. Add to Cart outline, Buy Now filled yellow.
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  addCartBtn: {
    flex: 1,
    height: 32,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: XSELF_YELLOW,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addCartText: { fontSize: 12, fontWeight: '600', color: XSELF_YELLOW },
  buyNowBtn: {
    flex: 1,
    height: 32,
    borderRadius: 8,
    backgroundColor: XSELF_YELLOW,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buyNowText: { fontSize: 12, fontWeight: '700', color: '#FFFFFF' },
  ctaBtnDisabled:     { borderColor: '#E5E7EB', backgroundColor: '#F3F4F6' },
  ctaBtnTextDisabled: { color: '#9CA3AF' },

  // ── Chat ─────────────────────────────────────────────────────────────────
  listContent: { paddingHorizontal: 14, paddingTop: 14, paddingBottom: 12 },

  emptyWrap: { alignItems: 'center', paddingHorizontal: 24 },
  emptyBadge: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#FFFFFF',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.04, shadowOffset: { width: 0, height: 1 }, shadowRadius: 3,
    elevation: 1,
    marginBottom: 12,
  },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#1C1917' },
  emptyBody:  { fontSize: 12, color: '#6B7280', marginTop: 4, textAlign: 'center', lineHeight: 17 },

  row: { marginVertical: 4, flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  rowLeft:  { justifyContent: 'flex-start' },
  rowRight: { justifyContent: 'flex-end' },

  // Fixed Xself Concierge avatar — circle 36px, thin Xself Gold border, Xself
  // app-icon symbol mark filling the circle (its native teal field is the
  // visible interior; cream backgroundColor is intentionally omitted).
  // Inner image is sized slightly larger than the circle so the symbol mark
  // scales up and visible teal padding shrinks — the X never touches the ring.
  conciergeAvatar: {
    width: 36, height: 36, borderRadius: 18,
    borderWidth: 1, borderColor: XSELF_YELLOW,
    overflow: 'hidden',
  },
  conciergeAvatarLogo: { width: 39, height: 39, opacity: 0.93 },
  // Same width as the avatar — keeps bubble alignment stable for earlier
  // messages in a consecutive support-message group when the avatar is hidden.
  conciergeSpacer: { width: 36 },

  bubbleColumn: {
    maxWidth: '78%',
  },
  bubbleColumnUser: { alignItems: 'flex-end' },
  bubbleColumnAgent: { alignItems: 'flex-start' },

  bubble: {
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 18,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 3,
    marginRight: 2,
  },
  statusText:   { fontSize: 10, color: '#9CA3AF', fontWeight: '500' },
  statusFailed: { fontSize: 10, color: '#DC2626', fontWeight: '500' },
  bubbleUser: {
    backgroundColor: '#E8E1D4',
    borderBottomRightRadius: 6,
  },
  bubbleAgent: {
    backgroundColor: '#FFFFFF',
    borderBottomLeftRadius: 6,
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)',
    shadowColor: '#000', shadowOpacity: 0.03, shadowOffset: { width: 0, height: 1 }, shadowRadius: 2,
    elevation: 1,
  },
  bubbleAgentName: { fontSize: 11, color: '#9CA3AF', marginBottom: 2, fontWeight: '500' },
  bubbleTextUser:  { fontSize: 14, color: '#1C1917', lineHeight: 19 },
  bubbleTextAgent: { fontSize: 14, color: '#1C1917', lineHeight: 19 },

  // ── Composer ─────────────────────────────────────────────────────────────
  composerWrap: {
    backgroundColor: '#F3F1EB',
    borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.06)',
    paddingHorizontal: 14, paddingTop: 10,
  },
  sendError: { fontSize: 12, color: '#B45309', marginBottom: 6 },
  composerRow: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 10,
  },
  input: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10,
    minHeight: 40, maxHeight: 120,
    fontSize: 14, color: '#1C1917',
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)',
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: XSELF_YELLOW,
    alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#D1CDC2' },
});
