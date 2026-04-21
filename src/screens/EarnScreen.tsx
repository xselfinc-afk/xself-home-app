import React, { useState } from 'react';
import {
  View, Text, Image, ScrollView, TouchableOpacity,
  StyleSheet, Share, Alert, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useRewards, MEMBERSHIP_FEE, REFERRAL_CODE, getReferralLink } from '../context/RewardsContext';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';

const DELIVERED_PRODUCTS = [
  { id: 1, name: 'Minimalist Sofa', price: 1299, commission: 20, images: ['https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400'] },
  { id: 3, name: 'Modern Lamp', price: 199, commission: 5, images: ['https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400'] },
];

export default function EarnScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { balance, totalEarned, clicks, referralOrders, history, membershipProgress, shoppingCredit, trackClick } = useRewards();
  const { totalItems } = useCart();
  const { user } = useAuth();
  const [shareModal, setShareModal] = useState(false);

  const pctToMembership = Math.round(membershipProgress * 100);
  const leftToMembership = parseFloat(Math.max(0, MEMBERSHIP_FEE - balance).toFixed(2));

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
      // Empty cart — send to Discover so they can find products to buy with credit
      navigation.navigate('Discover');
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 48 }}>
        <Text style={styles.screenTitle}>Turn your taste into income</Text>

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
          <View style={styles.pointsTopRow}>
            <View>
              <Text style={styles.pointsLabel}>Rewards Balance</Text>
              <Text style={styles.pointsValue}>${balance.toFixed(2)}</Text>
            </View>
          </View>

          {/* Membership progress */}
          <View style={styles.membershipSection}>
            <View style={styles.membershipHeaderRow}>
              <Text style={styles.membershipLabel}>Membership · ${MEMBERSHIP_FEE}/month</Text>
              <Text style={styles.membershipPct}>{pctToMembership}%</Text>
            </View>
            <Text style={styles.membershipSubtext}>Rewards offsetting {pctToMembership}% of your membership fee</Text>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${pctToMembership}%` as any }]} />
            </View>
            <Text style={styles.progressHint}>
              {shoppingCredit > 0
                ? `+$${shoppingCredit.toFixed(2)} available for shopping`
                : `Earn $${leftToMembership.toFixed(2)} more to fully cover your fee`}
            </Text>
          </View>

          <Text style={styles.explanationText}>
            Your earnings first cover your membership. Any extra can be used for shopping.
          </Text>

          {/* CTAs */}
          <View style={styles.ctaRow}>
            <TouchableOpacity
              style={styles.startSharingBtn}
              onPress={() => setShareModal(true)}
            >
              <Text style={styles.startSharingText}>Start Sharing →</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.useShoppingBtn} onPress={handleUseShopping}>
              <Text style={styles.useShoppingText}>
                {shoppingCredit > 0 ? `Use $${shoppingCredit.toFixed(2)} →` : 'Use for Shopping →'}
              </Text>
            </TouchableOpacity>
          </View>

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
          <Text style={styles.codeHint}>Earn $5–$20 when someone buys from your link</Text>
        </View>

        {/* Ready to Share */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Ready to Share</Text>
          <Text style={styles.sectionSub}>From your delivered orders</Text>
          {DELIVERED_PRODUCTS.map(product => (
            <View key={product.id} style={styles.shareCard}>
              <Image source={{ uri: product.images[0] }} style={styles.shareImg} />
              <View style={styles.shareInfo}>
                <Text style={styles.shareName} numberOfLines={2}>{product.name}</Text>
                <View style={styles.commissionRow}>
                  <Ionicons name="gift-outline" size={12} color="#92660A" />
                  <Text style={styles.commissionText}>Earn ${product.commission} per referral purchase</Text>
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
                <View style={[styles.historyIcon, { backgroundColor: '#CA8A0418' }]}>
                  <Ionicons name="bag-outline" size={14} color="#CA8A04" />
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

        {/* How it works */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>How It Works</Text>
          <View style={styles.howCard}>
            {([
              { icon: 'share-social-outline', step: '1', text: 'Share your referral link or code' },
              { icon: 'cart-outline', step: '2', text: 'Someone buys through your link' },
              { icon: 'cash-outline', step: '3', text: 'You earn $5–$20 — covers membership or use for shopping' },
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

            {/* Referral code row */}
            <TouchableOpacity style={styles.codeCard} onPress={copyCode}>
              <Text style={styles.codeText}>{REFERRAL_CODE}</Text>
              <View style={styles.copyCodeBtn}>
                <Ionicons name="copy-outline" size={14} color="#CA8A04" />
                <Text style={styles.copyCodeText}>Copy Code</Text>
              </View>
            </TouchableOpacity>

            {/* Products */}
            {DELIVERED_PRODUCTS.map(product => (
              <View key={product.id} style={[styles.shareCard, { marginTop: 8 }]}>
                <Image source={{ uri: product.images[0] }} style={styles.shareImg} />
                <View style={styles.shareInfo}>
                  <Text style={styles.shareName} numberOfLines={1}>{product.name}</Text>
                  <Text style={styles.commissionText}>Earn ${product.commission} per purchase</Text>
                </View>
                <View style={styles.shareActions}>
                  <TouchableOpacity style={styles.copyLinkBtn} onPress={() => copyLink(product.id)}>
                    <Ionicons name="link-outline" size={15} color="#6B7280" />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.sharePrimaryBtn} onPress={async () => {
                    setShareModal(false);
                    await shareProduct(product);
                  }}>
                    <Ionicons name="share-outline" size={14} color="white" />
                    <Text style={styles.sharePrimaryText}>Share</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}

            {/* Broader sharing — not limited to delivered products */}
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
  screenTitle: { fontSize: 22, fontWeight: '600', color: '#1C1917', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },

  pointsCard: { backgroundColor: 'white', marginHorizontal: 16, marginTop: 12, borderRadius: 6, padding: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  pointsTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 },
  pointsLabel: { fontSize: 11, color: '#9CA3AF', marginBottom: 4 },
  pointsValue: { fontSize: 38, fontWeight: '700', color: '#1C1917', lineHeight: 42 },

  membershipSection: { marginBottom: 12 },
  membershipHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  membershipLabel: { fontSize: 12, color: '#6B7280', fontWeight: '500' },
  membershipPct: { fontSize: 12, color: '#CA8A04', fontWeight: '600' },
  membershipSubtext: { fontSize: 12, color: '#CA8A04', fontWeight: '500', marginBottom: 8 },
  progressTrack: { height: 6, backgroundColor: '#F3F4F6', borderRadius: 3, overflow: 'hidden', marginBottom: 6 },
  progressFill: { height: '100%', backgroundColor: '#EAB320', borderRadius: 3 },
  progressHint: { fontSize: 11, color: '#9CA3AF' },

  explanationText: { fontSize: 12, color: '#6B7280', lineHeight: 17, marginBottom: 14, paddingTop: 4 },

  ctaRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  startSharingBtn: { flex: 1, backgroundColor: '#EAB320', paddingVertical: 11, borderRadius: 8, alignItems: 'center' },
  startSharingText: { color: 'white', fontSize: 13, fontWeight: '600' },
  useShoppingBtn: { flex: 1, backgroundColor: '#FEF9EC', paddingVertical: 11, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: '#EAB320' },
  useShoppingText: { color: '#CA8A04', fontSize: 13, fontWeight: '600' },

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
  memberBonus: { fontSize: 11, color: '#CA8A04', fontWeight: '500', marginTop: 8 },

  ftcText: { fontSize: 11, color: '#9CA3AF', lineHeight: 16, paddingBottom: 8 },
  guestPromptCard: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#FEF9EC', marginHorizontal: 16, marginTop: 12, borderRadius: 6, padding: 14, gap: 10, borderWidth: 1, borderColor: '#FDE68A' },
  guestPromptTitle: { fontSize: 13, fontWeight: '600', color: '#1C1917', marginBottom: 4 },
  guestPromptSub: { fontSize: 11, color: '#6B7280', lineHeight: 16 },
  guestPromptBtn: { backgroundColor: '#EAB320', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, alignSelf: 'flex-start', marginTop: 4 },
  guestPromptBtnText: { color: 'white', fontSize: 12, fontWeight: '600' },

  browseMoreRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#F3F4F6' },
  browseMoreLabel: { fontSize: 13, fontWeight: '600', color: '#CA8A04' },
  browseMoreSub: { fontSize: 11, color: '#9CA3AF', marginTop: 2 },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  redeemSheet: { backgroundColor: 'white', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, paddingBottom: 40 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: '#E5E7EB', alignSelf: 'center', marginBottom: 16 },
  sheetTitle: { fontSize: 18, fontWeight: '600', color: '#1C1917', marginBottom: 4 },
  sheetSub: { fontSize: 12, color: '#9CA3AF', marginBottom: 16 },
});
