/**
 * DiscoverCard — image-first browse card for the Discover 3-column grid.
 *
 * Default: product image only (4:5 ratio), completely clean.
 * Tap → animated gradient overlay reveals price + cart icon.
 * Tap again (image/price area) → navigate to product detail (caller handles).
 * Tap cart icon → add to cart, cart icon animation + flying cart animation
 *   matching ProductCard exactly.
 *
 * Cart logic is self-contained (uses hooks internally).
 * Overlay open/close managed externally (DiscoverScreen) for single-open constraint.
 */

import React, { useRef, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Image,
  StyleSheet,
  Animated,
  Easing,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useCart } from '../context/CartContext';
import { useCartAnimation } from '../context/CartAnimationContext';
import { useRecommendations } from '../context/RecommendationContext';
import { incrementProductCounter } from '../services/analyticsService';
import type { ProductCardModel } from '../types/productCard';

type Props = {
  product: ProductCardModel;
  isOverlayOpen: boolean;
  onCardPress: () => void;
};

export default function DiscoverCard({ product, isOverlayOpen, onCardPress }: Props) {
  const imageUrl = product.images?.[0] ?? '';

  const { addItem } = useCart();
  const { triggerAnimation } = useCartAnimation();
  const { trackAddToCart } = useRecommendations();

  const cartBtnRef = useRef<View>(null);
  const lastHapticAt = useRef(0);
  const [added, setAdded] = useState(false);
  const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Card press scale — matches ProductCard
  const cardScale = useRef(new Animated.Value(1)).current;
  const handlePressIn = () =>
    Animated.spring(cardScale, { toValue: 0.97, useNativeDriver: true, speed: 100, bounciness: 0 }).start();
  const handlePressOut = () =>
    Animated.spring(cardScale, { toValue: 1, useNativeDriver: true, speed: 60, bounciness: 3 }).start();

  // Overlay reveal: opacity + translateY
  const overlayAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(overlayAnim, {
      toValue: isOverlayOpen ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [isOverlayOpen]);

  const overlayTranslateY = overlayAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [8, 0],
  });

  // Cart icon scale — matches ProductCard exactly: 1 → 0.92 → 1.06 → 1 (~160ms)
  const iconScale = useRef(new Animated.Value(1)).current;

  const handleAddToCart = () => {
    const now = Date.now();
    if (now - lastHapticAt.current > 500) {
      lastHapticAt.current = now;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    trackAddToCart(product.id);
    incrementProductCounter(product.id, 'add_to_cart_count');

    addItem({
      sku: `product-${product.id}`,
      productId: product.id,
      name: product.name,
      price: product.price,
      img: product.images[0] ?? '',
      color: '',
      size: '',
    }, 1);

    setAdded(true);
    if (addedTimer.current) clearTimeout(addedTimer.current);
    addedTimer.current = setTimeout(() => setAdded(false), 1300);

    Animated.sequence([
      Animated.timing(iconScale, { toValue: 0.92, duration: 50, useNativeDriver: true, easing: Easing.out(Easing.quad) }),
      Animated.timing(iconScale, { toValue: 1.06, duration: 70, useNativeDriver: true, easing: Easing.out(Easing.quad) }),
      Animated.timing(iconScale, { toValue: 1, duration: 50, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
    ]).start();

    (cartBtnRef.current as any)?.measureInWindow((x: number, y: number, w: number, h: number) => {
      triggerAnimation(x + w / 2, y + h / 2, product.images[0] ?? '');
    });
  };

  const price = product.price != null ? `$${Math.round(product.price)}` : '';

  return (
    <Animated.View style={[styles.card, { transform: [{ scale: cardScale }] }]}>
      <TouchableOpacity
        activeOpacity={1}
        onPress={onCardPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={styles.imageWrap}
      >
        {imageUrl ? (
          <Image source={{ uri: imageUrl }} style={styles.image} resizeMode="cover" />
        ) : (
          <View style={styles.emptyImage} />
        )}

        {/* Gradient overlay — animated in/out, no touches captured when hidden */}
        <Animated.View
          style={[
            styles.overlayContainer,
            {
              opacity: overlayAnim,
              transform: [{ translateY: overlayTranslateY }],
            },
          ]}
          pointerEvents={isOverlayOpen ? 'box-none' : 'none'}
        >
          <LinearGradient
            colors={['transparent', 'rgba(0,0,0,0.38)']}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />

          <View style={styles.overlayRow} pointerEvents="box-none">
            <Text style={styles.price} pointerEvents="none">{price}</Text>

            {/* Cart icon + animation — identical to ProductCard */}
            <Animated.View
              ref={cartBtnRef}
              style={{ transform: [{ scale: iconScale }] }}
            >
              <TouchableOpacity
                onPress={handleAddToCart}
                style={styles.cartBtn}
                activeOpacity={0.7}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="cart-outline" size={20} color={added ? '#EAB320' : 'rgba(255,255,255,0.92)'} />
              </TouchableOpacity>
            </Animated.View>
          </View>
        </Animated.View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#ECEAE2',
  },
  imageWrap: {
    width: '100%',
    aspectRatio: 4 / 5,
    backgroundColor: '#ECEAE2',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  emptyImage: {
    width: '100%',
    height: '100%',
    backgroundColor: '#ECEAE2',
  },
  overlayContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '40%',
    justifyContent: 'flex-end',
  },
  overlayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  price: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '500',
    textShadowColor: 'rgba(0,0,0,0.45)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  // Matches ProductCard cartBtn exactly
  cartBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
