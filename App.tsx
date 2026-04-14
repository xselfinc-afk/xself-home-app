import React, { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View, Text, ScrollView, TouchableOpacity, Image, TextInput, FlatList, StyleSheet, SafeAreaView, StatusBar, Share, Alert, Dimensions } from 'react-native';
import ProductCard from './src/components/ProductCard';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { products } from './src/data/products';
import { CartProvider, useCart } from './src/context/CartContext';
import { CartAnimProvider } from './src/context/CartAnimationContext';
import { RewardsProvider } from './src/context/RewardsContext';
import OrdersScreen from './src/screens/OrdersScreen';
import EarnScreen from './src/screens/EarnScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import NotificationsScreen from './src/screens/NotificationsScreen';
import CheckoutScreen from './src/screens/CheckoutScreen';
import OrderSuccessScreen from './src/screens/OrderSuccessScreen';
import DiscoverScreen from './src/screens/DiscoverScreen';
import ReviewSection from './src/components/ReviewSection';

const screenWidth = Dimensions.get('window').width;

const VARIANT_COLORS = [
  { label: 'Natural', hex: '#C4A265' },
  { label: 'Walnut', hex: '#6B3F1F' },
  { label: 'White', hex: '#EFEDE8' },
  { label: 'Slate', hex: '#78829A' },
];
const VARIANT_SIZES = ['Small', 'Medium', 'Large'];


async function pickSearchImage(source: 'camera' | 'library') {
  const perm = source === 'camera'
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();

  if (!perm.granted) {
    Alert.alert(
      'Permission required',
      source === 'camera'
        ? 'Please allow camera access to search by photo.'
        : 'Please allow photo access to search by photo.'
    );
    return null;
  }

  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync({ quality: 0.8 })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.8 });

  if (result.canceled) return null;
  return result.assets?.[0]?.uri ?? null;
}

function getTextResults(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return products;
  return products.filter(
    (p) =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.category || '').toLowerCase().includes(q)
  );
}

function getPhotoResults(uri: string | null) {
  // Scaffold visual match: deterministic fallback based on uri hash (real user flow: pick photo -> see matches)
  if (!uri) return [];
  let hash = 0;
  for (let i = 0; i < uri.length; i++) hash = (hash * 31 + uri.charCodeAt(i)) % 100000;
  const mode = hash % 3;
  if (mode === 0) return products.filter((p) => p.category === 'living');
  if (mode === 1) return products.filter((p) => !!p.sale);
  return products.filter((p) => !!p.hot);
}

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();


const TabIcon = ({ name, focused }) => {
  const iconMap = {
    Home: 'home-outline',
    Discover: 'search-outline',
    Cart: 'cart-outline',
    Account: 'person-outline',
  };
  return (
    <View style={focused ? { backgroundColor: 'rgba(202,138,4,0.13)', borderRadius: 12, paddingVertical: 3, borderColor: 'rgba(255,255,255,0.3)', borderWidth: 0.5 } : {}}>
      <Ionicons name={(iconMap[name] || 'ellipse-outline') as any} size={22} color={focused ? '#CA8A04' : '#9CA3AF'} />
    </View>
  );
};

const BottomGradient = () => (
  <LinearGradient
    colors={['rgba(250,250,249,0.12)', 'rgba(250,250,249,0.06)', 'rgba(250,250,249,0.00)']}
    start={{ x: 0, y: 1 }}
    end={{ x: 0, y: 0 }}
    pointerEvents="none"
    style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 90, zIndex: 1 }}
  />
);

function SignInEntryScreen({ navigation }) {
  const [email, setEmail] = useState('');
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.signInWrap} keyboardShouldPersistTaps="handled">
        <Image
          source={{ uri: 'https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=1200' }}
          style={styles.signInHero}
          resizeMode="cover"
        />

        <View style={styles.signInCard}>
          <Text style={styles.signInTitle}>Welcome to Xself Home</Text>
          <Text style={styles.signInSubtitle}>Sign in to save favorites, track orders, and get member perks.</Text>

          <View style={styles.signInInputRow}>
            <Ionicons name="mail-outline" size={18} color="#6B7280" />
            <TextInput
              style={styles.signInInput}
              placeholder="Email address"
              placeholderTextColor="#9CA3AF"
              autoCapitalize="none"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
              returnKeyType="done"
            />
          </View>

          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => navigation.replace('Main')}
          >
            <Text style={styles.primaryBtnText}>Continue</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => navigation.replace('Main')} style={styles.secondaryBtn}>
            <Text style={styles.secondaryBtnText}>Skip for now</Text>
          </TouchableOpacity>

          <Text style={styles.signInFinePrint}>
            By continuing, you agree to receive updates from Xself Home. You can unsubscribe anytime.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}


const HOME_CATEGORIES = ['All', 'Sofa', 'Chair', 'Rug', 'Table', 'Storage'];
const hCardWidth = (screenWidth - 48) / 2;

function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [homeCategory, setHomeCategory] = useState('All');

  const topPicks = products.filter(p => p.img && p.rating >= 4.5).slice(0, 4);
  const bestSellers = [...products].filter(p => p.img).sort((a, b) => b.reviews - a.reviews).slice(0, 4);
  const filteredProducts = homeCategory === 'All'
    ? products.filter(p => p.img)
    : products.filter(p => p.img && p.name.toLowerCase().includes(homeCategory.toLowerCase()));

  const goToProduct = (item: any) => navigation.navigate('ProductDetail', { product: item });

  const HomeHeader = (
    <>
      {/* Search pill */}
      <TouchableOpacity
        activeOpacity={0.9}
        style={styles.searchPill}
        onPress={() => navigation.navigate('Search')}
      >
        <Ionicons name="search-outline" size={18} color="#6B7280" />
        <Text style={styles.searchPillPlaceholder}>Search Xself</Text>
        <View style={styles.searchPillDivider} />
        <TouchableOpacity
          onPress={() => {
            Alert.alert('Search by photo', 'Choose a source', [
              { text: 'Take Photo', onPress: async () => { const uri = await pickSearchImage('camera'); if (uri) navigation.navigate('Search', { imageUri: uri }); } },
              { text: 'Upload Photo', onPress: async () => { const uri = await pickSearchImage('library'); if (uri) navigation.navigate('Search', { imageUri: uri }); } },
              { text: 'Cancel', style: 'cancel' },
            ]);
          }}
          style={styles.searchPillCamBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="camera-outline" size={18} color="#1C1917" />
        </TouchableOpacity>
      </TouchableOpacity>

      {/* Category shortcuts */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.homeCategoryRow} contentContainerStyle={{ paddingHorizontal: 10, gap: 6 }}>
        {HOME_CATEGORIES.map(cat => {
          const active = cat === homeCategory;
          return (
            <TouchableOpacity key={cat} style={[styles.homeCategoryChip, active && styles.homeCategoryChipActive]} onPress={() => setHomeCategory(cat)}>
              <Text style={[styles.homeCategoryChipText, active && styles.homeCategoryChipTextActive]}>{cat}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Hero banner */}
      <View style={styles.heroBanner}>
        <Text style={styles.heroEyebrow}>NEW ARRIVALS</Text>
        <Text style={styles.heroTitle}>Spring Collection{'\n'}Up to 30% off</Text>
        <TouchableOpacity style={styles.heroCTA} onPress={() => setHomeCategory('All')}>
          <Text style={styles.heroCTAText}>Shop Now</Text>
        </TouchableOpacity>
      </View>

      {/* Top Picks */}
      <View style={styles.homeSectionHeader}>
        <Text style={styles.homeSectionTitle}>Top Picks For You</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 6, gap: 6 }}>
        {topPicks.map(item => (
          <ProductCard key={item.id} product={item} onPress={() => goToProduct(item)} style={{ width: hCardWidth }} />
        ))}
      </ScrollView>

      {/* Best Sellers */}
      <View style={styles.homeSectionHeader}>
        <Text style={styles.homeSectionTitle}>Best Sellers</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 6, gap: 6 }}>
        {bestSellers.map(item => (
          <ProductCard key={item.id} product={item} onPress={() => goToProduct(item)} style={{ width: hCardWidth }} />
        ))}
      </ScrollView>

      {/* All Products header */}
      <View style={styles.homeSectionHeader}>
        <Text style={styles.homeSectionTitle}>{homeCategory === 'All' ? 'All Products' : homeCategory}</Text>
      </View>
    </>
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="dark-content" />
      <FlatList
        ListHeaderComponent={HomeHeader}
        data={filteredProducts}
        renderItem={({ item }) => (
          <ProductCard
            product={item}
            onPress={() => goToProduct(item)}
            style={styles.productCard}
          />
        )}
        keyExtractor={(item) => item.id.toString()}
        numColumns={2}
        contentContainerStyle={styles.productsGrid}
      />
    </View>
  );
}

function AddToCartButton({ product, qty }) {
  const { addItem } = useCart();
  return (
    <TouchableOpacity
      style={styles.addToCartBtn}
      onPress={() => addItem(product, qty)}
    >
      <Text style={styles.addToCartText}>
        {`Add to Cart — $${product.price * qty}`}
      </Text>
    </TouchableOpacity>
  );
}

function ProductDetailScreen({ route, navigation }) {
  const { product } = route.params;
  const [qty, setQty] = useState(1);
  const [activeImage, setActiveImage] = useState(0);
  const [selectedColor, setSelectedColor] = useState(VARIANT_COLORS[0].label);
  const [selectedSize, setSelectedSize] = useState(VARIANT_SIZES[0]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { totalItems, addItem } = useCart();

  const images: string[] = product.images ?? [product.img];
  const recommendations = products
    .filter(p => p.id !== product.id && p.category === product.category)
    .slice(0, 4);
  const fbt = products
    .filter(p => p.id !== product.id && p.img)
    .slice(0, 2);
  const fbtTotal = product.price + fbt.reduce((s, p) => s + p.price, 0);

  const handleShare = async () => {
    try {
      await Share.share({ message: `Check out ${product.name} - $${product.price} on Xself Home!` });
    } catch (e) {}
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={{ paddingBottom: 120 }}>
        {/* Image carousel */}
        <View>
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={e => {
              const idx = Math.round(e.nativeEvent.contentOffset.x / screenWidth);
              setActiveImage(idx);
            }}
          >
            {images.map((uri, i) => (
              <Image
                key={i}
                source={{ uri }}
                style={{ width: screenWidth, aspectRatio: 4 / 5 }}
                resizeMode="cover"
              />
            ))}
          </ScrollView>

          {/* Back + Share overlay buttons */}
          <TouchableOpacity style={styles.detailBackBtn} onPress={() => navigation.goBack()}>
            <Ionicons name="chevron-back" size={20} color="#1C1917" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.detailShareBtn} onPress={handleShare}>
            <Ionicons name="share-outline" size={18} color="#1C1917" />
          </TouchableOpacity>

          {/* Pagination dots */}
          {images.length > 1 && (
            <View style={styles.dotsRow}>
              {images.map((_, i) => (
                <View key={i} style={[styles.dot, i === activeImage && styles.dotActive]} />
              ))}
            </View>
          )}
        </View>

        {/* Product info */}
        <View style={styles.detailContent}>
          <Text style={styles.detailName}>{product.name}</Text>
          <View style={styles.detailPriceRow}>
            <Text style={styles.detailPrice}>${product.price}</Text>
            {product.sale && <Text style={styles.detailSale}>${product.sale}</Text>}
            {product.sale && (
              <View style={styles.detailSaveBadge}>
                <Text style={styles.detailSaveText}>Save ${product.sale - product.price}</Text>
              </View>
            )}
          </View>
          <View style={styles.detailRating}>
            <Text style={styles.detailStars}>★ {product.rating}</Text>
            <Text style={styles.detailReviews}>({product.reviews} reviews)</Text>
          </View>

          {/* Trust badges */}
          <View style={styles.trustBadgeRow}>
            <View style={styles.trustBadgeItem}>
              <Ionicons name="refresh-outline" size={14} color="#6B7280" />
              <Text style={styles.trustBadgeText}>Free Returns</Text>
            </View>
            <View style={styles.trustBadgeItem}>
              <Ionicons name="cube-outline" size={14} color="#6B7280" />
              <Text style={styles.trustBadgeText}>2–5 Day Delivery</Text>
            </View>
            <View style={styles.trustBadgeItem}>
              <Ionicons name="shield-checkmark-outline" size={14} color="#6B7280" />
              <Text style={styles.trustBadgeText}>1-Year Warranty</Text>
            </View>
            <View style={styles.trustBadgeItem}>
              <Ionicons name="lock-closed-outline" size={14} color="#6B7280" />
              <Text style={styles.trustBadgeText}>Secure Checkout</Text>
            </View>
          </View>

          {/* Color variants */}
          <View style={styles.variantSection}>
            <Text style={styles.variantLabel}>Color: <Text style={styles.variantValue}>{selectedColor}</Text></Text>
            <View style={styles.colorSwatches}>
              {VARIANT_COLORS.map(c => (
                <TouchableOpacity
                  key={c.label}
                  style={[styles.swatchRing, selectedColor === c.label && styles.swatchRingSelected]}
                  onPress={() => setSelectedColor(c.label)}
                  activeOpacity={0.8}
                >
                  <View style={[styles.swatch, { backgroundColor: c.hex }]} />
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Size variants */}
          <View style={styles.variantSection}>
            <Text style={styles.variantLabel}>Size: <Text style={styles.variantValue}>{selectedSize}</Text></Text>
            <View style={styles.sizeButtons}>
              {VARIANT_SIZES.map(s => (
                <TouchableOpacity
                  key={s}
                  style={[styles.sizeBtn, selectedSize === s && styles.sizeBtnSelected]}
                  onPress={() => setSelectedSize(s)}
                >
                  <Text style={[styles.sizeBtnText, selectedSize === s && styles.sizeBtnTextSelected]}>{s}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <Text style={styles.detailDesc}>{product.desc}</Text>

          {/* Collapsible product details */}
          <TouchableOpacity style={styles.productDetailsToggle} onPress={() => setDetailsOpen(v => !v)} activeOpacity={0.7}>
            <Text style={styles.productDetailsToggleLabel}>Product Details</Text>
            <Ionicons name={detailsOpen ? 'chevron-up' : 'chevron-down'} size={16} color="#6B7280" />
          </TouchableOpacity>
          {detailsOpen && (
            <View style={styles.specsCard}>
              <View style={styles.specRow}>
                <Text style={styles.specLabel}>Dimensions</Text>
                <Text style={styles.specValue}>85"W × 34"D × 32"H</Text>
              </View>
              <View style={[styles.specRow, { borderBottomWidth: 0 }]}>
                <Text style={styles.specLabel}>Material</Text>
                <Text style={styles.specValue}>Solid Wood · Linen Fabric</Text>
              </View>
            </View>
          )}

          <View style={styles.quantityRow}>
            <Text style={styles.qtyLabel}>Qty</Text>
            <View style={styles.qtyControls}>
              <TouchableOpacity style={styles.qtyBtn} onPress={() => setQty(Math.max(1, qty - 1))}>
                <Ionicons name="remove" size={16} color="#1C1917" />
              </TouchableOpacity>
              <Text style={styles.qtyValue}>{qty}</Text>
              <TouchableOpacity style={styles.qtyBtn} onPress={() => setQty(qty + 1)}>
                <Ionicons name="add" size={16} color="#1C1917" />
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* Reviews */}
        <ReviewSection product={product} />

        {/* Frequently Bought Together */}
        {fbt.length > 0 && (
          <View style={styles.fbtSection}>
            <Text style={styles.fbtTitle}>Frequently Bought Together</Text>
            <View style={styles.fbtRow}>
              <Image source={{ uri: product.img }} style={styles.fbtImg} />
              {fbt.map((p, i) => (
                <React.Fragment key={p.id}>
                  <Text style={styles.fbtPlus}>+</Text>
                  <Image source={{ uri: p.img }} style={styles.fbtImg} />
                </React.Fragment>
              ))}
            </View>
            <View style={styles.fbtNames}>
              {[product, ...fbt].map(p => (
                <Text key={p.id} style={styles.fbtName} numberOfLines={1}>· {p.name}</Text>
              ))}
            </View>
            <View style={styles.fbtFooter}>
              <Text style={styles.fbtTotal}>Total: <Text style={styles.fbtTotalValue}>${fbtTotal}</Text></Text>
              <TouchableOpacity style={styles.fbtBtn} onPress={() => { addItem(product, 1); fbt.forEach(p => addItem(p, 1)); }}>
                <Text style={styles.fbtBtnText}>Add All to Cart</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* You May Also Like */}
        {recommendations.length > 0 && (
          <View style={styles.recommendSection}>
            <Text style={styles.recommendTitle}>You May Also Like</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.recommendList}
            >
              {recommendations.map(p => (
                <ProductCard
                  key={p.id}
                  product={p}
                  onPress={() => (navigation as any).push('ProductDetail', { product: p })}
                  style={styles.recommendCard}
                />
              ))}
            </ScrollView>
          </View>
        )}
      </ScrollView>

      {/* Sticky bottom action bar */}
      <View style={styles.stickyBar}>
        <TouchableOpacity style={styles.stickyCartBtn} onPress={() => addItem(product, qty)}>
          <Text style={styles.stickyCartText}>Add to Cart</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.stickyBuyBtn}
          onPress={() => { addItem(product, qty); navigation.navigate('Main', { screen: 'Cart' }); }}
        >
          <Text style={styles.stickyBuyText}>Buy Now</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}



function SearchScreen({ navigation, route }) {
  const initialQuery = route?.params?.query ?? '';
  const initialImageUri = route?.params?.imageUri ?? null;
  const [query, setQuery] = useState(String(initialQuery));
  const [imageUri, setImageUri] = useState<string | null>(initialImageUri);

  const results = imageUri ? getPhotoResults(imageUri) : getTextResults(query);

  const onPressCamera = () => {
    Alert.alert('Search by photo', 'Choose a source', [
      {
        text: 'Take Photo',
        onPress: async () => {
          const uri = await pickSearchImage('camera');
          if (uri) setImageUri(uri);
        },
      },
      {
        text: 'Upload Photo',
        onPress: async () => {
          const uri = await pickSearchImage('library');
          if (uri) setImageUri(uri);
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.searchTopBar}>
        <TouchableOpacity style={styles.searchBackBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={20} color="#1C1917" />
        </TouchableOpacity>

        <View style={[styles.searchPill, styles.searchPillHeader]}>
          <Ionicons name="search-outline" size={18} color="#6B7280" />
          <TextInput
            style={styles.searchPillInput}
            placeholder="Search Xself"
            placeholderTextColor="#9CA3AF"
            autoFocus
            value={query}
            onChangeText={(t) => {
              setImageUri(null);
              setQuery(t);
            }}
            returnKeyType="search"
          />
          <View style={styles.searchPillDivider} />
          <TouchableOpacity style={styles.searchPillCamBtn} onPress={onPressCamera}>
            <Ionicons name="camera-outline" size={18} color="#1C1917" />
          </TouchableOpacity>
        </View>
      </View>

      {imageUri ? (<View style={styles.searchPhotoRow}>
          <Image source={{ uri: imageUri }} style={styles.searchPhotoThumb} />
          <View style={{ flex: 1 }}>
            <Text style={styles.searchPhotoTitle}>Visual search (beta)</Text>
            <Text style={styles.searchPhotoSub}>Showing similar picks from our catalog.</Text>
          </View>
          <TouchableOpacity onPress={() => setImageUri(null)}>
            <Ionicons name="close-circle" size={20} color="#9CA3AF" />
          </TouchableOpacity>
        </View>
      ) : null}

      <FlatList
        data={results}
        keyExtractor={(item) => String(item.id)}
        numColumns={2}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 0 }}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.productCard} onPress={() => navigation.navigate('ProductDetail', { product: item })}>
            <Image source={{ uri: item.img }} style={styles.productImage} resizeMode="cover" />
            {item.sale && (
              <View style={styles.saleBadge}>
                <Text style={styles.saleText}>SALE</Text>
              </View>
            )}
            <View style={styles.productInfo}>
              <Text style={styles.productName}>{item.name}</Text>
              <View style={styles.priceRow}>
                <Text style={styles.productPrice}>${item.price}</Text>
                {item.sale && <Text style={styles.originalPrice}>${item.sale}</Text>}
              </View>
            </View>
          </TouchableOpacity>
        )}
      />
    </SafeAreaView>
  );
}
function CartScreen({ navigation }) {
  const { cart, updateQty, removeItem } = useCart();
  const insets = useSafeAreaInsets();

  if (cart.length === 0) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.cartEmptyOuter}>
          <View style={styles.cartEmptyBlock}>
            <View style={styles.cartEmptyIconWrap}>
              <Ionicons name="cart-outline" size={32} color="#CA8A04" />
            </View>
            <Text style={styles.cartEmptyTitle}>Your cart is empty</Text>
            <Text style={styles.cartEmptySubtitle}>Browse our collection and add items to get started.</Text>
            <TouchableOpacity onPress={() => navigation.navigate('Home')} style={styles.cartSignInBtn}>
              <Text style={styles.cartSignInBtnText}>Start Shopping</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  const total = cart.reduce((sum, p) => sum + p.price * p.qty, 0);
  const freeShipThreshold = 500;
  const remaining = Math.max(0, freeShipThreshold - total);
  const cartIds = new Set(cart.map(p => p.id));
  const recommended = products.filter(p => p.img && !cartIds.has(p.id)).slice(0, 4);

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.screenTitle}>Cart</Text>
      <ScrollView contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 80 }}>
        {/* Shipping banner */}
        {remaining > 0 ? (
          <View style={styles.shipBanner}>
            <Ionicons name="cube-outline" size={14} color="#CA8A04" />
            <Text style={styles.shipBannerText}>Add <Text style={styles.shipBannerAmt}>${remaining}</Text> more for free shipping</Text>
            <View style={styles.shipBarTrack}>
              <View style={[styles.shipBarFill, { width: `${Math.min(100, (total / freeShipThreshold) * 100)}%` }]} />
            </View>
          </View>
        ) : (
          <View style={styles.shipBannerUnlocked}>
            <Ionicons name="gift-outline" size={16} color="#CA8A04" />
            <View style={{ flex: 1 }}>
              <Text style={styles.shipBannerUnlockedTitle}>Free shipping unlocked</Text>
              <Text style={styles.shipBannerUnlockedSub}>You're saving on delivery for this order</Text>
            </View>
          </View>
        )}

        {cart.map(item => (
          <View key={item.id} style={styles.cartItem}>
            <Image source={{ uri: item.img }} style={styles.cartImage} />
            <View style={styles.cartInfo}>
              <Text style={styles.cartName} numberOfLines={2}>{item.name}</Text>
              <Text style={styles.cartVariants}>
                {VARIANT_COLORS[(item.id ?? 0) % VARIANT_COLORS.length].label} · {VARIANT_SIZES[(item.id ?? 0) % VARIANT_SIZES.length]}
              </Text>
              <View style={styles.cartBottomRow}>
                <Text style={styles.cartPrice}>${item.price}</Text>
                <View style={styles.cartQtyControls}>
                  <TouchableOpacity
                    style={styles.cartQtyBtn}
                    onPress={() => updateQty(item.id, Math.max(1, item.qty - 1))}
                  >
                    <Ionicons name="remove" size={14} color="#1C1917" />
                  </TouchableOpacity>
                  <Text style={styles.cartQtyText}>{item.qty}</Text>
                  <TouchableOpacity
                    style={styles.cartQtyBtn}
                    onPress={() => updateQty(item.id, item.qty + 1)}
                  >
                    <Ionicons name="add" size={14} color="#1C1917" />
                  </TouchableOpacity>
                </View>
              </View>
            </View>
            <TouchableOpacity style={styles.cartDeleteBtn} onPress={() => removeItem(item.id)}>
              <Ionicons name="close" size={16} color="#9CA3AF" />
            </TouchableOpacity>
          </View>
        ))}

        {/* Summary block */}
        <View style={styles.cartSummary}>
          <View style={styles.summaryLines}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Subtotal</Text>
              <Text style={styles.summaryValue}>${total}</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Shipping</Text>
              {remaining === 0
                ? <Text style={styles.summaryFree}>Free</Text>
                : <Text style={styles.summaryValue}>${(29.99).toFixed(2)}</Text>}
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Tax</Text>
              <Text style={styles.summaryMuted}>Calculated at checkout</Text>
            </View>
            <View style={[styles.summaryRow, styles.summaryTotalRow]}>
              <Text style={styles.summaryTotalLabel}>Total</Text>
              <Text style={styles.summaryTotalValue}>${remaining === 0 ? total : (total + 29.99).toFixed(2)}</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.checkoutBtn} onPress={() => navigation.navigate('Checkout')}>
            <Text style={styles.checkoutBtnText}>Secure Checkout</Text>
            <Text style={styles.checkoutBtnSub}>Secure · Free returns · Fast delivery</Text>
          </TouchableOpacity>
        </View>

        {/* Complete Your Space */}
        {recommended.length > 0 && (
          <View style={styles.cartRecommendSection}>
            <Text style={styles.cartRecommendTitle}>Complete Your Space</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 12 }}>
              {recommended.map(p => (
                <TouchableOpacity key={p.id} style={styles.cartRecommendCard} onPress={() => navigation.navigate('ProductDetail', { product: p })}>
                  {p.img
                    ? <Image source={{ uri: p.img }} style={styles.cartRecommendImg} />
                    : <View style={[styles.cartRecommendImg, { alignItems: 'center', justifyContent: 'center', backgroundColor: '#F3F4F6' }]}>
                        <Ionicons name="image-outline" size={24} color="#D1D5DB" />
                      </View>}
                  <View style={styles.cartRecommendInfo}>
                    <Text style={styles.cartRecommendName} numberOfLines={2}>{p.name}</Text>
                    {p.rating && (
                      <Text style={styles.cartRecommendRating}>⭐ {p.rating} ({p.reviews})</Text>
                    )}
                    <View style={styles.cartRecommendBottom}>
                      <Text style={styles.cartRecommendPrice}>${p.price}</Text>
                      <TouchableOpacity style={styles.cartRecommendAdd} onPress={() => { addItem(p, 1); }}>
                        <Text style={styles.cartRecommendAddText}>+ Add</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const isMember = true; // mock — replace with auth state

function AccountScreen({ navigation }) {
  const menuItems = [
    { icon: 'gift-outline', title: 'Share & Earn', subtitle: 'Earn 500 pts · $5 per referral', route: 'Earn' },
    { icon: 'cube-outline', title: 'Orders & Purchases', route: 'Orders' },
    { icon: 'settings-outline', title: 'Settings', route: 'Settings' },
  ];

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 48 }}>

        {/* Identity — left-aligned, membership wallet style */}
        <View style={styles.identitySection}>
          {/* Top membership row */}
          {isMember ? (
            <View style={styles.membershipRow}>
              <Text style={styles.memberLabel}>XSELF GOLD</Text>
              <Text style={styles.memberSince}>Member since 2024</Text>
            </View>
          ) : (
            <View style={styles.membershipRow}>
              <Text style={styles.memberSince}>Personal Account</Text>
            </View>
          )}
          {/* Avatar + identity block */}
          <View style={styles.profileRow}>
            <View style={[styles.avatarRing, isMember ? styles.avatarRingMember : styles.avatarRingGuest]}>
              <View style={styles.avatarInner}>
                <Text style={styles.avatarInitials}>JD</Text>
              </View>
            </View>
            <View style={styles.profileInfo}>
              <Text style={styles.profileName}>John Doe</Text>
              {isMember && (
                <>
                  <View style={styles.rewardsRow}>
                    <Text style={styles.profileRewardsValue}>$12.50</Text>
                    <TouchableOpacity style={styles.useNowBtn} activeOpacity={0.88}>
                      <Text style={styles.useNowText}>Use Now</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.profileRewardsSub}>Available Rewards</Text>
                  <TouchableOpacity onPress={() => navigation.navigate('Earn')} activeOpacity={0.7}>
                    <Text style={styles.earnMoreHint}>Earn more → Share & Earn</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>
        </View>

        {/* Non-member CTA */}
        {!isMember && (
          <View style={styles.memberCTACard}>
            <Text style={styles.memberCTATitle}>Xself Gold</Text>
            <Text style={styles.memberCTASub}>Save more · Earn more on every order</Text>
            <TouchableOpacity style={styles.memberCTABtn} activeOpacity={0.88}>
              <Text style={styles.memberCTABtnText}>Join Now</Text>
            </TouchableOpacity>
          </View>
        )}


        {/* Menu rows */}
        <Text style={styles.menuSectionLabel}>MY ACCOUNT</Text>
        <View style={styles.menuList}>
          {menuItems.map((item, index) => (
            <TouchableOpacity
              key={index}
              style={[styles.menuItem, index < menuItems.length - 1 && styles.menuItemBorder, index === 0 && styles.menuItemHighlight]}
              onPress={() => item.route && navigation.navigate(item.route)}
            >
              <Ionicons name={item.icon as any} size={20} color="#CA8A04" />
              <View style={styles.menuTextWrap}>
                <Text style={styles.menuText}>{item.title}</Text>
                {item.subtitle && <Text style={styles.menuSubText}>{item.subtitle}</Text>}
              </View>
              <Ionicons name="chevron-forward" size={15} color="#C4C0BA" />
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function TabNavigator() {
  const insets = useSafeAreaInsets();
  const { totalItems } = useCart();
  return (
    <View style={{ flex: 1 }}>
    <Tab.Navigator
      screenOptions={({ route }) => ({
      headerShown: false,
      tabBarStyle: [styles.tabBar, { bottom: insets.bottom + 2, backgroundColor: 'rgba(255,255,255,0.6)' }],
      tabBarBackground: () => <BlurView intensity={40} tint="light" style={StyleSheet.absoluteFill} />,
      tabBarActiveTintColor: '#CA8A04',
      tabBarInactiveTintColor: '#6B7280',
      tabBarIcon: ({ focused }) => <TabIcon name={route.name} focused={focused} />,
      tabBarShowLabel: true,
      tabBarLabelStyle: { fontSize: 9, fontWeight: '600', marginTop: 1 },
      tabBarItemStyle: { flex: 1, alignItems: 'center', justifyContent: 'center' },
      tabBarIconStyle: { marginTop: 0 },
      tabBarLabelPosition: 'below-icon',
    })}>
      <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarLabel: 'Home' }} />
      <Tab.Screen name="Discover" component={DiscoverScreen} options={{ tabBarLabel: 'Discover' }} />
      <Tab.Screen
        name="Cart"
        component={CartScreen}
        options={{
          tabBarLabel: 'Cart',
          tabBarBadge: totalItems > 0 ? totalItems : undefined,
          tabBarBadgeStyle: { backgroundColor: '#CA8A04', fontSize: 10 },
        }}
      />
      <Tab.Screen name="Account" component={AccountScreen} options={{ tabBarLabel: 'Account' }} />
    </Tab.Navigator>
    <BottomGradient />
    </View>
  );
}

export default function App() {
  return (
    <RewardsProvider>
    <CartAnimProvider>
    <CartProvider>
    <NavigationContainer>
      <Stack.Navigator initialRouteName="SignInEntry" screenOptions={{ headerShown: false }}>
        <Stack.Screen name="SignInEntry" component={SignInEntryScreen} />
        <Stack.Screen name="Main" component={TabNavigator} />
        <Stack.Screen name="ProductDetail" component={ProductDetailScreen} />
        <Stack.Screen name="Search" component={SearchScreen} />
        <Stack.Screen name="Orders" component={OrdersScreen} />
        <Stack.Screen name="Earn" component={EarnScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
        <Stack.Screen name="Notifications" component={NotificationsScreen} />
        <Stack.Screen name="Checkout" component={CheckoutScreen} />
        <Stack.Screen name="OrderSuccess" component={OrderSuccessScreen} />
      </Stack.Navigator>
    </NavigationContainer>
    </CartProvider>
    </CartAnimProvider>
    </RewardsProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAFAF9', paddingBottom: 0 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16 },
  greeting: { fontSize: 12, color: '#9CA3AF', textTransform: 'uppercase' },
  title: { fontSize: 28, fontWeight: '600', color: '#1C1917' },
  headerIcons: { flexDirection: 'row', gap: 12 },
  iconBtn: { width: 44, height: 44, borderRadius: 14, backgroundColor: '#F5F5F4', alignItems: 'center', justifyContent: 'center' },
  searchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F3F4F6', borderRadius: 999, height: 40, paddingLeft: 12, paddingRight: 8, marginHorizontal: 20, marginTop: 12, marginBottom: 10, gap: 8 },
  searchInput: { flex: 1, paddingVertical: 0, fontSize: 15, color: '#1C1917' },
  categories: { paddingHorizontal: 20, marginVertical: 12 },
  categoryPill: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 24, backgroundColor: 'white', marginRight: 10, borderWidth: 1, borderColor: '#E5E7EB' },
  categoryPillActive: { backgroundColor: '#1C1917', borderColor: '#1C1917' },
  categoryText: { fontSize: 14, color: '#6B7280' },
  categoryTextActive: { color: 'white' },
  productsGrid: { paddingHorizontal: 6, paddingBottom: 100, paddingTop: 0 },
  homeCategoryRow: { paddingVertical: 8 },
  homeCategoryChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: '#F3F4F6', borderWidth: 1, borderColor: 'transparent' },
  homeCategoryChipActive: { backgroundColor: '#FFFBF0', borderColor: '#EAB320' },
  homeCategoryChipText: { fontSize: 13, color: '#6B7280', fontWeight: '500' },
  homeCategoryChipTextActive: { color: '#92660A', fontWeight: '600' },
  heroBanner: { marginHorizontal: 6, marginBottom: 16, borderRadius: 12, backgroundColor: '#1C1917', padding: 24, minHeight: 140, justifyContent: 'flex-end' },
  heroEyebrow: { fontSize: 10, fontWeight: '600', color: '#EAB320', letterSpacing: 2, marginBottom: 6 },
  heroTitle: { fontSize: 22, fontWeight: '600', color: '#FFFFFF', lineHeight: 28, marginBottom: 16 },
  heroCTA: { alignSelf: 'flex-start', backgroundColor: '#EAB320', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8 },
  heroCTAText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  homeSectionHeader: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: 8 },
  homeSectionTitle: { fontSize: 15, fontWeight: '600', color: '#1C1917' },
  productCard: { flex: 1, marginHorizontal: 3, marginVertical: 3, backgroundColor: 'white', borderRadius: 6, overflow: 'hidden', minHeight: 240 },
  productImage: { width: '100%', aspectRatio: 4 / 5, backgroundColor: '#F3F4F6' },
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
  detailName: { fontSize: 22, fontWeight: '600', color: '#1C1917', lineHeight: 28 },
  detailPriceRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  detailPrice: { fontSize: 28, fontWeight: '700', color: '#1C1917' },
  detailSale: { fontSize: 16, color: '#9CA3AF', textDecorationLine: 'line-through' },
  detailSaveBadge: { backgroundColor: '#FFF7E6', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  detailSaveText: { fontSize: 11, fontWeight: '600', color: '#CA8A04' },
  detailRating: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  detailStars: { color: '#D4AA50', fontSize: 13 },
  detailReviews: { color: '#9CA3AF', fontSize: 13, marginLeft: 6 },
  detailDesc: { fontSize: 14, color: '#6B7280', marginTop: 14, lineHeight: 22 },
  quantityRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#F3F4F6' },
  qtyLabel: { fontSize: 14, fontWeight: '600', color: '#1C1917' },
  qtyControls: { flexDirection: 'row', alignItems: 'center', gap: 0, backgroundColor: '#F3F4F6', borderRadius: 10, overflow: 'hidden' },
  qtyBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  qtyValue: { fontSize: 15, fontWeight: '600', color: '#1C1917', width: 32, textAlign: 'center' },
  addToCartBtn: { backgroundColor: '#1C1917', padding: 16, borderRadius: 24, alignItems: 'center', marginTop: 20 },
  addToCartText: { color: 'white', fontSize: 16, fontWeight: '600' },
  cartItem: { flexDirection: 'row', padding: 12, backgroundColor: 'white', marginHorizontal: 16, marginBottom: 8, borderRadius: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  cartImage: { width: 72, height: 72, borderRadius: 6, backgroundColor: '#F3F4F6' },
  cartInfo: { flex: 1, marginLeft: 10, paddingRight: 20 },
  cartName: { fontSize: 13, fontWeight: '500', color: '#1C1917', lineHeight: 18 },
  cartVariants: { fontSize: 11, color: '#9CA3AF', marginTop: 3 },
  cartBottomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  cartPrice: { fontSize: 15, fontWeight: '700', color: '#1C1917' },
  cartDeleteBtn: { position: 'absolute', top: 10, right: 10, padding: 4 },
  shipBanner: { flexDirection: 'column', gap: 8, marginHorizontal: 12, marginBottom: 8, backgroundColor: '#FFF7E6', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 },
  shipBannerText: { fontSize: 13, color: '#92660A', flex: 1 },
  shipBannerAmt: { fontWeight: '700', color: '#1C1917' },
  shipBannerUnlocked: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 12, marginBottom: 8, backgroundColor: '#FFF7E6', borderRadius: 8, paddingVertical: 12, paddingHorizontal: 14 },
  shipBannerUnlockedTitle: { fontSize: 13, fontWeight: '600', color: '#92660A' },
  shipBannerUnlockedSub: { fontSize: 11, color: '#B45309', marginTop: 2 },
  shipBarTrack: { height: 4, backgroundColor: '#F3E8C0', borderRadius: 2, overflow: 'hidden' },
  shipBarFill: { height: '100%', backgroundColor: '#EAB320', borderRadius: 2 },
  cartRecommendSection: { paddingHorizontal: 12, paddingTop: 16, paddingBottom: 8 },
  cartRecommendTitle: { fontSize: 14, fontWeight: '600', color: '#1C1917', marginBottom: 10 },
  cartRecommendCard: { width: 130, backgroundColor: 'white', borderRadius: 8, overflow: 'hidden' },
  cartRecommendImg: { width: 130, height: 100, backgroundColor: '#F3F4F6' },
  cartRecommendInfo: { paddingHorizontal: 8, paddingTop: 6, paddingBottom: 8 },
  cartRecommendName: { fontSize: 11, color: '#1C1917', fontWeight: '500', lineHeight: 15 },
  cartRecommendRating: { fontSize: 10, color: '#9CA3AF', marginTop: 3 },
  cartRecommendBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  cartRecommendPrice: { fontSize: 12, fontWeight: '700', color: '#1C1917' },
  cartRecommendAdd: { backgroundColor: '#EAB320', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 },
  cartRecommendAddText: { fontSize: 10, fontWeight: '600', color: 'white' },
  trustBadgeRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 14, borderTopWidth: 1, borderTopColor: '#F3F4F6', borderBottomWidth: 1, borderBottomColor: '#F3F4F6', marginTop: 14, marginBottom: 4 },
  trustBadgeItem: { flex: 1, alignItems: 'center', gap: 5 },
  trustBadgeText: { fontSize: 9, color: '#6B7280', textAlign: 'center', lineHeight: 12 },
  specsCard: { backgroundColor: '#F9FAFB', borderRadius: 8, marginTop: 16, marginBottom: 4 },
  specRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  specLabel: { fontSize: 13, color: '#6B7280' },
  specValue: { fontSize: 13, color: '#1C1917', fontWeight: '500' },
  cartSummary: { marginHorizontal: 12, marginTop: 8, marginBottom: 4, backgroundColor: 'white', borderRadius: 10, padding: 16 },
  summaryLines: { marginBottom: 14 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5 },
  summaryLabel: { fontSize: 13, color: '#6B7280' },
  summaryValue: { fontSize: 13, color: '#1C1917', fontWeight: '500' },
  summaryFree: { fontSize: 13, color: '#6B7280', fontWeight: '500' },
  summaryMuted: { fontSize: 13, color: '#9CA3AF' },
  summaryTotalRow: { borderTopWidth: 1, borderTopColor: '#F3F4F6', marginTop: 6, paddingTop: 10 },
  summaryTotalLabel: { fontSize: 15, fontWeight: '600', color: '#1C1917' },
  summaryTotalValue: { fontSize: 18, fontWeight: '700', color: '#1C1917' },
  checkoutBtn: { backgroundColor: '#EAB320', padding: 14, borderRadius: 8, alignItems: 'center' },
  checkoutBtnText: { color: 'white', fontSize: 16, fontWeight: '600' },
  checkoutBtnSub: { color: 'rgba(255,255,255,0.8)', fontSize: 11, marginTop: 3 },
  masonryWrap: { paddingHorizontal: 12, paddingBottom: 0 },
  masonryCols: { flexDirection: 'row', gap: 10 },
  masonryCol: { flex: 1, gap: 10 },
  masonryCard: { borderRadius: 16, overflow: 'hidden', backgroundColor: 'white' },
  masonryImage: { width: '100%', backgroundColor: '#F3F4F6' },
  // Identity section — no card
  identitySection: { paddingTop: 20, paddingBottom: 12, paddingHorizontal: 20 },
  membershipRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#111111', borderRadius: 6, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 8 },
  profileRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  profileInfo: { flex: 1 },
  avatarRing: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  avatarRingMember: { borderWidth: 2.5, borderColor: '#EAB320' },
  avatarRingGuest: { borderWidth: 2, borderColor: '#D1CFC9' },
  avatarInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#EAB320', alignItems: 'center', justifyContent: 'center' },
  avatarInitials: { fontSize: 22, fontWeight: '600', color: '#FFFFFF' },
  profileName: { fontSize: 17, fontWeight: '600', color: '#403F3D', marginBottom: 6 },
  profileRewardsValue: { fontSize: 20, fontWeight: '700', color: '#1C1917' },
  profileRewardsSub: { fontSize: 11, color: '#C4BFB8', marginTop: 2 },
  memberLabel: { fontSize: 10, fontWeight: '600', color: '#EAB320', letterSpacing: 2 },
  memberSince: { fontSize: 10, color: 'rgba(255,255,255,0.45)' },
  rewardsRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 12, marginBottom: 0 },
  useNowBtn: { backgroundColor: '#EAB320', paddingHorizontal: 12, height: 34, borderRadius: 6, alignItems: 'center', justifyContent: 'center', flexShrink: 0, maxWidth: 96 },
  useNowText: { color: '#FFFFFF', fontSize: 13, fontWeight: '500' },
  menuSectionLabel: { fontSize: 10, fontWeight: '600', color: '#9CA3AF', letterSpacing: 1.5, paddingHorizontal: 20, marginBottom: 8 },

  // Non-member CTA
  memberCTACard: { marginHorizontal: 20, marginBottom: 20, borderRadius: 10, padding: 16, backgroundColor: '#FEF9EC', borderWidth: 1, borderColor: '#F0DFA0' },
  memberCTATitle: { fontSize: 14, fontWeight: '700', color: '#1C1917', marginBottom: 3 },
  memberCTASub: { fontSize: 12, color: '#92660A', marginBottom: 12 },
  memberCTABtn: { backgroundColor: '#EAB320', paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  memberCTABtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },


  menuList: { marginHorizontal: 20, backgroundColor: '#FFFFFF', borderRadius: 12, overflow: 'hidden' },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16 },
  menuItemBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#EEEBE4' },
  menuItemHighlight: { backgroundColor: '#FFFBF0' },
  menuTextWrap: { flex: 1, marginLeft: 14 },
  menuText: { fontSize: 14, color: '#1C1917' },
  menuSubText: { fontSize: 11, color: '#9CA3AF', marginTop: 2 },
  earnMoreHint: { fontSize: 11, color: '#9CA3AF', marginTop: 4 },
  tabBar: { position: 'absolute', marginLeft: 48, marginRight: 48, height: 64, borderRadius: 32, overflow: 'hidden', zIndex: 2, borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)', shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.05, shadowRadius: 20, elevation: 12 },
  detailBackBtn: { position: 'absolute', top: 16, left: 16, width: 40, height: 40, borderRadius: 20, backgroundColor: 'white', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 4 },
  detailShareBtn: { position: 'absolute', top: 16, right: 16, width: 40, height: 40, borderRadius: 20, backgroundColor: 'white', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 4 },
  // Product details collapsible
  productDetailsToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#F3F4F6', borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  productDetailsToggleLabel: { fontSize: 14, fontWeight: '600', color: '#1C1917' },
  // Variant selection
  variantSection: { marginTop: 16 },
  variantLabel: { fontSize: 13, color: '#6B7280', marginBottom: 10 },
  variantValue: { fontWeight: '600', color: '#1C1917' },
  colorSwatches: { flexDirection: 'row', gap: 10 },
  swatchRing: { width: 36, height: 36, borderRadius: 18, padding: 3, borderWidth: 2, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  swatchRingSelected: { borderColor: '#EAB320' },
  swatch: { width: 26, height: 26, borderRadius: 13 },
  swatchSelected: { borderWidth: 2.5, borderColor: '#EAB320' },
  sizeButtons: { flexDirection: 'row', gap: 8 },
  sizeBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#E5E7EB' },
  sizeBtnSelected: { backgroundColor: '#FEF9EC', borderColor: '#EAB320' },
  sizeBtnText: { fontSize: 13, color: '#6B7280' },
  sizeBtnTextSelected: { color: '#92660A', fontWeight: '600' },

  // Sticky action bar
  stickyBar: { position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 28, backgroundColor: 'rgba(255,255,255,0.97)', borderTopWidth: 1, borderTopColor: '#F3F4F6' },
  stickyCartBtn: { flex: 1, paddingVertical: 14, borderRadius: 8, borderWidth: 1.5, borderColor: '#EAB320', alignItems: 'center' },
  stickyCartText: { fontSize: 15, fontWeight: '600', color: '#EAB320' },
  stickyBuyBtn: { flex: 1, paddingVertical: 14, borderRadius: 8, backgroundColor: '#EAB320', alignItems: 'center' },
  stickyBuyText: { fontSize: 15, fontWeight: '600', color: '#FFFFFF' },
  dotsRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', position: 'absolute', bottom: 12, left: 0, right: 0, gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.5)' },
  dotActive: { backgroundColor: 'white', width: 18, borderRadius: 3 },
  fbtSection: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  fbtTitle: { fontSize: 15, fontWeight: '600', color: '#1C1917', marginBottom: 14 },
  fbtRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  fbtImg: { width: 80, height: 80, borderRadius: 8, backgroundColor: '#F3F4F6' },
  fbtPlus: { fontSize: 18, color: '#9CA3AF', marginHorizontal: 10 },
  fbtNames: { marginBottom: 14, gap: 3 },
  fbtName: { fontSize: 12, color: '#6B7280' },
  fbtFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fbtTotal: { fontSize: 13, color: '#6B7280' },
  fbtTotalValue: { fontSize: 15, fontWeight: '700', color: '#1C1917' },
  fbtBtn: { backgroundColor: '#EAB320', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8 },
  fbtBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  recommendSection: { paddingTop: 8, paddingBottom: 16 },
  recommendTitle: { fontSize: 17, fontWeight: '600', color: '#1C1917', paddingHorizontal: 16, marginBottom: 12 },
  recommendList: { paddingLeft: 16, paddingRight: 8, gap: 12 },
  recommendCard: { width: 158, marginBottom: 0 },
  cartQtyControls: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cartQtyBtn: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' },
  cartQtyText: { fontSize: 13, fontWeight: '600', color: '#1C1917', minWidth: 18, textAlign: 'center' },

  signInWrap: { paddingBottom: 40 },
  signInHero: { width: '100%', height: 320, backgroundColor: '#F3F4F6' },
  signInCard: { padding: 20, marginTop: -24, marginHorizontal: 20, backgroundColor: 'white', borderRadius: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.08, shadowRadius: 20, elevation: 8 },
  signInTitle: { fontSize: 24, fontWeight: '700', color: '#1C1917' },
  signInSubtitle: { fontSize: 14, color: '#6B7280', marginTop: 8, lineHeight: 20 },
  signInInputRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#F3F4F6', borderRadius: 16, paddingHorizontal: 14, marginTop: 16 },
  signInInput: { flex: 1, paddingVertical: 12, fontSize: 15, color: '#1C1917' },
  signInFinePrint: { fontSize: 11, color: '#9CA3AF', marginTop: 12, lineHeight: 16 },

  primaryBtn: { backgroundColor: '#CA8A04', paddingVertical: 14, borderRadius: 18, alignItems: 'center', marginTop: 14 },
  primaryBtnText: { color: 'white', fontSize: 15, fontWeight: '700' },
  secondaryBtn: { paddingVertical: 12, alignItems: 'center' },
  secondaryBtnText: { color: '#1C1917', fontSize: 14, fontWeight: '600' },

  cartEmptyOuter: { flex: 1, justifyContent: 'flex-start', paddingTop: 60, paddingHorizontal: 28 },
  cartEmptyBlock: { alignItems: 'center' },
  cartEmptyIconWrap: { width: 68, height: 68, borderRadius: 34, backgroundColor: 'rgba(202,138,4,0.10)', alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  cartEmptyTitle: { fontSize: 22, fontWeight: '700', color: '#1C1917', textAlign: 'center', marginBottom: 8 },
  cartEmptySubtitle: { fontSize: 14, color: '#6B7280', textAlign: 'center', lineHeight: 20, marginBottom: 28 },
  cartSignInBtn: { backgroundColor: '#CA8A04', paddingVertical: 14, paddingHorizontal: 48, borderRadius: 18, alignItems: 'center', marginBottom: 12, alignSelf: 'stretch' },
  cartSignInBtnText: { color: 'white', fontSize: 16, fontWeight: '700' },
  cartKeepBtn: { paddingVertical: 10, alignItems: 'center' },
  cartKeepBtnText: { color: '#6B7280', fontSize: 14, fontWeight: '500' },

  searchPlaceholder: { color: '#9CA3AF', fontSize: 15 },


  searchPhotoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 14, marginBottom: 10, padding: 12, borderRadius: 16, backgroundColor: 'white', shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.06, shadowRadius: 14, elevation: 4 },
  searchPhotoThumb: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#F3F4F6' },
  searchPhotoTitle: { fontSize: 13, fontWeight: '700', color: '#1C1917' },
  searchPhotoSub: { fontSize: 12, color: '#6B7280', marginTop: 2 },

  // Wayfair-style compact pill search (shared)
  searchPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F3F4F6', borderRadius: 999, height: 40, paddingLeft: 12, paddingRight: 8, marginHorizontal: 6, marginTop: 0, marginBottom: 6, gap: 8 },
  searchPillPlaceholder: { flex: 1, color: '#9CA3AF', fontSize: 15 },
  searchPillInput: { flex: 1, paddingVertical: 0, fontSize: 15, color: '#1C1917' },
  searchPillCamBtn: { paddingLeft: 10, paddingRight: 4, paddingVertical: 6, alignItems: 'center', justifyContent: 'center' },

  searchTopBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingTop: 6, paddingBottom: 6, gap: 10 },
  searchBackBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  searchPillHeader: { flex: 1, marginHorizontal: 0, marginTop: 0, marginBottom: 0 },
  searchPillDivider: { width: 1, height: 18, backgroundColor: '#E5E7EB' },
});
