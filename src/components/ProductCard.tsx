import React, { useRef } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '../theme';
import { useCart } from '../context/CartContext';
import { useCartAnimation } from '../context/CartAnimationContext';
import { Product } from '../data/products';

export default function ProductCard({ product, onPress, style }: { product: Product; onPress: () => void; style?: object }) {
  const { addItem } = useCart();
  const { triggerAnimation } = useCartAnimation();
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const btnRef = useRef<View>(null);

  const handleQuickAdd = () => {
    addItem(product, 1);
    Animated.sequence([
      Animated.spring(scaleAnim, { toValue: 1.3, useNativeDriver: true, speed: 80, bounciness: 4 }),
      Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 2 }),
    ]).start();
    (btnRef.current as any)?.measureInWindow((x: number, y: number, w: number, h: number) => {
      triggerAnimation(x + w / 2, y + h / 2);
    });
  };

  return (
    <TouchableOpacity style={[styles.card, style]} onPress={onPress} activeOpacity={0.92}>
      <Image source={{ uri: product.img }} style={styles.image} resizeMode="cover" />
      {product.sale && (
        <View style={styles.saleBadge}>
          <Text style={styles.saleText}>−{Math.round((1 - product.price / product.sale) * 100)}%</Text>
        </View>
      )}
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={2}>{product.name}</Text>
        <View style={styles.bottomRow}>
          <View style={styles.priceRatingBlock}>
            <View style={styles.priceRow}>
              <Text style={styles.price}>${product.price}</Text>
              {product.sale && <Text style={styles.originalPrice}>${product.sale}</Text>}
            </View>
            {product.sale && (
              <Text style={styles.saveText}>Save ${product.sale - product.price}</Text>
            )}
            {product.hot && (
              <Text style={styles.urgencyText}>🔥 Selling fast</Text>
            )}
            <View style={styles.rating}>
              <Text style={styles.stars}>★ {product.rating}</Text>
              <Text style={styles.reviews}>({product.reviews})</Text>
            </View>
            <Animated.View
              ref={btnRef}
              style={[styles.quickAddWrap, { transform: [{ scale: scaleAnim }, { translateY: -15 }] }]}
            >
              <TouchableOpacity
                style={styles.quickAddBtn}
                onPress={handleQuickAdd}
                activeOpacity={0.7}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="cart-outline" size={22} color={colors.amber} />
              </TouchableOpacity>
            </Animated.View>
          </View>
        </View>
      </View>
    </TouchableOpacity>
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
    borderRadius: 6,
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
  info: { padding: spacing.md, position: 'relative' },
  name: { fontSize: 13, fontWeight: '500', color: colors.textSecondary, marginBottom: spacing.xs, paddingRight: 36 },
  bottomRow: { flexDirection: 'row' },
  priceRatingBlock: { position: 'relative', flex: 1 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  price: { fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  originalPrice: { fontSize: 12, color: colors.textTertiary, textDecorationLine: 'line-through' },
  saveText: { fontSize: 11, color: '#9CA3AF', fontWeight: '400', marginTop: 2 },
  urgencyText: { fontSize: 11, color: '#EA580C', fontWeight: '500', marginTop: 2 },
  rating: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  stars: { color: '#D4AA50', fontSize: 11 },
  reviews: { color: '#C4C0BA', fontSize: 11 },
  quickAddWrap: {
    position: 'absolute',
    right: -6,
    top: '50%',
  },
  quickAddBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1.5,
    borderColor: colors.amber,
    backgroundColor: '#FFFBF0',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
