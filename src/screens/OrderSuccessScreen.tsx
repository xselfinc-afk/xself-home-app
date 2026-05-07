import React, { useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { variantUrl } from '../utils/imageVariant';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { products, formatPrice } from '../data/products';
import { useOrders } from '../context/OrdersContext';

export default function OrderSuccessScreen({ route, navigation }: any) {
  const { total, orderId, orderNumber, checkoutSessionId, userEmail, paymentIntentId } = route.params ?? {};
  // orderNumber is the display-safe identifier shown to users
  // orderId is the internal key used for ledger lookups and refunds
  const displayOrderNumber = orderNumber ?? `XS-${Math.floor(10000 + Math.random() * 90000)}`;
  const insets = useSafeAreaInsets();
  const { orders, refreshOrders } = useOrders();

  // Pull latest order state from Supabase on mount — ensures webhook-confirmed status is reflected
  useEffect(() => {
    refreshOrders().catch(e => console.log('[OrderSuccess] refresh failed:', e?.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const order = orders.find(o => o.orderId === orderId);
  const suggestions = products.filter(p => p.images.length > 0).slice(0, 6);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }} showsVerticalScrollIndicator={false}>

        {/* Confirmation header */}
        <View style={styles.header}>
          <View style={styles.iconCircle}>
            <Ionicons name="checkmark" size={36} color="#FFFFFF" />
          </View>
          <Text style={styles.title}>Order Confirmed</Text>
          <Text style={styles.subtitle}>Your order has been received.</Text>
          <Text style={styles.orderNum}>Order #: {displayOrderNumber}</Text>
          {paymentIntentId ? (
            <Text style={styles.paymentInfoText} selectable>Payment ID: {paymentIntentId}</Text>
          ) : (
            <Text style={styles.paymentInfoText}>Payment confirmed</Text>
          )}
          {total && <Text style={styles.totalLine}>Order total: <Text style={styles.totalAmt}>${formatPrice(total)}</Text></Text>}
        </View>

        {/* What's next */}
        <View style={styles.card}>
          <View style={[styles.nextRow, { borderBottomWidth: 0 }]}>
            <Ionicons name="receipt-outline" size={16} color="#CA8A04" />
            <TouchableOpacity onPress={() => navigation.navigate('Main', { screen: 'Account', params: { screen: 'Orders' } })}>
              <Text style={[styles.nextText, { color: '#CA8A04' }]}>View your order →</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Fulfillment details — when available */}
        {order?.fulfillmentGroups && order.fulfillmentGroups.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.fulfillCardTitle}>
              {order.fulfillmentGroups.length === 1 ? 'Delivery' : `Delivery · ${order.fulfillmentGroups.length} Shipments`}
            </Text>
            {order.fulfillmentGroups.map((group, idx) => (
              <View
                key={group.warehouseCode}
                style={[styles.fulfillGroup, idx > 0 && styles.fulfillGroupBorder]}
              >
                {order.fulfillmentGroups!.length > 1 && (
                  <Text style={styles.fulfillGroupLabel}>
                    Shipment {idx + 1} of {order.fulfillmentGroups!.length}
                  </Text>
                )}
                <View style={styles.fulfillGroupMethodRow}>
                  <Ionicons
                    name={group.isPickup ? 'storefront-outline' : 'cube-outline'}
                    size={13}
                    color="#CA8A04"
                  />
                  <Text style={styles.fulfillGroupMethod}>
                    {group.isPickup ? 'Warehouse Pickup — Free' : `Shipping — $${group.shippingFee}`}
                  </Text>
                </View>
                <Text style={styles.fulfillGroupWarehouse}>{group.warehouseLabel}</Text>
                <Text style={styles.fulfillGroupAddr}>
                  {group.warehouseAddress.replace(', United States', '')}
                </Text>
                <Text style={styles.fulfillGroupItems} numberOfLines={3}>
                  {group.items.map(i => `${i.name} ×${i.qty}`).join('  ·  ')}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Review incentive */}
        <TouchableOpacity style={styles.reviewBanner} onPress={() => navigation.navigate('Main', { screen: 'Earn' })} activeOpacity={0.85}>
          <View style={styles.reviewBannerLeft}>
            <Ionicons name="share-social-outline" size={18} color="#EAB320" />
            <View>
              <Text style={styles.reviewBannerTitle}>Earn $5–$20 per referral</Text>
              <Text style={styles.reviewBannerSub}>Share your link — you earn when your referral buys</Text>
            </View>
          </View>
          <Ionicons name="chevron-forward" size={16} color="#9CA3AF" />
        </TouchableOpacity>

        {/* Complete your space */}
        <Text style={styles.sectionTitle}>Complete Your Space</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.suggestRow}>
          {suggestions.map(p => (
            <TouchableOpacity
              key={p.id}
              style={styles.suggestCard}
              onPress={() => navigation.navigate('ProductDetail', { product: p })}
            >
              <Image source={{ uri: variantUrl(p.images[0], { width: 320 }) }} style={styles.suggestImg} cachePolicy="memory-disk" transition={150} />
              <Text style={styles.suggestName} numberOfLines={2}>{p.name}</Text>
              <Text style={styles.suggestPrice}>${formatPrice(p.price)}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Continue Shopping CTA */}
        <View style={styles.ctaSection}>
          <TouchableOpacity style={styles.continueBtn} onPress={() => navigation.navigate('Main', { screen: 'Home' })}>
            <Text style={styles.continueBtnText}>Continue Shopping</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F3F1EB' },

  header: { alignItems: 'center', paddingTop: 36, paddingBottom: 24, paddingHorizontal: 24 },
  iconCircle: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#EAB320', alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  title: { fontSize: 24, fontWeight: '600', color: '#1C1917', marginBottom: 6 },
  subtitle: { fontSize: 14, color: '#6B7280', textAlign: 'center', marginBottom: 4 },
  orderNum: { fontSize: 12, color: '#9CA3AF', marginTop: 6, letterSpacing: 0.5 },
  totalLine: { fontSize: 12, color: '#9CA3AF', marginTop: 4 },
  paymentInfoText: { fontSize: 11, color: '#9CA3AF', marginTop: 3, fontStyle: 'italic' },
  totalAmt: { fontSize: 12, fontWeight: '500', color: '#6B7280' },

  card: { backgroundColor: 'white', marginHorizontal: 16, borderRadius: 10, paddingHorizontal: 16, marginBottom: 12 },
  fulfillCardTitle: { fontSize: 13, fontWeight: '600', color: '#1C1917', paddingTop: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#F3F4F6', marginBottom: 4 },
  fulfillGroup: { paddingVertical: 10 },
  fulfillGroupBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E5E7EB' },
  fulfillGroupLabel: { fontSize: 11, fontWeight: '600', color: '#6B7280', letterSpacing: 0.5, textTransform: 'uppercase' as const, marginBottom: 4 },
  fulfillGroupMethodRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 4 },
  fulfillGroupMethod: { fontSize: 13, fontWeight: '600', color: '#1C1917' },
  fulfillGroupWarehouse: { fontSize: 12, color: '#374151', fontWeight: '500', marginBottom: 2, marginLeft: 20 },
  fulfillGroupAddr: { fontSize: 11, color: '#6B7280', marginBottom: 4, marginLeft: 20 },
  fulfillGroupItems: { fontSize: 11, color: '#374151', lineHeight: 16, marginLeft: 20 },
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
  suggestPrice: { fontSize: 15, fontWeight: '700', color: '#1C1917', paddingHorizontal: 8, paddingBottom: 10 },

  ctaSection: { paddingHorizontal: 16, paddingTop: 24, paddingBottom: 8 },
  continueBtn: { backgroundColor: '#EAB320', paddingVertical: 14, borderRadius: 6, alignItems: 'center' },
  continueBtnText: { color: 'white', fontSize: 15, fontWeight: '600' },
});
