import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Image,
  StyleSheet,
  ScrollView,
  Modal,
  Switch,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { products } from '../data/products';

const HEIGHTS = [220, 320];
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

const COLOR_OPTIONS = [
  'Black',
  'White',
  'Walnut',
  'Oak',
  'Rustic Brown',
  'Gray',
  'Gold',
  'Beige',
  'Natural Wood',
];

const MATERIAL_OPTIONS = [
  'Wood',
  'MDF',
  'Metal',
  'Glass',
  'Upholstered',
  'Engineered Wood',
];

const ROOM_OPTIONS = [
  'Living Room',
  'Bedroom',
  'Dining Room',
  'Entryway',
  'Bathroom',
  'Office',
];

export default function DiscoverScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');

  // Filter panel state
  const [filterVisible, setFilterVisible] = useState(false);
  const [sortBy, setSortBy] = useState('Recommended');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedColors, setSelectedColors] = useState<string[]>([]);
  const [selectedMaterials, setSelectedMaterials] = useState<string[]>([]);
  const [selectedRooms, setSelectedRooms] = useState<string[]>([]);
  const [inStockOnly, setInStockOnly] = useState(false);
  const [pickupAvailable, setPickupAvailable] = useState(false);
  const [localDelivery, setLocalDelivery] = useState(false);

  // Pending state (used inside modal before Apply)
  const [pendingSortBy, setPendingSortBy] = useState('Recommended');
  const [pendingCategories, setPendingCategories] = useState<string[]>([]);
  const [pendingColors, setPendingColors] = useState<string[]>([]);
  const [pendingMaterials, setPendingMaterials] = useState<string[]>([]);
  const [pendingRooms, setPendingRooms] = useState<string[]>([]);
  const [pendingInStock, setPendingInStock] = useState(false);
  const [pendingPickup, setPendingPickup] = useState(false);
  const [pendingLocalDelivery, setPendingLocalDelivery] = useState(false);

  const activeFilterCount = [
    sortBy !== 'Recommended' ? 1 : 0,
    selectedCategories.length,
    selectedColors.length,
    selectedMaterials.length,
    selectedRooms.length,
    inStockOnly ? 1 : 0,
    pickupAvailable ? 1 : 0,
    localDelivery ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  const openFilter = () => {
    // Sync pending state with current applied state
    setPendingSortBy(sortBy);
    setPendingCategories([...selectedCategories]);
    setPendingColors([...selectedColors]);
    setPendingMaterials([...selectedMaterials]);
    setPendingRooms([...selectedRooms]);
    setPendingInStock(inStockOnly);
    setPendingPickup(pickupAvailable);
    setPendingLocalDelivery(localDelivery);
    setFilterVisible(true);
  };

  const applyFilters = () => {
    setSortBy(pendingSortBy);
    setSelectedCategories(pendingCategories);
    setSelectedColors(pendingColors);
    setSelectedMaterials(pendingMaterials);
    setSelectedRooms(pendingRooms);
    setInStockOnly(pendingInStock);
    setPickupAvailable(pendingPickup);
    setLocalDelivery(pendingLocalDelivery);
    setFilterVisible(false);
  };

  const resetFilters = () => {
    setPendingSortBy('Recommended');
    setPendingCategories([]);
    setPendingColors([]);
    setPendingMaterials([]);
    setPendingRooms([]);
    setPendingInStock(false);
    setPendingPickup(false);
    setPendingLocalDelivery(false);
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

  // Apply search filter
  let filtered = products.filter(
    p => p.img && (!search || p.name.toLowerCase().includes(search.toLowerCase())),
  );

  // Apply category filter (product.category exists)
  if (selectedCategories.length > 0) {
    filtered = filtered.filter(p =>
      selectedCategories.some(
        c => p.category && p.category.toLowerCase().includes(c.toLowerCase()),
      ),
    );
  }

  // Color, material, room: fields don't exist on Product — skip

  // Sort
  if (sortBy === 'Price: Low to High') {
    filtered = [...filtered].sort((a, b) => a.price - b.price);
  } else if (sortBy === 'Price: High to Low') {
    filtered = [...filtered].sort((a, b) => b.price - a.price);
  } else if (sortBy === 'Best Selling') {
    filtered = [...filtered].sort((a, b) => b.sales - a.sales);
  }
  // 'Newest' and 'Recommended' keep original order

  const left = filtered.filter((_, i) => i % 2 === 0);
  const right = filtered.filter((_, i) => i % 2 === 1);

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
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryRow} contentContainerStyle={{ paddingHorizontal: 10, gap: 6 }}>
          {['All', 'Sofa', 'Chair', 'Table', 'Lamp', 'Rug', 'Cabinet'].map(cat => {
            const active = cat === 'All' ? search === '' : search.toLowerCase() === cat.toLowerCase();
            return (
              <TouchableOpacity
                key={cat}
                style={[styles.categoryChip, active && styles.categoryChipActive]}
                onPress={() => setSearch(cat === 'All' ? '' : cat)}
              >
                <Text style={[styles.categoryChipText, active && styles.categoryChipTextActive]}>{cat}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.feed}>
        <View style={styles.columns}>
          <View style={styles.column}>
            {left.map((item, i) => (
              <TouchableOpacity
                key={item.id}
                style={[styles.card, { marginBottom: 6 }]}
                onPress={() => navigation.navigate('ProductDetail', { product: item })}
                activeOpacity={0.92}
              >
                <Image
                  source={{ uri: item.img }}
                  style={{ width: '100%', height: HEIGHTS[i % HEIGHTS.length], borderRadius: 6 }}
                  resizeMode="cover"
                />
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.column}>
            {right.map((item, i) => (
              <TouchableOpacity
                key={item.id}
                style={[styles.card, { marginBottom: 6 }]}
                onPress={() => navigation.navigate('ProductDetail', { product: item })}
                activeOpacity={0.92}
              >
                <Image
                  source={{ uri: item.img }}
                  style={{ width: '100%', height: HEIGHTS[(i + 1) % HEIGHTS.length], borderRadius: 6 }}
                  resizeMode="cover"
                />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </ScrollView>

      {/* Filter Modal */}
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
            style={[styles.filterPanel, { maxHeight: SCREEN_HEIGHT * 0.85, paddingBottom: insets.bottom + 16 }]}
            activeOpacity={1}
            onPress={() => {/* prevent overlay close */}}
          >
            {/* Handle bar */}
            <View style={styles.handleBar} />

            {/* Scrollable content */}
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.filterScroll}
            >
              {/* Sort By */}
              <Text style={styles.sectionTitle}>Sort By</Text>
              {SORT_OPTIONS.map(option => (
                <TouchableOpacity
                  key={option}
                  style={styles.radioRow}
                  onPress={() => setPendingSortBy(option)}
                >
                  <View style={[styles.radioOuter, pendingSortBy === option && styles.radioOuterSelected]}>
                    {pendingSortBy === option && <View style={styles.radioInner} />}
                  </View>
                  <Text style={styles.radioLabel}>{option}</Text>
                </TouchableOpacity>
              ))}

              <View style={styles.sectionSeparator} />

              {/* Style */}
              <Text style={styles.sectionTitle}>Style</Text>
              <View style={styles.chipRow}>
                {CATEGORY_OPTIONS.map(option => {
                  const selected = pendingCategories.includes(option);
                  return (
                    <TouchableOpacity
                      key={option}
                      style={[styles.chip, selected && styles.chipSelected]}
                      onPress={() => togglePendingChip(option, pendingCategories, setPendingCategories)}
                    >
                      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{option}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={styles.sectionSeparator} />

              {/* Color */}
              <Text style={styles.sectionTitle}>Color</Text>
              <View style={styles.chipRow}>
                {COLOR_OPTIONS.map(option => {
                  const selected = pendingColors.includes(option);
                  return (
                    <TouchableOpacity
                      key={option}
                      style={[styles.chip, selected && styles.chipSelected]}
                      onPress={() => togglePendingChip(option, pendingColors, setPendingColors)}
                    >
                      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{option}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={styles.sectionSeparator} />

              {/* Material */}
              <Text style={styles.sectionTitle}>Material</Text>
              <View style={styles.chipRow}>
                {MATERIAL_OPTIONS.map(option => {
                  const selected = pendingMaterials.includes(option);
                  return (
                    <TouchableOpacity
                      key={option}
                      style={[styles.chip, selected && styles.chipSelected]}
                      onPress={() => togglePendingChip(option, pendingMaterials, setPendingMaterials)}
                    >
                      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{option}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={styles.sectionSeparator} />

              {/* Room */}
              <Text style={styles.sectionTitle}>Room</Text>
              <View style={styles.chipRow}>
                {ROOM_OPTIONS.map(option => {
                  const selected = pendingRooms.includes(option);
                  return (
                    <TouchableOpacity
                      key={option}
                      style={[styles.chip, selected && styles.chipSelected]}
                      onPress={() => togglePendingChip(option, pendingRooms, setPendingRooms)}
                    >
                      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{option}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={styles.sectionSeparator} />

              {/* Availability */}
              <Text style={styles.sectionTitle}>Availability</Text>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>In Stock Only</Text>
                <Switch
                  value={pendingInStock}
                  onValueChange={setPendingInStock}
                  trackColor={{ false: '#E5E3DC', true: '#EAB320' }}
                  thumbColor="#FFFFFF"
                />
              </View>

              <View style={styles.sectionSeparator} />

              {/* Delivery Options */}
              <Text style={styles.sectionTitle}>Delivery Options</Text>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Pickup Available</Text>
                <Switch
                  value={pendingPickup}
                  onValueChange={setPendingPickup}
                  trackColor={{ false: '#E5E3DC', true: '#EAB320' }}
                  thumbColor="#FFFFFF"
                />
              </View>
              <View style={[styles.toggleRow, { marginTop: 12 }]}>
                <Text style={styles.toggleLabel}>Local Delivery Available</Text>
                <Switch
                  value={pendingLocalDelivery}
                  onValueChange={setPendingLocalDelivery}
                  trackColor={{ false: '#E5E3DC', true: '#EAB320' }}
                  thumbColor="#FFFFFF"
                />
              </View>
            </ScrollView>

            {/* Fixed bottom action bar */}
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
  topArea: { marginBottom: 10 },
  searchPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F3F4F6', borderRadius: 999, height: 40, paddingLeft: 12, paddingRight: 8, marginHorizontal: 6, gap: 8 },
  searchInput: { flex: 1, paddingVertical: 0, fontSize: 15, color: '#1C1917' },
  searchDivider: { width: 1, height: 18, backgroundColor: '#E5E7EB' },
  filterPillBtn: { paddingLeft: 10, paddingRight: 4, paddingVertical: 6, alignItems: 'center', justifyContent: 'center' },
  categoryRow: { paddingVertical: 8 },
  categoryChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: '#F3F4F6', borderWidth: 1, borderColor: 'transparent' },
  categoryChipActive: { backgroundColor: '#FFFBF0', borderColor: '#EAB320' },
  categoryChipText: { fontSize: 13, color: '#6B7280', fontWeight: '500' },
  categoryChipTextActive: { color: '#92660A', fontWeight: '600' },
  feed: { paddingHorizontal: 6, paddingBottom: 100 },
  columns: { flexDirection: 'row', gap: 10 },
  column: { flex: 1 },
  card: { borderRadius: 6, overflow: 'hidden', backgroundColor: '#F3F4F6' },

  // Badge
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

  // Modal
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

  // Sort
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

  // Chips
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

  // Toggles
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleLabel: {
    fontSize: 14,
    color: '#403F3D',
  },

  // Section separator
  sectionSeparator: {
    height: 1,
    backgroundColor: '#E5E3DC',
    marginVertical: 16,
  },

  // Action bar
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
