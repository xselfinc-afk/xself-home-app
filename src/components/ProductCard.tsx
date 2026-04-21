import React, { useRef, useState } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, Animated, Easing, NativeSyntheticEvent, ImageLoadEventData } from 'react-native';
import {
  STANDARD_CARD_RATIO,
  RatioBucket,
  cacheRatio,
  classifyRatio,
  getBucketForUrl,
  bucketContainerRatio,
  bucketResizeMode,
} from '../services/imageRatioCache';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius } from '../theme';
import { useCart } from '../context/CartContext';
import { useCartAnimation } from '../context/CartAnimationContext';
import { useRecommendations } from '../context/RecommendationContext';
import type { ProductCardModel } from '../types/productCard';

// ── Scarcity signal — returns null if no signal for this product ──────────────
function getScarcitySignal(p: ProductCardModel): { text: string; color: string } | null {
  const stock = p.stock ?? 0;
  if (stock > 0 && stock <= 3) {
    return { text: `Only ${stock} left`, color: '#EA580C' };
  }
  if (stock > 0 && stock <= 8 && (p.isBestSeller || p.isFeatured)) {
    return { text: 'Only a few left', color: '#CA8A04' };
  }
  if (p.isBestSeller && (p.sales ?? 0) > 30) {
    const n = Math.min(Math.floor((p.sales ?? 0) / 8), 28);
    return { text: `${n} bought today`, color: '#CA8A04' };
  }
  if (p.isFeatured || p.isBestSeller) {
    return { text: '🔥 Selling fast', color: '#EA580C' };
  }
  return null;
}

export default function ProductCard({
  product,
  onPress,
  style,
  flexibleRatio = false,
}: {
  product: ProductCardModel;
  onPress?: (product: ProductCardModel) => void;
  style?: object;
  /** When true, detect image aspect ratio and use appropriate bucket + contain mode (for All Products grid) */
  flexibleRatio?: boolean;
}) {
  const { addItem } = useCart();
  const { triggerAnimation } = useCartAnimation();
  const { trackAddToCart } = useRecommendations();
  const iconScale = useRef(new Animated.Value(1)).current;
  const cardScale = useRef(new Animated.Value(1)).current;
  const cartBtnRef = useRef<View>(null);
  const lastHapticAt = useRef(0);
  const [imgError, setImgError] = useState(false);

  // Ratio bucket: initialised from cache (warm), discovered via onLoad (cold)
  const [bucket, setBucket] = useState<RatioBucket | null>(() => {
    const url = product.images[0];
    return url && flexibleRatio ? getBucketForUrl(url) : null;
  });

  const handleImageLoad = (e: NativeSyntheticEvent<ImageLoadEventData>) => {
    if (!flexibleRatio) return;
    const { width, height } = e.nativeEvent.source;
    if (width > 0 && height > 0) {
      const ratio = width / height;
      const url = product.images[0];
      cacheRatio(url, ratio);
      const newBucket = classifyRatio(ratio);
      if (__DEV__) {
        console.log(
          `[ProductCard] ${product.id} ratio=${ratio.toFixed(2)} bucket=${newBucket} | ${product.name?.slice(0, 35)}`,
        );
      }
      setBucket(newBucket);
    }
  };

  // Image display properties — dynamic only in flexible mode
  const activeContainerRatio = flexibleRatio && bucket ? bucketContainerRatio(bucket) : STANDARD_CARD_RATIO;
  const activeResizeMode = flexibleRatio && bucket ? bucketResizeMode(bucket) : 'cover';

  const handlePressIn = () =>
    Animated.spring(cardScale, { toValue: 0.97, useNativeDriver: true, speed: 100, bounciness: 0 }).start();
  const handlePressOut = () =>
    Animated.spring(cardScale, { toValue: 1, useNativeDriver: true, speed: 60, bounciness: 3 }).start();

  const handleAddToCart = () => {
    // Haptic — throttled to 500ms
    const now = Date.now();
    if (now - lastHapticAt.current > 500) {
      lastHapticAt.current = now;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    trackAddToCart(product.id);
    const firstVariant = product.variants?.find((v) => v.enabled && v.stock > 0);
    addItem(
      firstVariant
        ? {
            sku: firstVariant.sku,
            productId: product.id,
            name: product.name,
            price: firstVariant.price,
            img: firstVariant.images[0] ?? product.images[0],
            color: firstVariant.color,
            size: firstVariant.size,
          }
        : {
            sku: `product-${product.id}`,
            productId: product.id,
            name: product.name,
            price: product.price,
            img: product.images[0],
            color: '',
            size: '',
          },
      1,
    );

    // Icon animation: 1 → 0.92 → 1.06 → 1 (~160ms)
    Animated.sequence([
      Animated.timing(iconScale, { toValue: 0.92, duration: 50, useNativeDriver: true, easing: Easing.out(Easing.quad) }),
      Animated.timing(iconScale, { toValue: 1.06, duration: 70, useNativeDriver: true, easing: Easing.out(Easing.quad) }),
      Animated.timing(iconScale, { toValue: 1, duration: 50, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
    ]).start();

    (cartBtnRef.current as any)?.measureInWindow((x: number, y: number, w: number, h: number) => {
      triggerAnimation(x + w / 2, y + h / 2, product.images[0] ?? '');
    });
  };

  const scarcitySignal = getScarcitySignal(product);
  const saveAmount = product.originalPrice ? product.originalPrice - product.price : 0;
  const savePct = product.originalPrice ? Math.round((1 - product.price / product.originalPrice) * 100) : 0;

  return (
    <Animated.View style={[styles.card, style, { transform: [{ scale: cardScale }] }]}>
      <TouchableOpacity
        onPress={() => onPress?.(product)}
        activeOpacity={0.92}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
      >
        {imgError
          ? <View style={[styles.image, { aspectRatio: activeContainerRatio }]} />
          : <Image
              source={{ uri: product.images[0] }}
              style={[styles.image, { aspectRatio: activeContainerRatio }]}
              resizeMode={activeResizeMode}
              onError={() => setImgError(true)}
              onLoad={handleImageLoad}
            />
        }
        {product.originalPrice && (
          <View style={styles.saleBadge}>
            <Text style={styles.saleText}>−{savePct}%</Text>
          </View>
        )}

        <View style={styles.info}>
          {/* Title */}
          <Text style={styles.name} numberOfLines={2}>{product.displayTitle ?? product.name}</Text>

          {/* Price row + cart icon */}
          <View style={styles.priceRow}>
            <Text style={styles.price}>${product.price}</Text>
            <View style={styles.spacer} />
            <Animated.View ref={cartBtnRef} style={{ transform: [{ scale: iconScale }] }}>
              <TouchableOpacity
                onPress={handleAddToCart}
                style={styles.cartBtn}
                activeOpacity={0.7}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="cart-outline" size={20} color="#EAB320" />
              </TouchableOpacity>
            </Animated.View>
          </View>

          {/* Save row — amount + percentage */}
          {product.originalPrice && (
            <View style={styles.saleRow}>
              <Text style={styles.originalPrice}>${product.originalPrice}</Text>
              <Text style={styles.saveText}>Save ${saveAmount} ({savePct}%)</Text>
            </View>
          )}

          {/* One signal only: scarcity > rating */}
          {scarcitySignal ? (
            <Text style={[styles.scarcityText, { color: scarcitySignal.color }]}>
              {scarcitySignal.text}
            </Text>
          ) : (
            <View style={styles.ratingRow}>
              <Text style={styles.stars}>★ {product.rating}</Text>
              <Text style={styles.reviews}>({product.reviewCount})</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 6,
    overflow: 'hidden',
    marginBottom: 6,
  },
  image: {
    width: '100%',
    aspectRatio: 4 / 5,
    backgroundColor: colors.muted,
  },
  saleBadge: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    backgroundColor: colors.danger,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
  },
  saleText: { color: colors.surface, fontSize: 11, fontWeight: '700' },
  info: { padding: spacing.md },
  name: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    marginBottom: 6,
    lineHeight: 18,
  },
  priceRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  price: { fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  spacer: { flex: 1 },
  cartBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  saleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  originalPrice: { fontSize: 11, color: colors.textTertiary, textDecorationLine: 'line-through' },
  saveText: { fontSize: 11, color: colors.textTertiary, fontWeight: '400' },
  scarcityText: { fontSize: 11, fontWeight: '500', marginTop: 1 },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  stars: { color: '#D4AA50', fontSize: 11 },
  reviews: { color: colors.textTertiary, fontSize: 11 },
});
