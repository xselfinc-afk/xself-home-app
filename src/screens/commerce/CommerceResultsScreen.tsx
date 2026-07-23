/**
 * CommerceResultsScreen (Phase 2, Commerce Layer) — product-results leaf for a
 * Department / Category / Product-Type path. Uses the REAL product-card component
 * and the REAL ProductDetail navigation (unchanged). One lightweight context
 * (parent-back + title + single count); compact Sort + a PROGRESSIVE Filters sheet
 * (Department → Category → Product Type). Reached only when
 * COMMERCE_TAXONOMY_NAVIGATION_ENABLED is on.
 *
 * route.params: { department?, category?, productType? } (stable slugs)
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Modal, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import ProductCard from '../../components/ProductCard';
import { useRecommendations } from '../../context/RecommendationContext';
import { loadSellableProducts } from '../../services/commerceCatalogLoader';
import {
  buildCommerceCatalog, filterProducts, labelForDepartment, labelForCategory, labelForType,
  type CommerceCatalog,
} from '../../services/commerceCatalog';
import type { Product } from '../../data/products';

const CANVAS = '#F3F1EB', INK = '#1C1917', SECONDARY = '#6B7280', MUTED = '#9CA3AF', LINE = 'rgba(0,0,0,0.06)', GOLD = '#EAB320', GOLD_DARK = '#CA8A04';
const SORTS = [
  { key: 'recommended', label: 'Recommended' },
  { key: 'price_asc', label: 'Price: Low to High' },
  { key: 'price_desc', label: 'Price: High to Low' },
  { key: 'newest', label: 'Newest' },
];

export default function CommerceResultsScreen({ route, navigation }: any) {
  const initial = route.params ?? {};
  const insets = useSafeAreaInsets();
  const { trackClick } = useRecommendations();
  const [all, setAll] = useState<Product[] | null>(null);

  // Full taxonomy path is editable via the progressive filter sheet.
  const [dept, setDept] = useState<string | undefined>(initial.department);
  const [cat, setCat] = useState<string | undefined>(initial.category);
  const [type, setType] = useState<string | undefined>(initial.productType);
  const [sortKey, setSortKey] = useState('recommended');
  const [sortOpen, setSortOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sheetView, setSheetView] = useState<'path' | 'dept' | 'cat' | 'type'>('path');

  useEffect(() => { let a = true; loadSellableProducts().then(p => { if (a) setAll(p); }); return () => { a = false; }; }, []);

  const catalog: CommerceCatalog | null = useMemo(() => (all ? buildCommerceCatalog(all) : null), [all]);
  const deptNode = catalog?.departments.find(d => d.id === dept);
  const catNode = deptNode?.categories.find(c => c.id === cat);

  const filtered = useMemo(() => {
    if (!all) return [];
    const f = filterProducts(all, { department: dept, category: cat, productType: type });
    const s = [...f];
    if (sortKey === 'price_asc') s.sort((a, b) => a.price - b.price);
    else if (sortKey === 'price_desc') s.sort((a, b) => b.price - a.price);
    else if (sortKey === 'newest') s.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return s;
  }, [all, dept, cat, type, sortKey]);

  const title = labelForType(type) || labelForCategory(cat) || labelForDepartment(dept) || 'Products';
  const parent = type ? labelForCategory(cat) : cat ? labelForDepartment(dept) : 'All Categories';

  const openFilter = () => { setSheetView('path'); setFilterOpen(true); };
  const resetFilter = () => { setDept(initial.department); setCat(initial.category); setType(initial.productType); setSheetView('path'); };
  const pickDept = (id: string) => { setDept(id); setCat(undefined); setType(undefined); setSheetView('path'); };
  const pickCat = (id: string) => { setCat(id); setType(undefined); setSheetView('path'); };
  const pickType = (id?: string) => { setType(id); setSheetView('path'); };

  if (!all || !catalog) {
    return <View style={[styles.container, { paddingTop: insets.top }]}><View style={styles.loading}><ActivityIndicator size="small" color={GOLD} /></View></View>;
  }

  const Row = ({ label, value, onPress }: { label: string; value: string; onPress: () => void }) => (
    <TouchableOpacity style={styles.selrow} activeOpacity={0.7} onPress={onPress}>
      <Text style={styles.selLab}>{label}</Text>
      <Text style={styles.selVal}>{value}</Text>
      <Ionicons name="chevron-forward" size={18} color="#C8C2B8" />
    </TouchableOpacity>
  );
  const Opt = ({ label, count, on, onPress }: { label: string; count?: number; on: boolean; onPress: () => void }) => (
    <TouchableOpacity style={styles.opt} activeOpacity={0.7} onPress={onPress}>
      <Text style={[styles.optText, on && styles.optOn]}>{label}</Text>
      {count != null ? <Text style={styles.optCount}>{count} items</Text> : null}
      {on ? <Ionicons name="checkmark" size={18} color={GOLD_DARK} style={{ marginLeft: 8 }} /> : null}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={[styles.topbar, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={20} color="#57534E" /><Text style={styles.backLbl}>{parent}</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={i => i.id}
        numColumns={2}
        columnWrapperStyle={styles.rowWrap}
        contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View>
            <View style={styles.head}>
              <Text style={styles.h1}>{title}</Text>
              <Text style={styles.count}>{filtered.length} items</Text>
            </View>
            <View style={styles.tools}>
              <TouchableOpacity style={styles.tool} activeOpacity={0.8} onPress={() => setSortOpen(true)}><Ionicons name="swap-vertical-outline" size={17} color={INK} /><Text style={styles.toolText}>Sort</Text></TouchableOpacity>
              <TouchableOpacity style={styles.tool} activeOpacity={0.8} onPress={openFilter}><Ionicons name="options-outline" size={17} color={INK} /><Text style={styles.toolText}>Filters</Text></TouchableOpacity>
            </View>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="search-outline" size={40} color="#CBBFA8" />
            <Text style={styles.emptyTitle}>Nothing matches just yet</Text>
            <Text style={styles.emptyBody}>Try clearing a filter to see the full range.</Text>
            <TouchableOpacity style={styles.emptyCta} activeOpacity={0.85} onPress={resetFilter}><Text style={styles.emptyCtaText}>Reset filters</Text></TouchableOpacity>
          </View>
        }
        renderItem={({ item }) => (
          <ProductCard product={item as any} onPress={() => { trackClick(item.id); navigation.navigate('ProductDetail', { product: item }); }} style={styles.card} />
        )}
      />

      {/* Sort */}
      <Modal visible={sortOpen} transparent animationType="fade" onRequestClose={() => setSortOpen(false)}>
        <TouchableOpacity style={styles.mask} activeOpacity={1} onPress={() => setSortOpen(false)}>
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.handle} /><Text style={styles.sheetTitle}>Sort</Text>
            {SORTS.map(s => (
              <TouchableOpacity key={s.key} style={styles.opt} onPress={() => { setSortKey(s.key); setSortOpen(false); }}>
                <Text style={[styles.optText, sortKey === s.key && styles.optOn]}>{s.label}</Text>
                {sortKey === s.key ? <Ionicons name="checkmark" size={18} color={GOLD_DARK} /> : null}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Progressive Filters: Department → Category → Product Type */}
      <Modal visible={filterOpen} transparent animationType="fade" onRequestClose={() => setFilterOpen(false)}>
        <TouchableOpacity style={styles.mask} activeOpacity={1} onPress={() => setFilterOpen(false)}>
          <TouchableOpacity style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]} activeOpacity={1} onPress={() => {}}>
            <View style={styles.handle} />
            {sheetView === 'path' ? (
              <>
                <Text style={styles.sheetTitle}>Filters</Text>
                <Row label="Department" value={labelForDepartment(dept) || 'Any'} onPress={() => setSheetView('dept')} />
                <Row label="Category" value={labelForCategory(cat) || 'Any'} onPress={() => setSheetView('cat')} />
                <Row label="Product Type" value={labelForType(type) || 'Any'} onPress={() => setSheetView('type')} />
                <View style={styles.actions}>
                  <TouchableOpacity style={styles.reset} onPress={resetFilter}><Text style={styles.resetText}>Reset</Text></TouchableOpacity>
                  <TouchableOpacity style={styles.apply} onPress={() => setFilterOpen(false)}><Text style={styles.applyText}>Show {filtered.length} results</Text></TouchableOpacity>
                </View>
              </>
            ) : (
              <>
                <View style={styles.optHead}>
                  <TouchableOpacity onPress={() => setSheetView('path')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ paddingRight: 8 }}><Ionicons name="chevron-back" size={20} color="#57534E" /></TouchableOpacity>
                  <Text style={styles.sheetTitle}>{sheetView === 'dept' ? 'Department' : sheetView === 'cat' ? 'Category' : 'Product Type'}</Text>
                </View>
                <ScrollView style={{ maxHeight: 340 }}>
                  {sheetView === 'dept' && catalog.departments.map(d => (
                    <Opt key={d.id} label={d.label} count={d.count} on={d.id === dept} onPress={() => pickDept(d.id)} />
                  ))}
                  {sheetView === 'cat' && (deptNode?.categories ?? []).map(c => (
                    <Opt key={c.id} label={c.label} count={c.count} on={c.id === cat} onPress={() => pickCat(c.id)} />
                  ))}
                  {sheetView === 'type' && (
                    <>
                      <Opt label={`All ${labelForCategory(cat) || 'products'}`} on={!type} onPress={() => pickType(undefined)} />
                      {(catNode?.types ?? []).map(t => (
                        <Opt key={t.id} label={t.label} count={t.count} on={t.id === type} onPress={() => pickType(t.id)} />
                      ))}
                    </>
                  )}
                </ScrollView>
                <View style={styles.actions}>
                  <TouchableOpacity style={styles.apply} onPress={() => setSheetView('path')}><Text style={styles.applyText}>Done</Text></TouchableOpacity>
                </View>
              </>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: CANVAS },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topbar: { paddingHorizontal: 12, paddingBottom: 2 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingVertical: 6, paddingRight: 8 },
  backLbl: { fontSize: 15, fontWeight: '600', color: '#57534E' },
  head: { paddingHorizontal: 18, paddingTop: 2 },
  h1: { fontSize: 26, fontWeight: '700', color: INK, letterSpacing: -0.3 },
  count: { fontSize: 13, color: SECONDARY, marginTop: 3 },
  tools: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  tool: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 38, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: LINE, backgroundColor: '#FFFFFF' },
  toolText: { fontSize: 13, fontWeight: '600', color: INK },
  rowWrap: { gap: 6 },
  card: { flex: 1, marginHorizontal: 3, marginVertical: 3 },
  empty: { alignItems: 'center', paddingVertical: 50, paddingHorizontal: 30 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: INK, marginTop: 14 },
  emptyBody: { fontSize: 14, color: SECONDARY, marginTop: 6, textAlign: 'center' },
  emptyCta: { marginTop: 18, backgroundColor: GOLD, borderRadius: 14, height: 48, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center' },
  emptyCtaText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  mask: { flex: 1, backgroundColor: 'rgba(28,25,23,0.42)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: CANVAS, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 8 },
  handle: { width: 38, height: 4, borderRadius: 2, backgroundColor: '#D6D0C6', alignSelf: 'center', marginBottom: 12 },
  sheetTitle: { fontSize: 19, fontWeight: '700', color: INK, marginBottom: 4 },
  optHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 2 },
  selrow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: LINE },
  selLab: { fontSize: 12, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6, width: 120 },
  selVal: { flex: 1, fontSize: 16, fontWeight: '600', color: INK },
  opt: { flexDirection: 'row', alignItems: 'center', paddingVertical: 15, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: LINE },
  optText: { flex: 1, fontSize: 16, color: INK },
  optOn: { color: GOLD_DARK, fontWeight: '700' },
  optCount: { fontSize: 14, color: MUTED },
  actions: { flexDirection: 'row', gap: 12, paddingTop: 16 },
  reset: { flex: 1, height: 54, borderRadius: 15, borderWidth: 1, borderColor: 'rgba(202,138,4,0.3)', alignItems: 'center', justifyContent: 'center' },
  resetText: { fontSize: 15, fontWeight: '600', color: INK },
  apply: { flex: 2, height: 54, borderRadius: 15, backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center' },
  applyText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
});
