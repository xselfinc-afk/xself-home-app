/**
 * Source of truth: /NORMALIZATION_ENGINE.md
 * All product title, features, description, specifications, image, and family logic must follow this file.
 * Do NOT add UI-side cleaning or formatting logic.
 */

import SupplierProductsScreen from './src/screens/SupplierProductsScreen';
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View, Text, ScrollView, TouchableOpacity, Image, TextInput, FlatList, StyleSheet, SafeAreaView, StatusBar, Share, Alert, Dimensions, Animated, ActivityIndicator, KeyboardAvoidingView, Platform, Modal, Linking, LayoutAnimation, UIManager } from 'react-native';
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import ProductCard from './src/components/ProductCard';
import { NavigationContainer, useNavigationState } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { products, Product, ProductVariant, MediaItem, formatPrice } from './src/data/products';
import { loadProductFamily } from './src/services/productFamilyService';
import { matchesCategory, normalizeForSkuMatch, matchesSearch } from './src/data/categories';
import { HeroBanner } from './src/components/HeroBanner';
import { selectHeroImage } from './src/utils/heroImageSelector';
import { loadHomeSectionTitles, HomeSectionTitles } from './src/services/homeContentService';
import { CartProvider, useCart, CartItem } from './src/context/CartContext';
import { CartAnimProvider, useCartAnimation } from './src/context/CartAnimationContext';
import { RewardsProvider, useRewards, getReferralLink } from './src/context/RewardsContext';
import { RecommendationProvider, useRecommendations, diversify } from './src/context/RecommendationContext';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { OrdersProvider } from './src/context/OrdersContext';
import { ConversationProvider, useConversations } from './src/context/ConversationContext';
import InboxScreen from './src/screens/InboxScreen';
import ChatScreen from './src/screens/ChatScreen';
import ProductConversationScreen from './src/screens/ProductConversationScreen';
import { supabase, supabaseConfigured } from './src/lib/supabase';
import { adaptStandardizedRow } from './src/services/detailProductAdapter';
import { isGoodFitForFeatured } from './src/services/imageRatioCache';
import OrdersScreen from './src/screens/OrdersScreen';
import EarnScreen from './src/screens/EarnScreen';
import CheckoutScreen from './src/screens/CheckoutScreen';
import OrderSuccessScreen from './src/screens/OrderSuccessScreen';
import CollectionScreen from './src/screens/CollectionScreen';
import { getCachedDelivery } from './src/utils/deliveryEligibility';
import DiscoverScreen from './src/screens/DiscoverScreen';
import ReviewSection from './src/components/ReviewSection';
import SearchPillBar from './src/components/SearchPillBar';
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
      ? await ImagePicker.launchCameraAsync({ quality: 0.8 })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.8 });

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
 * Sends the image at `uri` to Claude Haiku vision and returns 2–3 furniture
 * search keywords suitable for feeding into matchesSearch().
 * Returns '' if the API key is missing or the call fails.
 */
async function extractImageKeywords(uri: string): Promise<string> {
  const apiKey = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY ?? '';
  if (!apiKey) {
    console.warn('[ImageSearch] EXPO_PUBLIC_ANTHROPIC_API_KEY not set — image search disabled');
    return '';
  }

  try {
    const { base64, mimeType } = await uriToBase64(uri);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 64,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: base64 },
            },
            {
              type: 'text',
              text: 'Identify the furniture or home decor item in this image. Return ONLY 2–3 search keywords that would find similar products in a furniture catalog. Focus on: item type, color, and material if visible. Examples: "white dresser", "modern TV stand", "wood dining chair", "blue sofa". Return ONLY the keywords as a short phrase, nothing else.',
            },
          ],
        }],
      }),
    });

    if (!res.ok) {
      console.warn('[ImageSearch] API error:', res.status);
      return '';
    }

    const data = await res.json();
    const keywords = data?.content?.[0]?.text?.trim() ?? '';
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function SignInEntryScreen({ navigation }) {
  const { sendOtp, verifyOtp, continueAsGuest } = useAuth();
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'email' | 'otp'>('email');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailKey, setEmailKey] = useState(0);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [otpError, setOtpError] = useState(false);

  const emailValid = EMAIL_RE.test(email.trim());
  const otpRef = useRef<any>(null);
  const scrollRef = useRef<ScrollView>(null);
  const stepAnim = useRef(new Animated.Value(1)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const cooldownRef = useRef<any>(null);

  // Clear cooldown interval on unmount
  useEffect(() => {
    return () => { if (cooldownRef.current) clearInterval(cooldownRef.current); };
  }, []);

  // Focus hidden OTP input when step becomes 'otp' (after fade-in completes)
  useEffect(() => {
    if (step === 'otp') {
      const t = setTimeout(() => otpRef.current?.focus(), 320);
      return () => clearTimeout(t);
    }
  }, [step]);

  const startCooldown = (seconds = 30) => {
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    setResendCooldown(seconds);
    cooldownRef.current = setInterval(() => {
      setResendCooldown(prev => {
        if (prev <= 1) { clearInterval(cooldownRef.current); cooldownRef.current = null; return 0; }
        return prev - 1;
      });
    }, 1000);
  };

  const fadeTransition = (callback: () => void) => {
    Animated.timing(stepAnim, { toValue: 0, duration: 140, useNativeDriver: true }).start(() => {
      callback();
      Animated.timing(stepAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    });
  };

  const shakeOtp = () => {
    setOtpError(true);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -7, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 7, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start(() => setTimeout(() => setOtpError(false), 1600));
  };

  const handleContinue = async () => {
    if (!emailValid || loading) return;
    setLoading(true);
    setError(null);
    const { error: err } = await sendOtp(email.trim().toLowerCase());
    setLoading(false);
    if (err) { setError('Failed to send email. Try again.'); return; }
    startCooldown(30);
    fadeTransition(() => setStep('otp'));
  };

  const handleVerify = async () => {
    if (otp.length < 6 || loading) return;
    setLoading(true);
    setError(null);
    const { error: err } = await verifyOtp(email.trim().toLowerCase(), otp);
    setLoading(false);
    if (err) { setError('Invalid or expired code. Please try again.'); shakeOtp(); return; }
    navigation.replace('Main');
  };

  const handleResend = async () => {
    if (loading || resendCooldown > 0) return;
    setLoading(true);
    setError(null);
    const { error: err } = await sendOtp(email.trim().toLowerCase());
    setLoading(false);
    startCooldown(30); // always re-enter cooldown — success or fail
    if (err) {
      setError("We couldn't send a new code right now. Please wait a moment and try again.");
    }
  };

  const handleChangeEmail = () => {
    fadeTransition(() => {
      setEmail('');
      setOtp('');
      setError(null);
      setLoading(false);
      setOtpError(false);
      setStep('email');
      setEmailKey(k => k + 1);
    });
  };

  const handleGuest = () => {
    continueAsGuest();
    navigation.replace('Main');
  };

  const stepTitle = step === 'email' ? 'Sign in to Xself Home' : 'Check your email';
  const stepSubtitle = step === 'email'
    ? 'Save favorites, track orders, and unlock member rewards.'
    : `We sent a 6-digit code to\n${email.trim().toLowerCase()}`;

  return (
    <View style={{ flex: 1 }}>
      {/* Full-screen background image */}
      <Image
        source={{ uri: 'https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=1200' }}
        style={StyleSheet.absoluteFillObject}
        resizeMode="cover"
      />
      {/* Teal overlay — 50% opacity so image stays visible */}
      <View style={[StyleSheet.absoluteFillObject, { backgroundColor: '#0F766E', opacity: 0.48 }]} />
      <SafeAreaView style={{ flex: 1 }}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.signInWrap}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Logo above card */}
          <View style={styles.signInLogoWrap}>
            <Image source={require('./assets/splash-clean.png')} style={styles.signInLogo} resizeMode="contain" />
          </View>

          <View style={styles.signInCard}>
            <Animated.View style={{ opacity: stepAnim }}>
              <Text style={styles.signInTitle}>{stepTitle}</Text>
              <Text style={styles.signInSubtitle}>{stepSubtitle}</Text>

              {step === 'email' ? (
                <>
                  {!supabaseConfigured && __DEV__ && (
                    <View style={styles.configWarning}>
                      <Ionicons name="warning-outline" size={13} color="#92400E" />
                      <Text style={styles.configWarningText}>
                        Add credentials to .env and restart: npx expo start --clear
                      </Text>
                    </View>
                  )}

                  <View style={[styles.signInInputRow, !supabaseConfigured && { opacity: 0.4 }]}>
                    <Ionicons name="mail-outline" size={18} color="#6B7280" />
                    <TextInput
                      key={emailKey}
                      style={styles.signInInput}
                      placeholder="Email address"
                      placeholderTextColor="#9CA3AF"
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="email-address"
                      editable={supabaseConfigured}
                      value={email}
                      onChangeText={t => { setEmail(t); setError(null); }}
                      returnKeyType="done"
                      onSubmitEditing={handleContinue}
                    />
                  </View>

                  {supabaseConfigured && error ? (
                    <Text style={styles.signInError}>{error}</Text>
                  ) : null}

                  <TouchableOpacity
                    style={[styles.primaryBtn, (!emailValid || loading || !supabaseConfigured) && { opacity: 0.4 }]}
                    onPress={handleContinue}
                    disabled={!emailValid || loading || !supabaseConfigured}
                  >
                    {loading
                      ? <ActivityIndicator color="white" size="small" />
                      : <Text style={styles.primaryBtnText}>Continue</Text>}
                  </TouchableOpacity>

                  <View style={styles.signInDivider}>
                    <View style={styles.signInDividerLine} />
                    <Text style={styles.signInDividerText}>or</Text>
                    <View style={styles.signInDividerLine} />
                  </View>

                  <TouchableOpacity onPress={handleGuest} style={styles.guestBtn}>
                    <Text style={styles.guestBtnText}>Continue as Guest</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  {/* 6-slot segmented OTP display */}
                  <Animated.View style={[styles.otpBoxRow, { transform: [{ translateX: shakeAnim }] }]}>
                    {Array.from({ length: 6 }).map((_, i) => {
                      const isFilled = i < otp.length;
                      const isActive = i === otp.length && !loading;
                      return (
                        <TouchableOpacity
                          key={i}
                          activeOpacity={1}
                          onPress={() => otpRef.current?.focus()}
                          style={[
                            styles.otpBox,
                            isFilled && styles.otpBoxFilled,
                            !isFilled && isActive && styles.otpBoxActive,
                            otpError && styles.otpBoxError,
                          ]}
                        >
                          <Text style={styles.otpBoxText}>{otp[i] ?? ''}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </Animated.View>

                  {/* Hidden input captures keyboard typing, paste, and iOS autofill */}
                  <TextInput
                    ref={otpRef}
                    value={otp}
                    onChangeText={t => {
                      const digits = t.replace(/\D/g, '').slice(0, 6);
                      // Accept a full 6-digit autofill, or incremental changes of ±1 digit
                      // (normal typing/backspace). Reject drastic drops to avoid false
                      // state from a failed/partial iOS suggestion tap.
                      if (digits.length === 6 || Math.abs(digits.length - otp.length) <= 1) {
                        setOtpError(false);
                        setError(null);
                        setOtp(digits);
                      }
                    }}
                    onFocus={() => {
                      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
                    }}
                    keyboardType="number-pad"
                    textContentType="oneTimeCode"
                    autoComplete="sms-otp"
                    maxLength={6}
                    style={styles.otpHiddenInput}
                    caretHidden
                  />

                  {error ? <Text style={styles.signInError}>{error}</Text> : null}

                  <TouchableOpacity
                    style={[styles.primaryBtn, (otp.length < 6 || loading) && { opacity: 0.4 }]}
                    onPress={handleVerify}
                    disabled={otp.length < 6 || loading}
                  >
                    {loading
                      ? <ActivityIndicator color="white" size="small" />
                      : <Text style={styles.primaryBtnText}>Verify</Text>}
                  </TouchableOpacity>

                  <View style={styles.otpActionRow}>
                    <TouchableOpacity
                      onPress={handleResend}
                      disabled={loading || resendCooldown > 0}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Text style={[styles.otpActionText, (loading || resendCooldown > 0) && styles.otpActionTextDim]}>
                        {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
                      </Text>
                    </TouchableOpacity>
                    <Text style={styles.otpActionSep}>·</Text>
                    <TouchableOpacity
                      onPress={handleChangeEmail}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Text style={styles.otpActionText}>Change email</Text>
                    </TouchableOpacity>
                  </View>

                  <Text style={styles.otpSpamHint}>Didn't get it? Check spam or promotions first.</Text>
                </>
              )}

              <Text style={styles.signInFinePrint}>
                By continuing, you agree to our Terms and Privacy Policy.
              </Text>
            </Animated.View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
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
  const renderStartRef = useRef(Date.now());
  const heroSeenRef = useRef<{ productIds: string[]; categories: string[] }>({
    productIds: [],
    categories: [],
  });

  const { scoreProduct, trackClick } = useRecommendations();

  useEffect(() => {
    loadHomeSectionTitles().then(setSectionTitles);
  }, []);

  useEffect(() => {
    let active = true;
    async function loadProducts() {
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

      console.log('[Home] query done — error:', error?.message ?? null, '| rows:', data?.length ?? 0);
      if (error || !data || !active) return;
      if (__DEV__ && data[0]) {
        const r0 = data[0] as any;
        console.log('[Home] first raw row titles:', { optimized_title: r0.optimized_title, product_title_display: r0.product_title_display, product_title: r0.product_title });
      }

      const mapped: Product[] = (data as any[]).flatMap((r: any) => {
        try { return [adaptStandardizedRow(r)]; }
        catch (e) {
          if (__DEV__) console.warn('[Home] adaptStandardizedRow failed for row', (r as any)?.supplier_product_id, e);
          return [];
        }
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
      const deduped = mapped.filter(p => representativeIds.has(p.id));
      console.log('[Home] total mapped products:', deduped.length);
      if (__DEV__ && deduped[0]) console.log('[Home] first mapped product name:', deduped[0].name);
      if (active) setAllProducts(deduped);
    }
    loadProducts();
    return () => { active = false; };
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

  // Best hero image — anti-repeat + light randomness from top-3 candidates
  const heroImageResult = useMemo(() => {
    const seen = heroSeenRef.current;
    const opts = {
      excludeProductIds: seen.productIds,
      excludeCategories: seen.categories,
      randomizeTopN: 3,
    };
    const result =
      selectHeroImage(withImages, { ...opts, preferredCategory: 'Living Room' }) ??
      selectHeroImage(withImages, { ...opts, preferredCategory: 'Dining & Kitchen' }) ??
      selectHeroImage(withImages, { ...opts, preferredCategory: 'Storage' }) ??
      selectHeroImage(withImages, { randomizeTopN: 5 });

    if (result) {
      if (result.productId) seen.productIds = [...seen.productIds, result.productId];
      if (result.category)  seen.categories = [...seen.categories, result.category];
    }
    return result;
  }, [withImages]);

  // Max discount % across all products with a valid original price — drives hero subtitle
  const maxDiscount = useMemo(() => {
    let best = 0;
    for (const p of withImages) {
      if (p.originalPrice && p.originalPrice > p.price) {
        const pct = Math.round(((p.originalPrice - p.price) / p.originalPrice) * 100);
        if (pct > best) best = pct;
      }
    }
    return best;
  }, [withImages]);

  const HomeHeader = (
    <>
      {/* Search pill */}
      <SearchPillBar
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
        <Text style={styles.searchPillPlaceholder}>Search Xself</Text>
      </SearchPillBar>

      {/* Hero banner */}
      <HeroBanner
        variant="TEXT_LEFT"
        title="Spring Sale"
        subtitle={maxDiscount > 0 ? `Up to ${maxDiscount}% Off Selected Furniture` : 'Up to 30% Off Selected Furniture'}
        ctaText="Shop Deals"
        image={heroImageResult?.uri}
        imagePosition={heroImageResult?.position ?? 'right'}
        useSoftBlur={false}
        onPress={() => navigation.navigate('Collection', { key: 'spring-sale' })}
      />

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
        onEndReached={() => setDisplayCount(c => Math.min(c + 20, rankedProducts.length))}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={() => (
          <View style={{ alignItems: 'center', paddingVertical: 40 }}>
            <Text style={{ fontSize: 14, color: '#9CA3AF' }}>No products available yet</Text>
          </View>
        )}
        ListFooterComponent={() => (
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
                            source={{ uri: imageUri }}
                            style={{ width: circleSize, height: circleSize }}
                            resizeMode="contain"
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
        )}
      />
    </View>
  );
}


function defaultCartItem(product: any): Omit<CartItem, 'qty'> {
  const firstVariant = product.variants?.find((v: ProductVariant) => v.enabled && v.stock > 0);
  if (firstVariant) {
    return {
      sku: firstVariant.sku,
      productId: product.id,
      name: product.name,
      price: firstVariant.price,
      img: firstVariant.images[0] ?? product.images[0],
      color: firstVariant.color,
      size: firstVariant.size,
    };
  }
  return {
    sku: `product-${product.id}`,
    productId: product.id,
    name: product.name,
    price: product.price,
    img: product.images[0],
    color: '',
    size: '',
  };
}

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
              <Image source={{ uri: v.uri }} style={[styles.imageVariantThumb, v.disabled ? { opacity: 0.3 } : undefined]} resizeMode="cover" />
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
      {open && rows.map((row, i) => (
        <View key={row.label} style={[styles.specRow, i === rows.length - 1 && { borderBottomWidth: 0 }]}>
          <Text style={styles.specLabel}>{row.label}</Text>
          <Text style={styles.specValue}>{formatSpecValue(row.label, row.value)}</Text>
        </View>
      ))}
    </View>
  );
}

function ProductDetailScreen({ route, navigation }) {
  const { product: initialProduct, product_family_key } = route.params;
  const insets = useSafeAreaInsets();

  // product is state so the family loader can upgrade it to multi-variant
  const [product, setProduct] = useState<Product>(initialProduct);

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

  // Track product view (weight 1)
  React.useEffect(() => { trackView(product.id); }, [product.id]);

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
  React.useEffect(() => {
    if (!product_family_key) return;
    loadProductFamily(product_family_key).then(fullProduct => {
      if (!fullProduct) return;
      setProduct(fullProduct);
      setActiveImage(0);
      carouselRef.current?.scrollTo({ x: 0, animated: false });
    });
  }, [product_family_key]);

  // Derived: resolved SKU
  const selectedVariant: ProductVariant | null = hasVariants
    ? (product.variants.find((v: ProductVariant) =>
        v.color === selectedColor && v.size === selectedSize
      ) ?? null)
    : null;

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
  const savings = displayCompare ? displayCompare - displayPrice : 0;

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
    if (hasVariants && selectedVariant) {
      addItem({
        sku: selectedVariant.sku,
        productId: product.id,
        name: product.name,
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
    navigation.navigate('Checkout', { mode: 'buy_now', product, qty, selectedVariant: selectedVariant ?? null });
  };

  const handleShare = async () => {
    try {
      await Share.share({ message: `Check out ${product.name} - $${displayPrice} on Xself Home!` });
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
  const fbt = relatedProducts.slice(0, 2);

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
        contentContainerStyle={{ paddingBottom: 130 }}
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
                    source={{ uri: item.thumbnail ?? '' }}
                    style={{ width: screenWidth, aspectRatio: 4 / 5 }}
                    resizeMode="cover"
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
                  source={{ uri: item.url }}
                  style={{ width: screenWidth, aspectRatio: 4 / 5 }}
                  resizeMode="cover"
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
            <Text style={[styles.detailName, { flex: 1 }]} numberOfLines={3}>{product.displayTitle ?? product.name}</Text>
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
          <View style={styles.detailRating}>
            <Text style={styles.detailStars}>★ {product.rating ?? 4.5}</Text>
            <Text style={styles.detailReviews}>({product.reviewCount ?? 0} reviews)</Text>
          </View>
          {(() => {
            const cached = getCachedDelivery();
            const mode = cached?.eligibility.mode;
            const hint = mode === 'PICKUP' ? 'Pickup available' : mode === 'SHIPPING' ? 'Shipping available' : 'Pickup & shipping available';
            return <Text style={styles.availabilityHint}>{hint}</Text>;
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
            const hasMigrated = !!(product.features?.length);
            const safeDesc: string = product.desc ?? '';
            const fs: string[] = hasMigrated
              ? product.features!
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
            {product.specs
              ? (() => {
                  const groupMap = new Map<string, { label: string; value: string }[]>();
                  product.specs!.forEach(spec => {
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
                    product.tags?.material?.length ? { label: 'Material', value: product.tags.material.map((m: string) => m.replace(/-/g, ' ')).join(', ') } : null,
                    { label: 'Weight', value: (product as any).weight ?? '—' },
                    { label: 'Brand', value: 'Xselfhome' },
                    { label: 'SKU', value: product.variants?.[0]?.sku ?? 'XSF-XXXX' },
                  ].filter(Boolean) as { label: string; value: string }[];
                  return (
                    <View>
                      {fallback.map((row, i) => (
                        <View key={row.label} style={[styles.specRow, i === fallback.length - 1 && { borderBottomWidth: 0 }]}>
                          <Text style={styles.specLabel}>{row.label}</Text>
                          <Text style={styles.specValue}>{formatSpecValue(row.label, row.value)}</Text>
                        </View>
                      ))}
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
                style={[styles.addToCartBtn, isOutOfStock && styles.ctaBtnDisabled]}
                disabled={isOutOfStock}
                activeOpacity={0.85}
                onPress={() => {
                  if (isOutOfStock) return;
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
                <Text style={[styles.addToCartText, isOutOfStock && styles.ctaBtnTextDisabled]}>
                  {addedPermanent ? 'View Cart' : added ? 'Added \u2713' : 'Add to Cart'}
                </Text>
              </TouchableOpacity>
            </Animated.View>
            <TouchableOpacity
              style={[styles.buyNowBtn, isOutOfStock && styles.ctaBtnDisabled]}
              disabled={isOutOfStock}
              onPress={handleBuyNow}
            >
              <Text style={[styles.buyNowText, isOutOfStock && styles.ctaBtnTextDisabled]}>
                {isOutOfStock ? 'Unavailable' : 'Buy Now'}
              </Text>
            </TouchableOpacity>
          </View>

        </View>

        {/* Reviews */}
        <ReviewSection product={product} />

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
                  <Image source={{ uri: product.images[0] }} style={styles.fbtImg} />
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
                      <Image source={{ uri: p.images[0] }} style={styles.fbtImg} />
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
                  addItem(defaultCartItem(product), 1);
                  fbt.forEach(p => addItem(defaultCartItem(p), 1));
                  setBundleAdded(true);
                  setTimeout(() => setBundleAdded(false), 1000);
                }}
              >
                <Text style={styles.fbtCtaText}>{bundleAdded ? 'Added \u2713' : 'Add Bundle \u2192'}</Text>
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

      {/* Floating CTA — fades in after 30% scroll */}
      <Animated.View
        style={[
          styles.floatCta,
          {
            opacity: floatCtaAnim,
            transform: [{ translateY: floatCtaAnim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
          },
        ]}
        pointerEvents="box-none"
      >
        <TouchableOpacity
          style={[styles.floatCtaBtn, isOutOfStock && styles.ctaBtnDisabled]}
          disabled={isOutOfStock}
          activeOpacity={0.88}
          onPress={() => {
            if (isOutOfStock) return;
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
            {isOutOfStock ? 'Unavailable' : addedPermanent ? 'View Cart' : added ? 'Added \u2713' : 'Add to Cart'}
          </Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Messages FAB label — fades out after 2.5s */}
      <Animated.View style={[styles.msgFabLabel, { opacity: msgLabelAnim }]} pointerEvents="none">
        <Text style={styles.msgFabLabelText}>Need Help?</Text>
      </Animated.View>

      {/* Messages FAB — bottom-right, above Add to Cart */}
      <Animated.View style={[styles.msgFabWrap, { transform: [{ scale: msgFabScale }] }]}>
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
            if (!user) { navigation.navigate('SignInEntry'); return; }
            navigation.navigate('ProductConversation', {
              productId: product.id,
              productFamilyKey: product.product_family_key,
              productName: product.name,
              price: displayPrice,
              primaryImage: product.images[0] ?? '',
              selectedColor,
              sku: selectedVariant?.sku ?? product.variants?.[0]?.sku ?? '',
            });
          }}
        >
          <Ionicons name="chatbubble-ellipses" size={21} color="#CA8A04" />
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
  const [searchPool, setSearchPool] = useState<Product[]>([]);
  const [generatedQuery, setGeneratedQuery] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadPool() {
      const { data, error } = await supabase
        .from('sellable_products')
        .select(
          'id, supplier_product_id, product_title, product_title_display, optimized_title, short_description, ' +
          'key_features_json, specifications_json, sku_custom, sku_search, ' +
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

      // Family dedup — same rule as Home/Discover
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
      if (active) setSearchPool(mapped.filter(p => representativeIds.has(p.id) && p.images.length > 0));
    }
    loadPool();
    return () => { active = false; };
  }, []);

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
      if (__DEV__) {
        console.log('[ImageSearch] generated query:', JSON.stringify(keywords));
        console.log('[ImageSearch] result count:', searchPool.filter(p => matchesSearch(p, keywords)).length);
      }
    });
    return () => { cancelled = true; };
  }, [imageUri]);

  const activeQuery = imageUri ? generatedQuery : query;
  const textResults = isAnalyzing ? [] : searchPool.filter(p => matchesSearch(p, activeQuery));

  if (__DEV__ && !imageUri) {
    const qNorm = normalizeForSkuMatch(query);
    console.log('[HomeSearch] raw query:', JSON.stringify(query));
    console.log('[HomeSearch] normalized query:', JSON.stringify(qNorm));
    console.log('[HomeSearch] shared search reused from Discover: true');
    console.log('[HomeSearch] result count:', textResults.length);
  }

  const results = textResults;

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

      <FlatList
        data={results}
        keyExtractor={(item) => String(item.id)}
        numColumns={2}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 0 }}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.productCard} onPress={() => navigation.navigate('ProductDetail', { product: item })}>
            <Image source={{ uri: item.images[0] }} style={styles.productImage} resizeMode="cover" />
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
            </View>
          </TouchableOpacity>
        )}
      />
    </SafeAreaView>
  );
}

function SplashOverlay({ opacity }: { opacity: Animated.Value }) {
  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFillObject,
        { backgroundColor: '#0F766E', alignItems: 'center', justifyContent: 'center', opacity },
      ]}
    >
      <Image
        source={require('./assets/splash-clean.png')}
        style={{ width: 160, height: 160, transform: [{ translateY: -40 }] }}
        resizeMode="contain"
      />
    </Animated.View>
  );
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
  const { cart, updateQty, removeItem, addItem, reserveExpiry } = useCart();
  const { shoppingCredit, spendCredit } = useRewards();
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

  // Ensure each cart item has a removal animation value
  cart.forEach(item => {
    if (!removeAnims.current[item.sku]) {
      removeAnims.current[item.sku] = new Animated.Value(1);
    }
  });

  const handleRemove = (sku: string) => {
    const anim = removeAnims.current[sku];
    if (anim) {
      Animated.timing(anim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
        removeItem(sku);
        delete removeAnims.current[sku];
      });
    } else {
      removeItem(sku);
    }
  };

  const handleSaveForLater = (item: CartItem) => {
    const anim = removeAnims.current[item.sku];
    const doSave = () => {
      removeItem(item.sku);
      delete removeAnims.current[item.sku];
      setSavedItems(prev => prev.find(s => s.sku === item.sku) ? prev : [...prev, item]);
    };
    if (anim) {
      Animated.timing(anim, { toValue: 0, duration: 200, useNativeDriver: true }).start(doSave);
    } else {
      doSave();
    }
  };

  const handleMoveToCart = (item: CartItem) => {
    setSavedItems(prev => prev.filter(s => s.sku !== item.sku));
    const { sku, productId, name, price, img, color, size } = item;
    addItem({ sku, productId, name, price, img, color, size }, item.qty);
  };

  const handleRemoveSaved = (sku: string) => {
    setSavedItems(prev => prev.filter(s => s.sku !== sku));
  };

  const flashQty = (sku: string) => {
    setQtyFlash(prev => ({ ...prev, [sku]: true }));
    setTimeout(() => setQtyFlash(prev => { const n = { ...prev }; delete n[sku]; return n; }), 400);
  };

  const handleQtyChange = (sku: string, text: string) => {
    setQtyInputs(prev => ({ ...prev, [sku]: text.replace(/[^0-9]/g, '') }));
  };

  const handleQtyBlur = (sku: string) => {
    const draft = qtyInputs[sku];
    if (draft !== undefined) {
      const val = parseInt(draft, 10);
      updateQty(sku, isNaN(val) || val < 1 ? 1 : Math.min(val, 999));
      setQtyInputs(prev => { const next = { ...prev }; delete next[sku]; return next; });
    }
  };

  const clearDraft = (sku: string) =>
    setQtyInputs(prev => { const next = { ...prev }; delete next[sku]; return next; });

  React.useEffect(() => {
    return navigation.addListener('focus', () => setCheckoutLoading(false));
  }, [navigation]);

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
  const freeShipThreshold = 500;
  // Free shipping is based on merchandise subtotal, not post-credit amount
  const remaining = Math.max(0, freeShipThreshold - rawTotal);
  const shipping = remaining === 0 ? 0 : 29.99;
  const creditDeduction = creditApplied ? Math.min(shoppingCredit, rawTotal + shipping) : 0;
  const total = rawTotal + shipping - creditDeduction;
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
        {/* Shipping banner */}
        {remaining > 0 ? (
          <View style={styles.shipBanner}>
            <Ionicons name="cube-outline" size={14} color="#CA8A04" />
            <Text style={styles.shipBannerText}>Add <Text style={styles.shipBannerAmt}>${formatPrice(remaining)}</Text> more for free shipping</Text>
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
          <Animated.View
            key={item.sku}
            style={[styles.cartItem, { opacity: removeAnims.current[item.sku] ?? 1 }]}
          >
            <Image source={{ uri: item.img }} style={styles.cartImage} resizeMode="cover" />
            <View style={styles.cartInfo}>
              <Text style={styles.cartName} numberOfLines={2}>{item.name}</Text>
              {(item.color || item.size) && (
                <Text style={styles.cartVariants}>
                  {[item.color, item.size].filter(Boolean).join(' · ')}
                </Text>
              )}
              <View style={styles.cartBottomRow}>
                <Text style={styles.cartPrice}>${formatPrice(item.price * item.qty)}</Text>
                <View style={styles.cartQtyControls}>
                  <TouchableOpacity
                    style={styles.cartQtyBtn}
                    onPress={() => { clearDraft(item.sku); flashQty(item.sku); updateQty(item.sku, Math.max(1, item.qty - 1)); }}
                  >
                    <Ionicons name="remove" size={14} color="#1C1917" />
                  </TouchableOpacity>
                  <TextInput
                    style={[styles.cartQtyText, qtyFlash[item.sku] && { color: '#EAB320' }]}
                    value={qtyInputs[item.sku] !== undefined ? qtyInputs[item.sku] : String(item.qty)}
                    onChangeText={text => handleQtyChange(item.sku, text)}
                    onBlur={() => handleQtyBlur(item.sku)}
                    keyboardType="number-pad"
                    selectTextOnFocus
                    maxLength={3}
                  />
                  <TouchableOpacity
                    style={styles.cartQtyBtn}
                    onPress={() => { clearDraft(item.sku); flashQty(item.sku); updateQty(item.sku, item.qty + 1); }}
                  >
                    <Ionicons name="add" size={14} color="#1C1917" />
                  </TouchableOpacity>
                </View>
              </View>
              <TouchableOpacity onPress={() => handleSaveForLater(item)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Text style={styles.cartSaveText}>Save for later</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.cartDeleteBtn} onPress={() => handleRemove(item.sku)}>
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
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Shipping</Text>
              {shipping === 0
                ? <Text style={styles.summaryFree}>Free</Text>
                : <Text style={styles.summaryValue}>${formatPrice(shipping)}</Text>}
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
          <View style={styles.summaryTotalBlock}>
            <Text style={styles.summaryTotalLabel}>Total</Text>
            <Text style={styles.summaryTotalValue}>${formatPrice(total)}</Text>
            {shipping === 0 && <Text style={styles.summaryTotalSub}>Free shipping included</Text>}
          </View>
          {/* CTA */}
          <TouchableOpacity
            style={[styles.summaryCheckoutBtn, checkoutLoading && { opacity: 0.7 }]}
            disabled={checkoutLoading}
            onPress={() => { setCheckoutLoading(true); navigation.navigate('Checkout', { mode: 'cart', creditAmount: creditDeduction }); }}
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
              <View key={item.sku} style={styles.savedItem}>
                <Image source={{ uri: item.img }} style={styles.savedItemImg} />
                <View style={styles.savedItemInfo}>
                  <Text style={styles.savedItemName} numberOfLines={2}>{item.name}</Text>
                  <Text style={styles.savedItemPrice}>${formatPrice(item.price)}</Text>
                  <View style={styles.savedItemActions}>
                    <TouchableOpacity style={styles.savedMoveBtn} onPress={() => handleMoveToCart(item)}>
                      <Text style={styles.savedMoveBtnText}>Move to cart</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handleRemoveSaved(item.sku)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
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
                    ? <Image source={{ uri: p.images[0] }} style={styles.cartRecommendImg} />
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
    { icon: 'chatbubble-outline', title: 'Messages', route: 'Inbox', requiresAuth: true },
    { icon: 'cube-outline', title: 'Orders & Purchases', route: 'Orders', requiresAuth: true },
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
          : item.route ? navigation.navigate(item.route)
        : (item as any).href ? Linking.openURL((item as any).href)
        : null}
      >
        <Ionicons name={item.icon as any} size={20} color={iconColor} />
        <View style={styles.menuTextWrap}>
          <Text style={[styles.menuText, { color: textColor }]}>{item.title}</Text>
          {item.subtitle && !locked && <Text style={styles.menuSubText}>{item.subtitle}</Text>}
        </View>
        <Ionicons name={locked ? 'lock-closed-outline' : 'chevron-forward'} size={15} color="#D1CFC9" />
      </TouchableOpacity>
    );
  }

  const footer = (
    <Text style={styles.accountFooter}>
      <Text style={styles.accountFooterLink} onPress={() => Linking.openURL('https://pouncing-quotation-0f0.notion.site/Terms-of-Service-358e0472a4e28030bb0ce6258d50a1c9?source=copy_link')}>Terms</Text>
      <Text> · </Text>
      <Text style={styles.accountFooterLink} onPress={() => Linking.openURL('https://pouncing-quotation-0f0.notion.site/Privacy-Policy-351e0472a4e2805aa8f1dbd6a6555bf2?source=copy_link')}>Privacy</Text>
    </Text>
  );

  // Guest / signed-out state
  if (!user) {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>
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
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>

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
          <TouchableOpacity
            style={styles.menuItem}
            activeOpacity={0.7}
            onPress={() => Linking.openURL('https://xselfhome.com/membership')}>
            <Ionicons name="settings-outline" size={20} color="#9CA3AF" />
            <View style={styles.menuTextWrap}>
              <Text style={styles.menuText}>Manage Plan</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color="#D1CFC9" />
          </TouchableOpacity>
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
      <AccountStack.Screen name="SignInEntry" component={SignInEntryScreen} />
    </AccountStack.Navigator>
  );
}

function CustomTabBar({ state, navigation }: any) {
  const insets = useSafeAreaInsets();
  const { totalItems, badgeVersion } = useCart();
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

  if (['Checkout', 'OrderSuccess', 'ProductDetail', 'Collection', 'Chat'].includes(rootRouteName ?? '')) return null;

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

export default function App() {
  const [showSplash, setShowSplash] = useState(true);
  const splashOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const run = async () => {
      await SplashScreen.hideAsync();
      // Fade in the React splash overlay
      Animated.timing(splashOpacity, { toValue: 1, duration: 350, useNativeDriver: true }).start();
      // After brief hold, fade out and unmount
      setTimeout(() => {
        Animated.timing(splashOpacity, { toValue: 0, duration: 400, useNativeDriver: true })
          .start(() => setShowSplash(false));
      }, 900);
    };
    run();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: '#0F766E' }}>
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
      <NavigationContainer>
        <Stack.Navigator id="RootStack" initialRouteName="Main" screenOptions={{ headerShown: false, gestureEnabled: true } as any}>
          <Stack.Screen name="SignInEntry" component={SignInEntryScreen} />
          <Stack.Screen name="Main" component={TabNavigator} />
          <Stack.Screen name="ProductDetail" component={ProductDetailScreen} />
          <Stack.Screen name="Collection" component={CollectionScreen} />
          <Stack.Screen name="Checkout" component={CheckoutScreen} />
          <Stack.Screen name="OrderSuccess" component={OrderSuccessScreen} />
          <Stack.Screen name="Chat" component={ChatScreen} />
          <Stack.Screen name="ProductConversation" component={ProductConversationScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      </ConversationProvider>
      </OrdersProvider>
      </CartProvider>
      </CartAnimProvider>
      </RewardsProvider>
      </RecommendationProvider>
      </AuthProvider>
      </StripeProvider>
      {showSplash && <SplashOverlay opacity={splashOpacity} />}
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
  summaryCheckoutBtn: { backgroundColor: '#EAB320', height: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center', shadowColor: '#EAB320', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6, elevation: 3 },
  summaryCheckoutBtnText: { color: 'white', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  floatingCtaContainer: { position: 'absolute', left: 16, right: 16, zIndex: 10 },
  floatingCheckoutBtn: { backgroundColor: '#EAB320', paddingVertical: 16, borderRadius: 14, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 6 },
  floatingCheckoutBtnText: { color: 'white', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  summaryTotalLabel: { fontSize: 12, fontWeight: '500', color: '#9CA3AF', marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: 0.8 },
  summaryTotalValue: { fontSize: 21, fontWeight: '600', color: '#111111' },
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
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)',
    shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 5,
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
