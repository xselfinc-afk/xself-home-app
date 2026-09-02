/**
 * Source of truth: /NORMALIZATION_ENGINE.md
 * All product title, features, description, specifications, image, and family logic must follow this file.
 * Do NOT add UI-side cleaning or formatting logic.
 */

import SupplierProductsScreen from './src/screens/SupplierProductsScreen';
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View, Text, ScrollView, TouchableOpacity, TextInput, FlatList, StyleSheet, SafeAreaView, StatusBar, Share, Alert, Dimensions, Animated, ActivityIndicator, KeyboardAvoidingView, Platform, Modal, Linking, LayoutAnimation, UIManager } from 'react-native';
import { Image } from 'expo-image';
import { variantUrl, originalUrl } from './src/utils/imageVariant';
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import ProductCard from './src/components/ProductCard';
import { NavigationContainer, useNavigationState, createNavigationContainerRef } from '@react-navigation/native';
import MetaCheckoutLinkHandler from './src/components/MetaCheckoutLinkHandler';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { BlurView } from 'expo-blur';
import { orderSavings } from './src/utils/orderSavings';
import { LinearGradient } from 'expo-linear-gradient';
import { products, Product, ProductVariant, MediaItem, formatPrice } from './src/data/products';
import { loadProductDetail, loadProductFamily } from './src/services/productFamilyService';
import { isPilotFamily } from './src/config/productFamilyPilot';
import { collapsePilotFamilies } from './src/services/productFamilyCollapse';
import { LIST_SELECT } from './src/services/detailProductAdapter';
import { searchProducts, clearSearchCache } from './src/services/searchService';
import { resolveSkuDisplay } from './src/services/productResolvers';
import { matchesCategory, normalizeForSkuMatch, matchesSearch } from './src/data/categories';
import { HeroBanner } from './src/components/HeroBanner';
// Fixed Home Hero image — the approved sofa (prototype v4 PH[0]); deterministic,
// never randomized, no product-data dependency, identical across launches/reloads.
const HOME_HERO_IMAGE = require('./assets/home/home-hero.jpg');
import { loadHomeSectionTitles, HomeSectionTitles } from './src/services/homeContentService';
import { CartProvider, useCart, CartItem } from './src/context/CartContext';
import { defaultCartItem } from './src/utils/cartItem';
import { CartAnimProvider, useCartAnimation } from './src/context/CartAnimationContext';
import { RewardsProvider, useRewards, getReferralLink } from './src/context/RewardsContext';
import { RecommendationProvider, useRecommendations, diversify } from './src/context/RecommendationContext';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { OrdersProvider } from './src/context/OrdersContext';
import { ConversationProvider, useConversations } from './src/context/ConversationContext';
import { ConciergeProvider, useConcierge } from './src/context/ConciergeContext';
import ConciergeTopBanner from './src/components/ConciergeTopBanner';
import * as CrispChatSDK from 'react-native-crisp-chat-sdk';
import mobileAds from 'react-native-google-mobile-ads';
import { readHomeCache, writeHomeCache } from './src/services/homeCache';
import { markHomeReady } from './src/services/bootGate';
import { requestTrackingPermissionsAsync } from 'expo-tracking-transparency';
import { Settings as FBSettings } from 'react-native-fbsdk-next';
import { fetchCartPriceUpdates } from './src/services/cartPriceService';
import InboxScreen from './src/screens/InboxScreen';
import SupportScreen from './src/screens/SupportScreen';
import ChatScreen from './src/screens/ChatScreen';
import ProductConversationScreen from './src/screens/ProductConversationScreen';
import { supabase } from './src/lib/supabase';
import { summarizeActiveReviews } from './src/utils/reviewSummary';
import { adaptStandardizedRow } from './src/services/detailProductAdapter';
import { isGoodFitForFeatured } from './src/services/imageRatioCache';
import OrdersScreen from './src/screens/OrdersScreen';
import EarnScreen from './src/screens/EarnScreen';
import CheckoutScreen from './src/screens/CheckoutScreen';
import OrderSuccessScreen from './src/screens/OrderSuccessScreen';
import CollectionScreen from './src/screens/CollectionScreen';
// Phase 2 Commerce Taxonomy navigation (flag-gated; default OFF preserves legacy Home/Discover).
import { COMMERCE_TAXONOMY_NAVIGATION_ENABLED } from './src/config/commerceTaxonomy';
import { BrowseAllCategoriesCard } from './src/components/commerce/HomeShoppingEntry';
import HomeShopYourWay from './src/components/commerce/HomeShopYourWay';
import AuthEntryView from './src/components/AuthEntryView';
import CommerceBrowseScreen from './src/screens/commerce/CommerceBrowseScreen';
import CommerceResultsScreen from './src/screens/commerce/CommerceResultsScreen';
import { getCachedDelivery } from './src/utils/deliveryEligibility';
import { fetchFulfillmentAdvisory, FULFILLMENT_COPY, type FulfillmentAdvisory } from './src/services/fulfillmentAdvisoryService';
import DiscoverScreen from './src/screens/DiscoverScreen';
import ReviewSection from './src/components/ReviewSection';
import SearchPillBar from './src/components/SearchPillBar';
import NativeProductAdCard from './src/components/NativeProductAdCard';
import { buildDiscoverFeed, groupIntoRows, type DiscoverRow } from './src/services/discoverAdInsertion';
import { loadAdConfig } from './src/services/adsConfigService';
import * as interstitialAdManager from './src/services/interstitialAdManager';
import * as SplashScreen from 'expo-splash-screen';
import { StripeProvider } from '@stripe/stripe-react-native';

SplashScreen.preventAutoHideAsync();

const screenWidth = Dimensions.get('window').width;

// ── Home category circle carousel ─────────────────────────────────────────────
const CATEGORY_CIRCLES: { label: string; icon: string; bg: string; iconColor: string }[] = [
  { label: 'Storage',          icon: 'file-tray-stacked-outline', bg: '#FEF3C7', iconColor: '#92660A' },
  { label: 'Living Room',      icon: 'home-outline',              bg: '#E0F2FE', iconColor: '#1E6FA3' },
  { label: 'Bedroom',          icon: 'bed-outline',               bg: '#FCE7F3', iconColor: '#9C2772' },
  { label: 'Dining & Kitchen', icon: 'restaurant-outline',        bg: '#D1FAE5', iconColor: '#065F46' },
  { label: 'Office',           icon: 'desktop-outline',           bg: '#EDE9FE', iconColor: '#5B21B6' },
  { label: 'Outdoor & Garden', icon: 'leaf-outline',              bg: '#ECFDF5', iconColor: '#047857' },
  { label: 'Bathroom',         icon: 'water-outline',             bg: '#DBEAFE', iconColor: '#1D4ED8' },
  { label: 'Pet Furniture',    icon: 'paw-outline',               bg: '#FFF3E0', iconColor: '#D97706' },
];

type VariantColor = { type: 'color'; label: string; hex: string; disabled?: boolean };
type VariantImage = { type: 'image'; label: string; uri: string; disabled?: boolean };
type Variant = VariantColor | VariantImage;

const VARIANT_COLORS: VariantColor[] = [
  { type: 'color', label: 'Natural', hex: '#C4A265' },
  { type: 'color', label: 'Walnut', hex: '#6B3F1F' },
  { type: 'color', label: 'White', hex: '#EFEDE8' },
  { type: 'color', label: 'Slate', hex: '#78829A' },
];
const VARIANT_SIZES = ['Small', 'Medium', 'Large'];
const IMAGE_VARIANT_LABELS = ['Main', 'Detail', 'Side', 'Lifestyle'] as const;


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
      // quality 0.5 + exif stripped: cuts the vision upload to a fraction of the
      // original size (biggest latency item in the image-search path). A proper
      // resize (expo-image-manipulator) is scheduled for the next native build.
      ? await ImagePicker.launchCameraAsync({ quality: 0.5, exif: false })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.5, exif: false });

  if (result.canceled) return null;
  return result.assets?.[0]?.uri ?? null;
}

/** Reads a local file URI and returns { base64, mimeType } via FileReader. */
async function uriToBase64(uri: string): Promise<{ base64: string; mimeType: string }> {
  const response = await fetch(uri);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const [header, base64] = dataUrl.split(',');
      const mimeType = header.match(/:(.*?);/)?.[1] ?? 'image/jpeg';
      resolve({ base64, mimeType });
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Sends the image at `uri` to the `image-search` Supabase Edge Function, which
 * proxies the Claude Haiku vision call server-side. The Anthropic key lives only
 * as a Supabase secret and is never shipped in the app bundle. Returns 2–3
 * furniture search keywords for matchesSearch(), or '' if unavailable / on any
 * failure (preserving the previous graceful-degradation behavior).
 */
async function extractImageKeywords(uri: string): Promise<string> {
  try {
    const { base64, mimeType } = await uriToBase64(uri);
    const { data, error } = await supabase.functions.invoke('image-search', {
      body: { image_base64: base64, media_type: mimeType },
    });
    if (error) {
      console.warn('[ImageSearch] proxy error:', error.message);
      return '';
    }
    const keywords = typeof (data as { keywords?: string } | null)?.keywords === 'string'
      ? (data as { keywords: string }).keywords.trim()
      : '';
    console.log('[ImageSearch] generated query:', JSON.stringify(keywords));
    return keywords;
  } catch (err) {
    console.warn('[ImageSearch] extraction failed:', err);
    return '';
  }
}



const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();
const CartStack = createNativeStackNavigator();
const AccountStack = createNativeStackNavigator();


const TabIcon = ({ name, focused }) => {
  const iconMap = {
    Home: 'home-outline',
    Discover: 'search-outline',
    Cart: 'cart-outline',
    Account: 'person-outline',
  };
  return (
    <View style={focused ? { backgroundColor: 'rgba(202,138,4,0.14)', borderRadius: 12, paddingVertical: 4, paddingHorizontal: 10 } : {}}>
      <Ionicons name={(iconMap[name] || 'ellipse-outline') as any} size={22} color={focused ? '#B8860B' : '#57534E'} />
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

// (EMAIL_RE moved into src/components/AuthEntryView.tsx with the extracted login UI.)

function SignInEntryScreen({ navigation }) {
  // In-app sign-in route (Account / Checkout / Earn / Support). Reuses the single
  // AuthEntryView (source of truth) and returns to the guarded workflow after a guest
  // choice or successful sign-in — preserving the user's original intent. The standalone
  // startup login renders the same AuthEntryView via the root gate (see RootNavigation).
  return <AuthEntryView onDone={() => navigation.goBack()} />;
}


// Category list is defined in src/data/categories.ts (shared with DiscoverScreen)
const hCardWidth = (screenWidth - 48) / 2;

function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [displayCount, setDisplayCount] = useState(20);
  const [sectionTitles, setSectionTitles] = useState<HomeSectionTitles>({
    newArrivals: 'New This Season',
    topPicks: 'Handpicked For You',
    bestSellers: 'Loved By Our Customers',
    allProducts: 'Explore All Products',
  });
  // Tracks the load lifecycle so the empty-state ("No products available
  // yet") only renders after a *successful* fetch returned zero rows — never
  // during initial loading and never when the network failed.
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [hasCache, setHasCache] = useState(false);
  const renderStartRef = useRef(Date.now());

  const { scoreProduct, trackClick } = useRecommendations();

  useEffect(() => {
    loadHomeSectionTitles().then(setSectionTitles).catch(() => {/* keep defaults */});
  }, []);

  useEffect(() => {
    let active = true;

    function mapRows(rows: unknown[]): Product[] {
      const mapped: Product[] = (rows as any[]).flatMap((r: any) => {
        try { return [adaptStandardizedRow(r)]; }
        catch (e) {
          if (__DEV__) console.warn('[Home] adaptStandardizedRow failed for row', (r as any)?.supplier_product_id, e);
          return [];
        }
      });

      const familySeen = new Map<string, { id: string; hasImage: boolean }>();
      // Phase 2.1c — per-family price aggregate so a multi-price split family renders "From $X".
      const familyPrices = new Map<string, number[]>();
      (rows as any[]).forEach((r: any) => {
        const key: string = r.product_family_key || r.supplier_product_id;
        const hasImage = !!r.primary_image;
        const existing = familySeen.get(key);
        if (!existing || (!existing.hasImage && hasImage)) {
          familySeen.set(key, { id: r.supplier_product_id, hasImage });
        }
        const price = Number(r.selling_price ?? r.price);
        if (Number.isFinite(price) && price > 0) {
          const arr = familyPrices.get(key) ?? [];
          arr.push(price);
          familyPrices.set(key, arr);
        }
      });
      // Pilot families collapse to ONE representative card ("From $X" when prices differ);
      // every non-pilot SKU stays independent. (Legacy familySeen/familyPrices retained but
      // unused — the pure collapse helper recomputes representative + range from the Product list.)
      void familySeen; void familyPrices;
      return collapsePilotFamilies(mapped);
    }

    async function bootstrap() {
      // 1. Cache-first paint — hydrates Home instantly on returning launches
      //    so the user never sees the empty layout while Supabase loads.
      try {
        const cache = await readHomeCache();
        if (!active) return;
        if (cache && cache.rows.length > 0) {
          const cached = mapRows(cache.rows);
          if (cached.length > 0) {
            setAllProducts(cached);
            setHasCache(true);
            setLoadState('ready');
            markHomeReady();
            console.log('[Home] hydrated from cache —', cached.length, 'products,', `${(Date.now() - cache.timestamp) / 1000 | 0}s old`);
          }
        }
      } catch (err) {
        if (__DEV__) console.warn('[Home] cache hydrate failed:', err instanceof Error ? err.message : err);
      }

      // 2. Always refresh from Supabase silently in the background.
      const { data, error } = await supabase
        .from('sellable_products')
        .select(LIST_SELECT)
        .order('created_at', { ascending: false });

      if (!active) return;
      console.log('[Home] query done — error:', error?.message ?? null, '| rows:', data?.length ?? 0);

      if (error || !data) {
        // Cache exists → keep showing it. No cache → expose error state so
        // the polished retry UI renders (instead of the raw empty layout).
        if (allProducts.length === 0) {
          setLoadState('error');
        }
        markHomeReady();
        return;
      }

      if (__DEV__ && data[0]) {
        const r0 = data[0] as any;
        console.log('[Home] first raw row titles:', { optimized_title: r0.optimized_title, product_title_display: r0.product_title_display, product_title: r0.product_title });
      }

      const deduped = mapRows(data);
      console.log('[Home] total mapped products:', deduped.length);
      if (__DEV__ && deduped[0]) console.log('[Home] first mapped product name:', deduped[0].name);

      if (active) {
        setAllProducts(deduped);
        setLoadState('ready');
        markHomeReady();
        // Persist for next launch only on success.
        writeHomeCache(data as unknown[]).catch(() => {/* non-fatal */});
      }
    }

    bootstrap();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const withImages = useMemo(
    () => allProducts.filter(p => p.images.length > 0),
    [allProducts],
  );

  // First product image per level1 category — drives the category carousel thumbnails
  const categoryImageMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of withImages) {
      const level1 = p.categoryPath?.level1;
      if (level1 && !map[level1] && p.images[0]) {
        map[level1] = p.images[0];
      }
      if (Object.keys(map).length >= CATEGORY_CIRCLES.length) break;
    }
    return map;
  }, [withImages]);

  // ── Section pools — memoized, computed in display order so each pool excludes prior ──
  // ID-only exclusion across sections: family-key suppression was causing pool starvation
  // (GIGA catalog has many products sharing family keys → nearbySeenFamilies from 20 newArrivals
  // was eliminating most of the remaining pool). Color variants of newArrivals products CAN
  // appear in Top Picks / Best Sellers — they are different items.
  const { newArrivals, topPicks, bestSellers, nearbySeenIds } = useMemo(() => {
    const goodFit = (p: Product): boolean => !p.images[0] || isGoodFitForFeatured(p.images[0]);

    const sortByDate = (arr: Product[]) =>
      [...arr].sort((a, b) => {
        if (a.newArrivalAddedAt && b.newArrivalAddedAt) {
          return new Date(b.newArrivalAddedAt).getTime() - new Date(a.newArrivalAddedAt).getTime();
        }
        if (a.newArrivalAddedAt) return -1;
        if (b.newArrivalAddedAt) return 1;
        return 0;
      });

    // 1. New Arrivals — good-fit first (date-sorted within each group), non-standard as fallback
    const newArrivalsPool = withImages.filter(p => p.isNewArrival);
    const naGood = newArrivalsPool.filter(goodFit);
    const naBad  = newArrivalsPool.filter(p => !goodFit(p));
    const newArrivals = [...sortByDate(naGood), ...sortByDate(naBad)].slice(0, 20);

    if (__DEV__ && naBad.length > 0) {
      console.log(`[Home] deferred ${naBad.length} poor-fit new arrivals to All Products:`);
      naBad.forEach(p => console.log(`  [deferred-na] ${p.id} | ${p.name?.slice(0, 40)}`));
    }

    // ID-only exclusion set — grows as each section is computed
    const nearbySeenIds = new Set(newArrivals.map(p => p.id));
    const notSeen = (p: Product) => !nearbySeenIds.has(p.id);

    // 2. Top Picks — 12 items for carousel depth; good-fit preferred, any as fallback
    const tpPool = withImages.filter(notSeen);
    const tpGood = tpPool.filter(goodFit);
    const tpBad  = tpPool.filter(p => !goodFit(p));
    const topPicks = [...tpGood, ...tpBad].slice(0, 12);
    topPicks.forEach(p => nearbySeenIds.add(p.id));

    if (__DEV__) {
      console.log(`[Home] topPicks: ${topPicks.length} (pool: ${tpPool.length} | withImages: ${withImages.length} | naExcluded: ${newArrivals.length})`);
      console.log('[Home] topPicks IDs:', topPicks.map(p => p.id).slice(0, 12).join(', '));
    }

    // 3. Best Sellers — 12 items for carousel depth; good-fit preferred, any as fallback
    const bsPool = withImages.filter(notSeen);
    const bsGood = bsPool.filter(goodFit);
    const bsBad  = bsPool.filter(p => !goodFit(p));
    const bestSellers = [...bsGood, ...bsBad].slice(0, 12);
    bestSellers.forEach(p => nearbySeenIds.add(p.id));

    if (__DEV__) {
      console.log(`[Home] bestSellers: ${bestSellers.length} (pool: ${bsPool.length})`);
      console.log('[Home] bestSellers IDs:', bestSellers.map(p => p.id).slice(0, 12).join(', '));
    }

    return { newArrivals, topPicks, bestSellers, nearbySeenIds };
  }, [withImages]);

  // ── Main grid — all products ranked by score, excluding section carousels ──
  const rankedProducts = useMemo(() => {
    return diversify(
      [...withImages]
        .filter(p => !nearbySeenIds.has(p.id))
        .sort((a, b) => scoreProduct(b) - scoreProduct(a)),
    );
  }, [withImages, nearbySeenIds, scoreProduct]);

  // Performance debug log — fires when product data arrives
  useEffect(() => {
    if (!__DEV__ || withImages.length === 0) return;
    const elapsed = Date.now() - renderStartRef.current;
    console.log(
      '[Home] perf |', elapsed, 'ms | withImages:', withImages.length,
      '| newArrivals:', newArrivals.length,
      '| topPicks:', topPicks.length,
      '| bestSellers:', bestSellers.length,
      '| grid:', rankedProducts.length,
      '| initial batch:', Math.min(displayCount, rankedProducts.length),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withImages.length, rankedProducts.length]);

  const goToProduct = (item: any) => {
    trackClick(item.id);
    navigation.navigate('ProductDetail', { product: item });
  };

  // Home Hero image is a FIXED approved asset (HOME_HERO_IMAGE) — no random/rotating
  // selector and no product-data dependency, so it is identical on every launch/reload.

  // Max discount % across all products — drives hero subtitle. Reads
  // adapter-produced `discountPercent` (PRODUCT_DISPLAY_RULES.md §1.3) so
  // the formula lives in resolveDiscountPercent, not at the render site.
  const maxDiscount = useMemo(() => {
    let best = 0;
    for (const p of withImages) {
      if (p.discountPercent > best) best = p.discountPercent;
    }
    return best;
  }, [withImages]);

  const HomeHeader = (
    <>
      {/* Xself wordmark — brand mark; scrolls naturally with Home (not sticky), left-aligned. */}
      <Text style={styles.homeWordmark}>Xself</Text>

      {/* Search pill */}
      <SearchPillBar
        containerStyle={styles.homeSearchPill}
        onPress={() => navigation.navigate('Search')}
        rightSlot={
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
        }
      >
        <Text style={styles.searchPillPlaceholder}>Search furniture, rooms, styles...</Text>
      </SearchPillBar>

      {/* Hero banner */}
      <HeroBanner
        variant="TEXT_LEFT"
        title={'Make room for\nwhat matters'}
        subtitle={maxDiscount > 0 ? `Selected pieces up to ${maxDiscount}% off` : 'Selected pieces on sale now'}
        ctaText="Explore the collection"
        imageSource={HOME_HERO_IMAGE}
        heightRatio={0.80}
        useSoftBlur={false}
        onPress={() => navigation.navigate('CommerceBrowse', { level: 'department', department: 'furniture' })}
      />

      {/* Commerce discovery modules (Phase 2.5, navigation flag ON) — STABLE upper-page
          placement in the list HEADER, directly after the hero and before the curated
          rails, so product pagination (displayCount) never displaces them. Two modules:
          taxonomy doorway ("Browse all categories") → intent-led "Shop your way". The
          redundant "Shop by department" rail was removed — its destinations live in Browse
          all categories. Legacy "Shop by Category" circles still render in the footer when the flag is OFF. */}
      {COMMERCE_TAXONOMY_NAVIGATION_ENABLED && (
        <>
          <BrowseAllCategoriesCard navigation={navigation} />
          <HomeShopYourWay navigation={navigation} />
        </>
      )}

      {/* New Arrivals */}
      {newArrivals.length > 0 && (
        <>
          <View style={styles.homeSectionHeader}>
            <Text style={styles.homeSectionTitle}>{sectionTitles.newArrivals}</Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
            {newArrivals.map(item => (
              <ProductCard key={item.id} product={item} onPress={() => goToProduct(item)} style={{ width: hCardWidth }} flexibleRatio />
            ))}
          </ScrollView>
        </>
      )}

      {/* Top Picks */}
      <View style={styles.homeSectionHeader}>
        <Text style={styles.homeSectionTitle}>{sectionTitles.topPicks}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
        {topPicks.map(item => (
          <ProductCard key={item.id} product={item} onPress={() => goToProduct(item)} style={{ width: hCardWidth }} />
        ))}
      </ScrollView>

      {/* Best Sellers */}
      <View style={styles.homeSectionHeader}>
        <Text style={styles.homeSectionTitle}>{sectionTitles.bestSellers}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
        {bestSellers.map(item => (
          <ProductCard key={item.id} product={item} onPress={() => goToProduct(item)} style={{ width: hCardWidth }} />
        ))}
      </ScrollView>

      {/* All Products header */}
      <View style={styles.homeSectionHeader}>
        <Text style={styles.homeSectionTitle}>{sectionTitles.allProducts}</Text>
      </View>
    </>
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="dark-content" />
      <FlatList
        ListHeaderComponent={HomeHeader}
        data={rankedProducts.slice(0, displayCount)}
        renderItem={({ item }) => (
          <ProductCard
            product={item}
            onPress={() => goToProduct(item)}
            style={styles.productCard}
            flexibleRatio
          />
        )}
        keyExtractor={(item) => item.id.toString()}
        numColumns={2}
        contentContainerStyle={styles.productsGrid}
        removeClippedSubviews
        windowSize={5}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        onEndReached={() => setDisplayCount(c => Math.min(c + 20, rankedProducts.length))}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={() => {
          // Loading — show nothing (splash is still covering us).
          if (loadState === 'loading') return null;
          // Network/server error with no cache → polished retry state.
          if (loadState === 'error' && !hasCache) {
            return (
              <View style={{ alignItems: 'center', paddingVertical: 60, paddingHorizontal: 28 }}>
                <Ionicons name="cloud-offline-outline" size={28} color="#9CA3AF" />
                <Text style={{ fontSize: 15, fontWeight: '600', color: '#1C1917', marginTop: 10 }}>
                  We couldn't load products
                </Text>
                <Text style={{ fontSize: 12, color: '#6B7280', marginTop: 4, textAlign: 'center', lineHeight: 17 }}>
                  Check your connection and try again.
                </Text>
                <TouchableOpacity
                  style={{ marginTop: 16, backgroundColor: '#EAB320', paddingVertical: 10, paddingHorizontal: 22, borderRadius: 22 }}
                  onPress={() => { setLoadState('loading'); setAllProducts((p) => p); /* trigger refetch via remount */ navigation.replace?.('Main'); }}
                >
                  <Text style={{ color: '#FFFFFF', fontSize: 13, fontWeight: '600' }}>Try again</Text>
                </TouchableOpacity>
              </View>
            );
          }
          // Ready + truly zero rows from the server.
          return (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <Text style={{ fontSize: 14, color: '#9CA3AF' }}>No products available yet</Text>
            </View>
          );
        }}
        ListFooterComponent={() => (
          COMMERCE_TAXONOMY_NAVIGATION_ENABLED ? (
            /* Phase 2.5 — the Commerce entry now lives in the list HEADER (stable, above the
               paginated grid). The grid's contentContainerStyle paddingBottom:100 already
               clears the floating tab bar, so the footer is empty when the nav flag is ON.
               Legacy "Shop by Category" circles still render below when the flag is OFF. */
            null
          ) : (
          <>
            {/* Shop by Category — bottom discovery module */}
            <View style={styles.homeSectionHeader}>
              <Text style={styles.homeSectionTitle}>Shop by Category</Text>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 10, gap: 12, paddingBottom: 24 }}
            >
              {CATEGORY_CIRCLES.map(({ label, icon, bg, iconColor }) => {
                const imageUri = categoryImageMap[label];
                const circleSize = Math.round(screenWidth * 0.42);
                const radius = circleSize / 2;
                return (
                  <TouchableOpacity
                    key={label}
                    style={{ alignItems: 'center', width: circleSize }}
                    activeOpacity={0.75}
                    onPress={() => navigation.navigate('Discover', { initialCategory: label })}
                  >
                    <View style={{ width: circleSize, height: circleSize, borderRadius: radius, marginBottom: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.14, shadowRadius: 7, elevation: 5 }}>
                      <View style={{ width: circleSize, height: circleSize, borderRadius: radius, overflow: 'hidden', backgroundColor: bg, borderWidth: 2, borderColor: '#E5E3DC' }}>
                        {imageUri ? (
                          <Image
                            source={{ uri: variantUrl(imageUri, { width: 360, fit: 'contain' }) }}
                            style={{ width: circleSize, height: circleSize }}
                            contentFit="contain"
                            cachePolicy="memory-disk"
                            transition={150}
                          />
                        ) : (
                          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                            <Ionicons name={icon as any} size={40} color={iconColor} />
                          </View>
                        )}
                      </View>
                    </View>
                    <Text style={{ fontSize: 13, color: '#403F3D', textAlign: 'center', fontWeight: '500', lineHeight: 16 }} numberOfLines={2}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </>
          )
        )}
      />
    </View>
  );
}


// defaultCartItem moved to src/utils/cartItem.ts (imported above) to avoid
// the SupportScreen ↔ App.tsx circular import.

function VariantPicker({
  title,
  variants,
  selected,
  onSelect,
}: {
  title: string;
  variants: Variant[];
  selected: string;
  onSelect: (label: string) => void;
}) {
  return (
    <View style={styles.variantSection}>
      <Text style={styles.variantLabel}>
        {title}:{' '}<Text style={styles.variantValue}>{selected}</Text>
      </Text>
      <View style={styles.variantRow}>
        {variants.map(v => {
          const isSelected = selected === v.label;
          if (v.type === 'color') {
            return (
              <TouchableOpacity
                key={v.label}
                style={[styles.swatchRing, isSelected && styles.swatchRingSelected]}
                onPress={() => onSelect(v.label)}
                activeOpacity={0.8}
              >
                <View style={[styles.swatch, { backgroundColor: v.hex }]} />
              </TouchableOpacity>
            );
          }
          return (
            <TouchableOpacity
              key={v.label}
              style={[styles.imageVariantCard, isSelected && styles.imageVariantCardSelected, v.disabled && styles.imageVariantCardDisabled]}
              onPress={() => !v.disabled && onSelect(v.label)}
              activeOpacity={v.disabled ? 1 : 0.8}
            >
              <Image source={{ uri: variantUrl(v.uri, { width: 160 }) }} style={[styles.imageVariantThumb, v.disabled ? { opacity: 0.3 } : undefined]} contentFit="cover" cachePolicy="memory-disk" transition={150} />
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

/**
 * Formats a spec value for display.
 * - Weight: appends "lb", strips unnecessary trailing zeros (134.00 → "134 lb")
 * - Dimensions: prefixes each part with W/D/H and appends inch marks
 *   e.g. "43.66 × 15.74 × 74.00" → 'W43.66" × D15.74" × H74.00"'
 */
function formatSpecValue(label: string, value: string): string {
  const l = label.toLowerCase().trim();

  if (l === 'weight') {
    // Already formatted by pipeline (e.g. "134 lb") — parseFloat is idempotent here
    const num = parseFloat(value);
    if (!isNaN(num)) {
      const clean = num % 1 === 0 ? String(Math.round(num)) : String(num);
      return `${clean} lb`;
    }
    return value;
  }

  if (l === 'dimensions') {
    // Already formatted by pipeline (e.g. "W 43.66" × D 15.74" × H 74.00"") — passthrough
    if (/^W\s/.test(value.trim())) return value;
    // Legacy raw format fallback (pre-pipeline data)
    const parts = value.split(/\s*[×x]\s*/i);
    if (parts.length === 3) {
      const [w, d, h] = parts.map(p => p.trim());
      return `W ${w}" × D ${d}" × H ${h}"`;
    }
    return value;
  }

  return value;
}

function SpecGroup({ title, rows, defaultOpen = false }: {
  title: string;
  rows: { label: string; value: string }[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const chevronAnim = useRef(new Animated.Value(defaultOpen ? 1 : 0)).current;

  const toggle = () => {
    LayoutAnimation.configureNext({
      duration: 180,
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
      update: { type: LayoutAnimation.Types.easeInEaseOut },
      delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    });
    Animated.timing(chevronAnim, { toValue: open ? 0 : 1, duration: 180, useNativeDriver: true }).start();
    setOpen(v => !v);
  };

  const rotate = chevronAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });

  return (
    <View style={styles.specGroup}>
      <TouchableOpacity style={styles.specGroupHeader} onPress={toggle} activeOpacity={0.7}>
        <Text style={styles.specGroupTitle}>{title}</Text>
        <Animated.View style={{ transform: [{ rotate }] }}>
          <Ionicons name="chevron-down" size={15} color="#6B7280" />
        </Animated.View>
      </TouchableOpacity>
      {open && rows.map((row, i) => {
        const formatted = formatSpecValue(row.label, row.value);
        const isSku = row.label === 'SKU';
        return (
          <View key={row.label} style={[styles.specRow, i === rows.length - 1 && { borderBottomWidth: 0 }]}>
            <Text style={styles.specLabel}>{row.label}</Text>
            {isSku ? (
              <TouchableOpacity
                onLongPress={async () => {
                  await Clipboard.setStringAsync(formatted);
                }}
                activeOpacity={0.7}
                style={{ flex: 1, marginLeft: 16 }}
              >
                <Text style={[styles.specValue, { marginLeft: 0, flex: 0 }]} selectable>
                  {formatted}
                </Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.specValue} selectable>{formatted}</Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

function ProductDetailScreen({ route, navigation }) {
  const { product: initialProduct, product_family_key: routeFamilyKey } = route.params;
  // Fall back to the product's own product_family_key when the navigator
  // didn't pass one as a route param (Home/Saved/Cart pass `{ product }` only;
  // Discover passes both). Without this, the family loader (which provides
  // the full gallery_images_json) never fires from non-Discover entry points
  // and the Product Detail carousel collapses to a single image.
  const familyKey = routeFamilyKey ?? initialProduct?.product_family_key;
  const insets = useSafeAreaInsets();

  // product is state so the family loader can upgrade it to multi-variant
  const [product, setProduct] = useState<Product>(initialProduct);
  // Product Detail Native ad config — remote-gated, OFF by default; any error keeps OFF.
  const [detailAd, setDetailAd] = useState<{ enabled: boolean; testMode: boolean }>({ enabled: false, testMode: true });
  useEffect(() => {
    let active = true;
    loadAdConfig()
      .then(cfg => { if (active) setDetailAd({ enabled: cfg.adsEnabled && cfg.detailEnabled, testMode: cfg.nativeTestMode }); })
      .catch(() => { /* keep OFF defaults */ });
    return () => { active = false; };
  }, []);

  // ── Variant resolution ────────────────────────────────────────────────────
  const hasVariants = !!(product.variants?.length);
  const defaultVariant: ProductVariant | null = hasVariants
    ? (product.variants.find((v: ProductVariant) => v.enabled && v.stock > 0) ?? product.variants[0])
    : null;

  const [selectedColor, setSelectedColor] = useState(
    hasVariants ? defaultVariant!.color : VARIANT_COLORS[0].label
  );
  const [selectedSize, setSelectedSize] = useState(
    hasVariants ? defaultVariant!.size : ''
  );
  const [qty, setQty] = useState(1);
  const [activeImage, setActiveImage] = useState(0);
  const [added, setAdded] = useState(false);
  const [addedPermanent, setAddedPermanent] = useState(false);
  const [bundleAdded, setBundleAdded] = useState(false);
  // After the bundle lands in the cart, the CTA flips to "View Cart" — same
  // add → Added ✓ → View Cart pattern as the Add to Cart button above.
  const [bundleAddedPermanent, setBundleAddedPermanent] = useState(false);
  // Live header rating/review-count — same product_reviews data ReviewSection uses. null = loading.
  const [reviewSummary, setReviewSummary] = useState<{ count: number; avg: number } | null>(null);
  // Advisory fulfillment (pickup/shipping) for the SELECTED child SKU — server-authoritative
  // (fulfillment-eligibility endpoint). null = loading/unresolved → conservative copy. Versioned
  // so a slow response for a previously-selected sibling can never overwrite the current child.
  const [advisory, setAdvisory] = useState<FulfillmentAdvisory | null>(null);
  const advisoryReqRef = useRef(0);
  const carouselRef = useRef<ScrollView>(null);
  const btnRef = useRef<View>(null);
  const btnScaleAnim = useRef(new Animated.Value(1)).current;
  const floatCtaAnim = useRef(new Animated.Value(0)).current;
  const contentHeightRef = useRef(0);
  const floatCtaShownRef = useRef(false);
  const msgFabScale = useRef(new Animated.Value(1)).current;
  const msgLabelAnim = useRef(new Animated.Value(1)).current;
  const { addItem } = useCart();
  const { triggerAnimation } = useCartAnimation();
  const { trackView, scoreProduct } = useRecommendations();
  const { startConversation, getConversation } = useConversations();
  const { user } = useAuth();

  // Currently-selected child SKU id. On a family PDP this switches when the customer
  // changes colour/size (selectedColor/selectedSize state), so reviews, header rating,
  // and analytics all follow the SELECTED child — never the family representative.
  // Mirrors selectedVariant's resolution; falls back to product.id for single-SKU pages.
  const selectedChildId: string =
    (product.variants?.find((v: ProductVariant) => v.color === selectedColor && v.size === selectedSize)
      ?? product.variants?.find((v: ProductVariant) => v.enabled && v.stock > 0)
      ?? product.variants?.[0])?.supplierProductId ?? product.id;

  // Track the SELECTED child product view (weight 1); refires on option switch.
  React.useEffect(() => { trackView(selectedChildId); }, [selectedChildId]);

  // Advisory pickup/shipping for the SELECTED child + buyer ZIP (session-cached). Clears prior
  // state immediately on child change (never shows the previous sibling), and a request-version
  // guard drops out-of-order responses. ZIP is included in the service cache key.
  React.useEffect(() => {
    const zip = getCachedDelivery()?.zip ?? null;
    const reqId = ++advisoryReqRef.current;
    setAdvisory(null); // conservative fallback while loading; never a stale sibling result
    fetchFulfillmentAdvisory(selectedChildId, zip).then(a => {
      if (advisoryReqRef.current === reqId) setAdvisory(a);
    });
  }, [selectedChildId]);

  // Header rating/review count — read the SAME live product_reviews data as ReviewSection
  // for the SELECTED child SKU (status='active'; real reviews if any exist, else the
  // generated bootstrap). Refires on option switch so the rating tracks the chosen variant.
  // Header hides its rating row when there are 0 active reviews. Read-only; ReviewSection unchanged.
  React.useEffect(() => {
    let active = true;
    setReviewSummary(null);
    supabase
      .from('product_reviews')
      .select('rating, is_generated')
      .eq('supplier_product_id', selectedChildId)
      .eq('status', 'active')
      .then(({ data, error }: { data: Array<{ rating: number; is_generated?: boolean | null }> | null; error: unknown }) => {
        if (!active) return;
        if (error || !data) { setReviewSummary({ count: 0, avg: 0 }); return; }
        setReviewSummary(summarizeActiveReviews(data));
      });
    return () => { active = false; };
  }, [selectedChildId]);

  // Reset add-state when screen comes back into focus
  React.useEffect(() => {
    const unsub = navigation.addListener('focus', () => {
      setAdded(false);
      setAddedPermanent(false);
    });
    return unsub;
  }, [navigation]);

  // ── Real product pool for recommendations ─────────────────────────────────
  const [realProducts, setRealProducts] = useState<Product[]>([]);
  const [poolReady, setPoolReady] = useState(false);
  React.useEffect(() => {
    let active = true;
    async function loadRealProducts() {
      const { data, error } = await supabase
        .from('sellable_products')
        .select(
          'id, supplier_product_id, product_title, product_title_display, optimized_title, short_description, ' +
          'key_features_json, specifications_json, sku_custom, ' +
          'category_code, scene_code, color, color_options_json, ' +
          'has_multiple_colors, show_color_selector, material, dimensions, weight, ' +
          'primary_image, gallery_images_json, product_family_key, price, selling_price, original_price, normalization_status, created_at, category_label, category_priority, is_new_arrival, new_arrival_source, total_available_qty',
        )
        .order('created_at', { ascending: false });

      if (error || !data || !active) return;

      const mapped: Product[] = (data as any[]).flatMap((r: any) => {
        try { return [adaptStandardizedRow(r)]; }
        catch { return []; }
      });

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
      if (active) {
        setRealProducts(mapped.filter(p => representativeIds.has(p.id)));
        setPoolReady(true);
      }
    }
    loadRealProducts();
    return () => { active = false; };
  }, []);

  // Auto-hide "Need Help?" label after 2.5s
  React.useEffect(() => {
    const t = setTimeout(() => {
      Animated.timing(msgLabelAnim, { toValue: 0, duration: 400, useNativeDriver: true }).start();
    }, 2500);
    return () => clearTimeout(t);
  }, []);

  // Load full product family when navigated with a family key
  // Independent-SKU detail: load the EXACT tapped supplier_product_id's full row (incl.
  // gallery_images_json) so the carousel shows the complete gallery. No family collapse and
  // no color selector — each SKU is its own product. The list-card product only carries the
  // primary image (LIST_SELECT omits gallery_images_json), so this fetch is what restores the
  // full gallery on detail.
  React.useEffect(() => {
    const skuId = initialProduct?.id;
    if (!skuId) return;
    let active = true;

    // Single-SKU loader — the default for every non-pilot product. Opens exactly the
    // tapped supplier_product_id with its full gallery; no family color selector.
    const openSingle = () => loadProductDetail(skuId).then(fullProduct => {
      if (!active || !fullProduct) return;
      setProduct(fullProduct);
      const v = fullProduct.variants?.[0];
      if (v) { setSelectedColor(v.color); setSelectedSize(v.size); }
      setActiveImage(0);
      carouselRef.current?.scrollTo({ x: 0, animated: false });
    });

    // Pilot families ONLY: load the whole family (per-sibling variantProducts) and
    // preselect the exact opened child. Everything else keeps the single-SKU path.
    if (isPilotFamily(familyKey)) {
      loadProductFamily(familyKey!).then(fam => {
        if (!active) return;
        if (fam && (fam.variants?.length ?? 0) > 1 && (fam.variantProducts?.length ?? 0) > 0) {
          setProduct(fam);
          // Deterministic default: the tapped SKU if it belongs to the family, else the
          // first in-stock child, else the first variant — never a phantom selection.
          const opened = fam.variants!.find(v => v.supplierProductId === skuId);
          const pick = opened
            ?? fam.variants!.find(v => v.enabled && v.stock > 0)
            ?? fam.variants![0];
          if (pick) { setSelectedColor(pick.color); setSelectedSize(pick.size); }
          setActiveImage(0);
          carouselRef.current?.scrollTo({ x: 0, animated: false });
        } else {
          // Family didn't materialise as multi-child (single sellable child / load error)
          // → safe single-SKU fallback so the page still opens on the tapped SKU.
          openSingle();
        }
      }).catch(() => { if (active) openSingle(); });
    } else {
      openSingle();
    }
    return () => { active = false; };
  }, [initialProduct?.id, familyKey]);

  // Derived: resolved SKU
  // Never leave a multi-variant product with a null selection: if the current
  // color/size doesn't match (e.g. selectedColor hasn't synced yet right after the
  // family load), fall back to the default variant so cart/checkout always carry a
  // concrete variant supplier_product_id — never silently the representative.
  const selectedVariant: ProductVariant | null = hasVariants
    ? (product.variants.find((v: ProductVariant) =>
        v.color === selectedColor && v.size === selectedSize
      ) ?? defaultVariant)
    : null;

  // Full detail Product for the selected variant, so selecting a color switches CONTENT
  // (title / description / features / specs / dimensions), not just price+images. Falls back
  // to the family representative when the per-sibling Product isn't available.
  // Family PDP = a multi-variant product carrying per-sibling variantProducts. For a
  // family the selected variant MUST resolve to exactly one child Product; a single-SKU
  // page has no siblings and always renders itself.
  const isFamily = (product.variantProducts?.length ?? 0) > 0 && (product.variants?.length ?? 0) > 1;
  const resolvedSibling: Product | undefined = selectedVariant?.supplierProductId
    ? product.variantProducts?.find(vp => vp.id === selectedVariant.supplierProductId)
    : undefined;
  // Content source: the resolved child for a family; the product itself for single-SKU.
  const selectedSibling: Product = resolvedSibling ?? product;
  // A family selection is "resolved" only when the concrete child Product was found AND
  // its id equals the selected variant's fulfillment key. If it is NOT resolved we must
  // never sell/show the representative as if it were the chosen child — the purchase CTAs
  // are hard-disabled below (assertSelectedVariantConsistency).
  const variantResolved: boolean = !isFamily
    || (!!selectedVariant?.supplierProductId && !!resolvedSibling && resolvedSibling.id === selectedVariant.supplierProductId);
  if (__DEV__ && isFamily && !variantResolved) {
    // eslint-disable-next-line no-console
    console.error('[ProductFamily] selected variant did not resolve to a child Product — purchase disabled', {
      family: product.product_family_key, selectedColor, selectedSize,
      variantSku: selectedVariant?.supplierProductId,
    });
  }

  // Derived: gallery / price / savings
  const displayImages: string[] = selectedVariant?.images ?? product.images;
  // Unified media list — use selected variant images when available so gallery updates on color change
  const displayMedia: MediaItem[] = (() => {
    const variantImages = selectedVariant?.images;
    const raw: MediaItem[] = variantImages && variantImages.length > 0
      ? variantImages.map(url => ({ type: 'image' as const, url }))
      : (product.media ?? []);
    const valid = raw.filter(m => typeof m.url === 'string' && m.url.trim().length > 0);
    const images = valid.filter(m => m.type === 'image').slice(0, 8);
    const video = valid.find(m => m.type === 'video');
    const combined = video ? [...images, video] : images;
    return combined.length > 0 ? combined : [{ type: 'image' as const, url: product.images[0] ?? '' }];
  })();
  const displayPrice: number = selectedVariant?.price ?? product.price;
  const displayCompare: number | undefined = selectedVariant?.originalPrice ?? product.originalPrice;
  // Round to cents so a float artifact (e.g. 284.99 - 219 = 65.99000000000001) never
  // surfaces in the "Save $X" badge. Preserves cents for genuinely fractional savings.
  const savings = displayCompare ? Math.round((displayCompare - displayPrice) * 100) / 100 : 0;

  // Derived: stock state
  const stockCount: number = selectedVariant?.stock ?? Infinity;
  const isOutOfStock = selectedVariant ? selectedVariant.stock === 0 : false;
  const isLowStock = !isOutOfStock && !!selectedVariant && selectedVariant.stock <= 3;

  // Derived: color / size option sets
  const allColors: string[] = hasVariants
    ? [...new Set<string>(product.variants.map((v: ProductVariant) => v.color))]
    : [];
  const enabledColors: Set<string> = hasVariants
    ? new Set<string>(product.variants.filter((v: ProductVariant) => v.enabled).map((v: ProductVariant) => v.color))
    : new Set<string>();
  const allSizesForColor: string[] = hasVariants
    ? [...new Set<string>(product.variants.filter((v: ProductVariant) => v.color === selectedColor).map((v: ProductVariant) => v.size))]
    : [];
  const enabledSizesForColor: Set<string> = hasVariants
    ? new Set<string>(product.variants.filter((v: ProductVariant) => v.color === selectedColor && v.enabled).map((v: ProductVariant) => v.size))
    : new Set<string>();

  // Reset carousel when SKU changes
  const prevSkuRef = useRef(selectedVariant?.sku);
  React.useEffect(() => {
    if (selectedVariant?.sku !== prevSkuRef.current) {
      prevSkuRef.current = selectedVariant?.sku;
      setActiveImage(0);
      carouselRef.current?.scrollTo({ x: 0, animated: false });
    }
  }, [selectedVariant?.sku]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleColorSelect = (color: string) => {
    if (hasVariants) {
      const keepSize = product.variants.find(
        (v: ProductVariant) => v.color === color && v.size === selectedSize && v.enabled
      );
      if (!keepSize) {
        const firstAvail = product.variants.find((v: ProductVariant) => v.color === color && v.enabled);
        if (firstAvail) setSelectedSize(firstAvail.size);
      }
    }
    setSelectedColor(color);
  };

  const handleAddToCart = () => {
    if (isOutOfStock) return;
    if (!variantResolved) return; // never add a family child that didn't resolve to its own SKU
    if (hasVariants && selectedVariant) {
      addItem({
        sku: selectedVariant.sku,
        // Authoritative fulfillment key = the SELECTED variant's supplier_product_id,
        // not the family representative (product.id). The order Edge Function validates
        // inventory and ships by productId, so this must track the chosen color.
        productId: selectedVariant.supplierProductId ?? product.id,
        name: selectedSibling.name,
        price: selectedVariant.price,
        img: selectedVariant.images[0] ?? product.images[0],
        color: selectedVariant.color,
        size: selectedVariant.size,
      }, qty);
    } else {
      addItem(defaultCartItem(product), qty);
    }
  };

  const handleBuyNow = () => {
    if (isOutOfStock) return;
    if (!variantResolved) return; // never buy a family child that didn't resolve to its own SKU
    navigation.navigate('Checkout', { mode: 'buy_now', product, qty, selectedVariant: selectedVariant ?? null });
  };

  const handleShare = async () => {
    try {
      await Share.share({ message: `Check out ${product.name} - $${displayPrice} on Xself!` });
    } catch (e) {}
  };

  // ── Color thumbnails ──────────────────────────────────────────────────────
  const colorImageVariants: VariantImage[] = hasVariants
    ? allColors.map(color => {
        const v = product.variants.find((v: ProductVariant) => v.color === color && v.enabled);
        return { type: 'image' as const, label: color, uri: v?.images[0] ?? product.images[0], disabled: !enabledColors.has(color) };
      })
    : VARIANT_COLORS.map((c, i) => ({
        type: 'image' as const,
        label: c.label,
        uri: displayImages[i] ?? displayImages[0],
      }));

  // ── Related & FBT — from real standardized product pipeline ─────────────
  // Guard: skip computation entirely until the real pool has loaded.
  // Without this, the first render fires with realProducts=[] producing an
  // empty pool, wasted computation, and misleading 0-count logs.
  const pool = poolReady
    ? realProducts.filter(p => p.id !== product.id && p.images.length > 0)
    : [];
  // Prefer level2 match → level1 match → legacy keyword fallback
  const sameLevel2 = product.categoryPath?.level2
    ? pool.filter(p => p.categoryPath?.level2 === product.categoryPath!.level2)
    : [];
  const sameLevel1 = product.categoryPath?.level1
    ? pool.filter(p => p.categoryPath?.level1 === product.categoryPath!.level1)
    : pool.filter(p => matchesCategory(p, product.category ?? ''));
  const sameCategory = sameLevel2.length >= 4 ? sameLevel2 : sameLevel1;
  const relatedSource = sameCategory.length >= 4 ? sameCategory : pool;
  const relatedProducts = poolReady
    ? diversify([...relatedSource].sort((a, b) => scoreProduct(b) - scoreProduct(a))).slice(0, 8)
    : [];
  const recommendations = relatedProducts.slice(0, 4);
  // FBT (Frequently Bought Together) needs complementary, category-anchored
  // matches — NOT the cross-category diversification used by "You May Also
  // Like". We require:
  //   • Same category (level1 or shared room tag) — anchors to "goes with"
  //   • Different product_family_key — never recommend the same SKU/family
  //   • Price within ±30% of current — keeps the bundle realistic
  //   • Only emit when we have at least 2 valid candidates; otherwise hide
  //     the section entirely rather than fall back to a random pool slice.
  const currentFamilyKey = product.product_family_key;
  const currentRooms = new Set(product.tags?.room ?? []);
  const priceFloor  = displayPrice * 0.7;
  const priceCeil   = displayPrice * 1.3;
  const fbtCandidates = poolReady
    ? pool
        .filter(p => {
          if (currentFamilyKey && p.product_family_key === currentFamilyKey) return false;
          const sameLevel1Cat =
            !!product.categoryPath?.level1 &&
            p.categoryPath?.level1 === product.categoryPath!.level1;
          const sharedRoom = (p.tags?.room ?? []).some(r => currentRooms.has(r));
          if (!sameLevel1Cat && !sharedRoom) return false;
          if (p.price < priceFloor || p.price > priceCeil) return false;
          return true;
        })
        .sort((a, b) => scoreProduct(b) - scoreProduct(a))
    : [];
  const fbt = fbtCandidates.length >= 2 ? fbtCandidates.slice(0, 2) : [];

  if (__DEV__) {
    console.log('[ProductDetail] recommendation pool ready:', poolReady);
    if (!poolReady) {
      console.log('[ProductDetail] recommendation computation skipped before ready: true');
    } else {
      console.log('[ProductDetail] recommendation computation skipped before ready: false');
      console.log('[ProductDetail] youMayAlsoLike source: real');
      console.log('[ProductDetail] current product id:', product.id);
      console.log('[ProductDetail] recommendation pool count:', pool.length);
      console.log('[ProductDetail] final recommendation count:', recommendations.length);
    }
  }
  const fbtBundleTotal = displayPrice + fbt.reduce((s, p) => s + p.price, 0);
  const fbtSavings = savings + fbt.reduce((s, p) => (p.originalPrice ? s + (p.originalPrice - p.price) : s), 0);
  // Pre-initialized scale refs — one per FBT slot (fbt is always ≤ 2 items)
  const fbtScales = useRef([new Animated.Value(1), new Animated.Value(1)]).current;
  // Scale ref for the first (current product) thumbnail — press feedback only, no navigation
  const fbtMainScale = useRef(new Animated.Value(1)).current;

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 140 }}
        scrollEventThrottle={16}
        onContentSizeChange={(_, h) => { contentHeightRef.current = h; }}
        onScroll={e => {
          const y = e.nativeEvent.contentOffset.y;
          const threshold = contentHeightRef.current * 0.3;
          if (!floatCtaShownRef.current && y > threshold) {
            floatCtaShownRef.current = true;
            Animated.timing(floatCtaAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
          } else if (floatCtaShownRef.current && y <= threshold) {
            floatCtaShownRef.current = false;
            Animated.timing(floatCtaAnim, { toValue: 0, duration: 150, useNativeDriver: true }).start();
          }
        }}
      >
        {/* Image carousel */}
        <View>
          <ScrollView
            ref={carouselRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={e => {
              const idx = Math.round(e.nativeEvent.contentOffset.x / screenWidth);
              setActiveImage(idx);
            }}
          >
            {displayMedia.map((item, i) =>
              item.type === 'video' ? (
                <TouchableOpacity
                  key={i}
                  activeOpacity={0.9}
                  style={{ width: screenWidth, aspectRatio: 4 / 5 }}
                  onPress={() => Linking.openURL(item.url).catch(() => {})}
                >
                  <Image
                    source={{ uri: variantUrl(item.thumbnail ?? '', { width: 1200 }) }}
                    style={{ width: screenWidth, aspectRatio: 4 / 5 }}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    transition={150}
                  />
                  <View style={styles.videoPlayOverlay}>
                    <View style={styles.videoPlayBtn}>
                      <Ionicons name="play" size={22} color="#FFFFFF" style={{ marginLeft: 3 }} />
                    </View>
                  </View>
                </TouchableOpacity>
              ) : (
                <Image
                  key={i}
                  source={{ uri: variantUrl(item.url, { width: 1200 }) }}
                  style={{ width: screenWidth, aspectRatio: 4 / 5 }}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  transition={150}
                  placeholder={i === 0 && product?.primaryImageBlurhash ? { blurhash: product.primaryImageBlurhash } : undefined}
                  placeholderContentFit="cover"
                />
              )
            )}
          </ScrollView>

          {displayMedia.length > 1 && (
            <View style={styles.dotsRow}>
              {displayMedia.map((item, i) => (
                <View
                  key={i}
                  style={[
                    styles.dot,
                    i === activeImage && styles.dotActive,
                    item.type === 'video' && styles.dotVideo,
                  ]}
                />
              ))}
            </View>
          )}
        </View>

        {/* Product info */}
        <View style={styles.detailContent}>
          <View style={styles.detailNameRow}>
            <Text style={[styles.detailName, { flex: 1 }]} numberOfLines={3} selectable>{selectedSibling.displayTitle ?? selectedSibling.name}</Text>
            <TouchableOpacity onPress={handleShare} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="share-outline" size={18} color="#9CA3AF" />
            </TouchableOpacity>
          </View>
          <View style={styles.detailPriceRow}>
            <Text style={styles.detailPrice}>${displayPrice}</Text>
            {displayCompare && <Text style={styles.detailSale}>${displayCompare}</Text>}
            {savings > 0 && (
              <View style={styles.detailSaveBadge}>
                <Text style={styles.detailSaveText}>Save ${savings}</Text>
              </View>
            )}
          </View>
          {reviewSummary && reviewSummary.count > 0 && (
            <View style={styles.detailRating}>
              <Text style={styles.detailStars}>★ {reviewSummary.avg.toFixed(1)}</Text>
              <Text style={styles.detailReviews}>({reviewSummary.count} {reviewSummary.count === 1 ? 'review' : 'reviews'})</Text>
            </View>
          )}
          {(() => {
            // Server-authoritative advisory for the SELECTED child (dual-radius pickup + the
            // authoritative delivery-fee validator, via the fulfillment-eligibility endpoint).
            // Loading / unknown / error → conservative copy; never a false "Currently unavailable".
            const label = advisory ? FULFILLMENT_COPY[advisory.state] : FULFILLMENT_COPY.unknown;
            return <Text style={styles.availabilityHint}>{label}</Text>;
          })()}

          {/* Color thumbnails — hidden when only 1 color option */}
          {colorImageVariants.length > 1 && (
            <VariantPicker
              title="Color"
              variants={colorImageVariants}
              selected={selectedColor}
              onSelect={handleColorSelect}
            />
          )}

          {/* Size picker — only for products with real, non-blank sizes */}
          {hasVariants && allSizesForColor.some(s => s.trim().length > 0) && (
            <View style={styles.variantSection}>
              <Text style={styles.variantLabel}>
                Size:{' '}<Text style={styles.variantValue}>{selectedSize}</Text>
              </Text>
              <View style={styles.sizeButtons}>
                {allSizesForColor.map(size => {
                  const enabled = enabledSizesForColor.has(size);
                  const isSel = selectedSize === size;
                  return (
                    <TouchableOpacity
                      key={size}
                      style={[styles.sizeBtn, isSel && styles.sizeBtnSelected, !enabled && styles.sizeBtnDisabled]}
                      onPress={() => enabled && setSelectedSize(size)}
                      activeOpacity={enabled ? 0.7 : 1}
                    >
                      <Text style={[styles.sizeBtnText, isSel && styles.sizeBtnTextSelected, !enabled && styles.sizeBtnTextDisabled]}>
                        {size}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {/* Key Features */}
          {(() => {
            const hasMigrated = !!(selectedSibling.features?.length);
            const safeDesc: string = selectedSibling.desc ?? '';
            const fs: string[] = hasMigrated
              ? selectedSibling.features!
              : safeDesc.split(/\.\s+/).map((s: string) => s.replace(/\.$/, '').trim()).filter((s: string) => s.length > 8);
            return (
              <View style={styles.featuresSection}>
                <Text style={styles.featuresSectionLabel}>Key Features</Text>
                {fs.map((f, i) => (
                  <View key={i} style={styles.featureRow}>
                    <Ionicons name="checkmark" size={12} color="#CA8A04" style={{ marginTop: 4 }} />
                    <Text style={styles.featureText}>{f}</Text>
                  </View>
                ))}

              </View>
            );
          })()}

          {/* Stock status */}
          {isOutOfStock && <Text style={styles.stockOut}>Out of stock</Text>}
          {isLowStock && <Text style={styles.stockLow}>Only {stockCount} left</Text>}

          {/* Product Details */}
          <View style={styles.specsSection}>
            <Text style={styles.specsSectionLabel}>Product Details</Text>
            {selectedSibling.specs
              ? (() => {
                  const groupMap = new Map<string, { label: string; value: string }[]>();
                  selectedSibling.specs!.forEach(spec => {
                    const g = spec.group ?? 'Specifications';
                    if (!groupMap.has(g)) groupMap.set(g, []);
                    groupMap.get(g)!.push({ label: spec.label, value: spec.value });
                  });
                  return Array.from(groupMap.entries()).map(([groupName, rows], i) => (
                    <SpecGroup key={groupName} title={groupName} rows={rows} defaultOpen={i === 0} />
                  ));
                })()
              : (() => {
                  const fallback: { label: string; value: string }[] = [
                    selectedSibling.tags?.material?.length ? { label: 'Material', value: selectedSibling.tags.material.map((m: string) => m.replace(/-/g, ' ')).join(', ') } : null,
                    { label: 'Weight', value: (selectedSibling as any).weight ?? '—' },
                    { label: 'Brand', value: 'Xselfhome' },
                    { label: 'SKU', value: resolveSkuDisplay({
                        skuCustom: selectedSibling.skuCustom,
                        sku:       selectedVariant?.sku ?? selectedSibling.variants?.[0]?.sku,
                        id:        selectedChildId,
                    }) },
                  ].filter(Boolean) as { label: string; value: string }[];
                  return (
                    <View>
                      {fallback.map((row, i) => {
                        const formatted = formatSpecValue(row.label, row.value);
                        const isSku = row.label === 'SKU';
                        return (
                          <View key={row.label} style={[styles.specRow, i === fallback.length - 1 && { borderBottomWidth: 0 }]}>
                            <Text style={styles.specLabel}>{row.label}</Text>
                            {isSku ? (
                              <TouchableOpacity
                                onLongPress={async () => {
                                  await Clipboard.setStringAsync(formatted);
                                }}
                                activeOpacity={0.7}
                                style={{ flex: 1, marginLeft: 16 }}
                              >
                                <Text style={[styles.specValue, { marginLeft: 0, flex: 0 }]} selectable>
                                  {formatted}
                                </Text>
                              </TouchableOpacity>
                            ) : (
                              <Text style={styles.specValue} selectable>{formatted}</Text>
                            )}
                          </View>
                        );
                      })}
                    </View>
                  );
                })()
            }
          </View>

          <View style={styles.ctaRow}>
            <View style={styles.qtyControls}>
              <TouchableOpacity style={styles.qtyBtn} onPress={() => setQty(Math.max(1, qty - 1))}>
                <Ionicons name="remove" size={16} color="#1C1917" />
              </TouchableOpacity>
              <Text style={styles.qtyValue}>{qty}</Text>
              <TouchableOpacity style={styles.qtyBtn} onPress={() => setQty(qty + 1)}>
                <Ionicons name="add" size={16} color="#1C1917" />
              </TouchableOpacity>
            </View>
            <Animated.View style={{ flex: 1, transform: [{ scale: btnScaleAnim }] }}>
              <TouchableOpacity
                ref={btnRef}
                style={[styles.addToCartBtn, (isOutOfStock || !variantResolved) && styles.ctaBtnDisabled]}
                disabled={isOutOfStock || !variantResolved}
                activeOpacity={0.85}
                onPress={() => {
                  if (isOutOfStock || !variantResolved) return;
                  if (addedPermanent) {
                    navigation.navigate('Main', { screen: 'Cart' });
                    return;
                  }
                  handleAddToCart();
                  (btnRef.current as any)?.measureInWindow((x: number, y: number, w: number, h: number) => {
                    triggerAnimation(x + w / 2, y + h / 2);
                  });
                  setAdded(true);
                  setTimeout(() => { setAdded(false); setAddedPermanent(true); }, 1000);
                  Animated.sequence([
                    Animated.spring(btnScaleAnim, { toValue: 1.12, useNativeDriver: true, speed: 300, bounciness: 0 }),
                    Animated.spring(btnScaleAnim, { toValue: 1, useNativeDriver: true, speed: 200, bounciness: 3 }),
                  ]).start();
                }}
              >
                <Text style={[styles.addToCartText, (isOutOfStock || !variantResolved) && styles.ctaBtnTextDisabled]}>
                  {!variantResolved ? 'Unavailable' : addedPermanent ? 'View Cart' : added ? 'Added \u2713' : 'Add to Cart'}
                </Text>
              </TouchableOpacity>
            </Animated.View>
            <TouchableOpacity
              style={[styles.buyNowBtn, (isOutOfStock || !variantResolved) && styles.ctaBtnDisabled]}
              disabled={isOutOfStock || !variantResolved}
              onPress={handleBuyNow}
            >
              <Text style={[styles.buyNowText, (isOutOfStock || !variantResolved) && styles.ctaBtnTextDisabled]}>
                {(isOutOfStock || !variantResolved) ? 'Unavailable' : 'Buy Now'}
              </Text>
            </TouchableOpacity>
          </View>

        </View>

        {/* Reviews */}
        <ReviewSection product={selectedSibling} />

        {/* Frequently Bought Together */}
        {fbt.length > 0 && (
          <View style={styles.fbtSection}>
            <Text style={styles.fbtTitle}>Frequently Bought Together</Text>
            <View style={styles.fbtRow}>
              <TouchableOpacity
                activeOpacity={0.75}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                onPressIn={() => Animated.spring(fbtMainScale, { toValue: 0.93, useNativeDriver: true, speed: 100, bounciness: 0 }).start()}
                onPressOut={() => Animated.spring(fbtMainScale, { toValue: 1, useNativeDriver: true, speed: 60, bounciness: 3 }).start()}
                onPress={() => {
                  if (__DEV__) {
                    console.log('[FBT] first thumbnail pressed: true');
                    console.log('[FBT] first thumbnail navigation blocked: true');
                  }
                }}
              >
                <Animated.View style={{ transform: [{ scale: fbtMainScale }] }}>
                  <Image source={{ uri: variantUrl(product.images[0], { width: 320 }) }} style={styles.fbtImg} cachePolicy="memory-disk" transition={150} />
                </Animated.View>
              </TouchableOpacity>
              {fbt.map((p, i) => (
                <React.Fragment key={p.id}>
                  <Text style={styles.fbtPlus}>+</Text>
                  <TouchableOpacity
                    activeOpacity={0.75}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    onPressIn={() => Animated.spring(fbtScales[i], { toValue: 0.93, useNativeDriver: true, speed: 100, bounciness: 0 }).start()}
                    onPressOut={() => Animated.spring(fbtScales[i], { toValue: 1, useNativeDriver: true, speed: 60, bounciness: 3 }).start()}
                    onPress={() => {
                      if (__DEV__) {
                        console.log('[FBT] thumbnail pressed id:', p.id);
                        console.log('[FBT] opening detail id:', p.id);
                        console.log('[FBT] navigation push detail: true');
                      }
                      navigation.push('ProductDetail', { product: p });
                    }}
                  >
                    <Animated.View style={{ transform: [{ scale: fbtScales[i] }] }}>
                      <Image source={{ uri: variantUrl(p.images[0], { width: 320 }) }} style={styles.fbtImg} cachePolicy="memory-disk" transition={150} />
                    </Animated.View>
                  </TouchableOpacity>
                </React.Fragment>
              ))}
            </View>
            <View style={styles.fbtInfoRow}>
              <View>
                <Text style={styles.fbtInfoMeta}>
                  {fbt.length + 1} items{fbtSavings > 0 ? ` · Save $${fbtSavings}` : ''}
                </Text>
                <Text style={styles.fbtInfoPrice}>${fbtBundleTotal}</Text>
              </View>
              <TouchableOpacity
                style={styles.fbtCta}
                onPress={() => {
                  if (bundleAddedPermanent) {
                    navigation.navigate('Main', { screen: 'Cart' });
                    return;
                  }
                  addItem(defaultCartItem(product), 1);
                  fbt.forEach(p => addItem(defaultCartItem(p), 1));
                  setBundleAdded(true);
                  setTimeout(() => { setBundleAdded(false); setBundleAddedPermanent(true); }, 1000);
                }}
              >
                <Text style={styles.fbtCtaText}>
                  {bundleAdded ? 'Added \u2713' : bundleAddedPermanent ? 'View Cart \u2192' : 'Add Bundle \u2192'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Sponsored — single inline Native ad, remote-gated, between product info and recommendations */}
        {detailAd.enabled ? <NativeProductAdCard testMode={detailAd.testMode} variant="detail" /> : null}

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
                  onPress={() => {
                    if (__DEV__) {
                      console.log('[YMAL] tapped product id:', p.id);
                      console.log('[YMAL] opening product detail:', p.name);
                    }
                    navigation.push('ProductDetail', { product: p });
                  }}
                  style={styles.recommendCard}
                />
              ))}
            </ScrollView>
          </View>
        )}

      </ScrollView>

      {/* Back — floats over the hero. Surface tokens are the DESIGN.md "floating glass pill"
          (the tab bar's), icon + geometry are the existing searchBackBtn. Sits outside the
          ScrollView so it stays reachable after scrolling, and lives here at the shared
          ProductDetail level so every entry path gets it. goBack() only — swipe-back untouched. */}
      <TouchableOpacity
        style={[styles.detailBackBtn, { top: insets.top + 8 }]}
        onPress={() => navigation.goBack()}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityRole="button"
        accessibilityLabel="Back"
      >
        <Ionicons name="chevron-back" size={20} color="#1C1917" />
      </TouchableOpacity>

      {/* Floating CTA — fades in after 30% scroll */}
      <Animated.View
        style={[
          styles.floatCta,
          {
            bottom: insets.bottom + 16,
            opacity: floatCtaAnim,
            transform: [{ translateY: floatCtaAnim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
          },
        ]}
        pointerEvents="box-none"
      >
        <TouchableOpacity
          style={[styles.floatCtaBtn, (isOutOfStock || !variantResolved) && styles.ctaBtnDisabled]}
          disabled={isOutOfStock || !variantResolved}
          activeOpacity={0.88}
          onPress={() => {
            if (isOutOfStock || !variantResolved) return;
            if (addedPermanent) {
              navigation.navigate('Main', { screen: 'Cart' });
              return;
            }
            handleAddToCart();
            setAdded(true);
            setTimeout(() => { setAdded(false); setAddedPermanent(true); }, 1000);
          }}
        >
          <Text style={styles.floatCtaBtnText}>
            {(isOutOfStock || !variantResolved) ? 'Unavailable' : addedPermanent ? 'View Cart' : added ? 'Added \u2713' : 'Add to Cart'}
          </Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Messages FAB label — fades out after 2.5s */}
      <Animated.View
        style={[styles.msgFabLabel, { bottom: insets.bottom + 130, opacity: msgLabelAnim }]}
        pointerEvents="none"
      >
        <Text style={styles.msgFabLabelText}>Need Help?</Text>
      </Animated.View>

      {/* Messages FAB — bottom-right, above Add to Cart */}
      <Animated.View
        style={[styles.msgFabWrap, { bottom: insets.bottom + 72, transform: [{ scale: msgFabScale }] }]}
      >
        <TouchableOpacity
          style={styles.msgFabBtn}
          activeOpacity={1}
          onPressIn={() =>
            Animated.spring(msgFabScale, { toValue: 0.93, useNativeDriver: true, speed: 80, bounciness: 0 }).start()
          }
          onPressOut={() =>
            Animated.spring(msgFabScale, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 5 }).start()
          }
          onPress={() => {
            // Forwards full product + chosen variant + qty so SupportScreen
            // can render the same commerce surface (image, SKU, price,
            // availability) and reuse the existing Buy Now / Add to Cart
            // flow without duplicating logic.
            navigation.navigate('Support', {
              product,
              selectedVariant: selectedVariant ?? null,
              qty,
            });
          }}
        >
          <Ionicons name="chatbubble-ellipses" size={26} color="#FFFFFF" />
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}



function SearchScreen({ navigation, route }) {
  const initialQuery = route?.params?.query ?? '';
  const initialImageUri = route?.params?.imageUri ?? null;
  const [query, setQuery] = useState(String(initialQuery));
  const [imageUri, setImageUri] = useState<string | null>(initialImageUri);
  const [generatedQuery, setGeneratedQuery] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  // Server search state machine — idle | loading | success | error. Results come
  // from the search_products RPC via searchService (no more full-catalogue pool).
  const [results, setResults] = useState<Product[]>([]);
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [retryKey, setRetryKey] = useState(0);
  const searchSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Search Native ad config — remote-gated, OFF by default; any error keeps OFF.
  const [searchAdCfg, setSearchAdCfg] = useState<{ enabled: boolean; interval: number; max: number; testMode: boolean }>({
    enabled: false, interval: 24, max: 1, testMode: true,
  });
  useEffect(() => {
    let active = true;
    loadAdConfig()
      .then(cfg => {
        if (active) setSearchAdCfg({
          enabled: cfg.adsEnabled && cfg.searchEnabled,
          interval: cfg.searchInterval,
          max: cfg.searchMax,
          testMode: cfg.nativeTestMode,
        });
      })
      .catch(() => { /* keep OFF defaults */ });
    return () => { active = false; };
  }, []);

  // Debounced server search. Consistency guards: AbortController cancels the
  // in-flight RPC, and a monotonically increasing sequence drops any late
  // response for an older query — an old response can never overwrite a newer
  // one. Failures land in 'error' (rendered with a Retry button), never as a
  // silently-empty result list.
  const activeQuery = imageUri ? generatedQuery : query;
  useEffect(() => {
    const q = activeQuery.trim();
    if (isAnalyzing) return; // image path: wait for keywords
    if (!q) {
      abortRef.current?.abort();
      setResults([]);
      setAvailability({});
      setSearchState('idle');
      return;
    }
    const seq = ++searchSeqRef.current;
    setSearchState('loading');
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      searchProducts(q, { limit: 60, signal: controller.signal })
        .then((res) => {
          if (searchSeqRef.current !== seq) return; // stale response — drop
          setResults(res.items);
          setAvailability(res.availability);
          setSearchState('success');
        })
        .catch(() => {
          if (searchSeqRef.current !== seq) return;
          if (controller.signal.aborted) return;    // cancelled, not failed
          setSearchState('error');
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [activeQuery, isAnalyzing, retryKey]);

  // Session cache dies with the search UI — next visit starts fresh.
  useEffect(() => () => { abortRef.current?.abort(); clearSearchCache(); }, []);

  // Image analysis: when imageUri is set, extract furniture keywords via Claude vision
  useEffect(() => {
    if (!imageUri) { setGeneratedQuery(''); setIsAnalyzing(false); return; }
    let cancelled = false;
    setIsAnalyzing(true);
    setGeneratedQuery('');
    console.log('[ImageSearch] image selected: true');
    console.log('[ImageSearch] catalog search started: true');
    extractImageKeywords(imageUri).then(keywords => {
      if (cancelled) return;
      setGeneratedQuery(keywords);
      setIsAnalyzing(false);
      if (__DEV__) console.log('[ImageSearch] generated query:', JSON.stringify(keywords));
    });
    return () => { cancelled = true; };
  }, [imageUri]);

  // Image path with no usable keywords = recognition failure. Rendered as its
  // own state — NEVER falls through to an unfiltered "all products" list.
  const imageRecognitionFailed = !!imageUri && !isAnalyzing && !generatedQuery.trim();

  // Search feed rows: 2-up product rows + at most one full-width Native ad after
  // result 24 (no ad in empty/loading state — results is [] then, so no ad).
  const searchRows: DiscoverRow[] = groupIntoRows(
    buildDiscoverFeed(results, { enabled: searchAdCfg.enabled, interval: searchAdCfg.interval, max: searchAdCfg.max }),
    2,
  );

  if (__DEV__ && !imageUri) {
    const qNorm = normalizeForSkuMatch(query);
    console.log('[HomeSearch] raw query:', JSON.stringify(query));
    console.log('[HomeSearch] normalized query:', JSON.stringify(qNorm));
    console.log('[HomeSearch] shared search reused from Discover: true');
    console.log('[HomeSearch] result count:', results.length);
  }

  const onPressCamera = () => {
    Alert.alert('Search by photo', 'Choose a source', [
      {
        text: 'Take Photo',
        onPress: async () => {
          const uri = await pickSearchImage('camera');
          if (uri) { setQuery(''); setImageUri(uri); }
        },
      },
      {
        text: 'Upload Photo',
        onPress: async () => {
          const uri = await pickSearchImage('library');
          if (uri) { setQuery(''); setImageUri(uri); }
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

      {imageUri ? (
        <View style={styles.searchPhotoRow}>
          <Image source={{ uri: imageUri }} style={styles.searchPhotoThumb} />
          <View style={{ flex: 1 }}>
            <Text style={styles.searchPhotoTitle}>Visual search</Text>
            {isAnalyzing ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <ActivityIndicator size="small" color="#EAB320" />
                <Text style={styles.searchPhotoSub}>Analyzing photo...</Text>
              </View>
            ) : (
              <Text style={styles.searchPhotoSub}>
                {generatedQuery ? `"${generatedQuery}"` : 'Showing similar picks from our catalog.'}
              </Text>
            )}
          </View>
          <TouchableOpacity onPress={() => setImageUri(null)}>
            <Ionicons name="close-circle" size={20} color="#9CA3AF" />
          </TouchableOpacity>
        </View>
      ) : null}

      {imageRecognitionFailed ? (
        <View style={{ alignItems: 'center', paddingTop: 64, paddingHorizontal: 32 }}>
          <Ionicons name="image-outline" size={36} color="#9CA3AF" />
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#1C1917', marginTop: 12 }}>Couldn't identify the item</Text>
          <Text style={{ fontSize: 13, color: '#6B7280', marginTop: 6, textAlign: 'center' }}>
            Try a clearer photo of a single furniture piece, or search by name instead.
          </Text>
        </View>
      ) : searchState === 'error' ? (
        <View style={{ alignItems: 'center', paddingTop: 64, paddingHorizontal: 32 }}>
          <Ionicons name="cloud-offline-outline" size={36} color="#9CA3AF" />
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#1C1917', marginTop: 12 }}>Search didn't load</Text>
          <TouchableOpacity
            onPress={() => setRetryKey(k => k + 1)}
            style={{ marginTop: 14, backgroundColor: '#EAB320', borderRadius: 20, paddingVertical: 10, paddingHorizontal: 28 }}
          >
            <Text style={{ fontWeight: '700', color: '#1C1917' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : searchState === 'loading' ? (
        <View style={{ alignItems: 'center', paddingTop: 64 }}>
          <ActivityIndicator size="small" color="#EAB320" />
        </View>
      ) : (
      <FlatList
        data={searchRows}
        keyExtractor={(row) => row.key}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 0 }}
        renderItem={({ item: row }) => {
          if (row.type === 'ad') {
            return <NativeProductAdCard testMode={searchAdCfg.testMode} variant="search" />;
          }
          return (
            <View style={{ flexDirection: 'row' }}>
              {row.items.map(item => (
                <TouchableOpacity key={String(item.id)} style={styles.productCard} onPress={() => navigation.navigate('ProductDetail', { product: item })}>
                  <Image source={{ uri: variantUrl(item.images[0], { width: 720 }) }} style={styles.productImage} contentFit="cover" cachePolicy="memory-disk" transition={150} />
                  {item.originalPrice && (
                    <View style={styles.saleBadge}>
                      <Text style={styles.saleText}>SALE</Text>
                    </View>
                  )}
                  <View style={styles.productInfo}>
                    <Text style={styles.productName}>{item.name}</Text>
                    <View style={styles.priceRow}>
                      <Text style={styles.productPrice}>${item.price}</Text>
                      {item.originalPrice && <Text style={styles.originalPrice}>${item.originalPrice}</Text>}
                    </View>
                    {availability[item.id] === false && (
                      <Text style={{ fontSize: 11, color: '#B45309', marginTop: 2 }}>Temporarily unavailable</Text>
                    )}
                  </View>
                </TouchableOpacity>
              ))}
              {row.items.length < 2 ? <View style={{ flex: 1, marginHorizontal: 3 }} /> : null}
            </View>
          );
        }}
      />
      )}
    </SafeAreaView>
  );
}

// Per-line advisory fulfillment state for the Cart, reusing the SAME fulfillmentAdvisoryService
// (5-min sku|zip cache, server-authoritative). Non-blocking (renders nothing while loading);
// a request-version guard drops out-of-order responses so a SKU/ZIP change never shows a stale
// line result. Advisory failure → 'unknown' → conservative copy (never a false "unavailable").
// Read-only: never touches pricing, qty, row identity, or the checkout payload.
function CartLineFulfillment({ sku, zip }: { sku: string; zip: string | null }) {
  const [adv, setAdv] = useState<FulfillmentAdvisory | null>(null);
  const reqRef = useRef(0);
  React.useEffect(() => {
    const reqId = ++reqRef.current;
    setAdv(null); // clear on sku/zip change — never render the previous line's result
    fetchFulfillmentAdvisory(sku, zip).then(a => { if (reqRef.current === reqId) setAdv(a); });
  }, [sku, zip]);
  if (!adv) return null; // non-blocking: nothing until resolved
  return <Text style={styles.cartFulfillment}>{FULFILLMENT_COPY[adv.state]}</Text>;
}

function CartAddIcon({ onPress }: { onPress: () => void }) {
  const scale = useRef(new Animated.Value(1)).current;
  const handlePress = () => {
    onPress();
    Animated.sequence([
      Animated.spring(scale, { toValue: 0.9, useNativeDriver: true, speed: 300, bounciness: 0 }),
      Animated.spring(scale, { toValue: 1.1, useNativeDriver: true, speed: 300, bounciness: 0 }),
      Animated.spring(scale, { toValue: 1.0, useNativeDriver: true, speed: 200, bounciness: 3 }),
    ]).start();
  };
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <TouchableOpacity
        onPress={handlePress}
        style={styles.cartRecommendIconBtn}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        activeOpacity={0.7}
      >
        <Ionicons name="cart-outline" size={18} color="#EAB320" />
      </TouchableOpacity>
    </Animated.View>
  );
}

function CartScreen({ navigation }) {
  const { cart, updateQty, removeItem, addItem, refreshLines, reserveExpiry } = useCart();
  const { shoppingCredit, spendCredit } = useRewards();
  const { user } = useAuth();
  const [reserveTimeLeft, setReserveTimeLeft] = useState('');
  const [creditApplied, setCreditApplied] = useState(false);

  useEffect(() => {
    if (!reserveExpiry) { setReserveTimeLeft(''); return; }
    const tick = () => {
      const rem = reserveExpiry - Date.now();
      if (rem <= 0) { setReserveTimeLeft(''); return; }
      const m = Math.floor(rem / 60000);
      const s = Math.floor((rem % 60000) / 1000);
      setReserveTimeLeft(`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [reserveExpiry]);
  const insets = useSafeAreaInsets();
  const [qtyInputs, setQtyInputs] = useState<Record<string, string>>({});
  const [qtyFlash, setQtyFlash] = useState<Record<string, boolean>>({});
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [savedItems, setSavedItems] = useState<CartItem[]>([]);
  const removeAnims = useRef<Record<string, Animated.Value>>({});

  // Ensure each cart item has a removal animation value. Cart-line identity is
  // productId (= supplier_product_id, globally unique); sku_custom is NOT unique
  // and must never key line state, or two distinct SKUs could collide onto one row.
  cart.forEach(item => {
    if (!removeAnims.current[item.productId]) {
      removeAnims.current[item.productId] = new Animated.Value(1);
    }
  });

  const handleRemove = (productId: string) => {
    const anim = removeAnims.current[productId];
    if (anim) {
      Animated.timing(anim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
        removeItem(productId);
        delete removeAnims.current[productId];
      });
    } else {
      removeItem(productId);
    }
  };

  const handleSaveForLater = (item: CartItem) => {
    const anim = removeAnims.current[item.productId];
    const doSave = () => {
      removeItem(item.productId);
      delete removeAnims.current[item.productId];
      setSavedItems(prev => prev.find(s => s.productId === item.productId) ? prev : [...prev, item]);
    };
    if (anim) {
      Animated.timing(anim, { toValue: 0, duration: 200, useNativeDriver: true }).start(doSave);
    } else {
      doSave();
    }
  };

  const handleMoveToCart = (item: CartItem) => {
    setSavedItems(prev => prev.filter(s => s.productId !== item.productId));
    const { sku, productId, name, price, img, color, size } = item;
    addItem({ sku, productId, name, price, img, color, size }, item.qty);
  };

  const handleRemoveSaved = (productId: string) => {
    setSavedItems(prev => prev.filter(s => s.productId !== productId));
  };

  const flashQty = (productId: string) => {
    setQtyFlash(prev => ({ ...prev, [productId]: true }));
    setTimeout(() => setQtyFlash(prev => { const n = { ...prev }; delete n[productId]; return n; }), 400);
  };

  const handleQtyChange = (productId: string, text: string) => {
    setQtyInputs(prev => ({ ...prev, [productId]: text.replace(/[^0-9]/g, '') }));
  };

  const handleQtyBlur = (productId: string) => {
    const draft = qtyInputs[productId];
    if (draft !== undefined) {
      const val = parseInt(draft, 10);
      updateQty(productId, isNaN(val) || val < 1 ? 1 : Math.min(val, 999));
      setQtyInputs(prev => { const next = { ...prev }; delete next[productId]; return next; });
    }
  };

  const clearDraft = (productId: string) =>
    setQtyInputs(prev => { const next = { ...prev }; delete next[productId]; return next; });

  React.useEffect(() => {
    return navigation.addListener('focus', () => setCheckoutLoading(false));
  }, [navigation]);

  // Price/offer freshness: on every Cart focus, re-sync line prices with the
  // current catalog and (signed-in only) any active Special Offer quotes, so an
  // offer created AFTER the item was added still shows the negotiated price.
  // Display-level sync only — create-checkout-order re-prices authoritatively.
  const cartRef = useRef(cart);
  cartRef.current = cart;
  React.useEffect(() => {
    return navigation.addListener('focus', () => {
      const lines = cartRef.current;
      if (lines.length === 0) return;
      fetchCartPriceUpdates(lines, !!user?.email).then(updates => {
        if (updates.length > 0) refreshLines(updates);
      });
    });
  }, [navigation, user?.email]);

  // ── Real product pool for "Complete Your Space" ───────────────────────────
  const [realProducts, setRealProducts] = useState<Product[]>([]);
  React.useEffect(() => {
    let active = true;
    async function loadRealProducts() {
      const { data, error } = await supabase
        .from('sellable_products')
        .select(
          'id, supplier_product_id, product_title, product_title_display, optimized_title, short_description, ' +
          'key_features_json, specifications_json, sku_custom, ' +
          'category_code, scene_code, color, color_options_json, ' +
          'has_multiple_colors, show_color_selector, material, dimensions, weight, ' +
          'primary_image, gallery_images_json, product_family_key, price, selling_price, original_price, normalization_status, created_at, category_label, category_priority, is_new_arrival, new_arrival_source, total_available_qty',
        )
        .order('created_at', { ascending: false });

      if (error || !data || !active) return;

      const mapped: Product[] = (data as any[]).flatMap((r: any) => {
        try { return [adaptStandardizedRow(r)]; }
        catch { return []; }
      });

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
      if (active) setRealProducts(mapped.filter(p => representativeIds.has(p.id)));
    }
    loadRealProducts();
    return () => { active = false; };
  }, []);

  if (cart.length === 0) {
    const trending = realProducts.filter(p => p.images.length > 0).slice(0, 6);
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <Text style={styles.screenTitle}>Cart</Text>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}>
          {/* Empty-state card */}
          <View style={styles.cartEmptyCard}>
            <View style={styles.cartEmptyIconWrap}>
              <Ionicons name="home-outline" size={26} color="#CA8A04" />
            </View>
            <Text style={styles.cartEmptyHeroTitle}>Start your space</Text>
            <Text style={styles.cartEmptyHeroSub}>Discover furniture you'll love.</Text>
            <TouchableOpacity
              onPress={() => navigation.navigate('Home')}
              style={styles.cartEmptyBrowseBtn}
              activeOpacity={0.82}
            >
              <Text style={styles.cartEmptyBrowseBtnText}>Browse Collection</Text>
            </TouchableOpacity>
          </View>

          {/* Trending */}
          {trending.length > 0 && (
            <View style={styles.cartEmptyTrending}>
              <View style={styles.cartEmptyTrendingHeader}>
                <Text style={styles.cartEmptyTrendingTitle}>Trending now</Text>
                <TouchableOpacity onPress={() => navigation.navigate('Home')}>
                  <Text style={styles.cartEmptyTrendingLink}>See all</Text>
                </TouchableOpacity>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingRight: 16 }}>
                {trending.map(p => (
                  <ProductCard
                    key={p.id}
                    product={p}
                    onPress={() => navigation.navigate('ProductDetail', { product: p })}
                    style={{ width: hCardWidth, marginBottom: 0 }}
                  />
                ))}
              </ScrollView>
            </View>
          )}
        </ScrollView>
      </View>
    );
  }

  const rawTotal = cart.reduce((sum, p) => sum + p.price * p.qty, 0);
  // Shipping/fulfillment (Warehouse Pickup = $0, or Delivery = the real cached GIGA fee) is
  // selected and priced on CheckoutScreen — the cart intentionally shows no shipping charge yet.
  const creditDeduction = creditApplied ? Math.min(shoppingCredit, rawTotal) : 0;
  const total = rawTotal - creditDeduction;
  const cartIds = new Set(cart.map(p => p.productId));
  const cartCategories = [
    ...new Set(
      cart.map(i => realProducts.find(p => p.id === i.productId)?.category ?? '').filter(Boolean),
    ),
  ];
  const recPool = realProducts.filter(p => p.images.length > 0 && !cartIds.has(p.id));
  const cartCatSet = new Set(cartCategories);
  const related = recPool.filter(p => !!p.category && cartCatSet.has(p.category));
  const recSource = related.length >= 2 ? related : recPool;
  const recommended = diversify(recSource).slice(0, 4);

  if (__DEV__) {
    console.log('[Cart] completeYourSpace source: real');
    console.log('[Cart] cart item ids:', [...cartIds]);
    console.log('[Cart] recommendation pool count:', recPool.length);
    console.log('[Cart] final recommendation count:', recommended.length);
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Text style={styles.screenTitle}>Cart</Text>
      {cart.length > 0 && reserveTimeLeft ? (
        <View style={styles.reserveBanner}>
          <Ionicons name="lock-closed" size={11} color="#CA8A04" />
          <Text style={styles.reserveBannerText}>Prices reserved · {reserveTimeLeft}</Text>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 100 }}>
        {cart.map(item => (
          <Animated.View
            key={item.productId}
            style={[styles.cartItem, { opacity: removeAnims.current[item.productId] ?? 1 }]}
          >
            <Image source={{ uri: variantUrl(item.img, { width: 320 }) }} style={styles.cartImage} contentFit="cover" cachePolicy="memory-disk" transition={150} />
            <View style={styles.cartInfo}>
              <Text style={styles.cartName} numberOfLines={2}>{item.name}</Text>
              {(item.color || item.size) && (
                <Text style={styles.cartVariants}>
                  {[item.color, item.size].filter(Boolean).join(' · ')}
                </Text>
              )}
              <CartLineFulfillment sku={item.productId} zip={getCachedDelivery()?.zip ?? null} />
              <View style={styles.cartBottomRow}>
                <Text style={styles.cartPrice}>${formatPrice(item.price * item.qty)}</Text>
                <View style={styles.cartQtyControls}>
                  <TouchableOpacity
                    style={styles.cartQtyBtn}
                    onPress={() => { clearDraft(item.productId); flashQty(item.productId); updateQty(item.productId, Math.max(1, item.qty - 1)); }}
                  >
                    <Ionicons name="remove" size={14} color="#1C1917" />
                  </TouchableOpacity>
                  <TextInput
                    style={[styles.cartQtyText, qtyFlash[item.productId] && { color: '#EAB320' }]}
                    value={qtyInputs[item.productId] !== undefined ? qtyInputs[item.productId] : String(item.qty)}
                    onChangeText={text => handleQtyChange(item.productId, text)}
                    onBlur={() => handleQtyBlur(item.productId)}
                    keyboardType="number-pad"
                    selectTextOnFocus
                    maxLength={3}
                  />
                  <TouchableOpacity
                    style={styles.cartQtyBtn}
                    onPress={() => { clearDraft(item.productId); flashQty(item.productId); updateQty(item.productId, item.qty + 1); }}
                  >
                    <Ionicons name="add" size={14} color="#1C1917" />
                  </TouchableOpacity>
                </View>
              </View>
              <TouchableOpacity onPress={() => handleSaveForLater(item)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Text style={styles.cartSaveText}>Save for later</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.cartDeleteBtn} onPress={() => handleRemove(item.productId)}>
              <Ionicons name="close" size={16} color="#9CA3AF" />
            </TouchableOpacity>
          </Animated.View>
        ))}

        {/* Summary block */}
        <View style={styles.cartSummary}>
          {/* Secondary: Subtotal / Shipping / Tax */}
          <View style={styles.summaryLines}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Subtotal</Text>
              <Text style={styles.summaryValue}>${formatPrice(rawTotal)}</Text>
            </View>
            {orderSavings(cart) > 0 && (
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>You saved</Text>
                <Text style={[styles.summaryValue, { color: '#CA8A04' }]}>-${formatPrice(orderSavings(cart))}</Text>
              </View>
            )}
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Shipping</Text>
              <Text style={styles.summaryMuted}>Calculated at checkout</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Tax</Text>
              <Text style={styles.summaryMuted}>Calculated at checkout</Text>
            </View>
            {shoppingCredit > 0 && (
              <TouchableOpacity style={styles.summaryRow} onPress={() => setCreditApplied(v => !v)}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <Ionicons name={creditApplied ? 'checkmark-circle' : 'ellipse-outline'} size={15} color="#EAB320" />
                  <Text style={styles.summaryLabel}>Shopping credit</Text>
                </View>
                <Text style={[styles.summaryValue, { color: creditApplied ? '#CA8A04' : '#9CA3AF' }]}>
                  {creditApplied ? `-$${creditDeduction.toFixed(2)}` : `$${shoppingCredit.toFixed(2)} available`}
                </Text>
              </TouchableOpacity>
            )}
          </View>
          {/* Primary: Total */}
          <View style={[styles.summaryTotalBlock, styles.summaryTotalRow]}>
            <Text style={styles.summaryTotalLabel}>Total</Text>
            <Text style={styles.summaryTotalValue}>${formatPrice(total)}</Text>
          </View>
          {/* CTA */}
          <TouchableOpacity
            style={[styles.summaryCheckoutBtn, checkoutLoading && { opacity: 0.7 }]}
            disabled={checkoutLoading}
            onPress={() => { setCheckoutLoading(true); (navigation.getParent('RootStack') ?? navigation).navigate('Checkout', { mode: 'cart', creditAmount: creditDeduction }); }}
          >
            {checkoutLoading
              ? <ActivityIndicator size="small" color="white" />
              : <Text style={styles.summaryCheckoutBtnText}>Checkout · ${formatPrice(total)}</Text>}
          </TouchableOpacity>
        </View>

        {/* Saved for later */}
        {savedItems.length > 0 && (
          <View style={styles.savedSection}>
            <Text style={styles.savedSectionTitle}>Saved for later ({savedItems.length})</Text>
            {savedItems.map(item => (
              <View key={item.productId} style={styles.savedItem}>
                <Image source={{ uri: variantUrl(item.img, { width: 320 }) }} style={styles.savedItemImg} cachePolicy="memory-disk" transition={150} />
                <View style={styles.savedItemInfo}>
                  <Text style={styles.savedItemName} numberOfLines={2}>{item.name}</Text>
                  <Text style={styles.savedItemPrice}>${formatPrice(item.price)}</Text>
                  <View style={styles.savedItemActions}>
                    <TouchableOpacity style={styles.savedMoveBtn} onPress={() => handleMoveToCart(item)}>
                      <Text style={styles.savedMoveBtnText}>Move to cart</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handleRemoveSaved(item.productId)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Text style={styles.savedRemoveText}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Complete Your Space */}
        {recommended.length > 0 && (
          <View style={styles.cartRecommendSection}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <Text style={[styles.cartRecommendTitle, { marginBottom: 0 }]}>Complete Your Space</Text>
              <TouchableOpacity onPress={() => navigation.navigate('Home')}>
                <Text style={{ fontSize: 13, color: '#CA8A04', fontWeight: '500' }}>See all</Text>
              </TouchableOpacity>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 12 }}>
              {recommended.map(p => (
                <TouchableOpacity key={p.id} style={styles.cartRecommendCard} onPress={() => navigation.navigate('ProductDetail', { product: p })}>
                  {p.images[0]
                    ? <Image source={{ uri: variantUrl(p.images[0], { width: 320 }) }} style={styles.cartRecommendImg} cachePolicy="memory-disk" transition={150} />
                    : <View style={[styles.cartRecommendImg, { alignItems: 'center', justifyContent: 'center', backgroundColor: '#F3F4F6' }]}>
                        <Ionicons name="image-outline" size={24} color="#D1D5DB" />
                      </View>}
                  <View style={styles.cartRecommendInfo}>
                    <Text style={styles.cartRecommendName} numberOfLines={2}>{p.name}</Text>
                    {p.rating && (
                      <Text style={styles.cartRecommendRating}>⭐ {p.rating} ({p.reviewCount})</Text>
                    )}
                    <View style={styles.cartRecommendBottom}>
                      <Text style={styles.cartRecommendPrice}>${formatPrice(p.price)}</Text>
                      <CartAddIcon onPress={() => addItem(defaultCartItem(p), 1)} />
                    </View>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function AccountScreen({ navigation }) {
  const conciergeUnread = useConcierge().unreadCount;
  const insets = useSafeAreaInsets();
  const { user, isGuest, signOut, deleteAccount } = useAuth();
  const { balance } = useRewards();
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const handleDeleteAccount = async () => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    const { error } = await deleteAccount();
    setDeleteBusy(false);
    setDeleteModalVisible(false);
    if (error) {
      Alert.alert('Could not delete account', error);
    }
  };

  const accountItems = [
    // 'Messages' (Inbox → ConversationContext) hidden in Phase 1 of the
    // chat-entry-points consolidation. Route still registered in AccountStack
    // for safety; reachable only by direct code navigation.
    { icon: 'cube-outline', title: 'Orders & Purchases', route: 'Orders', requiresAuth: true },
    { icon: 'help-buoy-outline', title: 'Chat with us', subtitle: 'Usually replies soon', route: 'Support' },
    { icon: 'share-social-outline', title: 'Start Sharing', subtitle: 'Earn $5–$20 per referral', route: 'Earn', requiresAuth: true, secondary: true },
  ];


  function renderItem(item: any, index: number, list: any[], locked = false) {
    const isLast = index === list.length - 1;
    const iconColor = locked ? '#C4C0BA' : item.secondary ? '#C4B88A' : '#CA8A04';
    const textColor = locked ? '#9CA3AF' : item.secondary ? '#6B7280' : '#1C1917';
    return (
      <TouchableOpacity
        key={index}
        style={[styles.menuItem, !isLast && styles.menuItemBorder]}
        onPress={() => locked
          ? navigation.navigate('SignInEntry')
          : item.route === 'Support' ? (navigationRef.isReady() && navigationRef.navigate('Support' as never))
          : item.route ? navigation.navigate(item.route)
        : (item as any).href ? Linking.openURL((item as any).href)
        : null}
      >
        <Ionicons name={item.icon as any} size={20} color={iconColor} />
        <View style={styles.menuTextWrap}>
          <Text style={[styles.menuText, { color: textColor }]}>{item.title}</Text>
          {item.subtitle && !locked && <Text style={styles.menuSubText}>{item.subtitle}</Text>}
        </View>
        {item.route === 'Support' && conciergeUnread > 0 && (
          <View style={{ minWidth: 20, height: 20, borderRadius: 10, backgroundColor: '#CA8A04', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, marginRight: 6 }}>
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{conciergeUnread > 9 ? '9+' : String(conciergeUnread)}</Text>
          </View>
        )}
        <Ionicons name={locked ? 'lock-closed-outline' : 'chevron-forward'} size={15} color="#D1CFC9" />
      </TouchableOpacity>
    );
  }

  const footer = (
    <Text style={styles.accountFooter}>
      <Text style={styles.accountFooterLink} onPress={() => Linking.openURL('https://pouncing-quotation-0f0.notion.site/Terms-of-Service-358e0472a4e28030bb0ce6258d50a1c9?source=copy_link')}>Terms</Text>
      <Text> · </Text>
      <Text style={styles.accountFooterLink} onPress={() => Linking.openURL('https://xselfhome.com/privacy.html')}>Privacy</Text>
    </Text>
  );

  // Guest / signed-out state
  if (!user) {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}>
          <View style={styles.guestIdentity}>
            <View style={styles.guestAvatarWrap}>
              <Ionicons name="person-outline" size={32} color="#CA8A04" />
            </View>
            <Text style={styles.guestTitle}>Sign in to your account</Text>
            <Text style={styles.guestSub}>Unlock rewards, track orders, and start earning from your taste.</Text>
            <TouchableOpacity
              style={[styles.primaryBtn, { alignSelf: 'stretch', marginTop: 20 }]}
              onPress={() => navigation.navigate('SignInEntry')}
            >
              <Text style={styles.primaryBtnText}>Sign In</Text>
            </TouchableOpacity>
            {isGuest && (
              <Text style={styles.guestNote}>You're browsing as a guest. Sign in to save your progress.</Text>
            )}
          </View>

          <Text style={styles.menuSectionLabel}>MY ACCOUNT</Text>
          <View style={styles.menuListCard}>
            {accountItems.map((item, i) => renderItem(item, i, accountItems, true))}
          </View>

          {footer}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Signed-in state
  const initials = user.displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}>

        {/* Membership Card — premium dark focal point */}
        <View style={styles.memberCard}>
          <LinearGradient
            colors={['#1E1C18', '#111010']}
            style={StyleSheet.absoluteFillObject}
            start={{ x: 0.0, y: 0.0 }}
            end={{ x: 1.0, y: 1.0 }}
          />
          <View style={styles.memberCardHighlight} />
          <View style={styles.memberCardHeader}>
            <Text style={styles.memberCardBadge}>XSELF GOLD STATUS</Text>
          </View>
          <Text style={styles.memberCardName}>{user.displayName}</Text>
          <Text style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>Earned through rewards and referrals</Text>
          <View style={{ marginTop: 12 }}>
            <Text style={styles.memberCardBalanceLabel}>Rewards Balance</Text>
            <Text style={styles.memberCardBalance}>${balance.toFixed(2)}</Text>
          </View>
          <TouchableOpacity onPress={() => navigation.navigate('Membership')} style={styles.memberCardCTA} activeOpacity={0.75}>
            <Text style={styles.memberCardCTAText}>View Benefits →</Text>
          </TouchableOpacity>
        </View>

        {/* Your Benefits */}
        <Text style={styles.menuSectionLabel}>YOUR BENEFITS</Text>
        <View style={styles.menuListCard}>
          {([
            { icon: 'cash-outline',     text: 'Cashback on purchases' },
            { icon: 'pricetag-outline', text: 'Member-only deals' },
            { icon: 'star-outline',     text: 'Exclusive member pricing' },
          ] as const).map((b, i, arr) => (
            <View key={i} style={[styles.benefitRow, i < arr.length - 1 && styles.menuItemBorder]}>
              <Ionicons name={b.icon} size={17} color="#CA8A04" />
              <Text style={styles.benefitText}>{b.text}</Text>
              <Ionicons name="chevron-forward" size={14} color="#D1CFC9" />
            </View>
          ))}
        </View>

        {/* My Account */}
        <Text style={styles.menuSectionLabel}>MY ACCOUNT</Text>
        <View style={styles.menuListCard}>
          {accountItems.map((item, i) => renderItem(item, i, accountItems))}
        </View>

        <View style={[styles.menuListCard, { marginTop: 24 }]}>
          <TouchableOpacity style={styles.menuItem} onPress={signOut} activeOpacity={0.65}>
            <Ionicons name="log-out-outline" size={20} color="#E05252" />
            <View style={styles.menuTextWrap}>
              <Text style={[styles.menuText, { color: '#E05252' }]}>Sign Out</Text>
            </View>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={styles.deleteAccountLink}
          onPress={() => setDeleteModalVisible(true)}
          activeOpacity={0.6}
          hitSlop={{ top: 8, bottom: 8, left: 16, right: 16 }}
        >
          <Text style={styles.deleteAccountLinkText}>Delete Account</Text>
        </TouchableOpacity>

        {footer}
      </ScrollView>

      <Modal
        visible={deleteModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => { if (!deleteBusy) setDeleteModalVisible(false); }}
      >
        <View style={styles.deleteAccountBackdrop}>
          <View style={styles.deleteAccountCard}>
            <Text style={styles.deleteAccountTitle}>Delete your account?</Text>
            <Text style={styles.deleteAccountBody}>
              This permanently removes your saved addresses and signs you out. Past orders are anonymized but kept for fulfillment and accounting. This cannot be undone.
            </Text>
            <View style={styles.deleteAccountActions}>
              <TouchableOpacity
                style={styles.deleteAccountCancel}
                onPress={() => setDeleteModalVisible(false)}
                disabled={deleteBusy}
                activeOpacity={0.7}
              >
                <Text style={styles.deleteAccountCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.deleteAccountConfirm, deleteBusy && { opacity: 0.6 }]}
                onPress={handleDeleteAccount}
                disabled={deleteBusy}
                activeOpacity={0.85}
              >
                {deleteBusy
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.deleteAccountConfirmText}>Delete</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function MembershipScreen({ navigation }) {
  const { user } = useAuth();
  const { balance } = useRewards();

  // Guard: if user is null (signed out while screen was mounted), go back
  useEffect(() => { if (!user) navigation.goBack(); }, [user]);

  if (!user) return null;

  const benefits = [
    { icon: 'cash-outline',     text: 'Cashback on purchases' },
    { icon: 'pricetag-outline', text: 'Member-only deals' },
    { icon: 'star-outline',     text: 'Exclusive member pricing' },
  ] as const;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#F3F1EB' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={24} color="#1C1917" />
        </TouchableOpacity>
        <Text style={{ fontSize: 17, fontWeight: '600', color: '#1C1917', marginLeft: 8 }}>Membership</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>
        {/* Premium dark card */}
        <View style={styles.memberCard}>
          <LinearGradient
            colors={['#1A1816', '#0D0C0B']}
            style={StyleSheet.absoluteFillObject}
            start={{ x: 0.0, y: 0.0 }}
            end={{ x: 1.0, y: 1.0 }}
          />
          <View style={styles.memberCardHighlight} />
          <View style={styles.memberCardHeader}>
            <Text style={styles.memberCardBadge}>XSELF GOLD STATUS</Text>
          </View>
          <Text style={{ fontSize: 11, color: '#9CA3AF', marginTop: 6 }}>Earned through rewards and referrals</Text>
          <View style={{ marginTop: 14 }}>
            <Text style={styles.memberCardBalanceLabel}>Rewards Balance</Text>
            <Text style={styles.memberCardBalance}>${balance.toFixed(2)}</Text>
          </View>
        </View>

        {/* Your Plan */}
        <Text style={styles.menuSectionLabel}>YOUR PLAN</Text>
        <View style={styles.menuListCard}>
          <View style={[styles.menuItem, styles.menuItemBorder]}>
            <Ionicons name="shield-checkmark-outline" size={20} color="#CA8A04" />
            <View style={styles.menuTextWrap}>
              <Text style={styles.menuText}>Xself Gold Status</Text>
              <Text style={styles.menuSubText}>Earned through rewards and referrals</Text>
            </View>
            <View style={{ backgroundColor: '#F3F4F6', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 }}>
              <Text style={{ fontSize: 10, fontWeight: '600', color: '#9CA3AF' }}>PREVIEW</Text>
            </View>
          </View>
          {/* "Manage Plan" CTA hidden for 1.0.10 — https://xselfhome.com/membership is not published yet (was a 404). Restore when the membership page exists. */}
        </View>

        {/* Your Benefits */}
        <Text style={styles.menuSectionLabel}>YOUR BENEFITS</Text>
        <View style={styles.menuListCard}>
          {benefits.map((b, i, arr) => (
            <View key={i} style={[styles.benefitRow, i < arr.length - 1 && styles.menuItemBorder]}>
              <Ionicons name={b.icon} size={17} color="#CA8A04" />
              <Text style={styles.benefitText}>{b.text}</Text>
              <Ionicons name="chevron-forward" size={14} color="#D1CFC9" />
            </View>
          ))}
        </View>

        {/* Disclaimer */}
        <Text style={{ fontSize: 12, color: '#9CA3AF', marginHorizontal: 20, marginTop: 8, marginBottom: 4, lineHeight: 18, textAlign: 'center' }}>
          Membership features are not yet available and will be released in a future update.
        </Text>

        {/* Earn More */}
        <Text style={styles.menuSectionLabel}>EARN MORE</Text>
        <View style={styles.menuListCard}>
          <TouchableOpacity style={styles.menuItem} onPress={() => navigation.navigate('Earn')} activeOpacity={0.7}>
            <Ionicons name="gift-outline" size={20} color="#EAB320" />
            <View style={styles.menuTextWrap}>
              <Text style={styles.menuText}>Rewards & Cashback</Text>
              <Text style={styles.menuSubText}>View your earn history</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color="#D1CFC9" />
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function CartTabStack() {
  return (
    <CartStack.Navigator id="CartStack" screenOptions={{ headerShown: false } as any}>
      <CartStack.Screen name="CartMain" component={CartScreen} />
    </CartStack.Navigator>
  );
}

function AccountTabStack() {
  return (
    <AccountStack.Navigator id="AccountStack" screenOptions={{ headerShown: false } as any}>
      <AccountStack.Screen name="AccountMain" component={AccountScreen} />
      <AccountStack.Screen name="Orders" component={OrdersScreen} />
      <AccountStack.Screen name="Membership" component={MembershipScreen} />
      <AccountStack.Screen name="Earn" component={EarnScreen} />
      <AccountStack.Screen name="Inbox" component={InboxScreen} />
      {/* 'Support' is intentionally NOT registered in AccountStack. The Concierge
          chat opens via the root Stack 'Support' (navigationRef.navigate('Support'))
          so the bottom tab bar is hidden and the composer isn't covered. A nested
          registration here caused Support to render inside the Account tab, leaving
          the floating tab bar overlaying the message input. */}
      <AccountStack.Screen name="SignInEntry" component={SignInEntryScreen} />
    </AccountStack.Navigator>
  );
}

function CustomTabBar({ state, navigation }: any) {
  const insets = useSafeAreaInsets();
  const { totalItems, badgeVersion } = useCart();
  const { unreadCount: conciergeUnread } = useConcierge();
  const { setCartTarget } = useCartAnimation();
  const cartIconRef = useRef<View>(null);
  const rootRouteName = useNavigationState(s => s.routes[s.index]?.name);
  const badgeAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (badgeVersion === 0) return;
    Animated.sequence([
      Animated.spring(badgeAnim, { toValue: 1.15, useNativeDriver: true, speed: 300, bounciness: 0 }),
      Animated.spring(badgeAnim, { toValue: 1, useNativeDriver: true, speed: 250, bounciness: 2 }),
    ]).start();
  }, [badgeVersion]);

  const TAB_CONFIG = [
    { name: 'Home', icon: 'home-outline' },
    { name: 'Discover', icon: 'search-outline' },
    { name: 'Cart', icon: 'cart-outline' },
    { name: 'Account', icon: 'person-outline' },
  ] as const;

  if (['Checkout', 'OrderSuccess', 'ProductDetail', 'Collection', 'Chat', 'Support'].includes(rootRouteName ?? '')) return null;

  return (
    <View style={[styles.floatTabBar, { bottom: insets.bottom + 8 }]}>
      {/* <BlurView intensity={12} tint="light" style={StyleSheet.absoluteFill} /> */}
      {TAB_CONFIG.map(({ name, icon }) => {
        const route = state.routes.find((r: any) => r.name === name);
        if (!route) return null;
        const isFocused = state.routes[state.index]?.name === name;
        return (
          <TouchableOpacity
            key={name}
            style={styles.floatTabItem}
            onPress={() => {
              const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!isFocused && !event.defaultPrevented) navigation.navigate(name);
            }}
            activeOpacity={0.75}
          >
            <View style={styles.floatTabContent}>
              <View style={[styles.floatTabIconWrap, isFocused && styles.floatTabIconWrapActive]}>
                <View
                  ref={name === 'Cart' ? cartIconRef : undefined}
                  collapsable={false}
                  style={{ position: 'relative' }}
                  onLayout={() => {
                    if (name === 'Cart') {
                      cartIconRef.current?.measureInWindow((x, y, w, h) => {
                        setCartTarget(x + w / 2, y + h / 2 - 6);
                      });
                    }
                  }}
                >
                  <Ionicons name={icon as any} size={22} color={isFocused ? '#EAB320' : '#6B7280'} />
                  {name === 'Cart' && totalItems > 0 && (
                    <Animated.View style={[styles.floatTabBadge, { transform: [{ scale: badgeAnim }] }]}>
                      <Text style={styles.floatTabBadgeText}>{totalItems > 9 ? '9+' : String(totalItems)}</Text>
                    </Animated.View>
                  )}
                  {name === 'Account' && conciergeUnread > 0 && (
                    <View style={{ position: 'absolute', top: -2, right: -2, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: '#CA8A04', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }}>
                      <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{conciergeUnread > 9 ? '9+' : String(conciergeUnread)}</Text>
                    </View>
                  )}
                </View>
              </View>
              <Text style={[styles.floatTabLabel, isFocused && styles.floatTabLabelActive]}>{name}</Text>
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function TabNavigator() {
  return (
    <View style={{ flex: 1 }}>
      <Tab.Navigator
        id="TabNavigator"
        tabBar={(props) => <CustomTabBar {...props} />}
        screenOptions={{ headerShown: false } as any}
      >
        <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Discover" component={DiscoverScreen} />
        <Tab.Screen name="Cart" component={CartTabStack} />
        <Tab.Screen name="Account" component={AccountTabStack} />
        <Tab.Screen name="Search" component={SearchScreen} options={{ tabBarButton: () => null }} />
      </Tab.Navigator>
      <BottomGradient />
    </View>
  );
}

// ── Concierge in-app banner host (Phase 1) ────────────────────────────
// App-level overlay. Shows ConciergeTopBanner when ConciergeContext reports a new
// operator message; owns the auto-dismiss timer (banner stays pure). Tap → root
// Stack 'Support' (tab bar auto-hides) + markRead. No Crisp/quote/payment logic.
export const navigationRef = createNavigationContainerRef<any>();

function ConciergeBannerHost() {
  const { lastEvent, markRead } = useConcierge();
  const [bannerVisible, setBannerVisible] = useState(false);
  const [bannerPreview, setBannerPreview] = useState<string | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!lastEvent) return;
    setBannerPreview(lastEvent.preview);
    setBannerVisible(true);
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = setTimeout(() => setBannerVisible(false), 4500);
    return () => { if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current); };
  }, [lastEvent]);

  const goToSupport = () => {
    setBannerVisible(false);
    markRead();
    if (navigationRef.isReady()) navigationRef.navigate('Support' as never);
  };

  return (
    <ConciergeTopBanner
      visible={bannerVisible}
      preview={bannerPreview}
      onPress={goToSupport}
      onDismiss={() => setBannerVisible(false)}
    />
  );
}

function LoginEntryScreen() {
  // Standalone full-screen startup login — structurally OUTSIDE TabNavigator (no tabs).
  // No onDone: choosing Guest / signing in changes auth state and the root gate swaps
  // this navigator for the Main app automatically.
  return <AuthEntryView />;
}

// Root auth gate. Renders the standalone LoginEntry (no tab bar) until the user is
// authenticated OR has explicitly chosen guest; otherwise renders the Main app stack.
// Holds the native splash until session restoration resolves — no JS splash animation.
function RootNavigation() {
  const { user, isGuest, authReady } = useAuth();

  useEffect(() => {
    if (authReady) SplashScreen.hideAsync().catch(() => {});
  }, [authReady]);

  if (!authReady) return null; // native iOS Launch Screen stays visible (preventAutoHide)

  const entered = !!user || isGuest;

  return (
    <NavigationContainer
      ref={navigationRef}
      onStateChange={() => {
        // Single narrow hook for the browse-break interstitial: feed the DEEPEST active
        // route to the manager, which counts ProductDetail views and shows at most one ad
        // on a ProductDetail -> eligible-browse return. Inert unless remote config enables
        // it; swallows all errors; never blocks navigation.
        const r = navigationRef.getCurrentRoute();
        interstitialAdManager.handleRouteChange(r?.name, r?.key);
      }}
    >
      {entered ? (
        <Stack.Navigator id="RootStack" initialRouteName="Main" screenOptions={{ headerShown: false, gestureEnabled: true } as any}>
          <Stack.Screen name="Main" component={TabNavigator} />
          <Stack.Screen name="SignInEntry" component={SignInEntryScreen} />
          <Stack.Screen name="ProductDetail" component={ProductDetailScreen} />
          <Stack.Screen name="Collection" component={CollectionScreen} />
          {/* Phase 2 commerce taxonomy browse/results — registered always (harmless when
              not navigated to); only reachable via the flag-gated Home/Discover entries. */}
          <Stack.Screen name="CommerceBrowse" component={CommerceBrowseScreen} />
          <Stack.Screen name="CommerceResults" component={CommerceResultsScreen} />
          <Stack.Screen name="Checkout" component={CheckoutScreen} />
          <Stack.Screen name="OrderSuccess" component={OrderSuccessScreen} />
          <Stack.Screen name="Chat" component={ChatScreen} />
          <Stack.Screen name="ProductConversation" component={ProductConversationScreen} />
          <Stack.Screen name="Support" component={SupportScreen} />
        </Stack.Navigator>
      ) : (
        <Stack.Navigator id="AuthGate" screenOptions={{ headerShown: false } as any}>
          <Stack.Screen name="LoginEntry" component={LoginEntryScreen} />
        </Stack.Navigator>
      )}
    </NavigationContainer>
  );
}

export default function App() {

  // Initialise Crisp Chat once at app start. Safe to call on every mount —
  // configure() is idempotent inside the native SDK.
  useEffect(() => {
    const crispId = process.env.EXPO_PUBLIC_CRISP_WEBSITE_ID;
    if (crispId) {
      try {
        CrispChatSDK.configure(crispId);
      } catch (err) {
        console.warn('[Crisp] configure failed:', err instanceof Error ? err.message : err);
      }
    } else {
      console.warn('[Crisp] EXPO_PUBLIC_CRISP_WEBSITE_ID not set — chat disabled');
    }
  }, []);

  // App Tracking Transparency — asked once, 3s after launch so it never blocks
  // first paint. Denied → the Meta SDK stays in SKAdNetwork/aggregated mode
  // (advertiserTracking=false) and the app works exactly the same; granted →
  // the SDK may use IDFA for attribution. Meta init itself is automatic
  // (isAutoInitEnabled in app.json) and independent of this answer.
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const { status } = await requestTrackingPermissionsAsync();
        FBSettings.setAdvertiserTrackingEnabled(status === 'granted');
      } catch { /* ATT unavailable (old iOS/simulator) — SDK stays in limited mode */ }
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  // Initialise the Google Mobile Ads SDK once at app start. Phase N1 disabled the
  // intrusive App Open overlay: the SDK is initialised, but NO App Open ad is
  // loaded or shown here (no launch/foreground trigger). The App Open manager +
  // eligibility remain as dormant infrastructure, gated OFF by remote config, for
  // possible future use. Failure is non-fatal to boot. Native Discover ads load
  // themselves inside DiscoverScreen (remote-gated, OFF by default).
  useEffect(() => {
    mobileAds()
      .initialize()
      .catch((err: unknown) => {
        console.warn('[Ads] SDK initialize failed:', err instanceof Error ? err.message : err);
      });
  }, []);

  // Interstitial (browse-break) V1 — load the shared remote ad config once, hand it to the
  // manager, and warm a preload. Default OFF (ads_interstitial_enabled=false) so this stays
  // fully inert until the server row is set. Never blocks boot; failures are swallowed.
  useEffect(() => {
    loadAdConfig()
      .then(cfg => { interstitialAdManager.configure(cfg); interstitialAdManager.load(); })
      .catch(() => { /* non-fatal — manager stays inert */ });
  }, []);

  // (Removed) The custom JS splash gate/animation. The native iOS Launch Screen is now
  // released by RootNavigation once auth bootstrap resolves — no animated JS splash.

  return (
    <View style={{ flex: 1, backgroundColor: '#0F766E' }}>
      <SafeAreaProvider>
      <StripeProvider
        publishableKey={process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? ''}
        merchantIdentifier={process.env.EXPO_PUBLIC_APPLE_MERCHANT_ID ?? 'merchant.com.xself.home'}
        urlScheme="xselfhome"
      >
      <AuthProvider>
      <RecommendationProvider>
      <RewardsProvider>
      <CartAnimProvider>
      <CartProvider>
      <OrdersProvider>
      <ConversationProvider>
      <ConciergeProvider>
      <RootNavigation />
      {/* Meta Shop 的 checkout Universal Link 消费端。必须在 CartProvider 内（要用 useCart）。
          它只认 /checkout 路径；magic link 仍由 AuthContext 处理，两者判定互斥。 */}
      <MetaCheckoutLinkHandler navigator={navigationRef} />
      <ConciergeBannerHost />
      </ConciergeProvider>
      </ConversationProvider>
      </OrdersProvider>
      </CartProvider>
      </CartAnimProvider>
      </RewardsProvider>
      </RecommendationProvider>
      </AuthProvider>
      </StripeProvider>
      </SafeAreaProvider>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F3F1EB', paddingBottom: 0 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16 },
  greeting: { fontSize: 12, color: '#9CA3AF', textTransform: 'uppercase' },
  title: { fontSize: 28, fontWeight: '600', color: '#1C1917' },
  headerIcons: { flexDirection: 'row', gap: 12 },
  iconBtn: { width: 44, height: 44, borderRadius: 8, backgroundColor: '#F5F5F4', alignItems: 'center', justifyContent: 'center' },
  searchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F3F4F6', borderRadius: 999, height: 40, paddingLeft: 12, paddingRight: 8, marginHorizontal: 20, marginTop: 12, marginBottom: 10, gap: 8 },
  searchInput: { flex: 1, paddingVertical: 0, fontSize: 15, color: '#1C1917' },
  categories: { paddingHorizontal: 20, marginVertical: 12 },
  categoryPill: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 24, backgroundColor: 'white', marginRight: 10, borderWidth: 1, borderColor: '#E5E7EB' },
  categoryPillActive: { backgroundColor: '#1C1917', borderColor: '#1C1917' },
  categoryText: { fontSize: 14, color: '#6B7280' },
  categoryTextActive: { color: 'white' },
  productsGrid: { paddingHorizontal: 10, paddingBottom: 100, paddingTop: 4 },
  heroBanner: { marginHorizontal: 6, marginBottom: 16, borderRadius: 12, backgroundColor: '#1C1917', padding: 24, minHeight: 140, justifyContent: 'flex-end', overflow: 'hidden' },
  heroEyebrow: { fontSize: 10, fontWeight: '600', color: '#EAB320', letterSpacing: 2, marginBottom: 6 },
  heroTitle: { fontSize: 22, fontWeight: '600', color: '#FFFFFF', lineHeight: 28, marginBottom: 16 },
  heroCTA: { alignSelf: 'flex-start', backgroundColor: '#EAB320', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8 },
  heroCTAText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  homeSectionHeader: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8 },
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
  reserveBanner: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 20, paddingBottom: 10, marginTop: -10 },
  reserveBannerText: { fontSize: 12, color: '#CA8A04', fontWeight: '500' },
  detailImage: { width: '100%', height: 300, backgroundColor: '#F3F4F6' },
  detailContent: { padding: 20, backgroundColor: 'white', borderTopLeftRadius: 8, borderTopRightRadius: 8, marginTop: -8 },
  detailNameRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  detailName: { fontSize: 19, fontWeight: '600', color: '#1C1917', lineHeight: 26 },
  detailPriceRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  detailPrice: { fontSize: 28, fontWeight: '700', color: '#1C1917' },
  detailSale: { fontSize: 16, color: '#9CA3AF', textDecorationLine: 'line-through' },
  detailSaveBadge: { backgroundColor: '#FFF7E6', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  detailSaveText: { fontSize: 11, fontWeight: '600', color: '#CA8A04' },
  detailRating: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  detailStars: { color: '#D4AA50', fontSize: 13 },
  detailReviews: { color: '#9CA3AF', fontSize: 13, marginLeft: 6 },
  detailDesc: { fontSize: 14, color: '#6B7280', lineHeight: 22 },
  descSection: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#F3F4F6', paddingTop: 14, marginTop: 4 },
  descSectionLabel: { fontSize: 11, fontWeight: '700', color: '#6B7280', letterSpacing: 0.8, textTransform: 'uppercase' as const, marginBottom: 8 },
  ctaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#F3F4F6' },
  qtyLabel: { fontSize: 14, fontWeight: '600', color: '#1C1917' },
  qtyControls: { flexDirection: 'row', alignItems: 'center', gap: 0, backgroundColor: '#F3F4F6', borderRadius: 6, overflow: 'hidden' },
  qtyBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  qtyValue: { fontSize: 15, fontWeight: '600', color: '#1C1917', width: 32, textAlign: 'center' },
  cartItem: { flexDirection: 'row', padding: 12, backgroundColor: 'white', marginHorizontal: 16, marginBottom: 8, borderRadius: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4, elevation: 2 },
  cartImage: { width: 80, aspectRatio: 4 / 5, borderRadius: 6, backgroundColor: '#F3F4F6' },
  cartInfo: { flex: 1, marginLeft: 10, paddingRight: 20 },
  cartName: { fontSize: 13, fontWeight: '500', color: '#1C1917', lineHeight: 18 },
  cartVariants: { fontSize: 11, color: '#9CA3AF', marginTop: 3 },
  cartFulfillment: { fontSize: 11, color: '#6B7280', marginTop: 3 },
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
  cartRecommendIconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  specsCard: { backgroundColor: '#F9FAFB', borderRadius: 8 },
  specGroup: { marginTop: 2 },
  specGroupHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E5E3DC' },
  specGroupTitle: { fontSize: 13, fontWeight: '600', color: '#374151' },
  specRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#F3F4F6' },
  specLabel: { fontSize: 13, color: '#6B7280' },
  specValue: { fontSize: 13, color: '#1C1917', fontWeight: '500', textAlign: 'right' as const, flex: 1, marginLeft: 16 },

  featuresSection: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#F3F4F6', paddingTop: 16, marginTop: 12, gap: 7 },
  featuresSectionLabel: { fontSize: 11, fontWeight: '700', color: '#6B7280', letterSpacing: 0.8, textTransform: 'uppercase' as const, marginBottom: 2 },
  featureRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  featureText: { flex: 1, fontSize: 13, color: '#4B5563', lineHeight: 20 },
  cartSummary: { marginHorizontal: 12, marginTop: 8, marginBottom: 4, backgroundColor: 'white', borderRadius: 8, padding: 16 },
  summaryLines: { paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  summaryLabel: { fontSize: 12, color: '#9CA3AF' },
  summaryValue: { fontSize: 12, color: '#6B7280', fontWeight: '500', textAlign: 'right' as const },
  summaryFree: { fontSize: 12, color: '#6B7280', fontWeight: '500', textAlign: 'right' as const },
  summaryMuted: { fontSize: 12, color: '#C4C0BA', textAlign: 'right' as const },
  summaryTotalBlock: { paddingTop: 14, paddingBottom: 16 },
  summaryTotalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  summaryCheckoutBtn: { backgroundColor: '#EAB320', height: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center', shadowColor: '#EAB320', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6, elevation: 3 },
  summaryCheckoutBtnText: { color: 'white', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  floatingCtaContainer: { position: 'absolute', left: 16, right: 16, zIndex: 10 },
  floatingCheckoutBtn: { backgroundColor: '#EAB320', paddingVertical: 16, borderRadius: 14, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 6 },
  floatingCheckoutBtnText: { color: 'white', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  summaryTotalLabel: { fontSize: 16, lineHeight: 24, fontWeight: '600' as const, color: '#1C1917' },
  // 与 CheckoutScreen 同一档：和自己的 label 同尺寸，强调交给字重。
  summaryTotalValue: { fontSize: 16, lineHeight: 24, fontWeight: '700' as const, color: '#111111' },
  summaryTotalSub: { fontSize: 11, color: '#9CA3AF', marginTop: 4 },
  checkoutBtn: { backgroundColor: '#EAB320', paddingVertical: 13, borderRadius: 6, alignItems: 'center' },
  checkoutBtnText: { color: 'white', fontSize: 15, fontWeight: '600' },
  checkoutTrustText: { fontSize: 11, color: '#9CA3AF', textAlign: 'center', marginTop: 10 },
  masonryWrap: { paddingHorizontal: 12, paddingBottom: 0 },
  masonryCols: { flexDirection: 'row', gap: 10 },
  masonryCol: { flex: 1, gap: 10 },
  masonryCard: { borderRadius: 6, overflow: 'hidden', backgroundColor: 'white' },
  masonryImage: { width: '100%', backgroundColor: '#F3F4F6' },
  // Identity section — no card
  identitySection: { paddingTop: 28, paddingBottom: 20, paddingHorizontal: 20 },
  membershipRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
  profileRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 16 },
  profileInfo: { flex: 1, paddingTop: 2 },
  avatarRing: { width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center' },
  avatarRingMember: { borderWidth: 2, borderColor: '#EAB320' },
  // Membership card
  memberCard: { marginHorizontal: 16, marginTop: 20, marginBottom: 8, borderRadius: 16, padding: 20, overflow: 'hidden' },
  memberCardHighlight: { position: 'absolute', top: -50, right: -50, width: 180, height: 180, borderRadius: 90, backgroundColor: 'rgba(255,255,255,0.05)' },
  memberCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  memberCardBadge: { fontSize: 10, fontWeight: '700', color: '#D4A017', letterSpacing: 2 },
  memberCardSince: { fontSize: 10, color: 'rgba(255,255,255,0.45)' },
  memberCardName: { fontSize: 15, fontWeight: '600', color: '#FFFFFF' },
  memberCardBalanceLabel: { fontSize: 13, color: 'rgba(255,255,255,0.55)', marginBottom: 4 },
  memberCardBalance: { fontSize: 34, fontWeight: '600', color: '#FFFFFF' },
  memberCardCTA: { marginTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.12)', paddingTop: 12 },
  memberCardCTAText: { fontSize: 13, color: '#D4A017', fontWeight: '500' },
  benefitRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 20, gap: 14 },
  benefitText: { flex: 1, fontSize: 14, color: '#374151' },
  menuListCard: { marginHorizontal: 16, backgroundColor: '#FFFFFF', borderRadius: 16, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 2 },
  avatarRingGuest: { borderWidth: 1.5, borderColor: '#D1CFC9' },
  avatarInner: { width: 54, height: 54, borderRadius: 27, backgroundColor: '#EAB320', alignItems: 'center', justifyContent: 'center' },
  avatarInitials: { fontSize: 19, fontWeight: '600', color: '#FFFFFF' },
  profileName: { fontSize: 18, fontWeight: '600', color: '#1C1917', marginBottom: 10 },
  profileRewardsValue: { fontSize: 22, fontWeight: '700', color: '#1C1917', marginTop: 2 },
  profileRewardsSub: { fontSize: 11, color: '#9CA3AF' },
  memberLabel: { fontSize: 10, fontWeight: '700', color: '#D4A017', letterSpacing: 1.5 },
  memberSince: { fontSize: 10, color: '#9CA3AF' },
  rewardsRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 12 },
  useNowBtn: { marginTop: 8 },
  useNowText: { color: '#D4A017', fontSize: 13, fontWeight: '500' },
  menuSectionLabel: { fontSize: 10, fontWeight: '600', color: '#9CA3AF', letterSpacing: 1.5, paddingHorizontal: 20, marginBottom: 8, marginTop: 24 },

  // Non-member CTA
  memberCTACard: { marginHorizontal: 20, marginBottom: 20, borderRadius: 8, padding: 16, backgroundColor: '#FEF9EC', borderWidth: 1, borderColor: '#F0DFA0' },
  memberCTATitle: { fontSize: 14, fontWeight: '700', color: '#1C1917', marginBottom: 3 },
  memberCTASub: { fontSize: 12, color: '#92660A', marginBottom: 12 },
  memberCTABtn: { backgroundColor: '#EAB320', paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  memberCTABtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },


  menuList: { marginHorizontal: 0 },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 20 },
  menuItemBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#EEEBE4' },
  menuItemHighlight: { backgroundColor: '#FFFBF0' },
  menuTextWrap: { flex: 1, marginLeft: 14 },
  menuText: { fontSize: 15, color: '#1C1917' },
  menuSubText: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },
  earnMoreHint: { fontSize: 11, color: '#9CA3AF', marginTop: 4 },
  deleteAccountLink: { alignSelf: 'center', marginTop: 24, paddingVertical: 6 },
  deleteAccountLinkText: { fontSize: 13, fontWeight: '500' as const, color: '#C46B6B', letterSpacing: 0.1 },
  deleteAccountBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  deleteAccountCard: { width: '100%', backgroundColor: '#FFFFFF', borderRadius: 18, paddingVertical: 22, paddingHorizontal: 22 },
  deleteAccountTitle: { fontSize: 17, fontWeight: '600' as const, color: '#1C1917', marginBottom: 10 },
  deleteAccountBody: { fontSize: 13, color: '#4B5563', lineHeight: 19 },
  deleteAccountActions: { flexDirection: 'row', marginTop: 22, gap: 10 },
  deleteAccountCancel: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center', backgroundColor: '#F3F1EB' },
  deleteAccountCancelText: { fontSize: 15, fontWeight: '600' as const, color: '#1C1917' },
  deleteAccountConfirm: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center', backgroundColor: '#E05252' },
  deleteAccountConfirmText: { fontSize: 15, fontWeight: '600' as const, color: '#FFFFFF' },
  floatTabBar: { position: 'absolute', left: 32, right: 32, height: 76, borderRadius: 38, flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.82)', borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)', shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.08, shadowRadius: 18, elevation: 4 },
  floatTabItem: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  floatTabContent: { alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4 },
  floatTabIconWrap: { alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  floatTabIconWrapActive: {},
  floatTabLabel: { fontSize: 10, fontWeight: '500' as const, color: '#9CA3AF', marginTop: 2 },
  floatTabLabelActive: { color: '#CA8A04', fontWeight: '600' as const },
  floatTabBadge: { position: 'absolute', top: -3, right: -5, backgroundColor: '#EAB320', borderRadius: 8, minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  floatTabBadgeText: { color: 'white', fontSize: 9, fontWeight: '700' as const },
  // Product details collapsible
  specsSection: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#F3F4F6', paddingTop: 16, marginTop: 8 },
  specsSectionLabel: { fontSize: 11, fontWeight: '700', color: '#6B7280', letterSpacing: 0.8, textTransform: 'uppercase' as const, marginBottom: 10 },
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
  variantRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  imageVariantCard: { width: 64, height: 64, borderRadius: 8, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  imageVariantCardSelected: { borderColor: '#EAB320' },
  imageVariantCardDisabled: { opacity: 0.45 },
  imageVariantThumb: { width: '100%', height: '100%' },
  sizeBtnDisabled: { borderColor: '#E5E7EB', backgroundColor: '#F9FAFB' },
  sizeBtnTextDisabled: { color: '#D1D5DB', textDecorationLine: 'line-through' as const },
  stockOut: { fontSize: 12, fontWeight: '600' as const, color: '#DC2626', marginTop: 10 },
  stockLow: { fontSize: 12, fontWeight: '600' as const, color: '#D97706', marginTop: 10 },

  // Sticky action bar
  addToCartBtn: { flex: 1, height: 42, borderRadius: 6, borderWidth: 1.5, borderColor: '#EAB320', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  addToCartText: { fontSize: 13, fontWeight: '600', color: '#EAB320' },
  buyNowBtn: { flex: 1, height: 42, borderRadius: 6, backgroundColor: '#EAB320', alignItems: 'center', justifyContent: 'center' },
  buyNowText: { fontSize: 13, fontWeight: '600', color: '#FFFFFF' },
  ctaBtnDisabled: { borderColor: '#E5E7EB', backgroundColor: '#F3F4F6' },
  ctaBtnTextDisabled: { color: '#9CA3AF' },
  shareEarnRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#F3F4F6' },
  shareEarnLabel: { fontSize: 13, fontWeight: '600', color: '#CA8A04' },
  shareEarnSub: { fontSize: 11, color: '#9CA3AF', marginTop: 1 },
  toastBar: { position: 'absolute', left: 20, right: 20, backgroundColor: '#1C1917', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 12, elevation: 10, zIndex: 100 },
  toastText: { color: 'white', fontSize: 14, fontWeight: '500' },
  toastAction: { color: '#EAB320', fontSize: 14, fontWeight: '600' },
  dotsRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', position: 'absolute', bottom: 12, left: 0, right: 0, gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.5)' },
  dotActive: { backgroundColor: 'white', width: 18, borderRadius: 3 },
  dotVideo: { width: 10, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.7)' },
  videoPlayOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  videoPlayBtn: { width: 54, height: 54, borderRadius: 27, backgroundColor: 'rgba(0,0,0,0.42)', alignItems: 'center', justifyContent: 'center' },
  // PDP back control. Geometry copied from searchBackBtn (40/20); the surface is the
  // DESIGN.md floating-glass pill used by floatTabBar — semi-transparent warm white,
  // hairline border, soft shadow. That combination is what keeps a light chip legible
  // on dark product photography without resorting to a heavy black circle.
  // 40pt + 8pt hitSlop = 56pt touch target, matching the hitSlop convention already
  // used by Share here and by CollectionScreen's back button.
  detailBackBtn: {
    position: 'absolute', left: 16,
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.82)',
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)',
    shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.08, shadowRadius: 18,
    elevation: 4,
  },
  fbtSection: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  fbtTitle: { fontSize: 15, fontWeight: '600', color: '#1C1917', marginBottom: 14 },
  fbtRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  fbtImg: { width: 72, height: 72, borderRadius: 8, backgroundColor: '#F3F4F6' },
  fbtPlus: { fontSize: 16, color: '#9CA3AF', marginHorizontal: 8 },
  fbtInfoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fbtInfoMeta: { fontSize: 12, color: '#6B7280', marginBottom: 2 },
  fbtInfoPrice: { fontSize: 17, fontWeight: '700', color: '#1C1917' },
  fbtCta: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1.5, borderColor: '#1C1917' },
  fbtCtaText: { fontSize: 13, fontWeight: '600', color: '#1C1917' },
  recommendSection: { paddingTop: 8, paddingBottom: 16 },
  recommendTitle: { fontSize: 17, fontWeight: '600', color: '#1C1917', paddingHorizontal: 16, marginBottom: 12 },
  recommendList: { paddingLeft: 16, paddingRight: 8, gap: 12 },
  recommendCard: { width: 158, marginBottom: 0 },
  cartQtyControls: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cartQtyBtn: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' },
  cartQtyText: { fontSize: 13, fontWeight: '600', color: '#1C1917', minWidth: 28, textAlign: 'center', padding: 0 },
  cartSaveText: { fontSize: 11, color: '#9CA3AF', marginTop: 6 },
  savedSection: { marginHorizontal: 12, marginTop: 12, marginBottom: 4 },
  savedSectionTitle: { fontSize: 13, fontWeight: '600', color: '#6B7280', marginBottom: 8, paddingHorizontal: 2 },
  savedItem: { flexDirection: 'row', backgroundColor: '#F9F8F6', borderRadius: 6, padding: 10, marginBottom: 6, gap: 10 },
  savedItemImg: { width: 60, height: 60, borderRadius: 6, backgroundColor: '#EDEDEB' },
  savedItemInfo: { flex: 1 },
  savedItemName: { fontSize: 12, fontWeight: '500', color: '#1C1917', lineHeight: 16, marginBottom: 4 },
  savedItemPrice: { fontSize: 13, fontWeight: '700', color: '#1C1917', marginBottom: 8 },
  savedItemActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  savedMoveBtn: { backgroundColor: '#EAB320', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 5 },
  savedMoveBtnText: { fontSize: 11, fontWeight: '700', color: 'white' },
  savedRemoveText: { fontSize: 11, color: '#9CA3AF' },

  signInWrap: { paddingBottom: 48 },
  signInLogoWrap: { alignItems: 'center', paddingTop: 64, paddingBottom: 20 },
  signInLogo: { width: 140, height: 140, opacity: 0.9 },
  signInCard: { padding: 24, marginHorizontal: 24, backgroundColor: '#FFFFFF', borderRadius: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 12, elevation: 2 },
  signInTitle: { fontSize: 22, fontWeight: '700', color: '#111827' },
  signInSubtitle: { fontSize: 14, color: '#6B7280', marginTop: 8, lineHeight: 20 },
  signInInputRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#F3F4F6', borderRadius: 8, paddingHorizontal: 14, marginTop: 16 },
  signInInput: { flex: 1, paddingVertical: 12, fontSize: 15, color: '#1C1917' },
  signInFinePrint: { fontSize: 11, color: '#9CA3AF', marginTop: 12, lineHeight: 16 },
  signInError: { fontSize: 12, color: '#DC2626', marginTop: 8, marginBottom: 2 },
  configWarning: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, backgroundColor: '#FEF3C7', borderRadius: 6, padding: 10, marginTop: 10 },
  configWarningText: { fontSize: 12, color: '#92400E', flex: 1, lineHeight: 16 },
  signInDivider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, marginBottom: 2 },
  signInDividerLine: { flex: 1, height: 1, backgroundColor: '#E5E7EB' },
  signInDividerText: { fontSize: 12, color: '#9CA3AF', fontWeight: '500' },
  guestBtn: { paddingVertical: 13, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: '#E5E7EB', marginTop: 10 },
  guestBtnText: { fontSize: 15, fontWeight: '600', color: '#374151' },

  otpBoxRow: { flexDirection: 'row', gap: 8, marginTop: 20, marginBottom: 4 },
  otpBox: { flex: 1, aspectRatio: 1, borderRadius: 8, borderWidth: 1, borderColor: '#E8E5DF', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FAFAF9' },
  otpBoxFilled: { borderColor: '#403F3D', borderWidth: 1.5, backgroundColor: '#FFFFFF' },
  otpBoxActive: { borderColor: '#EAB320', borderWidth: 1.5, backgroundColor: '#FFFDF5' },
  otpBoxError: { borderColor: '#DC2626', borderWidth: 1.5, backgroundColor: '#FEF2F2' },
  otpBoxText: { fontSize: 17, fontWeight: '600', color: '#403F3D' },
  otpHiddenInput: { position: 'absolute', width: 0, height: 0, opacity: 0 },
  otpActionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16 },
  otpActionText: { fontSize: 13, color: '#6B7280', fontWeight: '500' },
  otpActionTextDim: { color: '#D1D5DB' },
  otpActionSep: { fontSize: 13, color: '#D1D5DB' },
  otpSpamHint: { fontSize: 12, color: '#9CA3AF', textAlign: 'center', marginTop: 12, lineHeight: 17 },

  guestIdentity: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 28, paddingBottom: 20 },
  guestAvatarWrap: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#FEF9EC', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  guestTitle: { fontSize: 20, fontWeight: '600', color: '#1C1917', textAlign: 'center', marginBottom: 8 },
  guestSub: { fontSize: 14, color: '#6B7280', textAlign: 'center', lineHeight: 20, marginBottom: 4 },
  guestNote: { fontSize: 12, color: '#9CA3AF', textAlign: 'center', marginTop: 12 },

  accountFooter: { textAlign: 'center', fontSize: 12, color: '#C4C0BA', marginTop: 14, marginBottom: 8 },
  accountFooterLink: { color: '#8E8A82' },

  primaryBtn: { backgroundColor: '#F4B740', height: 58, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 14 },
  primaryBtnText: { color: 'white', fontSize: 15, fontWeight: '700' },
  secondaryBtn: { paddingVertical: 12, alignItems: 'center' },
  secondaryBtnText: { color: '#1C1917', fontSize: 14, fontWeight: '600' },

  cartEmptyCard: { marginHorizontal: 20, marginTop: 16, backgroundColor: '#FFFFFF', borderRadius: 20, padding: 30, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.07, shadowRadius: 8, elevation: 2 },
  cartEmptyIconWrap: { width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(202,138,4,0.10)', alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  cartEmptyHeroTitle: { fontSize: 22, fontWeight: '700', color: '#1C1917', marginBottom: 8, textAlign: 'center' },
  cartEmptyHeroSub: { fontSize: 14, color: '#6B7280', lineHeight: 21, marginBottom: 24, textAlign: 'center' },
  cartEmptyBrowseBtn: { backgroundColor: '#EAB320', height: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch', shadowColor: '#EAB320', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.28, shadowRadius: 8, elevation: 4 },
  cartEmptyBrowseBtnText: { color: 'white', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  cartEmptyTrending: { paddingTop: 28, paddingLeft: 16 },
  cartEmptyTrendingHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: 16, marginBottom: 14 },
  cartEmptyTrendingTitle: { fontSize: 16, fontWeight: '600', color: '#1C1917' },
  cartEmptyTrendingLink: { fontSize: 13, color: '#CA8A04', fontWeight: '500' },
  cartKeepBtn: { paddingVertical: 10, alignItems: 'center' },
  cartKeepBtnText: { color: '#6B7280', fontSize: 14, fontWeight: '500' },

  searchPlaceholder: { color: '#9CA3AF', fontSize: 15 },


  searchPhotoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 14, marginBottom: 10, padding: 12, borderRadius: 16, backgroundColor: 'white', shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.06, shadowRadius: 14, elevation: 4 },
  searchPhotoThumb: { width: 44, height: 44, borderRadius: 8, backgroundColor: '#F3F4F6' },
  searchPhotoTitle: { fontSize: 13, fontWeight: '700', color: '#1C1917' },
  searchPhotoSub: { fontSize: 12, color: '#6B7280', marginTop: 2 },

  // Wayfair-style compact pill search (shared)
  searchPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 999, height: 44, paddingLeft: 14, paddingRight: 8, marginHorizontal: 16, marginTop: 8, marginBottom: 4, gap: 8, borderWidth: 1, borderColor: 'rgba(0,0,0,0.07)' },
  homeWordmark: { fontFamily: Platform.select({ ios: 'Georgia', default: 'serif' }), fontSize: 26, lineHeight: 31, fontWeight: '600', color: '#1C1917', marginHorizontal: 16, marginTop: 2, marginBottom: 6 },
  homeSearchPill: { marginHorizontal: 6, height: 56, borderRadius: 20 },
  searchPillPlaceholder: { flex: 1, color: '#9CA3AF', fontSize: 15 },
  searchPillInput: { flex: 1, paddingVertical: 0, fontSize: 15, color: '#1C1917' },
  searchPillCamBtn: { paddingLeft: 10, paddingRight: 4, paddingVertical: 6, alignItems: 'center', justifyContent: 'center' },

  searchTopBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingTop: 6, paddingBottom: 6, gap: 10 },
  searchBackBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  searchPillHeader: { flex: 1, marginHorizontal: 0, marginTop: 0, marginBottom: 0 },
  searchPillDivider: { width: 1, height: 18, backgroundColor: '#E5E7EB' },


  // Message Seller row
  messageSellerRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 13, borderTopWidth: 1, borderTopColor: '#F3F4F6',
  },
  messageSellerLabel: { fontSize: 13, fontWeight: '600', color: '#1C1917', lineHeight: 18 },
  messageSellerSub: { fontSize: 11, color: '#9CA3AF', marginTop: 1, lineHeight: 15 },
  availabilityHint: { fontSize: 12, color: '#6B7280', marginTop: 5 },
  floatCta: {
    position: 'absolute', bottom: 24, left: 24, right: 24,
    alignItems: 'center',
  },
  floatCtaBtn: {
    backgroundColor: '#EAB320', borderRadius: 24,
    paddingHorizontal: 32, paddingVertical: 13,
    shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  floatCtaBtnText: { fontSize: 15, fontWeight: '600', color: '#FFFFFF' },
  msgFabWrap: {
    position: 'absolute', bottom: 90, right: 20,
    width: 58, height: 58, borderRadius: 29,
    backgroundColor: '#EAB320',
    shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  msgFabBtn: {
    width: '100%', height: '100%',
    alignItems: 'center', justifyContent: 'center',
  },
  msgFabLabel: {
    position: 'absolute', bottom: 148, right: 20,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)',
    borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5,
    shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  msgFabLabelText: { fontSize: 12, fontWeight: '500', color: '#6B7280' },

  handleBar: {
    width: 36, height: 4, backgroundColor: '#C8C6BF', borderRadius: 2,
    alignSelf: 'center', marginBottom: 12,
  },

  // ZIP check modal
  zipOverlay: { flex: 1, backgroundColor: 'rgba(64,63,61,0.4)', justifyContent: 'flex-end' },
  zipPanel: { backgroundColor: '#F3F1EB', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 24, paddingBottom: 36 },
  zipPanelTitle: { fontSize: 16, fontWeight: '600', color: '#1C1917', marginBottom: 6 },
  zipPanelSub: { fontSize: 13, color: '#6B7280', marginBottom: 16 },
  zipInputField: {
    backgroundColor: '#FFFFFF', borderRadius: 8, borderWidth: 1, borderColor: '#E5E3DC',
    paddingHorizontal: 14, paddingVertical: 11, fontSize: 16, color: '#1C1917', letterSpacing: 2,
  },
  zipCheckBtn: { backgroundColor: '#EAB320', borderRadius: 8, height: 46, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  zipCheckBtnDisabled: { opacity: 0.4 },
  zipCheckBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
});
