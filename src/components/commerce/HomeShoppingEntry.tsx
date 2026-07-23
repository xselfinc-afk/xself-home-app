/**
 * HomeShoppingEntry (Phase 2) — Home's browse module set.
 *
 * NOT "the Experience Layer" (the Experience Layer is conceptual, not a widget).
 * This is simply the set of Home browse modules that carry the single canonical
 * Commerce doorway into the taxonomy:
 *   1) "Browse all categories" → the All Categories screen (canonical doorway)
 *   2) "Shop by department" → a lightweight preview rail of the ACTIVE departments
 *      (real, data-derived; each opens that Department screen)
 *
 * Rendered on Home ONLY when COMMERCE_TAXONOMY_NAVIGATION_ENABLED is true; when
 * off, the legacy "Shop by Category" circle row renders instead and Home is
 * unchanged. Every entry here is a real, working route — no dead actions, and
 * no unsupported "Shop by Need/Trip" modes.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { variantUrl } from '../../utils/imageVariant';
import { loadSellableProducts } from '../../services/commerceCatalogLoader';
import { buildCommerceCatalog, type DepartmentNode } from '../../services/commerceCatalog';

const GOLD_DARK = '#CA8A04', GOLD_TINT = '#FBF6E9', INK = '#1C1917', SECONDARY = '#6B7280', MUTED = '#9CA3AF', LINE = 'rgba(28,25,23,0.08)', WARM = '#ECE7DE';

export default function HomeShoppingEntry({ navigation }: { navigation: any }) {
  const [depts, setDepts] = useState<DepartmentNode[]>([]);
  useEffect(() => {
    let a = true;
    loadSellableProducts().then(p => { if (a) setDepts(buildCommerceCatalog(p).departments); });
    return () => { a = false; };
  }, []);

  return (
    <View style={styles.wrap}>
      {/* Canonical Commerce doorway */}
      <TouchableOpacity style={styles.browseAll} activeOpacity={0.85} onPress={() => navigation.navigate('CommerceBrowse', { level: 'all' })}>
        <View style={styles.icon}><Ionicons name="grid-outline" size={20} color={GOLD_DARK} /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.baTitle}>Browse all categories</Text>
          <Text style={styles.baSub}>Departments, categories & product types</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color="#C8C2B8" />
      </TouchableOpacity>

      {/* Lightweight department preview (real active departments) */}
      {depts.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Shop by department</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
            {depts.map(d => (
              <TouchableOpacity key={d.id} style={styles.deptItem} activeOpacity={0.8} onPress={() => navigation.navigate('CommerceBrowse', { level: 'department', department: d.id })}>
                <View style={styles.thumb}>
                  {d.image
                    ? <Image source={{ uri: variantUrl(d.image, { width: 300 }) }} style={{ width: '100%', height: '100%' }} contentFit="cover" cachePolicy="memory-disk" transition={120} />
                    : <Ionicons name="cube-outline" size={30} color="#B8AE9C" />}
                </View>
                <Text style={styles.deptLabel} numberOfLines={1}>{d.label}</Text>
                <Text style={styles.deptCount}>{d.count} items</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingTop: 8, paddingBottom: 8 },
  browseAll: {
    marginHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: LINE, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 15,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 6, elevation: 2,
  },
  icon: { width: 40, height: 40, borderRadius: 12, backgroundColor: GOLD_TINT, alignItems: 'center', justifyContent: 'center' },
  baTitle: { fontSize: 15, fontWeight: '700', color: INK },
  baSub: { fontSize: 12, color: SECONDARY, marginTop: 1 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: INK, letterSpacing: -0.2, marginTop: 22, marginBottom: 10, marginHorizontal: 20 },
  rail: { paddingHorizontal: 16, gap: 12 },
  deptItem: { width: 128 },
  thumb: { width: 128, height: 92, borderRadius: 14, overflow: 'hidden', backgroundColor: WARM, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 6, elevation: 1 },
  deptLabel: { fontSize: 14, fontWeight: '600', color: INK, marginTop: 8 },
  deptCount: { fontSize: 11, color: MUTED, marginTop: 1 },
});
