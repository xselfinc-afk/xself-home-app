import React from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet } from 'react-native';

export default function ProductCard({ product, onPress, style }) {
  return (
    <TouchableOpacity style={[styles.card, style]} onPress={onPress}>
      <Image source={{ uri: product.img }} style={styles.image} />
      {product.sale && (
        <View style={styles.saleBadge}>
          <Text style={styles.saleText}>SALE</Text>
        </View>
      )}
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={2}>{product.name}</Text>
        <View style={styles.priceRow}>
          <Text style={styles.price}>${product.price}</Text>
          {product.sale && <Text style={styles.originalPrice}>${product.sale}</Text>}
        </View>
        <View style={styles.rating}>
          <Text style={styles.stars}>★ {product.rating}</Text>
          <Text style={styles.reviews}>({product.reviews})</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: 'white', borderRadius: 16, overflow: 'hidden', marginBottom: 12 },
  image: { width: '100%', height: 180, backgroundColor: '#F3F4F6' },
  saleBadge: { position: 'absolute', top: 8, left: 8, backgroundColor: '#DC2626', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  saleText: { color: 'white', fontSize: 10, fontWeight: '700' },
  info: { padding: 12 },
  name: { fontSize: 14, fontWeight: '500', color: '#1C1917', marginBottom: 6 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  price: { fontSize: 18, fontWeight: '700', color: '#1C1917' },
  originalPrice: { fontSize: 14, color: '#9CA3AF', textDecorationLine: 'line-through' },
  rating: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  stars: { color: '#FBBF24', fontSize: 12 },
  reviews: { color: '#9CA3AF', fontSize: 12 },
});
