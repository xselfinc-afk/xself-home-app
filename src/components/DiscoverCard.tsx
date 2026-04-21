/**
 * DiscoverCard — image-only browse card for masonry/column grids.
 *
 * Renders a single product image with a dynamic aspect ratio that resolves
 * to the actual loaded image dimensions (clamped to avoid extreme heights).
 * No price, cart, or rating — intentionally minimal for discovery browsing.
 *
 * Used by: DiscoverScreen (3-column masonry grid)
 */

import React, { useState, useRef } from 'react';
import { View, Image, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import type { ProductCardModel } from '../types/productCard';

// ── Aspect-ratio helpers ──────────────────────────────────────────────────────

// Keywords for tall/portrait furniture — used to pick a better loading placeholder ratio
const TALL_KEYWORDS = [
  'cabinet', 'pantry', 'wardrobe', 'bookshelf', 'bookcase',
  'vanity', 'armoire', 'storage tower', 'tall cabinet',
  'display cabinet', 'curio cabinet', 'mirror cabinet',
];

// Clamp image h/w to avoid extreme card heights on narrow columns
const MIN_HW = 0.70; // widest allowed: aspectRatio ≈ 1.43
const MAX_HW = 2.00; // tallest allowed: aspectRatio = 0.50

function clampHW(hw: number): number {
  return Math.max(MIN_HW, Math.min(MAX_HW, hw));
}

/** Returns the initial w/h aspectRatio to show while the image is loading. */
export function guessAspectRatio(name: string, category: string): number {
  const text = `${name} ${category}`.toLowerCase();
  const hw = TALL_KEYWORDS.some(k => text.includes(k)) ? 1.40 : 1.05;
  return 1 / hw; // convert h/w → w/h (React Native aspectRatio = width/height)
}

// ── Component ─────────────────────────────────────────────────────────────────

type Props = {
  product: ProductCardModel;
  onPress?: (product: ProductCardModel) => void;
  debugLog?: boolean;
};

export default function DiscoverCard({ product, onPress, debugLog }: Props) {
  const imageUrl = product.images?.[0] ?? '';
  const [aspectRatio, setAspectRatio] = useState<number>(
    guessAspectRatio(product.name ?? '', product.category ?? ''),
  );

  const cardScale = useRef(new Animated.Value(1)).current;
  const handlePressIn = () =>
    Animated.spring(cardScale, { toValue: 0.97, useNativeDriver: true, speed: 100, bounciness: 0 }).start();
  const handlePressOut = () =>
    Animated.spring(cardScale, { toValue: 1, useNativeDriver: true, speed: 60, bounciness: 3 }).start();

  return (
    <Animated.View style={[styles.card, { transform: [{ scale: cardScale }] }]}>
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={() => onPress?.(product)}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
    >
      <View style={[styles.imageWrap, { aspectRatio }]}>
        {imageUrl ? (
          <Image
            source={{ uri: imageUrl }}
            style={styles.image}
            resizeMode="cover"
            onLoad={(e) => {
              const { width, height } = e.nativeEvent.source;
              const hw = height / width;
              const clamped = clampHW(hw);
              const finalRatio = 1 / clamped;
              if (__DEV__ && debugLog) {
                console.log('[DiscoverCard aspect]', {
                  name: (product.name ?? '').slice(0, 50),
                  category: product.category,
                  imageSize: `${width}×${height}`,
                  naturalHW: hw.toFixed(2),
                  clampedHW: clamped.toFixed(2),
                  cardAspectRatio: finalRatio.toFixed(2),
                });
              }
              setAspectRatio(finalRatio);
            }}
          />
        ) : (
          <View style={styles.emptyImage} />
        )}
      </View>
    </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 6,
    overflow: 'hidden',
    marginBottom: 4,
    backgroundColor: '#ECEAE2',
  },
  imageWrap: {
    width: '100%',
    backgroundColor: '#ECEAE2',
  },
  image: {
    width: '100%',
    height: '100%',
    backgroundColor: '#ECEAE2',
  },
  emptyImage: {
    width: '100%',
    height: '100%',
    backgroundColor: '#ECEAE2',
  },
});
