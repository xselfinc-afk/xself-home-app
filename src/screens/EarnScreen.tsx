import React, { useState } from 'react';
import {
  View, Text, Image, ScrollView, TouchableOpacity,
  StyleSheet, Share, Alert, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useRewards, REFERRAL_CODE, getReferralLink } from '../context/RewardsContext';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';

const DELIVERED_PRODUCTS = [
  { id: 1, name: 'Minimalist Sofa', price: 1299, commission: 20, images: ['https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400'] },
  { id: 3, name: 'Modern Lamp', price: 199, commission: 5, images: ['https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400'] },
];

export default function EarnScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { balance, totalEarned, clicks, referralOrders, history, shoppingCredit, trackClick } = useRewards();
  const { totalItems } = useCart();
  const { user } = useAuth();
  const [shareModal, setShareModal] = useState(false);

  const shareProduct = async (product: typeof DELIVERED_PRODUCTS[0]) => {
    try {
      trackClick();
      await Share.share({
        message: `I love my ${product.name} from Xself Home! Check it out: ${getReferralLink(product.id, 'earn_screen')}`,
      });
    } catch {}
  };

  const copyLink = (id: number) => {
    Alert.alert('Referral Link', getReferralLink(id, 'earn_screen'), [{ text: 'OK' }]);
  };

  const copyCode = () => {
    Alert.alert('Referral Code Copied', `Your code: ${REFERRAL_CODE}`, [{ text: 'OK' }]);
  };

  const handleUseShopping = () => {
    if (totalItems > 0) {
      navigation.navigate('Cart');
    } else {
      navigation.navigate('Discover');
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}>

        {/* Header */}
        <Text style={styles.screenTitle}>Turn your taste into income</Text>
        <Text style={styles.screenSub}>Share your favorites and earn rewards.</Text>

        {/* Guest prompt */}
        {!user && (
          <View style={styles.guestPromptCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.guestPromptTitle}>Sign in to start earning</Text>
              <Text style={styles.guestPromptSub}>Create your share link, track referral sales, and use earnings toward membership or shopping.</Text>
            </View>
            <TouchableOpacity style={styles.guestPromptBtn} onPress={() => navigation.navigate('SignInEntry')}>
              <Text style={styles.guestPromptBtnText}>Sign In</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Balance card */}
        <View style={styles.pointsCard}>
          <Text style={styles.pointsLabel}>Rewards Balance</Text>
          <Text style={styles.pointsValue}>${balance.toFixed(2)}</Text>

          {/* Progress */}
          <View style={styles.membershipSection}>
            <Text style={styles.membershipLabel}>Rewards coming soon</Text>
          </View>

          <View style={styles.cardDivider} />

          {/* Stats */}
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
              <Text style={styles.statValue}>${totalEarned.toFixed(2)}</Text>
              <Text style={styles.statLabel}>Total Earned</Text>
            </View>
          </View>

          <View style={styles.cardDivider} />

          {/* CTAs */}
          <TouchableOpacity style={styles.startSharingBtn} onPress={() => setShareModal(true)}>
            <Text style={styles.startSharingText}>Start Sharing</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.useShoppingBtn} onPress={handleUseShopping}>
            <Text style={styles.useShoppingText}>
              {shoppingCredit > 0 ? `Use $${shoppingCredit.toFixed(2)} for Shopping` : 'Use for Shopping'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Referral code */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Your Referral Code</Text>
          <View style={styles.codeCard}>
            <Text style={styles.codeText}>{REFERRAL_CODE}</Text>
            <TouchableOpacity style={styles.copyCodeBtn} onPress={copyCode}>
              <Ionicons name="copy-outline" size={13} color="#CA8A04" />
              <Text style={styles.copyCodeText}>Copy</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.codeHint}>Earn $5–$20 when someone buys from your link</Text>
        </View>

        {/* Ready to Share */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Ready to Share</Text>
          <View style={styles.shareListCard}>
            {DELIVERED_PRODUCTS.map((product, idx) => (
              <View key={product.id} style={[styles.shareCard, idx < DELIVERED_PRODUCTS.length - 1 && styles.shareCardBorder]}>
                <Image source={{ uri: product.images[0] }} style={styles.shareImg} />
                <View style={styles.shareInfo}>
                  <Text style={styles.shareName} numberOfLines={2}>{product.name}</Text>
                  <Text style={styles.commissionText}>Earn ${product.commission} per referral</Text>
                </View>
                <View style={styles.shareActions}>
                  <TouchableOpacity style={styles.copyLinkBtn} onPress={() => copyLink(product.id)}>
                    <Ionicons name="link-outline" size={15} color="#9CA3AF" />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.sharePrimaryBtn} onPress={() => shareProduct(product)}>
                    <Text style={styles.sharePrimaryText}>Share</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* Earning History */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Earning History</Text>
          <View style={styles.historyCard}>
            {history.length === 0 && (
              <Text style={styles.historyEmpty}>No earnings yet. Start sharing to earn.</Text>
            )}
            {history.map((entry, idx) => (
              <View
                key={entry.id}
                style={[styles.historyRow, idx === history.length - 1 && { borderBottomWidth: 0 }]}
              >
                <View style={styles.historyIcon}>
                  <Ionicons name="bag-outline" size={13} color="#CA8A04" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.historyLabel}>{entry.label}</Text>
                  <Text style={styles.historyDate}>{entry.date}</Text>
                </View>
                <Text style={styles.historyPts}>+${entry.amount.toFixed(2)}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* How It Works */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>How It Works</Text>
          <View style={styles.howCard}>
            {([
              { step: '1', text: 'Share your referral link or code' },
              { step: '2', text: 'Someone buys through your link' },
              { step: '3', text: 'You earn $5–$20 per purchase' },
            ] as const).map((item, idx, arr) => (
              <View key={item.step} style={[styles.howRow, idx < arr.length - 1 && styles.howRowBorder]}>
                <View style={styles.howStep}>
                  <Text style={styles.howStepNum}>{item.step}</Text>
                </View>
                <Text style={styles.howText}>{item.text}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.memberBonus}>Members earn +30% commission on all referrals</Text>
        </View>

        {/* FTC Disclosure */}
        <View style={styles.section}>
          <Text style={styles.ftcText}>
            You may earn a commission if purchases are made through your link. Earnings apply to membership first; any excess is available as shopping credit. Membership is optional.
          </Text>
        </View>
      </ScrollView>

      {/* Share & Earn Modal */}
      <Modal visible={shareModal} transparent animationType="slide" onRequestClose={() => setShareModal(false)}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setShareModal(false)}>
          <TouchableOpacity style={styles.redeemSheet} activeOpacity={1}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Share & Earn</Text>
            <Text style={styles.sheetSub}>Share these links — earn $5–$20 when someone buys</Text>

            <TouchableOpacity style={styles.codeCard} onPress={copyCode}>
              <Text style={styles.codeText}>{REFERRAL_CODE}</Text>
              <View style={styles.copyCodeBtn}>
                <Ionicons name="copy-outline" size={13} color="#CA8A04" />
                <Text style={styles.copyCodeText}>Copy Code</Text>
              </View>
            </TouchableOpacity>

            {DELIVERED_PRODUCTS.map(product => (
              <View key={product.id} style={[styles.shareCard, { marginTop: 8 }]}>
                <Image source={{ uri: product.images[0] }} style={styles.shareImg} />
                <View style={styles.shareInfo}>
                  <Text style={styles.shareName} numberOfLines={1}>{product.name}</Text>
                  <Text style={styles.commissionText}>Earn ${product.commission} per purchase</Text>
                </View>
                <View style={styles.shareActions}>
                  <TouchableOpacity style={styles.copyLinkBtn} onPress={() => copyLink(product.id)}>
                    <Ionicons name="link-outline" size={15} color="#9CA3AF" />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.sharePrimaryBtn} onPress={async () => {
                    setShareModal(false);
                    await shareProduct(product);
                  }}>
                    <Text style={styles.sharePrimaryText}>Share</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}

            <TouchableOpacity
              style={styles.browseMoreRow}
              onPress={() => { setShareModal(false); navigation.navigate('Discover'); }}
            >
              <Ionicons name="search-outline" size={14} color="#CA8A04" />
              <View style={{ flex: 1, marginLeft: 8 }}>
                <Text style={styles.browseMoreLabel}>Browse more products to share →</Text>
                <Text style={styles.browseMoreSub}>Share any product — earn when someone buys through your link</Text>
              </View>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F3F1EB' },
  screenTitle: { fontSize: 22, fontWeight: '700', color: '#1C1917', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 2 },
  screenSub: { fontSize: 14, color: '#9CA3AF', paddingHorizontal: 20, paddingBottom: 12 },

  // Balance card
  pointsCard: { backgroundColor: 'white', marginHorizontal: 16, marginTop: 4, borderRadius: 18, padding: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 },
  pointsLabel: { fontSize: 12, color: '#9CA3AF', marginBottom: 4 },
  pointsValue: { fontSize: 38, fontWeight: '700', color: '#1C1917', lineHeight: 44, marginBottom: 16 },

  membershipSection: { marginBottom: 14 },
  membershipHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  membershipLabel: { fontSize: 12, color: '#6B7280' },
  membershipPct: { fontSize: 12, color: '#CA8A04', fontWeight: '600' },
  progressTrack: { height: 4, backgroundColor: '#F3F4F6', borderRadius: 2, overflow: 'hidden', marginBottom: 6 },
  progressFill: { height: '100%', backgroundColor: '#EAB320', borderRadius: 2 },
  progressHint: { fontSize: 11, color: '#9CA3AF' },

  cardDivider: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(0,0,0,0.07)', marginBottom: 14 },

  statsRow: { flexDirection: 'row', marginBottom: 14 },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { fontSize: 16, fontWeight: '700', color: '#1C1917' },
  statLabel: { fontSize: 10, color: '#9CA3AF', marginTop: 2, textAlign: 'center' },
  statDivider: { width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(0,0,0,0.07)' },

  startSharingBtn: { backgroundColor: '#EAB320', height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginBottom: 10, shadowColor: '#EAB320', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6, elevation: 3 },
  startSharingText: { color: 'white', fontSize: 15, fontWeight: '700', letterSpacing: 0.2 },
  useShoppingBtn: { height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(202,138,4,0.4)' },
  useShoppingText: { color: '#CA8A04', fontSize: 14, fontWeight: '500' },

  // Sections
  section: { paddingHorizontal: 16, paddingTop: 20 },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: '#1C1917', marginBottom: 10 },

  // Referral code
  codeCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: 'white', borderRadius: 14, paddingHorizontal: 18, paddingVertical: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 6, elevation: 1 },
  codeText: { fontSize: 20, fontWeight: '700', color: '#1C1917', letterSpacing: 3 },
  copyCodeBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FEF9EC', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  copyCodeText: { fontSize: 12, color: '#CA8A04', fontWeight: '500' },
  codeHint: { fontSize: 11, color: '#9CA3AF', marginTop: 8 },

  // Share products
  shareListCard: { backgroundColor: 'white', borderRadius: 16, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 1 },
  shareCard: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  shareCardBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(0,0,0,0.07)' },
  shareImg: { width: 54, height: 54, borderRadius: 10, backgroundColor: '#F3F4F6' },
  shareInfo: { flex: 1, marginLeft: 12 },
  shareName: { fontSize: 13, fontWeight: '500', color: '#1C1917', lineHeight: 18 },
  commissionText: { fontSize: 11, color: '#CA8A04', fontWeight: '500', marginTop: 4 },
  shareActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 8 },
  copyLinkBtn: { width: 32, height: 32, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: '#E5E7EB', alignItems: 'center', justifyContent: 'center' },
  sharePrimaryBtn: { backgroundColor: '#EAB320', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  sharePrimaryText: { color: 'white', fontSize: 12, fontWeight: '600' },

  // History
  historyCard: { backgroundColor: 'white', borderRadius: 16, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 1 },
  historyRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 13, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(0,0,0,0.06)' },
  historyIcon: { width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(202,138,4,0.08)', alignItems: 'center', justifyContent: 'center' },
  historyLabel: { fontSize: 13, color: '#1C1917', fontWeight: '500' },
  historyDate: { fontSize: 11, color: '#9CA3AF', marginTop: 1 },
  historyPts: { fontSize: 13, fontWeight: '600', color: '#CA8A04' },
  historyEmpty: { fontSize: 13, color: '#9CA3AF', textAlign: 'center', paddingVertical: 20 },

  // How it works
  howCard: { backgroundColor: 'white', borderRadius: 16, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 1 },
  howRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 14 },
  howRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(0,0,0,0.06)' },
  howStep: { width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(202,138,4,0.10)', alignItems: 'center', justifyContent: 'center' },
  howStepNum: { fontSize: 12, fontWeight: '700', color: '#CA8A04' },
  howText: { flex: 1, fontSize: 13, color: '#6B7280', lineHeight: 19 },
  memberBonus: { fontSize: 11, color: '#9CA3AF', marginTop: 8 },

  ftcText: { fontSize: 11, color: '#9CA3AF', lineHeight: 16, paddingBottom: 8 },

  // Guest
  guestPromptCard: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: 'white', marginHorizontal: 16, marginTop: 8, borderRadius: 14, padding: 16, gap: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 6, elevation: 1 },
  guestPromptTitle: { fontSize: 14, fontWeight: '600', color: '#1C1917', marginBottom: 4 },
  guestPromptSub: { fontSize: 12, color: '#6B7280', lineHeight: 17 },
  guestPromptBtn: { backgroundColor: '#EAB320', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, alignSelf: 'flex-start', marginTop: 4 },
  guestPromptBtnText: { color: 'white', fontSize: 12, fontWeight: '600' },

  // Modal
  browseMoreRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(0,0,0,0.07)' },
  browseMoreLabel: { fontSize: 13, fontWeight: '600', color: '#CA8A04' },
  browseMoreSub: { fontSize: 11, color: '#9CA3AF', marginTop: 2 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  redeemSheet: { backgroundColor: 'white', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 40 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: '#E5E7EB', alignSelf: 'center', marginBottom: 16 },
  sheetTitle: { fontSize: 18, fontWeight: '600', color: '#1C1917', marginBottom: 4 },
  sheetSub: { fontSize: 12, color: '#9CA3AF', marginBottom: 16 },
});
