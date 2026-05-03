import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { adaptStandardizedRow } from '../services/detailProductAdapter';
import type { Product } from '../data/products';
import ProductCard from '../components/ProductCard';
import { useRecommendations } from '../context/RecommendationContext';

type CollectionMeta = {
  eyebrow: string;
  title: string;
  subtitle: string;
};

const COLLECTIONS: Record<string, CollectionMeta> = {
  'spring-collection': {
    eyebrow: 'SPRING 2025',
    title: 'Spring Collection',
    subtitle: 'Fresh picks for the season — up to 30% off select furniture',
  },
  'spring-sale': {
    eyebrow: 'SPRING SALE',
    title: 'Spring Sale',
    subtitle: 'Up to 30% Off Selected Furniture',
  },
};

export default function CollectionScreen({ route, navigation }: any) {
  const { key } = route.params ?? {};
  const collection = COLLECTIONS[key];
  const insets = useSafeAreaInsets();
  const { trackClick } = useRecommendations();
  const [items, setItems] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [topDiscount, setTopDiscount] = useState(0);

  useEffect(() => {
    if (!collection) { setLoading(false); return; }
    let active = true;

    async function loadDiscounted() {
      // Server-side: done products with price > 0 and original_price present
      const { data, error } = await supabase
        .from('sellable_products')
        .select(
          'id, supplier_product_id, product_title, product_title_display, optimized_title, short_description, ' +
          'key_features_json, specifications_json, sku_custom, ' +
          'category_code, scene_code, color, color_options_json, ' +
          'has_multiple_colors, show_color_selector, material, dimensions, weight, ' +
          'primary_image, gallery_images_json, product_family_key, price, selling_price, original_price, ' +
          'normalization_status, created_at, total_available_qty',
        )
        .gt('price', 0)
        .not('original_price', 'is', null);

      console.log('[SpringCollection] source: real');
      console.log('[SpringCollection] discounted rows fetched:', data?.length ?? 0);

      if (error || !data || !active) { setLoading(false); return; }

      const mapped: Product[] = (data as any[]).flatMap((r: any) => {
        try { return [adaptStandardizedRow(r)]; }
        catch { return []; }
      });

      // Family dedup — same logic as Home / Discover / ProductDetail
      const familySeen = new Map<string, { id: string; hasImage: boolean }>();
      (data as any[]).forEach((r: any) => {
        const fk: string = r.product_family_key || r.supplier_product_id;
        const hasImage = !!r.primary_image;
        const existing = familySeen.get(fk);
        if (!existing || (!existing.hasImage && hasImage)) {
          familySeen.set(fk, { id: r.supplier_product_id, hasImage });
        }
      });
      const representativeIds = new Set([...familySeen.values()].map(v => v.id));
      const deduped = mapped.filter(p => representativeIds.has(p.id));

      // Client-side: require originalPrice > price and a valid image
      const discounted = deduped.filter(
        p => p.images.length > 0 && p.originalPrice != null && p.originalPrice > p.price,
      );

      // Sort highest discount % first
      discounted.sort((a, b) => {
        const pctA = a.originalPrice ? (a.originalPrice - a.price) / a.originalPrice : 0;
        const pctB = b.originalPrice ? (b.originalPrice - b.price) / b.originalPrice : 0;
        return pctB - pctA;
      });

      const computedTopDiscount = discounted[0]?.originalPrice
        ? Math.round(((discounted[0].originalPrice - discounted[0].price) / discounted[0].originalPrice) * 100)
        : 0;
      console.log('[SpringCollection] final mapped products:', discounted.length);
      console.log('[SpringCollection] highest discount:', computedTopDiscount + '%');

      if (active) { setItems(discounted); setTopDiscount(computedTopDiscount); setLoading(false); }
    }

    loadDiscounted();
    return () => { active = false; };
  }, [key]);

  if (!collection) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <TouchableOpacity
          style={[styles.backBtn, { margin: 16 }]}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="chevron-back" size={22} color="#1C1917" />
        </TouchableOpacity>
        <View style={styles.notFound}>
          <Text style={styles.notFoundText}>Collection not found.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="chevron-back" size={22} color="#1C1917" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="small" color="#EAB320" />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={item => item.id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 32 }]}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <View style={styles.collectionHeader}>
              <Text style={styles.title}>{collection.title}</Text>
              <Text style={styles.subtitle}>
                {key === 'spring-sale' && topDiscount > 0
                  ? `Up to ${topDiscount}% Off Selected Furniture`
                  : collection.subtitle}
              </Text>
              <View style={styles.divider} />
              <Text style={styles.count}>{items.length} items</Text>
            </View>
          }
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyText}>No discounted products available right now.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <ProductCard
              product={item}
              onPress={() => {
                trackClick(item.id);
                navigation.navigate('ProductDetail', { product: item });
              }}
              style={styles.card}
            />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAFAF9' },
  topBar: { paddingHorizontal: 16, paddingVertical: 8 },
  backBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center',
  },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  collectionHeader: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16 },
  eyebrow: { fontSize: 10, fontWeight: '700', color: '#EAB320', letterSpacing: 2, marginBottom: 6 },
  title: { fontSize: 26, fontWeight: '700', color: '#1C1917', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#6B7280', lineHeight: 20 },
  divider: { height: 1, backgroundColor: '#F3F4F6', marginVertical: 12 },
  count: { fontSize: 12, color: '#9CA3AF', fontWeight: '500' },
  list: { paddingHorizontal: 10 },
  row: { gap: 8 },
  card: { flex: 1 },
  emptyWrap: { paddingTop: 60, alignItems: 'center' },
  emptyText: { fontSize: 14, color: '#9CA3AF' },
  notFound: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  notFoundText: { fontSize: 15, color: '#9CA3AF' },
});
