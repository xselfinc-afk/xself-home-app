import React, { useState } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, Image, StyleSheet, ScrollView } from 'react-native';

const products = [
  { id: 1, name: 'Minimalist Sofa', price: 1299, img: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400', category: 'living' },
  { id: 2, name: 'Oak Coffee Table', price: 449, img: 'https://images.unsplash.com/photo-1532372320572-cda25653a26d?w=400', category: 'living' },
  { id: 3, name: 'Modern Lamp', price: 199, img: 'https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400', category: 'living' },
  { id: 4, name: 'Velvet Chair', price: 599, img: 'https://images.unsplash.com/photo-1551298370-9d3d53bc4dc3?w=400', category: 'living' },
  { id: 5, name: 'Bookshelf', price: 349, img: 'https://images.unsplash.com/photo-1594620302200-9a762244a156?w=400', category: 'living' },
  { id: 6, name: 'Area Rug', price: 279, img: 'https://images.unsplash.com/photo-1600166898405-da9535204843?w=400', category: 'living' },
];

const rooms = ['All', 'Living', 'Bedroom', 'Kitchen', 'Bathroom'];
const colors = ['All', 'Pastels', 'Neutral', 'Bold', 'Natural'];

export default function DiscoverScreen({ navigation }) {
  const [search, setSearch] = useState('');
  const [room, setRoom] = useState('All');
  const [color, setColor] = useState('All');

  const filtered = products.filter(p => {
    const matchRoom = room === 'All' || p.category === room.toLowerCase();
    const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase());
    return matchRoom && matchSearch;
  });

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Discover</Text>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.close}>Close</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder='Try "Cabinet"...'
          value={search}
          onChangeText={setSearch}
          placeholderTextColor="#9CA3AF"
        />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips}>
        {rooms.map(r => (
          <TouchableOpacity
            key={r}
            style={[styles.chip, room === r && styles.chipActive]}
            onPress={() => setRoom(r)}
          >
            <Text style={[styles.chipText, room === r && styles.chipTextActive]}>{r}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.colorChips}>
        <Text style={styles.colorLabel}>Color:</Text>
        {colors.map(c => (
          <TouchableOpacity
            key={c}
            style={[styles.colorChip, color === c && styles.colorChipActive]}
            onPress={() => setColor(c)}
          >
            <Text style={[styles.colorChipText, color === c && styles.colorChipTextActive]}>{c}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <FlatList
        data={filtered}
        numColumns={2}
        keyExtractor={item => item.id.toString()}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.masonryItem} onPress={() => navigation.navigate('ProductDetail', { product: item })}>
            <Image source={{ uri: item.img }} style={styles.masonryImage} />
          </TouchableOpacity>
        )}
        contentContainerStyle={styles.masonry}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'white' },
  header: { flexDirection: 'row', justifyContent: 'space-between', padding: 20, paddingTop: 50 },
  title: { fontSize: 24, fontWeight: '600', color: '#1C1917' },
  close: { fontSize: 16, color: '#6B7280' },
  searchContainer: { paddingHorizontal: 20, marginBottom: 12 },
  searchInput: { backgroundColor: '#F3F4F6', borderRadius: 24, padding: 14, fontSize: 15 },
  chips: { paddingHorizontal: 20, marginBottom: 12 },
  chip: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 24, backgroundColor: '#F3F4F6', marginRight: 8 },
  chipActive: { backgroundColor: '#1C1917' },
  chipText: { fontSize: 13, color: '#6B7280' },
  chipTextActive: { color: 'white' },
  colorChips: { paddingHorizontal: 20, marginBottom: 16 },
  colorLabel: { fontSize: 12, color: '#9CA3AF', marginRight: 8, alignSelf: 'center' },
  colorChip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: '#F3F4F6', marginRight: 6 },
  colorChipActive: { backgroundColor: '#1C1917' },
  colorChipText: { fontSize: 12, color: '#6B7280' },
  colorChipTextActive: { color: 'white' },
  masonry: { padding: 12 },
  masonryItem: { flex: 1, margin: 4, borderRadius: 12, overflow: 'hidden' },
  masonryImage: { width: '100%', height: 150 + Math.random() * 50, backgroundColor: '#F3F4F6' },
});
