/**
 * CommerceBrowseScreen (Phase 2, Commerce Layer) — one parametrized browse screen
 * for the three non-leaf levels: All Categories → Department → Category. Data is
 * the live sellable_products catalog grouped by classifyCommerce. Tapping a
 * Product Type opens CommerceResults directly (no standalone context page).
 *
 * route.params: { level: 'all' | 'department' | 'category', department?, category?, anchor? }
 * Reached only when COMMERCE_TAXONOMY_NAVIGATION_ENABLED is on (Home/Discover
 * entries are flag-gated); legacy screens are untouched.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { variantUrl } from '../../utils/imageVariant';
import { loadSellableProducts } from '../../services/commerceCatalogLoader';
import { buildCommerceCatalog, type CommerceCatalog, type DepartmentNode, type CategoryNode } from '../../services/commerceCatalog';
import type { Product } from '../../data/products';

const CANVAS = '#F3F1EB', INK = '#1C1917', SECONDARY = '#6B7280', MUTED = '#9CA3AF', LINE = 'rgba(0,0,0,0.06)', WARM = '#ECE7DE', GOLD_DARK = '#CA8A04';
const PRIMARY_DEPT_MIN = 5; // depts below this show under "Also available"

function Thumb({ uri, size = 44, radius = 12 }: { uri?: string; size?: number; radius?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: radius, overflow: 'hidden', backgroundColor: WARM, alignItems: 'center', justifyContent: 'center' }}>
      {uri
        ? <Image source={{ uri: variantUrl(uri, { width: 240 }) }} style={{ width: '100%', height: '100%' }} contentFit="cover" cachePolicy="memory-disk" transition={120} />
        : <Ionicons name="cube-outline" size={size * 0.42} color="#B8AE9C" />}
    </View>
  );
}

export default function CommerceBrowseScreen({ route, navigation }: any) {
  const { level = 'all', department, category } = route.params ?? {};
  const insets = useSafeAreaInsets();
  const [products, setProducts] = useState<Product[] | null>(null);

  useEffect(() => { let a = true; loadSellableProducts().then(p => { if (a) setProducts(p); }); return () => { a = false; }; }, []);
  const catalog: CommerceCatalog | null = useMemo(() => (products ? buildCommerceCatalog(products) : null), [products]);

  const back = () => navigation.goBack();
  const openDept = (d: string) => navigation.navigate('CommerceBrowse', { level: 'department', department: d });
  const openCat = (d: string, c: string) => navigation.navigate('CommerceBrowse', { level: 'category', department: d, category: c });
  const openResults = (p: { department?: string; category?: string; productType?: string }) => navigation.navigate('CommerceResults', p);

  const Header = ({ title, sub, parent }: { title: string; sub?: string; parent?: string }) => (
    <View>
      <View style={[styles.topbar, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity onPress={back} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={20} color="#57534E" />
          {parent ? <Text style={styles.backLbl}>{parent}</Text> : null}
        </TouchableOpacity>
      </View>
      <View style={styles.head}>
        <Text style={styles.h1}>{title}</Text>
        {sub ? <Text style={styles.sub}>{sub}</Text> : null}
      </View>
    </View>
  );

  if (!catalog) {
    return <View style={[styles.container, { paddingTop: insets.top }]}><View style={styles.loading}><ActivityIndicator size="small" color="#EAB320" /></View></View>;
  }

  const bottomPad = { paddingBottom: insets.bottom + 32 };

  // ── Level: ALL CATEGORIES ──
  if (level === 'all') {
    const primary = catalog.departments.filter(d => d.count >= PRIMARY_DEPT_MIN);
    const also = catalog.departments.filter(d => d.count < PRIMARY_DEPT_MIN);
    return (
      <ScrollView style={styles.container} contentContainerStyle={bottomPad} showsVerticalScrollIndicator={false}>
        <Header title="All Categories" parent="Home" />
        {primary.map(d => (
          <View key={d.id} style={styles.deptBlock}>
            <TouchableOpacity style={styles.deptHead} activeOpacity={0.7} onPress={() => openDept(d.id)}>
              <Thumb uri={d.image} size={30} radius={9} />
              <Text style={styles.deptName}>{d.label}</Text>
              <Text style={styles.deptCount}>{d.count} items</Text>
              <Ionicons name="chevron-forward" size={16} color="#C8C2B8" />
            </TouchableOpacity>
            <View style={styles.cellGrid}>
              {d.categories.map(c => (
                <TouchableOpacity key={c.id} style={styles.cell} activeOpacity={0.75} onPress={() => openCat(d.id, c.id)}>
                  <Text style={styles.cellLabel} numberOfLines={2}>{c.label}</Text>
                  <Text style={styles.cellCount}>{c.count}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ))}
        {also.length > 0 && (
          <View style={{ paddingHorizontal: 18 }}>
            <Text style={styles.groupHint}>Also available</Text>
            <View style={styles.alsoRow}>
              {also.map(d => (
                <TouchableOpacity key={d.id} style={styles.alsoCell} activeOpacity={0.75} onPress={() => openDept(d.id)}>
                  <Text style={styles.alsoLabel}>{d.label}</Text><Text style={styles.cellCount}>{d.count}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    );
  }

  const dept: DepartmentNode | undefined = catalog.departments.find(d => d.id === department);
  if (!dept) return <View style={[styles.container, { paddingTop: insets.top }]}><Header title="Not found" parent="Back" /></View>;

  // ── Level: DEPARTMENT ──
  if (level === 'department') {
    const topTypes = dept.categories.flatMap(c => c.types.map(t => ({ ...t, category: c.id }))).sort((a, b) => b.count - a.count).slice(0, 8);
    return (
      <ScrollView style={styles.container} contentContainerStyle={bottomPad} showsVerticalScrollIndicator={false}>
        <Header title={dept.label} sub={`${dept.count} items`} parent="All Categories" />
        <Text style={styles.sectionTitle}>Shop by category</Text>
        <View style={{ paddingHorizontal: 14, gap: 12 }}>
          {dept.categories.map(c => (
            <TouchableOpacity key={c.id} style={styles.catCard} activeOpacity={0.85} onPress={() => openCat(dept.id, c.id)}>
              <Image source={{ uri: c.image ? variantUrl(c.image, { width: 480 }) : undefined }} style={styles.catImg} contentFit="cover" cachePolicy="memory-disk" />
              <View style={styles.catScrim} />
              <View style={styles.catBody}>
                <Text style={styles.catTitle}>{c.label}</Text>
                <Text style={styles.catCount}>{c.count} items</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.sectionTitle}>Browse by product</Text>
        <View style={styles.rows}>
          {topTypes.map(t => (
            <TouchableOpacity key={t.id} style={styles.row} activeOpacity={0.7} onPress={() => openResults({ department: dept.id, category: (t as any).category, productType: t.id })}>
              <Thumb uri={t.image} />
              <Text style={styles.rowLabel}>{t.label}</Text>
              <Text style={styles.rowCount}>{t.count}</Text>
              <Ionicons name="chevron-forward" size={18} color="#C8C2B8" />
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    );
  }

  // ── Level: CATEGORY ──
  const cat: CategoryNode | undefined = dept.categories.find(c => c.id === category);
  if (!cat) return <View style={[styles.container, { paddingTop: insets.top }]}><Header title="Not found" parent={dept.label} /></View>;
  return (
    <ScrollView style={styles.container} contentContainerStyle={bottomPad} showsVerticalScrollIndicator={false}>
      <Header title={cat.label} sub={`${cat.count} items`} parent={dept.label} />
      <Text style={styles.sectionTitle}>Browse by product</Text>
      <View style={styles.rows}>
        {cat.types.map(t => (
          <TouchableOpacity key={t.id} style={styles.row} activeOpacity={0.7} onPress={() => openResults({ department: dept.id, category: cat.id, productType: t.id })}>
            <Thumb uri={t.image} />
            <Text style={styles.rowLabel}>{t.label}</Text>
            <Text style={styles.rowCount}>{t.count}</Text>
            <Ionicons name="chevron-forward" size={18} color="#C8C2B8" />
          </TouchableOpacity>
        ))}
      </View>
      <View style={{ paddingHorizontal: 16, marginTop: 10 }}>
        <TouchableOpacity style={styles.viewAll} activeOpacity={0.85} onPress={() => openResults({ department: dept.id, category: cat.id })}>
          <Text style={styles.viewAllText}>View all {cat.count} items</Text>
          <Ionicons name="arrow-forward" size={18} color={INK} />
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: CANVAS },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topbar: { paddingHorizontal: 12, paddingBottom: 2 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingVertical: 6, paddingRight: 8 },
  backLbl: { fontSize: 15, fontWeight: '600', color: '#57534E' },
  head: { paddingHorizontal: 20, paddingTop: 2, paddingBottom: 6 },
  h1: { fontSize: 24, fontWeight: '700', color: INK, letterSpacing: -0.3 },
  sub: { fontSize: 13, color: SECONDARY, marginTop: 2 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: INK, marginTop: 20, marginBottom: 10, marginHorizontal: 20 },
  deptBlock: { marginTop: 16 },
  deptHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, marginBottom: 8 },
  deptName: { fontSize: 18, fontWeight: '700', color: INK, flex: 1 },
  deptCount: { fontSize: 12, color: MUTED, marginRight: 4 },
  cellGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16 },
  cell: { width: '48%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: LINE, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 13 },
  cellLabel: { fontSize: 14, fontWeight: '600', color: INK, flex: 1 },
  cellCount: { fontSize: 12, color: MUTED },
  groupHint: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', color: MUTED, marginTop: 22, marginBottom: 8 },
  alsoRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  alsoCell: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: LINE, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 12 },
  alsoLabel: { fontSize: 14, fontWeight: '500', color: SECONDARY },
  catCard: { height: 128, borderRadius: 16, overflow: 'hidden', backgroundColor: WARM },
  catImg: { position: 'absolute', width: '100%', height: '100%' },
  catScrim: { position: 'absolute', width: '100%', height: '100%', backgroundColor: 'rgba(28,25,23,0.28)' },
  catBody: { flex: 1, justifyContent: 'flex-end', padding: 16 },
  catTitle: { fontSize: 17, fontWeight: '700', color: '#FFFFFF' },
  catCount: { fontSize: 12, color: 'rgba(255,255,255,0.9)', marginTop: 2 },
  rows: { marginHorizontal: 16, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: LINE, borderRadius: 16, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 15, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: LINE },
  rowLabel: { fontSize: 16, fontWeight: '600', color: INK, flex: 1 },
  rowCount: { fontSize: 13, color: MUTED },
  viewAll: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, borderRadius: 14, borderWidth: 1, borderColor: LINE, backgroundColor: '#FFFFFF' },
  viewAllText: { fontSize: 15, fontWeight: '700', color: INK },
});
