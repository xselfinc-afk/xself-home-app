import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList, KeyboardAvoidingView,
  Platform, ActivityIndicator,
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
  SupportMessage,
} from '../services/supportService';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { Product, ProductVariant, formatPrice } from '../data/products';
import { variantUrl } from '../utils/imageVariant';
import { defaultCartItem } from '../utils/cartItem';

const SESSION_KEY = 'xself_support_session_id_v2';
const POLL_INTERVAL_MS = 8000;

// Xself yellow — matches Product Detail Buy Now / Add to Cart (App.tsx:3125-3128).
const XSELF_YELLOW = '#EAB320';

// Outgoing user messages carry a UI-only delivery status. Server-fetched
// messages from Crisp have status === undefined (no indicator rendered).
type LocalSupportMessage = SupportMessage & {
  status?: 'sending' | 'sent' | 'failed';
};

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

  const initialQty = Math.max(1, Math.min(routeQty || 1, maxQty));
  const [qty, setQty] = useState(initialQty);

  // Re-clamp local qty when the product/variant — and therefore stock — changes.
  useEffect(() => {
    setQty((q) => Math.max(1, Math.min(q, maxQty)));
  }, [maxQty]);

  const listRef = useRef<FlatList<LocalSupportMessage>>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastFingerprintRef = useRef<number>(0);
  const cancelledRef = useRef(false);
  // Tracks which product id we last pushed Crisp meta for. Resets when the
  // route's product changes, so revisiting chat with a different product
  // re-sends fresh metadata to the agent's side panel.
  const metaSentForProductIdRef = useRef<string | null>(null);

  // ── Init: load or create session ──────────────────────────────────────────
  useEffect(() => {
    cancelledRef.current = false;
    (async () => {
      try {
        let sid = await AsyncStorage.getItem(SESSION_KEY);
        if (!sid) {
          sid = await createSupportSession();
          await AsyncStorage.setItem(SESSION_KEY, sid);
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
  }, []);

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

  // Reset the "Added" indicator when the route product changes.
  useEffect(() => {
    setAddedFlash(false);
    setAddedPermanent(false);
  }, [product?.id, selectedVariant?.sku]);

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
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const empty = useMemo(
    () => (!booting && !bootError && messages.length === 0),
    [booting, bootError, messages.length],
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

  const addToCartLabel = addedPermanent ? 'View Cart' : addedFlash ? 'Added ✓' : 'Add to Cart';
  const buyNowLabel    = isOutOfStock ? 'Unavailable' : 'Buy Now';

  const minusDisabled = qty <= 1 || isOutOfStock;
  const plusDisabled  = qty >= maxQty || isOutOfStock;

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
                  await AsyncStorage.setItem(SESSION_KEY, sid);
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
            {hasProductContext && product && (
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
                    <Text style={styles.title} numberOfLines={2}>
                      {product.name}
                    </Text>
                    <Text style={styles.metaLine} numberOfLines={1}>
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
                    style={[styles.addCartBtn, isOutOfStock && styles.ctaBtnDisabled]}
                    onPress={addedPermanent
                      ? () => navigation.navigate('Main', { screen: 'Cart' })
                      : onAddToCart}
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
                      {buyNowLabel}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            <FlatList
              ref={listRef}
              data={messages}
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
