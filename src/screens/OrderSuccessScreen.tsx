import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { products } from '../data/products';

const ORDER_NUMBER = `ORD-${Math.floor(10000 + Math.random() * 90000)}`;

export default function OrderSuccessScreen({ route, navigation }: any) {
  const { total } = route.params ?? {};
  const insets = useSafeAreaInsets();
  const suggestions = products.filter(p => p.img).slice(0, 6);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }} showsVerticalScrollIndicator={false}>

        {/* Confirmation header */}
        <View style={styles.header}>
          <View style={styles.iconCircle}>
            <Ionicons name="checkmark" size={36} color="#FFFFFF" />
          </View>
          <Text style={styles.title}>Order Placed!</Text>
          <Text style={styles.subtitle}>Your order {ORDER_NUMBER} has been confirmed.</Text>
          {total && <Text style={styles.totalLine}>Total charged: <Text style={styles.totalAmt}>${total}</Text></Text>}
        </View>

        {/* What's next */}
        <View style={styles.card}>
          <View style={styles.nextRow}>
            <Ionicons name="mail-outline" size={16} color="#CA8A04" />
            <Text style={styles.nextText}>Confirmation email sent to john@example.com</Text>
          </View>
          <View style={styles.nextRow}>
            <Ionicons name="cube-outline" size={16} color="#CA8A04" />
            <Text style={styles.nextText}>Ships in 1–2 business days</Text>
          </View>
          <View style={[styles.nextRow, { borderBottomWidth: 0 }]}>
            <Ionicons name="receipt-outline" size={16} color="#CA8A04" />
            <TouchableOpacity onPress={() => navigation.navigate('Orders')}>
              <Text style={[styles.nextText, { color: '#CA8A04' }]}>Track your order →</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Review incentive */}
        <TouchableOpacity style={styles.reviewBanner} onPress={() => navigation.navigate('Orders')} activeOpacity={0.85}>
          <View style={styles.reviewBannerLeft}>
            <Ionicons name="star-outline" size={18} color="#EAB320" />
            <View>
              <Text style={styles.reviewBannerTitle}>Leave a review, earn 100 pts</Text>
              <Text style={styles.reviewBannerSub}>Share your experience once your order arrives</Text>
            </View>
          </View>
          <Ionicons name="chevron-forward" size={16} color="#9CA3AF" />
        </TouchableOpacity>

        {/* You may also like */}
        <Text style={styles.sectionTitle}>You May Also Like</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.suggestRow}>
          {suggestions.map(p => (
            <TouchableOpacity
              key={p.id}
              style={styles.suggestCard}
              onPress={() => navigation.navigate('ProductDetail', { product: p })}
            >
              <Image source={{ uri: p.img }} style={styles.suggestImg} />
              <Text style={styles.suggestName} numberOfLines={2}>{p.name}</Text>
              <Text style={styles.suggestPrice}>${p.price}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </ScrollView>

      {/* Bottom CTA */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 12 }]}>
        <TouchableOpacity style={styles.continueBtn} onPress={() => navigation.navigate('Main', { screen: 'Home' })}>
          <Text style={styles.continueBtnText}>Continue Shopping</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F3F1EB' },

  header: { alignItems: 'center', paddingTop: 36, paddingBottom: 24, paddingHorizontal: 24 },
  iconCircle: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#EAB320', alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  title: { fontSize: 24, fontWeight: '600', color: '#1C1917', marginBottom: 6 },
  subtitle: { fontSize: 14, color: '#6B7280', textAlign: 'center', marginBottom: 4 },
  totalLine: { fontSize: 13, color: '#6B7280', marginTop: 4 },
  totalAmt: { fontWeight: '700', color: '#1C1917' },

  card: { backgroundColor: 'white', marginHorizontal: 16, borderRadius: 10, paddingHorizontal: 16, marginBottom: 12 },
  nextRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  nextText: { fontSize: 13, color: '#1C1917', flex: 1 },

  reviewBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FEF9EC', marginHorizontal: 16, borderRadius: 10, padding: 14, marginBottom: 24, borderWidth: 1, borderColor: '#F5D97A' },
  reviewBannerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  reviewBannerTitle: { fontSize: 13, fontWeight: '600', color: '#92660A' },
  reviewBannerSub: { fontSize: 11, color: '#9CA3AF', marginTop: 2 },

  sectionTitle: { fontSize: 15, fontWeight: '600', color: '#1C1917', paddingHorizontal: 16, marginBottom: 12 },
  suggestRow: { paddingHorizontal: 12, gap: 10 },
  suggestCard: { width: 130, backgroundColor: 'white', borderRadius: 8, overflow: 'hidden' },
  suggestImg: { width: 130, height: 110, backgroundColor: '#F3F4F6' },
  suggestName: { fontSize: 11, color: '#1C1917', fontWeight: '500', padding: 8, paddingBottom: 2, lineHeight: 15 },
  suggestPrice: { fontSize: 13, fontWeight: '700', color: '#1C1917', paddingHorizontal: 8, paddingBottom: 10 },

  bottomBar: { backgroundColor: 'rgba(255,255,255,0.97)', borderTopWidth: 1, borderTopColor: '#F3F4F6', paddingTop: 12, paddingHorizontal: 16 },
  continueBtn: { backgroundColor: '#EAB320', padding: 15, borderRadius: 8, alignItems: 'center' },
  continueBtnText: { color: 'white', fontSize: 15, fontWeight: '600' },
});
