import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Image, TextInput, FlatList, StyleSheet, SafeAreaView, StatusBar } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

const products = [
  { id: 1, name: 'Minimalist Sofa', price: 1299, sale: 1599, img: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400', rating: 4.2, reviews: 328, sales: 1234, hot: true, desc: 'Premium minimalist sofa with clean lines.', category: 'living' },
  { id: 2, name: 'Oak Coffee Table', price: 449, img: 'https://images.unsplash.com/photo-1532372320572-cda25653a26d?w=400', rating: 4.8, reviews: 156, sales: 567, desc: 'Solid oak coffee table.', category: 'living' },
  { id: 3, name: 'Modern Lamp', price: 199, img: 'https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400', rating: 4.5, reviews: 89, sales: 234, desc: 'Sleek modern lamp.', category: 'living' },
  { id: 4, name: 'Velvet Chair', price: 599, sale: 799, img: 'https://images.unsplash.com/photo-1551298370-9d3d53bc4dc3?w=400', rating: 4.6, reviews: 412, sales: 2567, hot: true, desc: 'Luxurious velvet chair.', category: 'living' },
  { id: 5, name: 'Bookshelf', price: 349, img: 'https://images.unsplash.com/photo-1594620302200-9a762244a156?w=400', rating: 4.3, reviews: 78, sales: 189, desc: 'Modern bookshelf.', category: 'living' },
  { id: 6, name: 'Area Rug', price: 279, img: 'https://images.unsplash.com/photo-1600166898405-da9535204843?w=400', rating: 4.7, reviews: 203, sales: 892, desc: 'Soft area rug.', category: 'living' },
  { id: 7, name: 'Dining Chair', price: 199, img: 'https://images.unsplash.com/photo-1503602642458-2321114458c4?w=400', rating: 4.4, reviews: 156, sales: 456, desc: 'Classic dining chair.', category: 'dining' },
  { id: 8, name: 'Sectional Sofa', price: 899, img: 'https://images.unsplash.com/photo-1493663284031-b7e3aefcae8e?w=400', rating: 4.6, reviews: 289, sales: 789, hot: true, desc: 'Large sectional sofa.', category: 'living' },
];

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const TabIcon = ({ name, focused }) => {
  const icons = { Home: '🏠', Discover: '🔍', Cart: '🛒', Account: '👤' };
  return <Text style={{ fontSize: 22 }}>{icons[name] || '○'}</Text>;
};

function HomeScreen({ navigation }) {
  const categories = ['All', 'Living', 'Bedroom', 'Dining'];

  const renderProduct = ({ item }) => (
    <TouchableOpacity style={styles.productCard} onPress={() => navigation.navigate('ProductDetail', { product: item })}>
      <Image source={{ uri: item.img }} style={styles.productImage} />
      {item.sale && <View style={styles.saleBadge}><Text style={styles.saleText}>SALE</Text></View>}
      <View style={styles.productInfo}>
        <Text style={styles.productName}>{item.name}</Text>
        <View style={styles.priceRow}>
          <Text style={styles.productPrice}>${item.price}</Text>
          {item.sale && <Text style={styles.originalPrice}>${item.sale}</Text>}
        </View>
        <View style={styles.ratingRow}>
          <Text style={styles.stars}>★ {item.rating}</Text>
          <Text style={styles.reviews}>({item.reviews})</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Good Morning</Text>
          <Text style={styles.title}>Discover</Text>
        </View>
        <View style={styles.headerIcons}>
          <TouchableOpacity style={styles.iconBtn}><Text>🔔</Text></TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn}><Text>👤</Text></TouchableOpacity>
        </View>
      </View>

      <View style={styles.searchBar}>
        <Text>🔍</Text>
        <TextInput style={styles.searchInput} placeholder="Search furniture..." placeholderTextColor="#9CA3AF" />
      </View>

      <View style={styles.memberBanner}>
        <View>
          <View style={styles.memberBadge}><Text style={styles.memberBadgeText}>★ Gold Member</Text></View>
          <Text style={styles.pointsValue}>2,450</Text>
          <Text style={styles.pointsLabel}>Points</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>$89</Text>
          <Text style={styles.statLabel}>Saved</Text>
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categories}>
        {categories.map((cat, index) => (
          <TouchableOpacity key={index} style={[styles.categoryPill, index === 0 && styles.categoryPillActive]}>
            <Text style={[styles.categoryText, index === 0 && styles.categoryTextActive]}>{cat}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <FlatList data={products} renderItem={renderProduct} keyExtractor={item => item.id.toString()} numColumns={2} contentContainerStyle={styles.productsGrid} />
    </SafeAreaView>
  );
}

function ProductDetailScreen({ route }) {
  const { product } = route.params;
  const [qty, setQty] = useState(1);
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView>
        <Image source={{ uri: product.img }} style={styles.detailImage} />
        <View style={styles.detailContent}>
          <Text style={styles.detailName}>{product.name}</Text>
          <View style={styles.detailRating}><Text style={styles.detailStars}>★ {product.rating}</Text><Text style={styles.detailReviews}>({product.reviews} reviews)</Text></View>
          <Text style={styles.detailPrice}>${product.price}</Text>
          {product.sale && <Text style={styles.detailSale}>${product.sale}</Text>}
          <Text style={styles.detailDesc}>{product.desc}</Text>}
          <View style={styles.quantityRow}>
            <TouchableOpacity style={styles.qtyBtn} onPress={() => setQty(Math.max(1, qty - 1))}><Text>-</Text></TouchableOpacity>
            <Text style={styles.qtyValue}>{qty}</Text>
            <TouchableOpacity style={styles.qtyBtn} onPress={() => setQty(qty + 1)}><Text>+</Text></TouchableOpacity>
          </View>
          <TouchableOpacity style={styles.addToCartBtn}><Text style={styles.addToCartText}>Add to Cart - ${product.price * qty}</Text></TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function CartScreen() {
  const cart = [{ ...products[0], qty: 1 }, { ...products[2], qty: 2 }];
  const total = cart.reduce((sum, p) => sum + p.price * p.qty, 0);
  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.screenTitle}>Cart ({cart.length})</Text>
      {cart.map(item => (
        <View key={item.id} style={styles.cartItem}>
          <Image source={{ uri: item.img }} style={styles.cartImage} />
          <View style={styles.cartInfo}>
            <Text style={styles.cartName}>{item.name}</Text>
            <Text style={styles.cartPrice}>${item.price} x {item.qty}</Text>
          </View>
        </View>
      ))}
      <View style={styles.cartSummary}>
        <View style={styles.totalRow}><Text>Total</Text><Text style={styles.totalValue}>${total}</Text></View>
        <TouchableOpacity style={styles.checkoutBtn}><Text style={styles.checkoutBtnText}>Proceed to Checkout</Text></TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function DiscoverScreen() {
  const [search, setSearch] = useState('');
  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.screenTitle}>Discover</Text>
      <View style={styles.searchBar}><Text>🔍</Text><TextInput style={styles.searchInput} placeholder='Try "Cabinet"...' value={search} onChangeText={setSearch} /></View>
      <FlatList data={products} numColumns={2} keyExtractor={item => item.id.toString()} renderItem={({ item }) => (
        <TouchableOpacity style={styles.masonryItem}><Image source={{ uri: item.img }} style={styles.masonryImage} /></TouchableOpacity>
      )} />
    </SafeAreaView>
  );
}

function AccountScreen() {
  const menuItems = [
    { icon: '📦', title: 'My Orders', arrow: true },
    { icon: '❤️', title: 'Saved Items', arrow: true },
    { icon: '💰', title: 'Earn & Share', arrow: true },
    { icon: '⚙️', title: 'Settings', arrow: true },
  ];
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.accountHeader}>
        <View style={styles.avatar}><Text style={styles.avatarText}>JD</Text></View>
        <View><Text style={styles.accountName}>John Doe</Text><Text style={styles.accountEmail}>john@email.com</Text></View>
      </View>
      {menuItems.map((item, index) => (
        <TouchableOpacity key={index} style={styles.menuItem}>
          <Text style={{ fontSize: 20 }}>{item.icon}</Text>
          <Text style={styles.menuText}>{item.title}</Text>
          <Text style={{ color: '#9CA3AF' }}>›</Text>
        </TouchableOpacity>
      ))}
    </SafeAreaView>
  );
}

function TabNavigator() {
  return (
    <Tab.Navigator screenOptions={({ route }) => ({
      headerShown: false,
      tabBarStyle: styles.tabBar,
      tabBarActiveTintColor: '#1C1917',
      tabBarInactiveTintColor: '#9CA3AF',
      tabBarIcon: ({ focused }) => <TabIcon name={route.name} focused={focused} />,
    })}>
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Discover" component={DiscoverScreen} />
      <Tab.Screen name="Cart" component={CartScreen} />
      <Tab.Screen name="Account" component={AccountScreen} />
    </Tab.Navigator>
  );
}

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Main" component={TabNavigator} />
        <Stack.Screen name="ProductDetail" component={ProductDetailScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAFAF9' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16 },
  greeting: { fontSize: 12, color: '#9CA3AF', textTransform: 'uppercase' },
  title: { fontSize: 28, fontWeight: '600', color: '#1C1917' },
  headerIcons: { flexDirection: 'row', gap: 12 },
  iconBtn: { width: 44, height: 44, borderRadius: 14, backgroundColor: '#F5F5F4', alignItems: 'center', justifyContent: 'center' },
  searchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F3F4F6', borderRadius: 20, paddingHorizontal: 16, margin: 20, gap: 8 },
  searchInput: { flex: 1, paddingVertical: 12, fontSize: 15 },
  memberBanner: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#1C1917', borderRadius: 20, padding: 20, marginHorizontal: 20 },
  memberBadge: { backgroundColor: '#CA8A04', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, marginBottom: 8 },
  memberBadgeText: { color: 'white', fontSize: 11, fontWeight: '600' },
  pointsValue: { color: 'white', fontSize: 24, fontWeight: '600' },
  pointsLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 11 },
  statItem: { alignItems: 'flex-end' },
  statValue: { color: 'white', fontSize: 14, fontWeight: '600' },
  statLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 10 },
  categories: { paddingHorizontal: 20, marginBottom: 10 },
  categoryPill: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 24, backgroundColor: 'white', marginRight: 10, borderWidth: 1, borderColor: '#E5E7EB' },
  categoryPillActive: { backgroundColor: '#1C1917', borderColor: '#1C1917' },
  categoryText: { fontSize: 14, color: '#6B7280' },
  categoryTextActive: { color: 'white' },
  productsGrid: { padding: 10 },
  productCard: { flex: 1, margin: 5, backgroundColor: 'white', borderRadius: 16, overflow: 'hidden' },
  productImage: { width: '100%', height: 150, backgroundColor: '#F3F4F6' },
  saleBadge: { position: 'absolute', top: 8, left: 8, backgroundColor: '#DC2626', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  saleText: { color: 'white', fontSize: 10, fontWeight: '700' },
  productInfo: { padding: 12 },
  productName: { fontSize: 13, fontWeight: '500', color: '#1C1917', marginBottom: 4 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  productPrice: { fontSize: 16, fontWeight: '700', color: '#1C1917' },
  originalPrice: { fontSize: 12, color: '#9CA3AF', textDecorationLine: 'line-through' },
  ratingRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 4 },
  stars: { color: '#FBBF24', fontSize: 10 },
  reviews: { color: '#9CA3AF', fontSize: 10 },
  screenTitle: { fontSize: 24, fontWeight: '600', color: '#1C1917', padding: 20 },
  detailImage: { width: '100%', height: 300, backgroundColor: '#F3F4F6' },
  detailContent: { padding: 20, backgroundColor: 'white', borderTopLeftRadius: 32, borderTopRightRadius: 32, marginTop: -24 },
  detailName: { fontSize: 26, fontWeight: '600', color: '#1C1917' },
  detailRating: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  detailStars: { color: '#FBBF24', fontSize: 14 },
  detailReviews: { color: '#6B7280', fontSize: 14, marginLeft: 8 },
  detailPrice: { fontSize: 28, fontWeight: '700', color: '#1C1917', marginTop: 12 },
  detailSale: { fontSize: 18, color: '#9CA3AF', textDecorationLine: 'line-through', marginLeft: 8 },
  detailDesc: { fontSize: 14, color: '#6B7280', marginTop: 16, lineHeight: 22 },
  quantityRow: { flexDirection: 'row', alignItems: 'center', marginTop: 20, gap: 16 },
  qtyBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' },
  qtyValue: { fontSize: 18, fontWeight: '600' },
  addToCartBtn: { backgroundColor: '#1C1917', padding: 16, borderRadius: 24, alignItems: 'center', marginTop: 20 },
  addToCartText: { color: 'white', fontSize: 16, fontWeight: '600' },
  cartItem: { flexDirection: 'row', padding: 12, backgroundColor: 'white', marginHorizontal: 20, marginBottom: 10, borderRadius: 16 },
  cartImage: { width: 70, height: 70, borderRadius: 12, backgroundColor: '#F3F4F6' },
  cartInfo: { flex: 1, marginLeft: 12, justifyContent: 'center' },
  cartName: { fontSize: 14, fontWeight: '500', color: '#1C1917' },
  cartPrice: { fontSize: 16, fontWeight: '600', color: '#1C1917', marginTop: 4 },
  cartSummary: { padding: 20, backgroundColor: 'white', borderTopWidth: 1, borderTopColor: '#F3F4F6' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
  totalValue: { fontSize: 20, fontWeight: '700', color: '#1C1917' },
  checkoutBtn: { backgroundColor: '#CA8A04', padding: 16, borderRadius: 24, alignItems: 'center' },
  checkoutBtnText: { color: 'white', fontSize: 16, fontWeight: '600' },
  masonryItem: { flex: 1, margin: 4, borderRadius: 12, overflow: 'hidden' },
  masonryImage: { width: '100%', height: 150 + Math.random() * 50, backgroundColor: '#F3F4F6' },
  accountHeader: { flexDirection: 'row', alignItems: 'center', padding: 20 },
  avatar: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#CA8A04', alignItems: 'center', justifyContent: 'center', marginRight: 16 },
  avatarText: { color: 'white', fontSize: 24, fontWeight: '600' },
  accountName: { fontSize: 20, fontWeight: '600', color: '#1C1917' },
  accountEmail: { fontSize: 14, color: '#6B7280' },
  menuItem: { flexDirection: 'row', alignItems: 'center', padding: 16, backgroundColor: 'white', marginHorizontal: 20, marginBottom: 8, borderRadius: 12 },
  menuText: { flex: 1, fontSize: 16, color: '#1C1917', marginLeft: 16 },
  tabBar: { position: 'absolute', bottom: 24, left: 20, right: 20, backgroundColor: 'white', borderRadius: 24, paddingBottom: 8, height: 70 },
});
