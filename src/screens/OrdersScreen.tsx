import React, { useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Image,
  StyleSheet, Modal, TextInput, Share, Alert, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { useRewards, getReferralLink } from '../context/RewardsContext';
import { useOrders, PlacedOrder, OrderFulfillmentGroup } from '../context/OrdersContext';
import { formatPickupDate, PICKUP_TIME_WINDOW } from '../services/pickupDateService';

const STATUS_COLORS: Record<string, string> = {
  delivered:      '#16A34A',
  shipped:        '#2563EB',
  processing:     '#F59E0B',
  pending_pickup: '#CA8A04',
  ready_for_pickup: '#0D5F67',
  picked_up:      '#16A34A',
};
const STATUS_ICONS: Record<string, any> = {
  delivered:      'checkmark-circle',
  shipped:        'cube-outline',
  processing:     'time-outline',
  pending_pickup: 'storefront-outline',
  ready_for_pickup: 'storefront',
  picked_up:      'checkmark-circle',
};
const STATUS_LABELS: Record<string, string> = {
  delivered:      'Delivered',
  shipped:        'Shipped',
  processing:     'Processing',
  pending_pickup: 'Pending Pickup',
  ready_for_pickup: 'Ready for Pickup',
  picked_up:      'Picked Up',
};
const STEP_ACTIVE: Record<string, number> = { processing: 0, shipped: 1, delivered: 2 };
const PICKUP_STEP_ACTIVE: Record<string, number> = {
  pending_pickup: 0, ready_for_pickup: 1, picked_up: 2,
};

interface ReviewTarget {
  itemName: string;
  itemImg: string;
  itemSku: string;
  orderId: string;
}

interface ShareTarget {
  name: string;
  img: string;
  price: number;
}

export default function OrdersScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { trackClick } = useRewards();
  const { orders } = useOrders();

  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [reviewStars, setReviewStars] = useState(5);
  const [reviewText, setReviewText] = useState('');
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [reviewImages, setReviewImages] = useState<string[]>([]);

  const pickImage = () => {
    Alert.alert('Add Photo', '', [
      {
        text: 'Take Photo', onPress: async () => {
          const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 });
          if (!result.canceled) setReviewImages(prev => [...prev, result.assets[0].uri].slice(0, 5));
        },
      },
      {
        text: 'Choose from Library', onPress: async () => {
          const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
          if (!result.canceled) setReviewImages(prev => [...prev, result.assets[0].uri].slice(0, 5));
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const submitReview = () => {
    if (!reviewTarget) return;
    const { itemName, itemImg, itemSku, orderId } = reviewTarget;
    setReviewed(prev => new Set([...prev, `${orderId}-${itemSku}`]));
    setReviewTarget(null);
    setReviewText('');
    setReviewStars(5);
    setReviewImages([]);
    setTimeout(() => setShareTarget({ name: itemName, img: itemImg, price: 0 }), 350);
  };

  const handleShare = async (target: ShareTarget) => {
    try {
      trackClick();
      await Share.share({
        message: `I love my ${target.name} from Xself Home! ${getReferralLink(0, 'orders')}`,
      });
    } catch {}
    setShareTarget(null);
  };

  const renderOrder = ({ item: order }: { item: PlacedOrder }) => {
    const isPickupOrder = order.status === 'pending_pickup' || order.status === 'ready_for_pickup' || order.status === 'picked_up';
    const activeStep = isPickupOrder
      ? (PICKUP_STEP_ACTIVE[order.status] ?? 0)
      : (STEP_ACTIVE[order.status] ?? 0);
    const isCompleted = order.status === 'delivered' || order.status === 'picked_up';
    const color = STATUS_COLORS[order.status] ?? '#F59E0B';

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View>
            <Text style={styles.orderId}>{order.orderNumber} · <Text style={styles.orderTotal}>${order.total}</Text></Text>
            <Text style={styles.orderDate}>{order.date}</Text>
          </View>
          <View style={[styles.badge, { backgroundColor: color + '18' }]}>
            <Ionicons name={STATUS_ICONS[order.status] ?? 'time-outline'} size={11} color={color} />
            <Text style={[styles.badgeText, { color }]}>
              {STATUS_LABELS[order.status] ?? order.status}
            </Text>
          </View>
        </View>

        {!isCompleted && !isPickupOrder && (
          <View style={styles.tracker}>
            {(['Ordered', 'Shipped', 'Delivered'] as const).map((step, i) => (
              <React.Fragment key={step}>
                <View style={styles.stepWrap}>
                  <View style={[styles.stepDot, i <= activeStep && styles.stepDotActive]}>
                    {i <= activeStep && <Ionicons name="checkmark" size={8} color="white" />}
                  </View>
                  <Text style={[styles.stepLabel, i <= activeStep && styles.stepLabelActive]}>{step}</Text>
                </View>
                {i < 2 && <View style={[styles.stepLine, i < activeStep && styles.stepLineActive]} />}
              </React.Fragment>
            ))}
          </View>
        )}

        {isPickupOrder && !isCompleted && (
          <View style={styles.tracker}>
            {(['Ordered', 'Ready for Pickup', 'Picked Up'] as const).map((step, i) => (
              <React.Fragment key={step}>
                <View style={styles.stepWrap}>
                  <View style={[styles.stepDot, i <= activeStep && styles.stepDotActive]}>
                    {i <= activeStep && <Ionicons name="checkmark" size={8} color="white" />}
                  </View>
                  <Text style={[styles.stepLabel, i <= activeStep && styles.stepLabelActive]}>{step}</Text>
                </View>
                {i < 2 && <View style={[styles.stepLine, i < activeStep && styles.stepLineActive]} />}
              </React.Fragment>
            ))}
          </View>
        )}

        {/* Fulfillment groups — shown when present; old orders fall through to flat items */}
        {order.fulfillmentGroups && order.fulfillmentGroups.length > 0 && (
          <View style={styles.fulfillSection}>
            {order.fulfillmentGroups.length > 1 && (
              <Text style={styles.fulfillSectionNote}>
                Split across {order.fulfillmentGroups.length} warehouses
              </Text>
            )}
            {order.fulfillmentGroups.map((group: OrderFulfillmentGroup, idx: number) => (
              <View
                key={group.warehouseCode}
                style={[styles.fulfillGroupBlock, idx > 0 && styles.fulfillGroupBlockBorder]}
              >
                <View style={styles.fulfillGroupMethodRow}>
                  <Ionicons
                    name={group.isPickup ? 'storefront-outline' : 'cube-outline'}
                    size={13}
                    color="#CA8A04"
                  />
                  <Text style={styles.fulfillGroupMethod}>
                    {order.fulfillmentGroups!.length > 1 ? `Shipment ${idx + 1} · ` : ''}
                    {group.isPickup ? `Pickup · ${group.warehouseLabel}` : `Ships from ${group.warehouseLabel}`}
                    {!group.isPickup && ` · $${group.shippingFee}`}
                  </Text>
                </View>
                <Text style={styles.fulfillGroupAddr}>
                  {group.warehouseAddress.replace(', United States', '')}
                </Text>
                {group.isPickup && group.pickupWindow && (
                  <View style={styles.pickupWindowRow}>
                    <Ionicons name="calendar-outline" size={11} color="#0D5F67" style={{ marginRight: 4 }} />
                    <Text style={styles.pickupWindowText}>
                      {formatPickupDate(group.pickupWindow.earliest)} – {formatPickupDate(group.pickupWindow.latest)}
                    </Text>
                    <Text style={styles.pickupWindowTime}>  {PICKUP_TIME_WINDOW}</Text>
                  </View>
                )}
                <Text style={styles.fulfillGroupItems} numberOfLines={3}>
                  {group.items.map(i => `${i.name} ×${i.qty}`).join('  ·  ')}
                </Text>
              </View>
            ))}
          </View>
        )}

        {order.items.map(item => {
          const reviewKey = `${order.orderId}-${item.sku}`;
          const hasReviewed = reviewed.has(reviewKey);
          return (
            <View key={item.sku} style={styles.item}>
              <Image source={{ uri: item.img }} style={styles.itemImg} />
              <View style={styles.itemInfo}>
                <Text style={styles.itemName}>{item.name}</Text>
                {(item.color || item.size) && (
                  <Text style={styles.itemVariant}>{[item.color, item.size].filter(Boolean).join(' · ')}</Text>
                )}
                <Text style={styles.itemSku}>SKU: {item.sku}</Text>
                <Text style={styles.itemPrice}>${item.price}</Text>
                {isCompleted && (
                  <View style={styles.actionRow}>
                    <TouchableOpacity
                      style={[styles.actionBtn, hasReviewed && styles.actionBtnReviewed]}
                      onPress={() => !hasReviewed && setReviewTarget({ itemName: item.name, itemImg: item.img, itemSku: item.sku, orderId: order.orderId })}
                    >
                      <Text style={[styles.actionText, hasReviewed && styles.actionTextReviewed]}>
                        {hasReviewed ? '✓ Reviewed' : 'Write Review'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            </View>
          );
        })}
      </View>
    );
  };

  if (orders.length === 0) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <Text style={styles.title}>My Orders</Text>
        <View style={styles.emptyState}>
          <Ionicons name="bag-outline" size={52} color="#D1CFC9" />
          <Text style={styles.emptyTitle}>No orders yet</Text>
          <Text style={styles.emptySub}>When you place an order, it will show up here.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Text style={styles.title}>My Orders</Text>
      <FlatList
        data={orders}
        renderItem={renderOrder}
        keyExtractor={item => item.orderId}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
      />

      {/* Write Review modal */}
      <Modal visible={!!reviewTarget} transparent animationType="slide" onRequestClose={() => { setReviewTarget(null); setReviewImages([]); }}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => { setReviewTarget(null); setReviewImages([]); }}>
          <TouchableOpacity style={styles.sheet} activeOpacity={1}>
            <View style={styles.handle} />
            {reviewTarget && (
              <>
                <Text style={styles.sheetTitle}>Write a Review</Text>
                <View style={styles.reviewProductRow}>
                  <Image source={{ uri: reviewTarget.itemImg }} style={styles.reviewProductImg} />
                  <Text style={styles.reviewProductName} numberOfLines={2}>{reviewTarget.itemName}</Text>
                </View>
                <View style={styles.starsRow}>
                  {[1, 2, 3, 4, 5].map(s => (
                    <TouchableOpacity key={s} onPress={() => setReviewStars(s)}>
                      <Ionicons name={s <= reviewStars ? 'star' : 'star-outline'} size={32} color="#FBBF24" />
                    </TouchableOpacity>
                  ))}
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoRow} contentContainerStyle={{ gap: 8 }}>
                  {reviewImages.map((uri, i) => (
                    <View key={i} style={styles.photoThumb}>
                      <Image source={{ uri }} style={styles.photoImg} />
                      <TouchableOpacity style={styles.photoDelete} onPress={() => setReviewImages(prev => prev.filter((_, idx) => idx !== i))}>
                        <Ionicons name="close-circle" size={18} color="#6B7280" />
                      </TouchableOpacity>
                    </View>
                  ))}
                  {reviewImages.length < 5 && (
                    <TouchableOpacity style={styles.photoAdd} onPress={pickImage}>
                      <Ionicons name="camera-outline" size={20} color="#9CA3AF" />
                      <Text style={styles.photoAddText}>Add Photos</Text>
                    </TouchableOpacity>
                  )}
                </ScrollView>
                <TextInput
                  style={styles.reviewInput}
                  placeholder="Share your experience..."
                  placeholderTextColor="#9CA3AF"
                  multiline
                  value={reviewText}
                  onChangeText={setReviewText}
                />
                <TouchableOpacity style={styles.primaryBtn} onPress={submitReview}>
                  <Text style={styles.primaryBtnText}>Submit Review</Text>
                </TouchableOpacity>
              </>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Earn Rewards modal */}
      <Modal visible={!!shareTarget} transparent animationType="fade" onRequestClose={() => setShareTarget(null)}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setShareTarget(null)}>
          <TouchableOpacity style={styles.sheet} activeOpacity={1}>
            <View style={styles.handle} />
            <View style={styles.shareHeader}>
              <Ionicons name="gift" size={28} color="#EAB320" />
              <Text style={styles.sheetTitle}>Earn Rewards</Text>
              <Text style={styles.shareSub}>Earn $5–$20 for every friend who orders</Text>
            </View>
            {shareTarget?.name ? (
              <View style={styles.shareProductRow}>
                <Image source={{ uri: shareTarget.img }} style={styles.shareProductImg} />
                <Text style={styles.shareProductName}>{shareTarget.name}</Text>
              </View>
            ) : null}
            <TouchableOpacity style={styles.primaryBtn} onPress={() => shareTarget && handleShare(shareTarget)}>
              <Ionicons name="share-outline" size={17} color="white" />
              <Text style={styles.primaryBtnText}>Share Now</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => setShareTarget(null)}>
              <Text style={styles.secondaryBtnText}>Maybe later</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F3F1EB' },
  title: { fontSize: 22, fontWeight: '600', color: '#1C1917', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  list: { padding: 16, paddingTop: 8 },

  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 80, gap: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: '#1C1917' },
  emptySub: { fontSize: 13, color: '#9CA3AF', textAlign: 'center', paddingHorizontal: 40 },

  card: { backgroundColor: 'white', borderRadius: 6, marginBottom: 16, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', padding: 14, backgroundColor: '#FAFAF9', borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  orderId: { fontSize: 13, fontWeight: '600', color: '#1C1917' },
  orderTotal: { fontSize: 13, fontWeight: '600', color: '#1C1917' },
  orderDate: { fontSize: 11, color: '#9CA3AF', marginTop: 2 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999 },
  badgeText: { fontSize: 11, fontWeight: '600' },

  tracker: { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  stepWrap: { alignItems: 'center' },
  stepDot: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#E5E7EB', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  stepDotActive: { backgroundColor: '#CA8A04' },
  stepLabel: { fontSize: 10, color: '#D1D5DB' },
  stepLabelActive: { color: '#6B7280', fontWeight: '500' },
  stepLine: { flex: 1, height: 2, backgroundColor: '#E5E7EB', marginBottom: 14, marginHorizontal: 2 },
  stepLineActive: { backgroundColor: '#CA8A04' },

  fulfillSection: { borderBottomWidth: 1, borderBottomColor: '#F3F4F6', paddingHorizontal: 14, paddingVertical: 10, backgroundColor: '#FAFAF9' },
  fulfillSectionNote: { fontSize: 11, fontWeight: '600', color: '#6B7280', letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 8 },
  fulfillGroupBlock: { paddingVertical: 6 },
  fulfillGroupBlockBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E5E7EB', marginTop: 6, paddingTop: 8 },
  fulfillGroupMethodRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
  fulfillGroupMethod: { fontSize: 13, fontWeight: '600', color: '#374151', flex: 1 },
  fulfillGroupAddr: { fontSize: 11, color: '#6B7280', marginBottom: 3, marginLeft: 18 },
  fulfillGroupItems: { fontSize: 11, color: '#374151', marginLeft: 18, lineHeight: 16 },
  pickupWindowRow: { flexDirection: 'row', alignItems: 'center', marginLeft: 18, marginTop: 3, marginBottom: 2 },
  pickupWindowText: { fontSize: 11, color: '#0D5F67', fontWeight: '500' },
  pickupWindowTime: { fontSize: 11, color: '#CA8A04', fontWeight: '500' },

  item: { flexDirection: 'row', padding: 14, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  itemImg: { width: 56, height: 56, borderRadius: 6, backgroundColor: '#F3F4F6' },
  itemInfo: { flex: 1, marginLeft: 12 },
  itemName: { fontSize: 13, fontWeight: '500', color: '#1C1917' },
  itemVariant: { fontSize: 11, color: '#6B7280', marginTop: 2 },
  itemSku: { fontSize: 10, color: '#9CA3AF', marginTop: 1, fontFamily: 'monospace' as any },
  itemPrice: { fontSize: 13, fontWeight: '600', color: '#1C1917', marginTop: 3 },
  actionRow: { flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  actionBtn: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: '#E5E7EB' },
  actionBtnReviewed: { borderColor: '#D1FAE5', backgroundColor: '#F0FDF4' },
  actionText: { fontSize: 11, color: '#1C1917', fontWeight: '500' },
  actionTextReviewed: { color: '#16A34A' },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: 'white', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, paddingBottom: 36 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: '#E5E7EB', alignSelf: 'center', marginBottom: 16 },
  sheetTitle: { fontSize: 17, fontWeight: '600', color: '#1C1917', marginBottom: 6 },

  reviewProductRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, backgroundColor: '#F9FAFB', borderRadius: 6, marginBottom: 14 },
  reviewProductImg: { width: 44, height: 44, borderRadius: 6, backgroundColor: '#F3F4F6' },
  reviewProductName: { flex: 1, fontSize: 13, fontWeight: '500', color: '#1C1917' },
  starsRow: { flexDirection: 'row', gap: 6, marginBottom: 12 },
  photoRow: { marginBottom: 12 },
  photoThumb: { width: 72, height: 72, borderRadius: 8, overflow: 'hidden' },
  photoImg: { width: 72, height: 72 },
  photoDelete: { position: 'absolute', top: 2, right: 2 },
  photoAdd: { width: 72, height: 72, borderRadius: 8, borderWidth: 1, borderColor: '#E5E7EB', borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: 4 },
  photoAddText: { fontSize: 10, color: '#9CA3AF' },
  reviewInput: { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 8, padding: 12, fontSize: 13, color: '#1C1917', height: 88, textAlignVertical: 'top', marginBottom: 14 },

  shareHeader: { alignItems: 'center', gap: 6, marginBottom: 16 },
  shareSub: { fontSize: 13, color: '#6B7280', textAlign: 'center' },
  shareProductRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: '#F9FAFB', borderRadius: 6, marginBottom: 16 },
  shareProductImg: { width: 48, height: 48, borderRadius: 6, backgroundColor: '#F3F4F6' },
  shareProductName: { fontSize: 14, fontWeight: '500', color: '#1C1917', flex: 1 },

  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#EAB320', padding: 14, borderRadius: 8, marginBottom: 10 },
  primaryBtnText: { color: 'white', fontSize: 15, fontWeight: '700' },
  secondaryBtn: { alignItems: 'center', padding: 10 },
  secondaryBtnText: { fontSize: 14, color: '#9CA3AF' },
});
