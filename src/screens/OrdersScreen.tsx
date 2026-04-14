import React, { useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Image,
  StyleSheet, Modal, TextInput, Share, Alert, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { useRewards } from '../context/RewardsContext';

const orders = [
  { id: 'ORD-001', status: 'delivered', date: 'Feb 15, 2026', items: [1, 3], total: 1697 },
  { id: 'ORD-002', status: 'shipped', date: 'Feb 10, 2026', items: [4], total: 599 },
  { id: 'ORD-003', status: 'processing', date: 'Feb 18, 2026', items: [2], total: 449 },
];

const productData = [
  { id: 1, name: 'Minimalist Sofa', price: 1299, img: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400' },
  { id: 2, name: 'Oak Coffee Table', price: 449, img: 'https://images.unsplash.com/photo-1532372320572-cda25653a26d?w=400' },
  { id: 3, name: 'Modern Lamp', price: 199, img: 'https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400' },
  { id: 4, name: 'Velvet Chair', price: 599, img: 'https://images.unsplash.com/photo-1551298370-9d3d53bc4dc3?w=400' },
];

const STATUS_COLORS: Record<string, string> = {
  delivered: '#16A34A',
  shipped: '#2563EB',
  processing: '#F59E0B',
};
const STATUS_ICONS: Record<string, any> = {
  delivered: 'checkmark-circle',
  shipped: 'cube-outline',
  processing: 'time-outline',
};
const STEP_ACTIVE: Record<string, number> = { processing: 0, shipped: 1, delivered: 2 };

export default function OrdersScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { addPoints, trackClick } = useRewards();

  const [reviewTarget, setReviewTarget] = useState<{ productId: number; orderId: string } | null>(null);
  const [shareTarget, setShareTarget] = useState<typeof productData[0] | null>(null);
  const [reviewStars, setReviewStars] = useState(5);
  const [reviewText, setReviewText] = useState('');
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [reviewImages, setReviewImages] = useState<string[]>([]);

  const getProduct = (id: number) => productData.find(p => p.id === id)!;

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
    const product = getProduct(reviewTarget.productId);
    setReviewed(prev => new Set([...prev, `${reviewTarget.orderId}-${reviewTarget.productId}`]));
    addPoints(reviewImages.length > 0 ? 150 : 100, 'review', `Review submitted — ${product.name}`);
    setReviewTarget(null);
    setReviewText('');
    setReviewStars(5);
    setReviewImages([]);
    setTimeout(() => setShareTarget(product), 350);
  };

  const handleShare = async (product: typeof productData[0]) => {
    try {
      trackClick();
      await Share.share({
        message: `I love my ${product.name} from Xself Home! https://xself.app/ref/JOHN2024/p/${product.id}`,
      });
    } catch {}
    setShareTarget(null);
  };

  const renderOrder = ({ item: order }: { item: typeof orders[0] }) => {
    const activeStep = STEP_ACTIVE[order.status] ?? 0;
    const isDelivered = order.status === 'delivered';

    return (
      <View style={styles.card}>
        {/* Header */}
        <View style={styles.cardHeader}>
          <View>
            <Text style={styles.orderId}>{order.id} · <Text style={styles.orderTotal}>${order.total}</Text></Text>
            <Text style={styles.orderDate}>{order.date}</Text>
          </View>
          <View style={[styles.badge, { backgroundColor: STATUS_COLORS[order.status] + '18' }]}>
            <Ionicons name={STATUS_ICONS[order.status]} size={11} color={STATUS_COLORS[order.status]} />
            <Text style={[styles.badgeText, { color: STATUS_COLORS[order.status] }]}>
              {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
            </Text>
          </View>
        </View>

        {/* Progress tracker for non-delivered */}
        {!isDelivered && (
          <View style={styles.tracker}>
            {['Ordered', 'Shipped', 'Delivered'].map((step, i) => (
              <React.Fragment key={step}>
                <View style={styles.stepWrap}>
                  <View style={[styles.stepDot, i <= activeStep && styles.stepDotActive]}>
                    {i <= activeStep && <Ionicons name="checkmark" size={8} color="white" />}
                  </View>
                  <Text style={[styles.stepLabel, i <= activeStep && styles.stepLabelActive]}>{step}</Text>
                </View>
                {i < 2 && (
                  <View style={[styles.stepLine, i < activeStep && styles.stepLineActive]} />
                )}
              </React.Fragment>
            ))}
          </View>
        )}

        {/* Items */}
        {order.items.map(pid => {
          const product = getProduct(pid);
          const reviewKey = `${order.id}-${pid}`;
          const hasReviewed = reviewed.has(reviewKey);
          return (
            <View key={pid} style={styles.item}>
              <Image source={{ uri: product.img }} style={styles.itemImg} />
              <View style={styles.itemInfo}>
                <Text style={styles.itemName}>{product.name}</Text>
                <Text style={styles.itemPrice}>${product.price}</Text>
                {isDelivered && (
                  <View style={styles.actionRow}>
                    <TouchableOpacity style={[styles.actionBtn, styles.actionBtnPrimary]}>
                      <Text style={styles.actionTextPrimary}>Buy Again</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.actionBtn, hasReviewed && styles.actionBtnReviewed]}
                      onPress={() => !hasReviewed && setReviewTarget({ productId: pid, orderId: order.id })}
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

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Text style={styles.title}>My Orders</Text>
      <FlatList
        data={orders}
        renderItem={renderOrder}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
      />

      {/* Write Review modal */}
      <Modal visible={!!reviewTarget} transparent animationType="slide" onRequestClose={() => { setReviewTarget(null); setReviewImages([]); }}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => { setReviewTarget(null); setReviewImages([]); }}>
          <TouchableOpacity style={styles.sheet} activeOpacity={1}>
            <View style={styles.handle} />
            {reviewTarget && (() => {
              const product = getProduct(reviewTarget.productId);
              return (
                <>
                  <Text style={styles.sheetTitle}>Write a Review</Text>
                  <View style={styles.reviewProductRow}>
                    <Image source={{ uri: product.img }} style={styles.reviewProductImg} />
                    <Text style={styles.reviewProductName} numberOfLines={2}>{product.name}</Text>
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
                  <View style={styles.earnHint}>
                    <Ionicons name="gift-outline" size={13} color="#EAB320" />
                    <Text style={styles.earnHintText}>+100 pts for review · extra pts for photos</Text>
                  </View>
                  <TouchableOpacity style={styles.primaryBtn} onPress={submitReview}>
                    <Text style={styles.primaryBtnText}>Submit Review</Text>
                  </TouchableOpacity>
                </>
              );
            })()}
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
              <Text style={styles.sheetTitle}>Earn Rewards Rewards</Text>
              <Text style={styles.shareSub}>Earn 500 pts (=$5) for every friend who orders</Text>
            </View>
            {shareTarget && (
              <View style={styles.shareProductRow}>
                <Image source={{ uri: shareTarget.img }} style={styles.shareProductImg} />
                <View>
                  <Text style={styles.shareProductName}>{shareTarget.name}</Text>
                  <Text style={styles.shareProductPrice}>${shareTarget.price}</Text>
                </View>
              </View>
            )}
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={() => shareTarget && handleShare(shareTarget)}
            >
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

  item: { flexDirection: 'row', padding: 14, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  itemImg: { width: 56, height: 56, borderRadius: 6, backgroundColor: '#F3F4F6' },
  itemInfo: { flex: 1, marginLeft: 12 },
  itemName: { fontSize: 13, fontWeight: '500', color: '#1C1917' },
  itemPrice: { fontSize: 13, fontWeight: '600', color: '#1C1917', marginTop: 3 },
  actionRow: { flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  actionBtn: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: '#E5E7EB' },
  actionBtnPrimary: { backgroundColor: '#EAB320', borderColor: '#EAB320' },
  actionBtnReviewed: { borderColor: '#D1FAE5', backgroundColor: '#F0FDF4' },
  actionText: { fontSize: 11, color: '#1C1917', fontWeight: '500' },
  actionTextPrimary: { fontSize: 11, color: '#FFFFFF', fontWeight: '600' },
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
  reviewInput: { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 8, padding: 12, fontSize: 13, color: '#1C1917', height: 88, textAlignVertical: 'top', marginBottom: 10 },
  earnHint: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 14 },
  earnHintText: { fontSize: 12, color: '#92660A', fontWeight: '500' },

  shareHeader: { alignItems: 'center', gap: 6, marginBottom: 16 },
  shareSub: { fontSize: 13, color: '#6B7280', textAlign: 'center' },
  shareProductRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: '#F9FAFB', borderRadius: 6, marginBottom: 16 },
  shareProductImg: { width: 48, height: 48, borderRadius: 6, backgroundColor: '#F3F4F6' },
  shareProductName: { fontSize: 14, fontWeight: '500', color: '#1C1917' },
  shareProductPrice: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },

  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#EAB320', padding: 14, borderRadius: 8, marginBottom: 10 },
  primaryBtnText: { color: 'white', fontSize: 15, fontWeight: '600' },
  secondaryBtn: { alignItems: 'center', padding: 10 },
  secondaryBtnText: { fontSize: 14, color: '#9CA3AF' },
});
