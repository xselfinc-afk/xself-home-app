import React from 'react';
import { View, Text, FlatList, TouchableOpacity, Image, StyleSheet, ScrollView } from 'react-native';

const orders = [
  { id: 'ORD-001', status: 'delivered', date: 'Feb 15, 2026', items: [1, 3], total: 1697 },
  { id: 'ORD-002', status: 'shipped', date: 'Feb 10, 2026', items: [4], total: 599 },
  { id: 'ORD-003', status: 'processing', date: 'Feb 18, 2026', items: [2], total: 449 },
];

const products = [
  { id: 1, name: 'Minimalist Sofa', price: 1299, img: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400' },
  { id: 2, name: 'Oak Coffee Table', price: 449, img: 'https://images.unsplash.com/photo-1532372320572-cda25653a26d?w=400' },
  { id: 3, name: 'Modern Lamp', price: 199, img: 'https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400' },
  { id: 4, name: 'Velvet Chair', price: 599, img: 'https://images.unsplash.com/photo-1551298370-9d3d53bc4dc3?w=400' },
];

const statusColors = {
  delivered: '#059669',
  shipped: '#2563EB',
  processing: '#F59E0B',
};

export default function OrdersScreen({ navigation }) {
  const getProduct = (id) => products.find(p => p.id === id);

  const renderOrder = ({ item: order }) => (
    <View style={styles.orderCard}>
      <View style={styles.orderHeader}>
        <Text style={styles.orderId}>{order.id} · {order.date}</Text>
        <View style={[styles.statusBadge, { backgroundColor: statusColors[order.status] + '20' }]}>
          <Text style={[styles.statusText, { color: statusColors[order.status] }]}>
            {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
          </Text>
        </View>
      </View>

      {order.status !== 'delivered' && (
        <View style={styles.tracking}>
          <Text style={styles.trackingText}>📍 Tracking: In Transit</Text>
          <View style={styles.steps}>
            {['Ordered', 'Shipped', 'Delivered'].map((step, i) => (
              <View key={step} style={styles.step}>
                <View style={[styles.stepDot, i <= ['delivered','shipped','processing'].indexOf(order.status) && styles.stepDotActive]} />
                <Text style={styles.stepText}>{step}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {order.items.map(productId => {
        const product = getProduct(productId);
        return (
          <View key={productId} style={styles.orderItem}>
            <Image source={{ uri: product.img }} style={styles.orderImage} />
            <View style={styles.orderInfo}>
              <Text style={styles.orderName}>{product.name}</Text>
              <Text style={styles.orderPrice}>${product.price}</Text>
            </View>
          </View>
        );
      })}

      <View style={styles.orderFooter}>
        <Text>Total</Text>
        <Text style={styles.orderTotal}>${order.total}</Text>
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>My Orders</Text>
      <FlatList data={orders} renderItem={renderOrder} keyExtractor={item => item.id} contentContainerStyle={styles.list} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAFAF9', paddingTop: 50 },
  title: { fontSize: 24, fontWeight: '600', color: '#1C1917', padding: 20 },
  list: { padding: 20 },
  orderCard: { backgroundColor: 'white', borderRadius: 16, marginBottom: 16, overflow: 'hidden' },
  orderHeader: { flexDirection: 'row', justifyContent: 'space-between', padding: 16, backgroundColor: '#F9FAFB' },
  orderId: { fontSize: 12, color: '#6B7280' },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  statusText: { fontSize: 12, fontWeight: '600' },
  tracking: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  trackingText: { fontSize: 14, color: '#1C1917', marginBottom: 12 },
  steps: { flexDirection: 'row', justifyContent: 'space-between' },
  step: { alignItems: 'center' },
  stepDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#E5E7EB', marginBottom: 4 },
  stepDotActive: { backgroundColor: '#059669' },
  stepText: { fontSize: 10, color: '#9CA3AF' },
  orderItem: { flexDirection: 'row', padding: 16, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  orderImage: { width: 60, height: 60, borderRadius: 8, backgroundColor: '#F3F4F6' },
  orderInfo: { flex: 1, marginLeft: 12, justifyContent: 'center' },
  orderName: { fontSize: 14, fontWeight: '500', color: '#1C1917' },
  orderPrice: { fontSize: 14, fontWeight: '600', color: '#1C1917', marginTop: 4 },
  orderFooter: { flexDirection: 'row', justifyContent: 'space-between', padding: 16 },
  orderTotal: { fontSize: 18, fontWeight: '700', color: '#1C1917' },
});
