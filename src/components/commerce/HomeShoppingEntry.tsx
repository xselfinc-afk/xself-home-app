/**
 * Home Commerce browse module (Phase 2 / 2.5).
 *
 * BrowseAllCategoriesCard → the single canonical taxonomy doorway (→ All Categories),
 * composed into the Home list HEADER (never the paginated footer) so product pagination
 * can never displace it. Rendered on Home ONLY when COMMERCE_TAXONOMY_NAVIGATION_ENABLED
 * is true; when off, the legacy "Shop by Category" circle row renders (in the footer) and
 * Home is unchanged.
 *
 * (The former ShopByDepartmentRail was removed in Phase 2.5 — its destinations are already
 * reachable via Browse all categories → Department.)
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const GOLD_DARK = '#CA8A04', GOLD_TINT = '#FBF6E9', INK = '#1C1917', SECONDARY = '#6B7280', LINE = 'rgba(28,25,23,0.08)';

/** Canonical Commerce doorway — a premium navigation card, not a settings cell. */
export function BrowseAllCategoriesCard({ navigation }: { navigation: any }) {
  return (
    <View style={styles.browseWrap}>
      <TouchableOpacity style={styles.browseAll} activeOpacity={0.85} onPress={() => navigation.navigate('CommerceBrowse', { level: 'all' })}>
        <View style={styles.icon}><Ionicons name="grid-outline" size={22} color={GOLD_DARK} /></View>
        <View style={styles.browseAllText}>
          <Text style={styles.baTitle}>Browse all categories</Text>
          <Text style={styles.baSub} numberOfLines={1}>Departments, categories & product types</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color="#C8C2B8" style={styles.baChevron} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  browseWrap: { paddingTop: 4 },
  browseAll: {
    marginHorizontal: 6, flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: LINE, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 6, elevation: 1,
  },
  icon: { width: 40, height: 40, borderRadius: 12, backgroundColor: GOLD_TINT, alignItems: 'center', justifyContent: 'center' },
  browseAllText: { flex: 1, justifyContent: 'center' },
  baTitle: { fontSize: 16, fontWeight: '700', color: INK, letterSpacing: -0.2 },
  baSub: { fontSize: 12, color: SECONDARY, marginTop: 2, lineHeight: 16 },
  baChevron: { marginLeft: 2 },
});
