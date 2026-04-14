import React, { useState } from 'react';
import { View, Text, Image, TouchableOpacity, ScrollView, StyleSheet, SafeAreaView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCart } from '../context/CartContext';

const VARIANT_COLORS = ['Natural', 'Walnut', 'White', 'Slate'];
const VARIANT_SIZES = ['Small', 'Medium', 'Large'];

export default function CheckoutScreen({ navigation }) {
  const { cart } = useCart();
  const insets = useSafeAreaInsets();
  const [address] = useState({
    name: 'John Doe',
    street: '123 Main St',
    city: 'New York',
    zip: '10001',
  });

  const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  const shipping = subtotal > 500 ? 0 : 29.99;
  const tax = Math.round(subtotal * 0.075);
  const total = subtotal + shipping + tax;
  const savings = cart.reduce(
    (sum, item) => (item.sale ? sum + (item.sale - item.price) * item.qty : sum),
    0
  );

  const today = new Date();
  const d1 = new Date(today); d1.setDate(today.getDate() + 2);
  const d2 = new Date(today); d2.setDate(today.getDate() + 5);
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const deliveryRange = `${fmt(d1)}–${fmt(d2)}`;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={{ paddingBottom: 140 }}>
        <Text style={styles.title}>Checkout</Text>

        {/* Shipping Address */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Shipping Address</Text>
          <TouchableOpacity style={styles.card} activeOpacity={0.85}>
            <View style={styles.cardRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.addressName}>{address.name}</Text>
                <Text style={styles.addressText}>{address.street}</Text>
                <Text style={styles.addressText}>{address.city}, {address.zip}</Text>
                <Text style={styles.deliveryEstimate}>Estimated delivery: {deliveryRange}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
            </View>
          </TouchableOpacity>
        </View>

        {/* Payment Method */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Payment Method</Text>
          <TouchableOpacity style={styles.card} activeOpacity={0.85}>
            <View style={styles.cardRow}>
              <View style={{ flex: 1 }}>
                <View style={styles.paymentRow}>
                  <Text style={styles.cardIcon}>💳</Text>
                  <Text style={styles.cardText}>Visa ending in 4242</Text>
                </View>
                <View style={styles.secureRow}>
                  <Ionicons name="lock-closed" size={11} color="#CA8A04" />
                  <Text style={styles.secureText}>Secure payment · Encrypted</Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
            </View>
          </TouchableOpacity>
        </View>

        {/* Order Summary */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Order Summary</Text>
            <TouchableOpacity onPress={() => navigation.goBack()}>
              <Text style={styles.editLink}>Edit</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.card}>
            {cart.map((item, idx) => (
              <View
                key={item.id}
                style={[styles.orderItem, idx === cart.length - 1 && { borderBottomWidth: 0 }]}
              >
                <Image source={{ uri: item.img }} style={styles.orderImg} />
                <View style={styles.orderInfo}>
                  <Text style={styles.itemName} numberOfLines={2}>{item.name}</Text>
                  <Text style={styles.itemVariants}>
                    {VARIANT_COLORS[(item.id ?? 0) % VARIANT_COLORS.length]} · {VARIANT_SIZES[(item.id ?? 0) % VARIANT_SIZES.length]}
                  </Text>
                  <View style={styles.itemBottom}>
                    <Text style={styles.itemPrice}>${item.price * item.qty}</Text>
                    <Text style={styles.itemQty}>Qty: {item.qty}</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* Totals */}
        <View style={styles.totals}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Subtotal</Text>
            <Text style={styles.rowValue}>${subtotal}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Shipping</Text>
            {shipping === 0
              ? <Text style={styles.freeText}>Free</Text>
              : <Text style={styles.rowValue}>${shipping}</Text>
            }
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Tax</Text>
            <Text style={styles.rowValue}>${tax}</Text>
          </View>
          {savings > 0 && (
            <View style={styles.savingsRow}>
              <Ionicons name="pricetag-outline" size={13} color="#CA8A04" />
              <Text style={styles.savingsText}>You saved ${savings} on this order</Text>
            </View>
          )}
          <View style={[styles.row, styles.totalRow]}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>${total}</Text>
          </View>
        </View>
      </ScrollView>

      {/* Trust row + sticky CTA */}
      <View style={[styles.stickyBar, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.trustRow}>
          <View style={styles.trustItem}>
            <Ionicons name="refresh-outline" size={13} color="#6B7280" />
            <Text style={styles.trustText}>Free Returns</Text>
          </View>
          <View style={styles.trustDivider} />
          <View style={styles.trustItem}>
            <Ionicons name="lock-closed-outline" size={13} color="#6B7280" />
            <Text style={styles.trustText}>Secure Checkout</Text>
          </View>
          <View style={styles.trustDivider} />
          <View style={styles.trustItem}>
            <Ionicons name="cube-outline" size={13} color="#6B7280" />
            <Text style={styles.trustText}>2–5 Day Delivery</Text>
          </View>
          <View style={styles.trustDivider} />
          <View style={styles.trustItem}>
            <Ionicons name="shield-checkmark-outline" size={13} color="#6B7280" />
            <Text style={styles.trustText}>Money-Back</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.placeOrderBtn} onPress={() => navigation.navigate('OrderSuccess', { total })}>
          <Text style={styles.placeOrderText}>Place Order · ${total}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F3F1EB' },
  title: { fontSize: 22, fontWeight: '600', color: '#1C1917', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },

  section: { paddingHorizontal: 20, paddingBottom: 8 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: '#1C1917', marginBottom: 12 },
  editLink: { fontSize: 13, color: '#CA8A04', fontWeight: '500' },

  card: { backgroundColor: 'white', borderRadius: 6, padding: 16 },
  cardRow: { flexDirection: 'row', alignItems: 'center' },

  addressName: { fontSize: 14, fontWeight: '600', color: '#1C1917' },
  addressText: { fontSize: 13, color: '#6B7280', marginTop: 3 },
  deliveryEstimate: { fontSize: 12, color: '#CA8A04', marginTop: 7, fontWeight: '500' },

  paymentRow: { flexDirection: 'row', alignItems: 'center' },
  cardIcon: { fontSize: 18, marginRight: 8 },
  cardText: { fontSize: 14, color: '#1C1917', fontWeight: '500' },
  secureRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  secureText: { fontSize: 11, color: '#CA8A04' },

  orderItem: { flexDirection: 'row', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  orderImg: { width: 56, height: 56, borderRadius: 6, backgroundColor: '#F3F4F6' },
  orderInfo: { flex: 1, marginLeft: 10 },
  itemName: { fontSize: 13, color: '#1C1917', fontWeight: '500', lineHeight: 18 },
  itemVariants: { fontSize: 11, color: '#9CA3AF', marginTop: 2 },
  itemBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 },
  itemPrice: { fontSize: 13, fontWeight: '600', color: '#1C1917' },
  itemQty: { fontSize: 11, color: '#9CA3AF' },

  totals: { marginHorizontal: 20, marginBottom: 8, backgroundColor: 'white', borderRadius: 6, padding: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 },
  rowLabel: { fontSize: 13, color: '#6B7280' },
  rowValue: { fontSize: 13, color: '#1C1917', fontWeight: '500' },
  freeText: { fontSize: 13, color: '#CA8A04', fontWeight: '600' },
  savingsRow: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#F0FDF4', borderRadius: 6, paddingVertical: 7, paddingHorizontal: 10, marginVertical: 4 },
  savingsText: { fontSize: 12, color: '#CA8A04', fontWeight: '500' },
  totalRow: { borderTopWidth: 1, borderTopColor: '#F3F4F6', marginTop: 6, paddingTop: 12 },
  totalLabel: { fontSize: 15, fontWeight: '600', color: '#1C1917' },
  totalValue: { fontSize: 17, fontWeight: '700', color: '#1C1917' },

  stickyBar: { backgroundColor: 'rgba(255,255,255,0.97)', borderTopWidth: 1, borderTopColor: '#F3F4F6', paddingTop: 12, paddingHorizontal: 20 },
  trustRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  trustItem: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  trustDivider: { width: 1, height: 14, backgroundColor: '#E5E7EB' },
  trustText: { fontSize: 11, color: '#6B7280' },
  placeOrderBtn: { backgroundColor: '#EAB320', padding: 15, borderRadius: 8, alignItems: 'center' },
  placeOrderText: { color: 'white', fontSize: 15, fontWeight: '600' },
});
