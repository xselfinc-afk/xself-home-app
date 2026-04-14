import React, { useState } from 'react';
import {
  View, Text, Image, ScrollView, TouchableOpacity,
  StyleSheet, Share, Alert, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRewards } from '../context/RewardsContext';

const DELIVERED_PRODUCTS = [
  { id: 1, name: 'Minimalist Sofa', price: 1299, commission: 65, img: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400' },
  { id: 3, name: 'Modern Lamp', price: 199, commission: 10, img: 'https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400' },
];

const REFERRAL_CODE = 'JOHN2024';
const getReferralLink = (id: number) => `https://xself.app/ref/${REFERRAL_CODE}/p/${id}`;

const HISTORY_ICONS: Record<string, any> = {
  referral: 'people-outline',
  review: 'star-outline',
  purchase: 'bag-outline',
};
const HISTORY_COLORS: Record<string, string> = {
  referral: '#EAB320',
  review: '#0D5F67',
  purchase: '#CA8A04',
};

export default function EarnScreen() {
  const insets = useSafeAreaInsets();
  const { points, totalEarned, clicks, referralOrders, history, trackClick } = useRewards();
  const [redeemModal, setRedeemModal] = useState(false);

  const dollarValue = (points / 100).toFixed(2);

  const shareProduct = async (product: typeof DELIVERED_PRODUCTS[0]) => {
    try {
      trackClick();
      await Share.share({
        message: `I love my ${product.name} from Xself Home! Check it out: ${getReferralLink(product.id)}`,
      });
    } catch {}
  };

  const copyLink = (id: number) => {
    Alert.alert('Referral Link', getReferralLink(id), [{ text: 'OK' }]);
  };

  const copyCode = () => {
    Alert.alert('Referral Code Copied', `Your code: ${REFERRAL_CODE}`, [{ text: 'OK' }]);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 48 }}>
        <Text style={styles.screenTitle}>Share & Earn</Text>

        {/* Points header */}
        <View style={styles.pointsCard}>
          <View style={styles.pointsTopRow}>
            <View>
              <Text style={styles.pointsLabel}>Points Balance</Text>
              <Text style={styles.pointsValue}>{points.toLocaleString()}</Text>
              <Text style={styles.dollarEquiv}>≈ ${dollarValue} value</Text>
            </View>
            <TouchableOpacity style={styles.redeemBtn} onPress={() => setRedeemModal(true)}>
              <Text style={styles.redeemBtnText}>Redeem</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.statsRow}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{clicks}</Text>
              <Text style={styles.statLabel}>Link Clicks</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.stat}>
              <Text style={styles.statValue}>{referralOrders}</Text>
              <Text style={styles.statLabel}>Referral Orders</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.stat}>
              <Text style={styles.statValue}>{totalEarned.toLocaleString()}</Text>
              <Text style={styles.statLabel}>Total Earned (pts)</Text>
            </View>
          </View>
        </View>

        {/* Referral code */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Your Referral Code</Text>
          <View style={styles.codeCard}>
            <Text style={styles.codeText}>{REFERRAL_CODE}</Text>
            <TouchableOpacity style={styles.copyCodeBtn} onPress={copyCode}>
              <Ionicons name="copy-outline" size={14} color="#CA8A04" />
              <Text style={styles.copyCodeText}>Copy</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.codeHint}>+500 pts per referral order · +10 pts per link click</Text>
        </View>

        {/* Ready to Share */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Ready to Share</Text>
          <Text style={styles.sectionSub}>From your delivered orders</Text>
          {DELIVERED_PRODUCTS.map(product => (
            <View key={product.id} style={styles.shareCard}>
              <Image source={{ uri: product.img }} style={styles.shareImg} />
              <View style={styles.shareInfo}>
                <Text style={styles.shareName} numberOfLines={2}>{product.name}</Text>
                <View style={styles.commissionRow}>
                  <Ionicons name="gift-outline" size={12} color="#92660A" />
                  <Text style={styles.commissionText}>Earn ${product.commission} per referral</Text>
                </View>
              </View>
              <View style={styles.shareActions}>
                <TouchableOpacity style={styles.copyLinkBtn} onPress={() => copyLink(product.id)}>
                  <Ionicons name="link-outline" size={15} color="#6B7280" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.sharePrimaryBtn} onPress={() => shareProduct(product)}>
                  <Ionicons name="share-outline" size={14} color="white" />
                  <Text style={styles.sharePrimaryText}>Share</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>

        {/* Earning history */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Earning History</Text>
          <View style={styles.historyCard}>
            {history.map((entry, idx) => (
              <View
                key={entry.id}
                style={[styles.historyRow, idx === history.length - 1 && { borderBottomWidth: 0 }]}
              >
                <View style={[styles.historyIcon, { backgroundColor: HISTORY_COLORS[entry.type] + '18' }]}>
                  <Ionicons name={HISTORY_ICONS[entry.type]} size={14} color={HISTORY_COLORS[entry.type]} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.historyLabel}>{entry.label}</Text>
                  <Text style={styles.historyDate}>{entry.date}</Text>
                </View>
                <Text style={styles.historyPts}>+{entry.points} pts</Text>
              </View>
            ))}
          </View>
        </View>

        {/* How it works */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>How It Works</Text>
          <View style={styles.howCard}>
            {([
              { icon: 'share-social-outline', step: '1', text: 'Share your referral link or code' },
              { icon: 'cart-outline', step: '2', text: 'Friend places an order using your link' },
              { icon: 'gift-outline', step: '3', text: 'You earn points — redeemable for discounts' },
            ] as const).map(item => (
              <View key={item.step} style={styles.howRow}>
                <View style={styles.howStep}>
                  <Text style={styles.howStepNum}>{item.step}</Text>
                </View>
                <Ionicons name={item.icon} size={18} color="#EAB320" style={{ marginHorizontal: 10 }} />
                <Text style={styles.howText}>{item.text}</Text>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>

      {/* Redeem modal */}
      <Modal visible={redeemModal} transparent animationType="slide" onRequestClose={() => setRedeemModal(false)}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setRedeemModal(false)}>
          <TouchableOpacity style={styles.redeemSheet} activeOpacity={1}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Redeem Points</Text>
            <Text style={styles.sheetBalance}>{points.toLocaleString()} pts = ${dollarValue}</Text>
            <Text style={styles.sheetSub}>100 points = $1.00 off your next order</Text>
            {([
              { pts: 500, label: '$5 off your order' },
              { pts: 1000, label: '$10 off your order' },
              { pts: 2500, label: '$25 off — membership upgrade' },
            ]).map(opt => (
              <TouchableOpacity
                key={opt.pts}
                style={[styles.redeemOpt, points < opt.pts && styles.redeemOptDisabled]}
                disabled={points < opt.pts}
                onPress={() => {
                  setRedeemModal(false);
                  Alert.alert('Points Redeemed', `${opt.pts} pts applied as "${opt.label}".`);
                }}
              >
                <View>
                  <Text style={[styles.redeemOptPts, points < opt.pts && { color: '#9CA3AF' }]}>{opt.pts} pts</Text>
                  <Text style={styles.redeemOptLabel}>{opt.label}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={points < opt.pts ? '#D1D5DB' : '#EAB320'} />
              </TouchableOpacity>
            ))}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F3F1EB' },
  screenTitle: { fontSize: 22, fontWeight: '600', color: '#1C1917', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },

  pointsCard: { backgroundColor: 'white', marginHorizontal: 16, marginTop: 12, borderRadius: 6, padding: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  pointsTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  pointsLabel: { fontSize: 11, color: '#9CA3AF', marginBottom: 4 },
  pointsValue: { fontSize: 38, fontWeight: '700', color: '#1C1917', lineHeight: 42 },
  dollarEquiv: { fontSize: 13, color: '#CA8A04', fontWeight: '500', marginTop: 2 },
  redeemBtn: { backgroundColor: '#EAB320', paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8 },
  redeemBtnText: { color: 'white', fontSize: 13, fontWeight: '600' },
  statsRow: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#F3F4F6', paddingTop: 14 },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { fontSize: 17, fontWeight: '700', color: '#1C1917' },
  statLabel: { fontSize: 10, color: '#9CA3AF', marginTop: 2, textAlign: 'center' },
  statDivider: { width: 1, backgroundColor: '#F3F4F6' },

  section: { paddingHorizontal: 16, paddingTop: 20 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: '#1C1917', marginBottom: 4 },
  sectionSub: { fontSize: 11, color: '#9CA3AF', marginBottom: 10 },

  codeCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: 'white', borderRadius: 6, paddingHorizontal: 16, paddingVertical: 14, marginTop: 8 },
  codeText: { fontSize: 22, fontWeight: '700', color: '#1C1917', letterSpacing: 3 },
  copyCodeBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#FEF9EC', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 },
  copyCodeText: { fontSize: 12, color: '#CA8A04', fontWeight: '500' },
  codeHint: { fontSize: 11, color: '#9CA3AF', marginTop: 6 },

  shareCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'white', borderRadius: 6, padding: 12, marginBottom: 8 },
  shareImg: { width: 52, height: 52, borderRadius: 6, backgroundColor: '#F3F4F6' },
  shareInfo: { flex: 1, marginLeft: 10 },
  shareName: { fontSize: 13, fontWeight: '500', color: '#1C1917' },
  commissionRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  commissionText: { fontSize: 11, color: '#92660A', fontWeight: '500' },
  shareActions: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 8 },
  copyLinkBtn: { width: 32, height: 32, borderRadius: 8, borderWidth: 1, borderColor: '#E5E7EB', alignItems: 'center', justifyContent: 'center' },
  sharePrimaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#EAB320', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  sharePrimaryText: { color: 'white', fontSize: 12, fontWeight: '600' },

  historyCard: { backgroundColor: 'white', borderRadius: 6, overflow: 'hidden' },
  historyRow: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  historyIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  historyLabel: { fontSize: 13, color: '#1C1917', fontWeight: '500' },
  historyDate: { fontSize: 11, color: '#9CA3AF', marginTop: 2 },
  historyPts: { fontSize: 13, fontWeight: '600', color: '#CA8A04' },

  howCard: { backgroundColor: 'white', borderRadius: 6, padding: 16, gap: 14 },
  howRow: { flexDirection: 'row', alignItems: 'center' },
  howStep: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#FEF9EC', alignItems: 'center', justifyContent: 'center' },
  howStepNum: { fontSize: 12, fontWeight: '700', color: '#EAB320' },
  howText: { flex: 1, fontSize: 13, color: '#6B7280' },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  redeemSheet: { backgroundColor: 'white', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, paddingBottom: 40 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: '#E5E7EB', alignSelf: 'center', marginBottom: 16 },
  sheetTitle: { fontSize: 18, fontWeight: '600', color: '#1C1917', marginBottom: 4 },
  sheetBalance: { fontSize: 28, fontWeight: '700', color: '#EAB320', marginBottom: 4 },
  sheetSub: { fontSize: 12, color: '#9CA3AF', marginBottom: 20 },
  redeemOpt: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 8, marginBottom: 10 },
  redeemOptDisabled: { opacity: 0.4 },
  redeemOptPts: { fontSize: 16, fontWeight: '700', color: '#1C1917' },
  redeemOptLabel: { fontSize: 12, color: '#6B7280', marginTop: 2 },
});
