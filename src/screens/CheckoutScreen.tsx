import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';

export default function CheckoutScreen({ navigation, route }) {
  const [address, setAddress] = useState({
    name: 'John Doe',
    street: '123 Main St',
    city: 'New York',
    zip: '10001',
  });

  const cart = [
    { id: 1, name: 'Minimalist Sofa', price: 1299, qty: 1, img: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=100' },
    { id: 3, name: 'Modern Lamp', price: 199, qty: 2, img: 'https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=100' },
  ];

  const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  const shipping = subtotal > 500 ? 0 : 29.99;
  const tax = Math.round(subtotal * 0.075);
  const total = subtotal + shipping + tax;

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Checkout</Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Shipping Address</Text>
        <View style={styles.card}>
          <Text style={styles.addressName}>{address.name}</Text>
          <Text style={styles.addressText}>{address.street}</Text>
          <Text style={styles.addressText}>{address.city}, {address.zip}</Text>
          <TouchableOpacity><Text style={styles.changeBtn}>Change</Text></TouchableOpacity>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Payment Method</Text>
        <View style={styles.card}>
          <View style={styles.paymentRow}>
            <Text style={styles.cardIcon}>💳</Text>
            <Text style={styles.cardText}>Visa ending in 4242</Text>
          </View>
          <TouchableOpacity><Text style={styles.changeBtn}>Change</Text></TouchableOpacity>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Order Summary</Text>
        {cart.map(item => (
          <View key={item.id} style={styles.cartItem}>
            <Text style={styles.itemName}>{item.name} x{item.qty}</Text>
            <Text style={styles.itemPrice}>${item.price * item.qty}</Text>
          </View>
        ))}
      </View>

      <View style={styles.totals}>
        <View style={styles.row}><Text>Subtotal</Text><Text>${subtotal}</Text></View>
        <View style={styles.row}><Text>Shipping</Text><Text>{shipping === 0 ? 'Free' : `$${shipping}`}</Text></View>
        <View style={styles.row}><Text>Tax</Text><Text>${tax}</Text></View>
        <View style={[styles.row, styles.totalRow]}><Text style={styles.totalLabel}>Total</Text><Text style={styles.totalValue}>${total}</Text></View>
      </View>

      <TouchableOpacity style={styles.placeOrderBtn}>
        <Text style={styles.placeOrderText}>Place Order - ${total}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAFAF9', paddingTop: 50 },
  title: { fontSize: 24, fontWeight: '600', color: '#1C1917', padding: 20 },
  section: { padding: 20 },
  sectionTitle: { fontSize: 16, fontWeight: '600', color: '#1C1917', marginBottom: 12 },
  card: { backgroundColor: 'white', borderRadius: 16, padding: 16 },
  addressName: { fontSize: 16, fontWeight: '600', color: '#1C1917' },
  addressText: { fontSize: 14, color: '#6B7280', marginTop: 4 },
  changeBtn: { color: '#CA8A04', fontWeight: '600', marginTop: 8 },
  paymentRow: { flexDirection: 'row', alignItems: 'center' },
  cardIcon: { fontSize: 24, marginRight: 12 },
  cardText: { fontSize: 14, color: '#1C1917' },
  cartItem: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  itemName: { fontSize: 14, color: '#1C1917' },
  itemPrice: { fontSize: 14, fontWeight: '600', color: '#1C1917' },
  totals: { padding: 20, backgroundColor: 'white', margin: 20, borderRadius: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  totalRow: { borderTopWidth: 1, borderTopColor: '#F3F4F6', marginTop: 8, paddingTop: 16 },
  totalLabel: { fontSize: 18, fontWeight: '600', color: '#1C1917' },
  totalValue: { fontSize: 18, fontWeight: '700', color: '#1C1917' },
  placeOrderBtn: { backgroundColor: '#1C1917', margin: 20, padding: 18, borderRadius: 24, alignItems: 'center' },
  placeOrderText: { color: 'white', fontSize: 16, fontWeight: '600' },
});
