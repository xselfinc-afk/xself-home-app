/**
 * Source of truth: /NORMALIZATION_ENGINE.md
 * All product title, features, description, specifications, image, and family logic must follow this file.
 * Do NOT add UI-side cleaning or formatting logic.
 */

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Modal,
  Dimensions,
  Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PRODUCT_CATEGORIES, matchesCategory, normalizeForSkuMatch, matchesSearch } from '../data/categories';
import { supabase } from '../lib/supabase';
import { fetchCaAvailableProductIds } from '../services/inventoryCacheService';
import { CategoryPillRow } from '../components/CategoryPillRow';
import { adaptStandardizedRow } from '../services/detailProductAdapter';
import type { Product } from '../data/products';
import DiscoverCard from '../components/DiscoverCard';

const SCREEN_HEIGHT = Dimensions.get('window').height;

const SORT_OPTIONS = [
  'Recommended',
  'Newest',
  'Price: Low to High',
  'Price: High to Low',
  'Best Selling',
];

const CATEGORY_OPTIONS = [
  'Storage Cabinet',
  'Sideboard',
  'Dresser',
  'Bookshelf',
  'TV Stand',
  'Nightstand',
  'Dining Chair',
  'Coffee Table',
  'Console Table',
  'Bathroom Cabinet',
];

export default function DiscoverScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();

  const [search, setSearch] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [caAvailableIds, setCaAvailableIds] = useState<Set<string>>(new Set());
  const [filterVisible, setFilterVisible] = useState(false);
  const [sortBy, setSortBy] = useState('Recommended');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);

  const [pendingSortBy, setPendingSortBy] = useState('Recommended');
  const [pendingCategories, setPendingCategories] = useState<string[]>([]);

  useEffect(() => {
    let active = true;

    async function loadProducts() {
      const { data, error } = await supabase
        .from('standardized_products')
        .select(
          'id, supplier_product_id, product_title, product_title_display, short_description, ' +
          'key_features_json, specifications_json, sku_custom, sku_search, ' +
          'category_code, scene_code, color, color_options_json, ' +
          'has_multiple_colors, show_color_selector, material, dimensions, weight, ' +
          'primary_image, gallery_images_json, product_family_key, price, normalization_status, created_at, category_label, category_priority, is_new_arrival',
        )
        .eq('normalization_status', 'done')
        .order('created_at', { ascending: false });

      console.log('[Discover] query done — error:', error?.message ?? null, '| rows:', data?.length ?? 0);
      if (data?.[0]) console.log('[Discover] first raw row:', JSON.stringify(data[0]).slice(0, 300));

      if (error) {
        console.log('[DiscoverScreen] load products error:', error.message);
        return;
      }

      if (!active || !data) return;

      const mapped: Product[] = (data as any[]).flatMap((r: any) => {
        try {
          return [adaptStandardizedRow(r)];
        } catch (e) {
          console.warn('[Discover] adaptStandardizedRow failed for row', r?.supplier_product_id, e);
          return [];
        }
      });

      console.log('[Discover] mapped count:', mapped.length);
      if (mapped[0]) console.log('[Discover] first mapped item:', { id: mapped[0].id, name: mapped[0].name, images: mapped[0].images.length, category: mapped[0].category });

      // Deduplicate by product_family_key — keep first row with a valid image per family.
      // Same-style different-color products collapse to one card; no DB rows are removed.
      const familySeen = new Map<string, { id: string; hasImage: boolean }>();
      (data as any[]).forEach((r: any) => {
        const key: string = r.product_family_key || r.supplier_product_id;
        const hasImage = !!r.primary_image;
        const existing = familySeen.get(key);
        if (!existing || (!existing.hasImage && hasImage)) {
          familySeen.set(key, { id: r.supplier_product_id, hasImage });
        }
      });
      const representativeIds = new Set([...familySeen.values()].map(v => v.id));
      const deduped = mapped.filter(p => representativeIds.has(p.id));

      const first10FamilyKeys = [...familySeen.keys()].slice(0, 10);
      console.log('[Discover] after dedup:', deduped.length, 'families from', mapped.length, 'rows');
      console.log('[Discover] first 10 family keys:', first10FamilyKeys);
      console.log('[Discover] passing', deduped.length, 'rows to list renderer');
      setProducts(deduped);

      // Load CA pickup availability for ranking — non-blocking, degrades to no boost if empty
      fetchCaAvailableProductIds()
        .then(ids => { if (active) setCaAvailableIds(ids); })
        .catch(() => { /* cache unavailable — ranking unaffected */ });
    }

    loadProducts();

    return () => {
      active = false;
    };
  }, []);

  const activeFilterCount = [
    sortBy !== 'Recommended' ? 1 : 0,
    selectedCategories.length,
  ].reduce((a, b) => a + b, 0);

  const openFilter = () => {
    setPendingSortBy(sortBy);
    setPendingCategories([...selectedCategories]);
    setFilterVisible(true);
  };

  const applyFilters = () => {
    setSortBy(pendingSortBy);
    setSelectedCategories(pendingCategories);
    setFilterVisible(false);
  };

  const resetFilters = () => {
    setPendingSortBy('Recommended');
    setPendingCategories([]);
  };

  const togglePendingChip = (
    value: string,
    list: string[],
    setList: (v: string[]) => void,
  ) => {
    if (list.includes(value)) {
      setList(list.filter(v => v !== value));
    } else {
      setList([...list, value]);
    }
  };

  let filtered = products.filter(p => {
    if (!search) return true;
    return matchesSearch(p, search);
  });

  if (selectedCategories.length > 0) {
    filtered = filtered.filter(p =>
      selectedCategories.some(c => matchesCategory(p, c)),
    );
  }

  if (__DEV__) {
    const qNorm = normalizeForSkuMatch(search);
    console.log('[Search] raw query:', JSON.stringify(search));
    console.log('[Search] normalized query:', JSON.stringify(qNorm));
    console.log('[Search] sku partial match enabled:', qNorm.length >= 2);
    console.log('[Search] result count:', filtered.length);
    console.log('[Discover] render — products:', products.length, '| categories:', selectedCategories, '| filtered:', filtered.length);
  }

  if (sortBy === 'Price: Low to High') {
    filtered = [...filtered].sort((a, b) => a.price - b.price);
  } else if (sortBy === 'Price: High to Low') {
    filtered = [...filtered].sort((a, b) => b.price - a.price);
  } else if (sortBy === 'Newest') {
    filtered = [...filtered];
  } else if (sortBy === 'Best Selling') {
    filtered = [...filtered].sort((a, b) => b.sales - a.sales);
  } else {
    // Recommended: CA-pickup-available products first; ties keep existing order
    if (caAvailableIds.size > 0) {
      filtered = [...filtered].sort((a, b) => {
        const aCA = caAvailableIds.has(a.id) ? 0 : 1;
        const bCA = caAvailableIds.has(b.id) ? 0 : 1;
        return aCA - bCA;
      });
    }
  }

  const col0 = filtered.filter((_, i) => i % 3 === 0);
  const col1 = filtered.filter((_, i) => i % 3 === 1);
  const col2 = filtered.filter((_, i) => i % 3 === 2);

  return (
    <View style={styles.container}>
      <View style={[styles.topArea, { paddingTop: insets.top }]}>
        <View style={styles.searchPill}>
          <Ionicons name="search-outline" size={18} color="#6B7280" />
          <TextInput
            style={styles.searchInput}
            placeholder='Try "Cabinet"...'
            value={search}
            onChangeText={setSearch}
            placeholderTextColor="#9CA3AF"
          />
          <View style={styles.searchDivider} />
          <TouchableOpacity
            style={styles.filterPillBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            onPress={openFilter}
          >
            <View>
              <Ionicons name="options-outline" size={18} color="#1C1917" />
              {activeFilterCount > 0 && (
                <View style={styles.filterBadge}>
                  <Text style={styles.filterBadgeText}>{activeFilterCount}</Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
        </View>

        <CategoryPillRow
          categories={PRODUCT_CATEGORIES}
          isActive={cat =>
            cat === 'All'
              ? search === ''
              : search.toLowerCase() === cat.toLowerCase()
          }
          onPress={cat => setSearch(cat === 'All' ? '' : cat)}
        />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.feed}
      >
        <View style={styles.columns}>
          <View style={styles.column}>
            {col0.map((item, i) => (
              <DiscoverCard
                key={item.id}
                product={item}
                debugLog={i < 2}
                onPress={() => {
                  console.log('[Discover] opening family:', item.product_family_key ?? item.id);
                  navigation.navigate('ProductDetail', { product: item, product_family_key: item.product_family_key });
                }}
              />
            ))}
          </View>

          <View style={styles.column}>
            {col1.map((item, i) => (
              <DiscoverCard
                key={item.id}
                product={item}
                debugLog={i < 2}
                onPress={() => {
                  console.log('[Discover] opening family:', item.product_family_key ?? item.id);
                  navigation.navigate('ProductDetail', { product: item, product_family_key: item.product_family_key });
                }}
              />
            ))}
          </View>

          <View style={styles.column}>
            {col2.map((item, i) => (
              <DiscoverCard
                key={item.id}
                product={item}
                debugLog={i < 2}
                onPress={() => {
                  console.log('[Discover] opening family:', item.product_family_key ?? item.id);
                  navigation.navigate('ProductDetail', { product: item, product_family_key: item.product_family_key });
                }}
              />
            ))}
          </View>
        </View>
      </ScrollView>

      <Modal
        visible={filterVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setFilterVisible(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setFilterVisible(false)}
        >
          <TouchableOpacity
            style={[
              styles.filterPanel,
              {
                maxHeight: SCREEN_HEIGHT * 0.85,
                paddingBottom: insets.bottom + 16,
              },
            ]}
            activeOpacity={1}
            onPress={() => {}}
          >
            <View style={styles.handleBar} />

            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.filterScroll}
            >
              <Text style={styles.sectionTitle}>Sort By</Text>
              {SORT_OPTIONS.map(option => (
                <TouchableOpacity
                  key={option}
                  style={styles.radioRow}
                  onPress={() => setPendingSortBy(option)}
                >
                  <View
                    style={[
                      styles.radioOuter,
                      pendingSortBy === option && styles.radioOuterSelected,
                    ]}
                  >
                    {pendingSortBy === option && <View style={styles.radioInner} />}
                  </View>
                  <Text style={styles.radioLabel}>{option}</Text>
                </TouchableOpacity>
              ))}

              <View style={styles.sectionSeparator} />

              <Text style={styles.sectionTitle}>Style</Text>
              <View style={styles.chipRow}>
                {CATEGORY_OPTIONS.map(option => {
                  const selected = pendingCategories.includes(option);
                  return (
                    <TouchableOpacity
                      key={option}
                      style={[styles.chip, selected && styles.chipSelected]}
                      onPress={() =>
                        togglePendingChip(
                          option,
                          pendingCategories,
                          setPendingCategories,
                        )
                      }
                    >
                      <Text
                        style={[
                          styles.chipText,
                          selected && styles.chipTextSelected,
                        ]}
                      >
                        {option}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>

            <View style={styles.filterActions}>
              <TouchableOpacity style={styles.resetBtn} onPress={resetFilters}>
                <Text style={styles.resetBtnText}>Reset</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.applyBtn} onPress={applyFilters}>
                <Text style={styles.applyBtnText}>Apply</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAFAF9' },

  topArea: {
    marginBottom: 0,
    paddingHorizontal: 6,
  },

  searchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
    borderRadius: 999,
    height: 40,
    paddingLeft: 12,
    paddingRight: 8,
    marginHorizontal: 6,
    gap: 8,
  },

  searchInput: {
    flex: 1,
    paddingVertical: 0,
    fontSize: 15,
    color: '#1C1917',
  },

  searchDivider: {
    width: 1,
    height: 18,
    backgroundColor: '#E5E7EB',
  },

  filterPillBtn: {
    paddingLeft: 10,
    paddingRight: 4,
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },

  feed: {
    paddingHorizontal: 4,
    paddingBottom: 100,
  },

  columns: {
    flexDirection: 'row',
    gap: 4,
  },

  column: {
    flex: 1,
  },


  filterBadge: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: '#EAB320',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },

  filterBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 12,
  },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(64, 63, 61, 0.4)',
    justifyContent: 'flex-end',
  },

  filterPanel: {
    backgroundColor: '#F3F1EB',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },

  handleBar: {
    width: 36,
    height: 4,
    backgroundColor: '#C8C6BF',
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 8,
  },

  filterScroll: {
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 12,
  },

  sectionTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#403F3D',
    marginBottom: 12,
    marginTop: 4,
  },

  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 10,
  },

  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#C8C6BF',
    alignItems: 'center',
    justifyContent: 'center',
  },

  radioOuterSelected: {
    borderColor: '#EAB320',
  },

  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#EAB320',
  },

  radioLabel: {
    fontSize: 14,
    color: '#403F3D',
  },

  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 4,
  },

  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E3DC',
  },

  chipSelected: {
    backgroundColor: '#EAB320',
    borderColor: '#EAB320',
  },

  chipText: {
    fontSize: 13,
    color: '#403F3D',
  },

  chipTextSelected: {
    color: '#FFFFFF',
    fontWeight: '600',
  },

  sectionSeparator: {
    height: 1,
    backgroundColor: '#E5E3DC',
    marginVertical: 16,
  },

  filterActions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#E5E3DC',
    backgroundColor: '#F3F1EB',
  },

  resetBtn: {
    flex: 1,
    height: 46,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E3DC',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },

  resetBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#403F3D',
  },

  applyBtn: {
    flex: 2,
    height: 46,
    borderRadius: 8,
    backgroundColor: '#EAB320',
    alignItems: 'center',
    justifyContent: 'center',
  },

  applyBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});