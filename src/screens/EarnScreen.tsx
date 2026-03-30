import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Share } from 'react-native';

const products = [
  { id: 1, name: 'Minimalist Sofa', price: 1299, commission: 194.85, img: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=100' },
  { id: 2, name: 'Oak Coffee Table', price: 449, commission: 67.35, img: 'https://images.unsplash.com/photo-1532372320572-cda25653a26d?w=100' },
  { id: 4, name: 'Velvet Chair', price: 599, commission: 89.85, img: 'https://images.unsplash.com/photo-1551298370-9d3d53bc4dc3?w=100' },
];

export default function EarnScreen() {
  const shareProduct = async (product) => {
    try {
      await Share.share({
        message: `Check out ${product.name} on Xself Home! Earn $${product.commission} commission: https://xself.app/ref/${product.id}`,
      });
    } catch (error) {}
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerLabel}>Total Earnings</Text>
        <Text style={styles.balance}>$247.50</Text>
        <View style={styles.stats}>
          <View style={styles.stat}><Text style={styles.statValue}>12</Text><Text style={styles.statLabel}>Clicks</Text></View>
          <View style={styles.stat}><Text style={styles.statValue}>3</Text><Text style={styles.statLabel}>Sales</Text></View>
          <View style={styles.stat}><Text style={styles.statValue}>15%</Text><Text style={styles.statLabel}>Commission</Text></View>
        </View>
      </View>

      <Text style={styles.sectionTitle}>Share & Earn</Text>
      {products.map(product => (
        <View key={product.id} style={styles.shareCard}>
          <View style={styles.shareInfo}>
            <Image source={{ uri: product.img }} style={styles.shareImage} />
            <View>
              <Text style={styles.shareName}>{product.name}</Text>
              <Text style={styles.shareCommission}>Earn ${product.commission}</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.shareBtn} onPress={() => shareProduct(product)}>
            <Text style={styles.shareBtnText}>Share</Text>
          </TouchableOpacity>
        </View>
      ))}

      <View style={styles.referralCode}>
        <Text style={styles.referralLabel}>Your Referral Code</Text>
        <Text style={styles.code}>JOHN2024</Text>
        <TouchableOpacity style={styles.copyBtn}>
          <Text style={styles.copyBtnText}>Copy Code</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

import { Image } from 'react-native';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAFAF9', paddingTop: 50 },
  header: { backgroundColor: '#059669', padding: 24 },
  headerLabel: { fontSize: 14, color: 'rgba(255,255,255,0.8)' },
  balance: { fontSize: 42, fontWeight: '700', color: 'white', marginVertical: 8 },
  stats: { flexDirection: 'row', marginTop: 16 },
  stat: { flex: 1, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 12, padding: 12, alignItems: 'center', marginRight: 8 },
  statValue: { fontSize: 20, fontWeight: '700', color: 'white' },
  statLabel: { fontSize: 11, color: 'rgba(255,255,255,0.8)', marginTop: 4 },
  sectionTitle: { fontSize: 18, fontWeight: '600', color: '#1C1917', padding: 20 },
  shareCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'white', marginHorizontal: 20, marginBottom: 12, borderRadius: 16, padding: 12 },
  shareInfo: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  shareImage: { width: 50, height: 50, borderRadius: 8, backgroundColor: '#F3F4F6' },
  shareName: { fontSize: 14, fontWeight: '500', color: '#1C1917', marginLeft: 12 },
  shareCommission: { fontSize: 12, color: '#059669', marginLeft: 12 },
  shareBtn: { backgroundColor: '#1C1917', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20 },
  shareBtnText: { color: 'white', fontWeight: '600' },
  referralCode: { backgroundColor: 'white', margin: 20, padding: 24, borderRadius: 16, alignItems: 'center' },
  referralLabel: { fontSize: 14, color: '#6B7280' },
  code: { fontSize: 28, fontWeight: '700', color: '#1C1917', letterSpacing: 4, marginVertical: 12 },
  copyBtn: { backgroundColor: '#F3F4F6', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 20 },
  copyBtnText: { color: '#1C1917', fontWeight: '600' },
});
