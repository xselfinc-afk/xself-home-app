import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, TextInput, Modal, KeyboardAvoidingView, Platform } from 'react-native';
import { Image } from 'expo-image';
import { variantUrl } from '../utils/imageVariant';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useCart } from '../context/CartContext';
import { fetchCartPriceUpdates } from '../services/cartPriceService';
import { formatAmount } from '../data/products';
import { useRewards } from '../context/RewardsContext';
import { useAuth } from '../context/AuthContext';
import { useOrders } from '../context/OrdersContext';
import { Address, fetchAddresses, insertAddress } from '../services/addressService';
import { type FulfillmentPlan, type FulfillmentGroup } from '../types/fulfillment';
import { DELIVERY_TIMING_COPY, deliveryTimingCopy, serverDeliveryCopyOf } from '../services/deliveryTimingCopy';
import { formatPickupDate, PICKUP_TIME_WINDOW } from '../services/pickupDateService';
import { useStripe, isPlatformPaySupported, PlatformPay, CardField } from '@stripe/stripe-react-native';
import { supabase } from '../lib/supabase';
import { incrementProductCounter } from '../services/analyticsService';
import { DEBUG_FLAGS } from '../config/debugFlags';
import { debugEnabled } from '../utils/debug';

// Affirm requires a minimum order of $50 USD. The Affirm tile is hidden/disabled
// below this threshold and the handler guards against stale state.
const AFFIRM_MIN_TOTAL = 50;

/**
 * Canonical fingerprint of a fulfillment plan for change detection.
 * Groups are sorted by warehouse code so order differences don't matter.
 * Detects: warehouse reassignment, pickup↔shipping flip, item-to-warehouse changes.
 */
function planFingerprint(plan: FulfillmentPlan): string {
  return plan.groups
    .map(g => ({
      key: g.warehouse.code,
      isPickup: g.isPickup,
      skus: g.items.map(i => i.sku).sort().join(','),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(g => `${g.key}:${g.isPickup}:[${g.skus}]`)
    .join('|');
}

/**
 * When the user selects "Delivery" on a plan that originally recommended pickup,
 * convert all pickup groups into delivery groups using the same warehouses. The Delivery
 * fee is the server-authoritative GIGA fee carried on the plan (deliveryFeeCents) — never
 * a hardcoded value. When the fee is unavailable, the fee shows as 0 here but Delivery is
 * blocked downstream via plan.deliveryAvailable (no charge happens).
 */
// Honest copy when a plan EXISTS but delivery is unavailable (no cached GIGA fee /
// deliveryFeeCents null). The address is NOT the problem — the item needs a quote or pickup.
const DELIVERY_QUOTE_UNAVAILABLE_COPY = 'Delivery quote is not available for this item yet. Please choose pickup if available or contact us for delivery help.';

function overrideGroupsToDelivery(plan: FulfillmentPlan): FulfillmentPlan {
  const feeDollars = plan.deliveryAvailable && plan.deliveryFeeCents != null ? plan.deliveryFeeCents / 100 : 0;
  // Never clobber a delivery string the server already sent. A converted group carries the PICKUP
  // window, which must not survive the switch to Delivery — so we reuse the server's delivery copy
  // from any delivery group in this same plan, and fall back to the constant only when it sent none.
  const serverDeliveryCopy = serverDeliveryCopyOf(plan.groups);
  const groups = plan.groups.map(g => {
    if (!g.isPickup) return g;
    return {
      ...g,
      isPickup: false as const,
      shipping: feeDollars,
      estimatedDelivery: serverDeliveryCopy || DELIVERY_TIMING_COPY,
      pickupWindow: undefined,
    };
  });
  return { ...plan, groups, totalShipping: feeDollars };
}

export default function CheckoutScreen({ route, navigation }: any) {
  const { cart, reserveExpiry, clearCart, refreshLines } = useCart();
  const { shoppingCredit, recordCreditSpend } = useRewards();
  const { user, isGuest, continueAsGuest, sendOtp, verifyOtp } = useAuth();
  const { addOrder } = useOrders();
  const { confirmPayment, confirmPlatformPayPayment } = useStripe();
  const insets = useSafeAreaInsets();
  const [reserveTimeLeft, setReserveTimeLeft] = useState('');

  useEffect(() => {
    if (!reserveExpiry) return;
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
  const { mode, product, qty: buyQty, selectedVariant, quoteToken, quotedPrice } = route?.params ?? {};


  // ── Order items based on mode ──────────────────────────────────────────────
  const isBuyNow = mode === 'buy_now';

  type OrderItem = {
    sku: string;
    /** supplier_product_id — used as fallback key in inventory lookup */
    productId: string;
    name: string;
    img: string;
    price: number;
    qty: number;
    color?: string;
    size?: string;
  };

  const orderItems: OrderItem[] = isBuyNow
    ? [{
        // Prefer variant SKU (sku_custom), then product-level skuCustom, then supplier_product_id
        sku: selectedVariant?.sku ?? product?.skuCustom ?? product?.id ?? '',
        // Fulfillment key = selected variant's supplier_product_id (the Edge Function
        // validates inventory/ships by productId); fall back to the representative only
        // when no variant is selected.
        productId: selectedVariant?.supplierProductId ?? product?.id ?? '',
        name: product?.name ?? '',
        img: selectedVariant?.images?.[0] ?? product?.images?.[0] ?? '',
        // Quote-based Buy Now: the negotiated quoted price (when present) is the
        // price the server will charge, so display it here in preference to the
        // catalog list price. quoteToken is still forwarded for server override.
        price: quotedPrice ?? selectedVariant?.price ?? product?.price ?? 0,
        qty: buyQty ?? 1,
        color: selectedVariant?.color,
        size: selectedVariant?.size,
      }]
    : cart.map(item => ({
        sku: item.sku,
        productId: item.productId,
        name: item.name,
        img: item.img,
        price: item.price,
        qty: item.qty,
        color: item.color,
        size: item.size,
      }));

  // Guard: at least one purchasable item is required to proceed to payment.
  // For Buy Now, also requires a named product with a positive price.
  const hasValidItems = isBuyNow
    ? (!!product?.name && (selectedVariant?.price ?? product?.price ?? 0) > 0)
    : orderItems.length > 0;

  const [fulfillmentPlan, setFulfillmentPlan] = useState<FulfillmentPlan | null>(null);
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState<string | null>(null);
  // Tracks WHY the fulfillment plan is missing — drives the correct error message in the UI
  const [deliveryErrorKind, setDeliveryErrorKind] = useState<'inventory_failed' | 'geocode_failed' | 'fulfillment_unavailable' | null>(null);
  // True when Edge Function returned stale: true — blocks checkout until user retries
  const [isInventoryStale, setIsInventoryStale] = useState(false);

  // Live inventory verification fallback: when the plan is a fallback (inventory_cache stale),
  // verify the exact cart SKUs against GIGA in real time (server-side verify-inventory-live).
  // On success (all in stock) we treat inventory as verified → clear the warning + enable Affirm.
  const [liveVerifying, setLiveVerifying] = useState(false);
  const [liveVerified, setLiveVerified] = useState(false);
  const verifyAttemptRef = useRef<string>('');

  // 'pickup' | 'delivery' | null — null means user hasn't chosen yet (req 9)
  const [fulfillmentChoice, setFulfillmentChoice] = useState<'pickup' | 'delivery' | null>(null);

  // When plan changes: auto-select 'delivery' when no pickup is available;
  // Default to delivery; user can switch to pickup if available.
  useEffect(() => {
    if (!fulfillmentPlan) { setFulfillmentChoice(null); return; }
    setFulfillmentChoice('delivery');
  }, [fulfillmentPlan]);


  // Whether the raw plan includes a pickup-capable warehouse
  const planHasPickup = fulfillmentPlan?.groups.some(g => g.isPickup) ?? false;

  // Active plan: reflects the user's chosen fulfillment method.
  // When user picks delivery on a pickup plan, all pickup groups become shipping groups.
  const activePlan: FulfillmentPlan | null = (() => {
    if (!fulfillmentPlan) return null;
    if (planHasPickup && fulfillmentChoice === 'delivery') return overrideGroupsToDelivery(fulfillmentPlan);
    return fulfillmentPlan;
  })();

  // True when live inventory is unavailable (real fallback or debug simulation).
  const isInventoryFallback = !!fulfillmentPlan?.isFallback || debugEnabled(DEBUG_FLAGS.forceInventoryFallback);

  // No default fee while loading — show 0 until the plan resolves
  const shipping = activePlan?.totalShipping ?? 0;
  const isPickup = activePlan !== null && activePlan.groups.length > 0 && activePlan.groups.every(g => g.isPickup);
  // Only non-pickup groups count as "shipments" for the label
  const shippingGroupCount = activePlan ? activePlan.groups.filter(g => !g.isPickup).length : 0;
  // Delivery selected but the server could not provide a GIGA fee → block checkout. There is
  // NO hardcoded fallback: payment is disabled and the fee shows "unavailable".
  const deliveryUnavailable = fulfillmentChoice === 'delivery' && activePlan !== null && !isPickup && !activePlan.deliveryAvailable;

  const subtotal = orderItems.reduce((sum, item) => sum + item.price * item.qty, 0);
  // Tax comes from the server (Stripe Tax, via plan-fulfillment's preview over the same catalogue
  // prices). This screen never computes a rate — it only renders what the server said. The charge
  // itself is recalculated authoritatively in create-checkout-order, which is why the two agree.
  // null (not yet planned, or the preview failed) renders as $0 rather than blocking checkout.
  const tax = (fulfillmentPlan?.taxCents ?? 0) / 100;
  // Cart mode: credit was toggled in CartScreen and passed here.
  // Buy Now mode: user toggles credit directly on this screen.
  // These two states are fully isolated — isBuyNow gates which applies.
  const routeCreditAmount: number = isBuyNow ? 0 : (route?.params?.creditAmount ?? 0);
  const [buyNowCreditApplied, setBuyNowCreditApplied] = useState(false);
  const appliedCredit = isBuyNow
    ? (buyNowCreditApplied ? Math.min(shoppingCredit, subtotal + shipping + tax) : 0)
    : routeCreditAmount;
  const total = subtotal + shipping + tax - appliedCredit;

  // Stable IDs per checkout session — generated once on mount, never re-assigned
  const checkoutSessionId = useRef(`sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  // Internal orderId: used for ledger idempotency keys and refund lookups
  const orderId = useRef(`ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  // Display orderNumber: shown in UI — human-readable, separate from internal ID
  const orderNumber = useRef(`XS-${Math.floor(10000 + Math.random() * 90000)}`);

  // Set by callCreateCheckoutOrder when the server rejects with price_changed
  // (catalog price rose above the cart snapshot). Callers surface it instead of
  // the generic "Unable to prepare your order" message.
  const priceChangedMsgRef = useRef<string | null>(null);

  // Cart-mode price/offer freshness on mount: sync line prices with the current
  // catalog + the signed-in customer's active Special Offer quotes so the totals
  // shown here match what create-checkout-order will charge. Display-level only —
  // the server re-prices authoritatively at order creation. Mount-only by design.
  useEffect(() => {
    if (isBuyNow || cart.length === 0) return;
    fetchCartPriceUpdates(cart, !!user?.email).then(updates => {
      if (updates.length > 0) refreshLines(updates);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Address system
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<Address | null>(null);
  const [addrModalVisible, setAddrModalVisible] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addrSaving, setAddrSaving] = useState(false);
  const [addrSaveError, setAddrSaveError] = useState<string | null>(null);
  const [fulfillRetryKey, setFulfillRetryKey] = useState(0);

  // ── Guest email verification (OTP) ──────────────────────────────────────────
  // Every order needs a verified contact email. Logged-in users are already
  // verified via their Supabase session email; guests must verify a one-time code
  // here before payment. Verifying reuses AuthContext.sendOtp/verifyOtp — on
  // success the guest gains a Supabase session (user.email set) and this section
  // auto-hides. No native, AuthContext, or backend changes.
  const [contactEmail, setContactEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpStep, setOtpStep] = useState<'email' | 'code'>('email');
  const [otpSending, setOtpSending] = useState(false);
  const [otpVerifying, setOtpVerifying] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpCooldown, setOtpCooldown] = useState(0);
  const otpCooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const otpCodeRef = useRef<TextInput>(null);

  // Load addresses from Supabase when the authenticated user is known
  useEffect(() => {
    if (!user) return;
    fetchAddresses(user.id)
      .then(rows => {
        setAddresses(rows);
        const def = rows.find(r => r.is_default) ?? rows[0] ?? null;
        setSelectedAddress(def);
      })
      .catch(() => {/* network error — addresses stay empty */});
  }, [user?.id]);

// Stable key to detect cart content changes (productId = supplier_product_id, or quantity).
  // Keyed on productId (not sku_custom, which is not unique) so a change in the physical
  // SKU set can never be masked by two items sharing a sku_custom.
  const orderItemsKey = orderItems.map(i => `${i.productId}:${i.qty}`).join(',');

  // Fulfillment planning — reruns on address change OR cart contents change
  useEffect(() => {
    if (!selectedAddress) return;
    const parts = [
      selectedAddress.address_line_1,
      selectedAddress.address_line_2,
      selectedAddress.city,
      `${selectedAddress.state} ${selectedAddress.zip}`,
      selectedAddress.country,
    ].filter(Boolean);
    const addressString = parts.join(', ');
    console.log('[Checkout] Selected address:', addressString);

    let cancelled = false;
    setDeliveryLoading(true);
    setRecheckError(null);
    setDeliveryErrorKind(null);
    setIsInventoryStale(false);

    // Call plan-fulfillment edge function — geocoding, warehouse ranking, and inventory
    // validation all happen server-side.
    const planItems = orderItems.map(i => ({ sku: i.sku, productId: i.productId, qty: i.qty }));
    const planAddress = {
      line1: selectedAddress.address_line_1,
      city: selectedAddress.city,
      state: selectedAddress.state,
      zip: selectedAddress.zip,
      country: selectedAddress.country ?? 'US',
    };

    (async () => {
      try {
        // Warm-up: refresh inventory_cache for cart SKUs via the live XHR path
        // before plan-fulfillment runs. Non-fatal — if this fails or returns
        // binary_only, plan-fulfillment still reads whatever is in inventory_cache
        // and surfaces a stale banner exactly as before.
        const cartProductIds = [...new Set(planItems.map(i => i.productId))].filter(Boolean);
        if (cartProductIds.length > 0) {
          try {
            const warm = await supabase.functions.invoke('giga-warehouse-stock', {
              body: { skus: cartProductIds },
            });
            console.log('[Checkout] inventory warm-up:', {
              skus: cartProductIds.length,
              error: warm.error?.message ?? null,
              source: (warm.data as { source?: string } | null)?.source ?? null,
              binaryOnly: (warm.data as { binaryOnly?: boolean } | null)?.binaryOnly ?? false,
            });
          } catch (warmErr) {
            console.log('[Checkout] inventory warm-up threw (non-fatal):', (warmErr as Error).message);
          }
          if (cancelled) return;
        }

        console.log('[Checkout] Calling plan-fulfillment edge function', {
          itemCount: planItems.length,
          skus: planItems.map(i => i.sku),
          productIds: planItems.map(i => i.productId),
          payload: { items: planItems, address: planAddress },
        });
        const { data, error } = await supabase.functions.invoke('plan-fulfillment', {
          // This (new) build supports the dynamic GIGA Delivery fee — opt into the new server
          // behavior via the version gate. Old builds omit this and get legacy behavior.
          //
          // preferredMethod: without it the planner defaults to "pickup whenever eligible", and the
          // screen then converts the groups to delivery locally. That override moves the shipping
          // number but not taxCents, so a delivery order inside the pickup radius would display the
          // warehouse-sourced tax while create-checkout-order charges the destination-sourced one.
          // Sending the choice keeps both figures from the same server plan.
          body: {
            items: planItems,
            address: planAddress,
            clientSupportsDynamicDelivery: true,
            // This build renders the server's taxCents, so it opts into real tax.
            clientSupportsTax: true,
            ...(fulfillmentChoice ? { preferredMethod: fulfillmentChoice } : {}),
          },
        });

        if (cancelled) return;
        console.log('[Checkout] plan-fulfillment response', {
          httpError: error?.message ?? null,
          valid: data?.valid,
          status: data?.fulfillmentStatus,
          reason: data?.reason,
          inventoryFreshness: data?.inventoryFreshness,
          inventoryTimestamp: data?.inventoryTimestamp,
          selectedWarehouse: data?.selectedWarehouse?.code,
        });
        if (error) throw new Error(error.message);

        if (!data?.valid || !data?.selectedWarehouse) {
          const status: string = data?.fulfillmentStatus ?? 'unknown';
          console.warn(`[Checkout] plan-fulfillment: valid=false status=${status} reason=${data?.reason ?? ''}`);
          const isInventoryStatus =
            status === 'stale_inventory'        ||
            status === 'no_inventory'           ||
            status === 'insufficient_qty'       ||
            status === 'inventory_unavailable'  ||
            status === 'warehouse_data_unavailable';
          if (isInventoryStatus) {
            setIsInventoryStale(true);
          } else if (status === 'geocode_failed') {
            // Real address/geocode failure — the address copy is accurate here.
            setDeliveryErrorKind('geocode_failed');
          } else {
            // no_eligible_warehouse (e.g. inventory parked under a non-canonical
            // warehouse code) or any other non-address failure — NOT the address.
            setDeliveryErrorKind('fulfillment_unavailable');
          }
          setFulfillmentPlan(null);
          return;
        }

        // Server-authoritative Delivery fee (GIGA product/price/v1). Null/unavailable →
        // Delivery is blocked in the UI; there is NO hardcoded fallback.
        const deliveryAvailable = data.deliveryAvailable === true && typeof data.deliveryFeeCents === 'number';
        const deliveryFeeCents: number | null = deliveryAvailable ? data.deliveryFeeCents : null;
        const deliveryFeeDollars = deliveryFeeCents != null ? deliveryFeeCents / 100 : 0;
        const deliveryUnavailableReason: string | null = deliveryAvailable ? null : (data.deliveryUnavailableReason ?? 'unavailable');

        const group: FulfillmentGroup = {
          warehouse: data.selectedWarehouse,
          distanceMiles: data.distanceMiles,
          isPickup: data.usePickup,
          shipping: data.usePickup ? 0 : deliveryFeeDollars,
          items: orderItems.map(i => ({ sku: i.sku, name: i.name, qty: i.qty, price: i.price, img: i.img })),
          estimatedDelivery: data.estimatedDelivery,
          pickupWindow: data.pickupWindow ?? undefined,
        };
        const plan: FulfillmentPlan = {
          groups: [group],
          totalShipping: data.usePickup ? 0 : deliveryFeeDollars,
          deliveryFeeCents,
          taxCents: typeof data.taxCents === 'number' ? data.taxCents : null,
          deliveryAvailable,
          deliveryUnavailableReason,
          isSingleWarehouse: true,
          // Surface the existing "Live inventory unavailable" banner whenever
          // the server reports anything other than fresh inventory.
          isFallback: data.inventoryFreshness !== 'fresh',
        };

        console.log(`[Checkout] Fulfillment plan: warehouse=${data.selectedWarehouse.code} dist=${data.distanceMiles.toFixed(1)}mi pickup=${data.usePickup} deliveryAvailable=${deliveryAvailable} deliveryFeeCents=${deliveryFeeCents} deliveryReason=${deliveryUnavailableReason ?? 'none'} freshness=${data.inventoryFreshness}`);
        setFulfillmentPlan(plan);
      } catch (err) {
        if (cancelled) return;
        console.log('[Checkout] plan-fulfillment failed:', (err as Error).message);
        // Network/exception — transient, NOT an address problem → generic retry copy.
        setDeliveryErrorKind(null);
        setFulfillmentPlan(null);
      } finally {
        if (!cancelled) setDeliveryLoading(false);
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAddress?.id, orderItemsKey, fulfillRetryKey, fulfillmentChoice]);

  // ── Live inventory verification fallback ──────────────────────────────────
  // Reset verification whenever the plan inputs change (new cart / address / retry).
  useEffect(() => { setLiveVerified(false); }, [orderItemsKey, selectedAddress?.id, fulfillRetryKey]);

  // When the plan came back as a fallback (inventory_cache stale) — NOT a hard stale failure —
  // probe GIGA in real time for the exact cart SKUs via the server-side verify-inventory-live
  // Edge Function. Success (all in stock) → mark verified (clears warning + enables Affirm).
  // Any failure/timeout/out-of-stock → leave unverified (Affirm stays blocked; card/Apple Pay
  // unaffected). One attempt per plan state (guarded by verifyAttemptRef) — never loops.
  useEffect(() => {
    if (!isInventoryFallback || isInventoryStale || liveVerified) return;
    const skus = [...new Set(orderItems.map(i => i.productId).filter(Boolean))];
    if (skus.length === 0) return;
    const attemptKey = `${selectedAddress?.id ?? ''}|${orderItemsKey}|${fulfillRetryKey}`;
    if (verifyAttemptRef.current === attemptKey) return;
    verifyAttemptRef.current = attemptKey;
    let active = true;
    setLiveVerifying(true);
    supabase.functions.invoke('verify-inventory-live', { body: { skus } })
      .then(({ data, error }) => {
        if (!active) return;
        const d = data as { verified?: boolean; allInStock?: boolean } | null;
        if (!error && d?.verified === true && d?.allInStock === true) setLiveVerified(true);
      })
      .catch(() => { /* fail-safe: keep Affirm blocked */ })
      .finally(() => { if (active) setLiveVerifying(false); });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInventoryFallback, isInventoryStale, liveVerified, orderItemsKey, selectedAddress?.id, fulfillRetryKey]);

  const [addrFirstName, setAddrFirstName] = useState('');
  const [addrLastName, setAddrLastName] = useState('');
  const [addrPhone, setAddrPhone] = useState('');
  const [addrLine1, setAddrLine1] = useState('');
  const [addrLine2, setAddrLine2] = useState('');
  const [addrCity, setAddrCity] = useState('');
  const [addrStateVal, setAddrStateVal] = useState('');
  const [addrZip, setAddrZip] = useState('');
  // Validation is lenient at the gate (every required field non-empty) so the
  // button never silently greys out when a reviewer or user types a short ZIP.
  // Real ZIP / address validation runs server-side at submit (plan-fulfillment
  // + Stripe geocode), which surfaces a specific error if the address fails.
  const addrFormValid = addrFirstName.trim() && addrLastName.trim() && addrPhone.trim() &&
    addrLine1.trim() && addrCity.trim() && addrStateVal.trim() && addrZip.trim();

  // A Supabase session email counts as verified (logged-in users and guests who
  // completed the OTP step below). Payment is blocked until this is true.
  const isEmailVerified = !!user?.email;
  const CHECKOUT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const contactEmailValid = CHECKOUT_EMAIL_RE.test(contactEmail.trim());

  const startOtpCooldown = (seconds = 30) => {
    if (otpCooldownRef.current) clearInterval(otpCooldownRef.current);
    setOtpCooldown(seconds);
    otpCooldownRef.current = setInterval(() => {
      setOtpCooldown(prev => {
        if (prev <= 1) {
          if (otpCooldownRef.current) clearInterval(otpCooldownRef.current);
          otpCooldownRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };
  useEffect(() => () => { if (otpCooldownRef.current) clearInterval(otpCooldownRef.current); }, []);

  // When the step advances to 'code' (only after sendOtp succeeds), the 6-digit
  // input has just rendered — focus it on the next frame so the number keyboard
  // opens and the iOS one-time-code autofill suggestion can appear. On send
  // failure the step stays 'email', so this never fires.
  useEffect(() => {
    if (otpStep !== 'code') return;
    const id = requestAnimationFrame(() => otpCodeRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [otpStep]);

  async function handleSendOtp() {
    if (!contactEmailValid || otpSending || otpCooldown > 0) return;
    setOtpSending(true);
    setOtpError(null);
    const { error } = await sendOtp(contactEmail.trim().toLowerCase());
    setOtpSending(false);
    if (error) { setOtpError('Could not send a code. Please try again.'); return; }
    setOtpStep('code');
    startOtpCooldown(30);
  }

  async function handleVerifyOtp() {
    if (otpCode.length < 6 || otpVerifying) return;
    setOtpVerifying(true);
    setOtpError(null);
    // On success, AuthContext.applySession sets `user` → isEmailVerified flips true
    // and the contact-email section auto-hides.
    const { error } = await verifyOtp(contactEmail.trim().toLowerCase(), otpCode);
    setOtpVerifying(false);
    if (error) { setOtpError('Invalid or expired code. Please try again.'); return; }
  }

  type PaymentMethod = 'apple_pay' | 'card' | 'affirm';
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('card');

  // If totals fall below Affirm's $50 minimum (e.g. after a coupon/credit was
  // applied), drop the user back to card so the picker state stays valid.
  useEffect(() => {
    if (paymentMethod === 'affirm' && total < AFFIRM_MIN_TOTAL) {
      setPaymentMethod('card');
    }
  }, [paymentMethod, total]);
  const [reviewExpanded, setReviewExpanded] = useState(false);
  // Tracks inline CardField completeness — null until user interacts
  const [cardDetails, setCardDetails] = useState<{ complete: boolean } | null>(null);
  // Affirm-specific loading/error states (separate from the main placing flow)
  const [affirmLoading, setAffirmLoading] = useState(false);
  const [affirmError, setAffirmError] = useState<string | null>(null);
  // Dev-only: raw Stripe error detail shown below the Affirm block in __DEV__ builds
  const [affirmDevDetail, setAffirmDevDetail] = useState<string | null>(null);

  // Prevent double-tap / duplicate recordCreditSpend calls
  const [placing, setPlacing] = useState(false);

  // Reset placing if user navigates back from OrderSuccess
  useFocusEffect(useCallback(() => { setPlacing(false); }, []));

  // Debug: log Place Order button state whenever any blocking condition changes.
  // If the button is disabled, onPress never fires — this is the only way to see why.
  useEffect(() => {
    if (__DEV__) {
      const isDisabled = !selectedAddress || placing || deliveryLoading || rechecking || !activePlan || fulfillmentChoice === null || (paymentMethod === 'card' && !cardDetails?.complete);
      console.log('[Payment] button state —', isDisabled ? 'DISABLED' : 'ENABLED', {
        hasAddress: !!selectedAddress,
        placing,
        deliveryLoading,
        rechecking,
        hasActivePlan: !!activePlan,
        fulfillmentChoice,
        cardComplete: cardDetails?.complete ?? null,
      });
    }
  }, [selectedAddress, placing, deliveryLoading, rechecking, activePlan, fulfillmentChoice, paymentMethod, cardDetails]);

  // Guest gate — sign-in or guest required for checkout
  if (!user && !isGuest) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <TouchableOpacity style={styles.gateBackBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={18} color="#6B7280" />
          <Text style={styles.gateBackText}>Back to cart</Text>
        </TouchableOpacity>

        <View style={styles.gateWrap}>
          <View style={styles.gateIconWrap}>
            <Ionicons name="lock-closed-outline" size={26} color="#CA8A04" />
          </View>

          <Text style={styles.gateTitle}>Continue to checkout</Text>
          <Text style={styles.gateSub}>Sign in for faster checkout, order tracking, and rewards.</Text>

          <TouchableOpacity style={styles.gateSignInBtn} onPress={() => navigation.navigate('SignInEntry')}>
            <Text style={styles.gateSignInText}>Sign In →</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.gateGuestBtn} onPress={continueAsGuest}>
            <Text style={styles.gateGuestText}>Continue as Guest</Text>
          </TouchableOpacity>

          <View style={styles.gateDivider} />

          <View style={styles.gateBenefits}>
            {['Track your order', 'Save your cart', 'Earn rewards'].map(b => (
              <Text key={b} style={styles.gateBenefit}>• {b}</Text>
            ))}
          </View>
        </View>
      </View>
    );
  }

  // Empty-order gate — must have at least one valid item to proceed
  if (!hasValidItems) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <TouchableOpacity style={styles.gateBackBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={18} color="#6B7280" />
          <Text style={styles.gateBackText}>Back to cart</Text>
        </TouchableOpacity>
        <View style={styles.gateWrap}>
          <View style={styles.gateIconWrap}>
            <Ionicons name="cart-outline" size={26} color="#CA8A04" />
          </View>
          <Text style={styles.gateTitle}>Your cart is empty</Text>
          <Text style={styles.gateSub}>Add an item before checkout.</Text>
          <TouchableOpacity style={styles.gateSignInBtn} onPress={() => navigation.goBack()}>
            <Text style={styles.gateSignInText}>Browse Products →</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Phase 8: create order + reservation + PaymentIntent in one server call ─
  async function callCreateCheckoutOrder(paymentMethodSelected: string): Promise<{
    orderId: string;
    orderNumber: string;
    clientSecret: string;
    guestToken: string | null;
    paymentIntentId: string;
  } | null> {
    const items = orderItems.map(i => ({
      sku: i.sku,
      productId: i.productId,
      qty: i.qty,
      title: i.name,
      unitPriceCents: Math.round(i.price * 100),
    }));
    const address = selectedAddress ? {
      line1: selectedAddress.address_line_1,
      city: selectedAddress.city,
      state: selectedAddress.state,
      zip: selectedAddress.zip,
      country: selectedAddress.country ?? 'US',
    } : undefined;
    // For cart-mode (no buy_now route param), if any cart line carries a
    // Special Offer redeem token (added via SupportScreen → Add to Cart),
    // forward it at the body root. The server will re-validate and override
    // the matching line's price. Multi-quote carts are not yet supported —
    // we pick the first quoted line and ignore the rest.
    const cartQuoteToken = !isBuyNow
      ? (cart.find(i => i.quoteToken)?.quoteToken ?? undefined)
      : undefined;
    const effectiveQuoteToken = quoteToken ?? cartQuoteToken;

    // Affirm risk underwriting requires a real first+last name on shipping[name].
    // Send it from the selected address so the Edge Function does not fall back
    // to deriving a single-word name from the customer's email local-part.
    const customerName = selectedAddress
      ? `${selectedAddress.first_name ?? ''} ${selectedAddress.last_name ?? ''}`.trim()
      : '';

    const { data, error } = await supabase.functions.invoke('create-checkout-order', {
      body: {
        items,
        customer: { email: user?.email ?? '' },
        address,
        fulfillmentMethod: fulfillmentChoice ?? 'delivery',
        userId: user?.id ?? null,
        paymentMethodSelected,
        // Version gate: this build charges the dynamic GIGA Delivery fee (no hardcoded fallback).
        // Old builds omit this flag and keep legacy checkout behavior.
        clientSupportsDynamicDelivery: true,
        // Tax gate: this build renders the server's taxCents, so the charge may include tax.
        // Builds that omit this are charged $0 tax — their Checkout cannot show a tax line.
        clientSupportsTax: true,
        ...(customerName ? { customerName } : {}),
        // Optional: present only when SupportScreen forwarded a special-offer
        // quote on Buy Now, OR when a cart line carries a quoteToken.
        ...(effectiveQuoteToken ? { quoteToken: effectiveQuoteToken } : {}),
      },
    });
    if (error || !data?.clientSecret) {
      // Structured price_changed (409): the server catalog price rose above the
      // cart snapshot. Refresh the displayed lines and let the caller surface a
      // review-and-retry message instead of the generic failure copy.
      priceChangedMsgRef.current = null;
      try {
        const ctx = (error as { context?: Response } | null)?.context;
        if (ctx && typeof ctx.json === 'function') {
          const body = await ctx.json();
          if (body?.error === 'price_changed') {
            priceChangedMsgRef.current =
              'Some prices changed since you added these items. We refreshed your order — please review the total and try again.';
            if (!isBuyNow && cart.length > 0) {
              fetchCartPriceUpdates(cart, !!user?.email).then(updates => {
                if (updates.length > 0) refreshLines(updates);
              });
            }
          }
        }
      } catch { /* body not JSON — fall through to generic handling */ }
      console.log('[Checkout] create-checkout-order failed:', error?.message ?? 'no clientSecret');
      return null;
    }
    orderId.current = data.orderId;
    orderNumber.current = data.orderNumber;
    return {
      orderId: data.orderId,
      orderNumber: data.orderNumber,
      clientSecret: data.clientSecret,
      guestToken: data.guestToken ?? null,
      paymentIntentId: data.paymentIntentId,
    };
  }

  // ── Affirm payment handler ────────────────────────────────────────────────
  async function handleAffirmPayment() {
    if (affirmLoading || placing) return;
    if (!isEmailVerified) return;
    if (!selectedAddress) { setShowAddForm(true); setAddrModalVisible(true); return; }
    if (!activePlan || fulfillmentChoice === null || deliveryUnavailable) return;

    setAffirmError(null);
    setAffirmDevDetail(null);

    // Affirm requires a minimum order of $50 USD. The Affirm tile is gated by
    // total in the picker but guard here so a stale selection cannot bypass.
    if (total < AFFIRM_MIN_TOTAL) {
      setAffirmError(`Affirm is available on orders over $${AFFIRM_MIN_TOTAL}. Please choose another payment method.`);
      return;
    }

    setAffirmLoading(true);

    if (debugEnabled(DEBUG_FLAGS.forcePaymentFailure)) {
      setAffirmError('Payment failed. Please try again.');
      setAffirmLoading(false);
      return;
    }

    const result = await callCreateCheckoutOrder('affirm');
    if (!result) {
      setAffirmError(priceChangedMsgRef.current ?? 'Unable to prepare your order. Please try again.');
      setAffirmLoading(false);
      return;
    }

    const { clientSecret, paymentIntentId } = result;

    console.log('[Affirm] confirmPayment params:', {
      clientSecretExists: !!clientSecret,
      amount: Math.round(total * 100),
      currency: 'usd',
      paymentMethod: 'affirm',
      urlScheme: 'xselfhome',
    });

    // Confirm Affirm payment — Stripe opens Affirm authorization in browser.
    // For Affirm specifically, the Edge Function attaches shipping[name] +
    // shipping[address][...] on the PaymentIntent (secret-key only); the
    // browser-side confirmPayment passes billingDetails for the payment
    // method itself. Don't re-send shipping here — Stripe rejects shipping
    // changes from the publishable key once the PI exists.
    const { error: confirmError, paymentIntent: confirmedPI } = await confirmPayment(clientSecret, {
      paymentMethodType: 'Affirm',
      paymentMethodData: {
        billingDetails: {
          name: `${selectedAddress.first_name} ${selectedAddress.last_name}`,
          email: user?.email,
          address: {
            line1: selectedAddress.address_line_1,
            line2: selectedAddress.address_line_2 ?? undefined,
            city: selectedAddress.city,
            state: selectedAddress.state,
            postalCode: selectedAddress.zip,
            country: selectedAddress.country ?? 'US',
          },
        },
      },
    });

    console.log('[Affirm] confirmPayment error:', JSON.stringify(confirmError, null, 2));
    console.log('[Affirm] paymentIntent:', JSON.stringify(confirmedPI, null, 2));

    if (confirmError) {
      if ((confirmError as any).code === 'Canceled') {
        setAffirmLoading(false);
        return;
      }
      const detail = (confirmError as any).message
        || (confirmError as any).localizedMessage
        || JSON.stringify(confirmError);
      const code = (confirmError as any).code ?? 'unknown';
      // Always log the exact Stripe error so production failures are diagnosable
      // in crash/log aggregators. Card and Apple Pay paths are unaffected.
      console.warn('[Affirm] confirmPayment failed', { code, detail, paymentIntentId });
      if (__DEV__) setAffirmDevDetail(`${code}: ${detail}`);
      setAffirmError('Affirm could not be started. Please try again or choose another payment method.');
      setAffirmLoading(false);
      return;
    }

    // Payment authorized — webhook will finalize; navigate to OrderSuccess
    if (appliedCredit > 0) {
      recordCreditSpend(orderId.current, checkoutSessionId.current, appliedCredit);
    }
    orderItems.forEach(item => {
      if (item.productId) incrementProductCounter(item.productId, 'order_count');
    });
    if (!isBuyNow) clearCart();
    navigation.navigate('OrderSuccess', {
      total,
      orderId: orderId.current,
      orderNumber: orderNumber.current,
      checkoutSessionId: checkoutSessionId.current,
      userEmail: user?.email ?? '',
      paymentIntentId,
    });
  }

  const anyDebugActive = __DEV__ && (
    DEBUG_FLAGS.forceInventoryFallback ||
    DEBUG_FLAGS.forceInventoryUnavailable ||
    DEBUG_FLAGS.forceAddressSaveFailure ||
    DEBUG_FLAGS.forcePaymentFailure ||
    DEBUG_FLAGS.forceOrderSaveFailure
  );

  // Single source of truth for the Place Order CTA label. Disabled-state logic
  // is unchanged and lives on the button itself; this only labels the button.
  const ctaLabel = (() => {
    if (deliveryLoading) return fulfillmentPlan ? 'Updating delivery…' : 'Checking delivery…';
    if (rechecking) return 'Verifying inventory…';
    if (placing) return 'Processing…';
    if (!isEmailVerified || !selectedAddress) return 'Add contact & delivery details';
    if (deliveryUnavailable) return 'Delivery unavailable';
    // Hard blocks: server gave us no usable plan (covers isInventoryStale,
    // geocode failures, and any other valid:false response). Pre-flight gaps
    // (no address, no fulfillment choice, incomplete card) fall through so
    // the price stays visible and the inline form guides the customer.
    if (selectedAddress && !fulfillmentPlan) return 'Currently Unavailable';
    return `Place Order · $${formatAmount(total)}`;
  })();

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {anyDebugActive && (
        <View style={styles.debugBadge}>
          <Text style={styles.debugBadgeText}>⚠ DEBUG MODE</Text>
        </View>
      )}
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 140 }}>
        <Text style={styles.title}>Checkout</Text>
        <Text style={styles.titleSub}>Review your order before placing</Text>

        {/* Contact & Delivery — one combined section. Email, name, phone, and
            address are all fulfillment details, collected together in the bottom
            sheet (email verified by OTP at the top of that sheet). Payment stays
            locked until the email is verified AND delivery details are saved. */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Contact & Delivery</Text>
          {isEmailVerified && selectedAddress ? (
            <View style={styles.card}>
              <View style={styles.addrRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.addrName}>{selectedAddress.first_name} {selectedAddress.last_name}  ·  {selectedAddress.phone}</Text>
                  <Text style={styles.addrLine}>{selectedAddress.address_line_1}{selectedAddress.address_line_2 ? `, ${selectedAddress.address_line_2}` : ''}</Text>
                  <Text style={styles.addrLine}>{selectedAddress.city}, {selectedAddress.state} {selectedAddress.zip}</Text>
                  <Text style={styles.emailVerifiedNote}>Email verified</Text>
                </View>
                <TouchableOpacity onPress={() => { setShowAddForm(false); setAddrModalVisible(true); }}>
                  <Text style={styles.addrChangeBtn}>Change</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity style={styles.card} onPress={() => { setShowAddForm(true); setAddrModalVisible(true); }} activeOpacity={0.7}>
              <View style={styles.addrRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.addrName}>Add contact &amp; delivery details</Text>
                  <Text style={[styles.otpHelp, { marginBottom: 0, marginTop: 4 }]}>Required before checkout</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color="#CA8A04" />
              </View>
            </TouchableOpacity>
          )}
        </View>

        {/* Fulfillment */}
        <View style={styles.section}>

          {deliveryLoading && (
            <View style={styles.card}>
              <Text style={styles.fulfillSub}>Checking availability…</Text>
            </View>
          )}

          {!deliveryLoading && !fulfillmentPlan && selectedAddress && !isInventoryStale && (
            <View style={styles.fulfillErrorBanner}>
              <Ionicons name="alert-circle-outline" size={16} color="#B45309" />
              <Text style={styles.fulfillErrorText}>
                {deliveryErrorKind === 'geocode_failed'
                  ? "We couldn't confirm delivery for this address. Please check the address or choose pickup if available."
                  : deliveryErrorKind === 'fulfillment_unavailable'
                  ? "This item is not available for delivery right now. Please choose another item or contact us for help."
                  : "We're unable to retrieve inventory information right now. Please try again later."}
              </Text>
            </View>
          )}

          {/* 🔒 LOCKED PICKUP RULE — do NOT change pickup eligibility, the "Warehouse
              Pickup" label, the pickup window/fee, or the planHasPickup gate /
              setFulfillmentChoice('pickup') call below while redesigning Delivery.
              Guarded by scripts/productionGuardrails.ts. See docs/fulfillment-rules.md. */}
          {/* Pickup available — delivery pre-selected, user can switch to pickup */}
          {!deliveryLoading && fulfillmentPlan && planHasPickup && (
            <>
              {/* Pickup option */}
              <TouchableOpacity
                style={[styles.fulfillOptionCard, fulfillmentChoice === 'pickup' && styles.fulfillOptionSelected]}
                onPress={() => setFulfillmentChoice('pickup')}
                activeOpacity={0.8}
              >
                <View style={[styles.radioOuter, fulfillmentChoice === 'pickup' && styles.radioOuterActive]}>
                  {fulfillmentChoice === 'pickup' && <View style={styles.radioDot} />}
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={styles.fulfillOptionLabel}>Pickup — Free</Text>
                  {fulfillmentPlan.groups.filter(g => g.isPickup).map(g => (
                    <View key={g.warehouse.code}>
                      <Text style={styles.fulfillOptionSub}>
                        {g.warehouse.label} · {g.distanceMiles.toFixed(1)} mi
                      </Text>
                      {g.pickupWindow && (
                        <Text style={styles.fulfillOptionSub}>
                          {formatPickupDate(g.pickupWindow.earliest)} – {formatPickupDate(g.pickupWindow.latest)}
                        </Text>
                      )}
                    </View>
                  ))}
                </View>
              </TouchableOpacity>

              {/* Delivery option */}
              <TouchableOpacity
                style={[styles.fulfillOptionCard, { marginTop: 8 }, fulfillmentChoice === 'delivery' && styles.fulfillOptionSelected]}
                onPress={() => setFulfillmentChoice('delivery')}
                activeOpacity={0.8}
              >
                <View style={[styles.radioOuter, fulfillmentChoice === 'delivery' && styles.radioOuterActive]}>
                  {fulfillmentChoice === 'delivery' && <View style={styles.radioDot} />}
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={styles.fulfillOptionLabel}>
                    {fulfillmentPlan.deliveryAvailable && fulfillmentPlan.deliveryFeeCents != null
                      ? `Delivery — $${formatAmount(fulfillmentPlan.deliveryFeeCents / 100)}`
                      : 'Delivery — Quote required'}
                  </Text>
                  <Text style={styles.fulfillOptionSub}>
                    {!fulfillmentPlan.deliveryAvailable
                      ? `${DELIVERY_QUOTE_UNAVAILABLE_COPY}${__DEV__ && fulfillmentPlan.deliveryUnavailableReason ? ` · ${fulfillmentPlan.deliveryUnavailableReason}` : ''}`
                      : deliveryTimingCopy(fulfillmentPlan.groups.find(g => !g.isPickup))}
                  </Text>
                </View>
              </TouchableOpacity>
            </>
          )}

          {/* Delivery only — auto-selected, no radio needed */}
          {!deliveryLoading && fulfillmentPlan && !planHasPickup && (
            <View style={styles.card}>
              {fulfillmentPlan.groups.map((group, idx) => (
                <View key={group.warehouse.code} style={[idx > 0 && { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#F3F2EE' }]}>
                  <View style={styles.fulfillRow}>
                    <Ionicons name="cube-outline" size={15} color="#CA8A04" />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={[styles.fulfillLabel, styles.fulfillLabelActive]}>
                        {fulfillmentPlan.deliveryAvailable && fulfillmentPlan.deliveryFeeCents != null
                          ? `Delivery — $${formatAmount(fulfillmentPlan.deliveryFeeCents / 100)}`
                          : 'Delivery — unavailable'}
                      </Text>
                      <Text style={styles.fulfillWarehouse}>
                        {fulfillmentPlan.deliveryAvailable ? deliveryTimingCopy(group) : `${DELIVERY_QUOTE_UNAVAILABLE_COPY}${__DEV__ && fulfillmentPlan.deliveryUnavailableReason ? ` · ${fulfillmentPlan.deliveryUnavailableReason}` : ''}`}
                      </Text>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          )}

          {!deliveryLoading && isInventoryFallback && !liveVerified && (
            <View style={styles.fulfillFallbackBanner}>
              <Ionicons name="information-circle-outline" size={13} color="#92660A" />
              <View style={{ flex: 1 }}>
                <Text style={[styles.fulfillFallbackText, { flex: 0 }]}>
                  {liveVerifying
                    ? 'Verifying live availability…'
                    : "We'll confirm availability after you place your order. Delivery dates are based on your shipping address."}
                </Text>
                <TouchableOpacity
                  onPress={() => setFulfillRetryKey(k => k + 1)}
                  activeOpacity={0.7}
                  style={{ marginTop: 5 }}
                >
                  <Text style={{ fontSize: 12, color: '#92660A', fontWeight: '600' }}>Retry</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {/* Payment */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Payment</Text>
          <View style={styles.card}>
            {(() => {
              const affirmEligible = total >= AFFIRM_MIN_TOTAL;
              const methods: { id: PaymentMethod; icon: any; label: string; sub: string | null; disabled?: boolean }[] = [
                { id: 'apple_pay', icon: 'logo-apple',    label: 'Apple Pay',           sub: 'Recommended' },
                { id: 'card',      icon: 'card-outline',  label: 'Credit / Debit Card', sub: '•••• •••• •••• ––––' },
                {
                  id: 'affirm',
                  icon: 'cash-outline',
                  label: 'Affirm',
                  // Do not display a per-month estimate: the actual figure
                  // depends on Affirm underwriting (term, APR, down payment)
                  // and is not known until the buyer is approved in Affirm's
                  // flow. Showing total/12 here would be misleading.
                  sub: affirmEligible
                    ? 'Pay over time with Affirm'
                    : `Available on orders over $${AFFIRM_MIN_TOTAL}`,
                  disabled: !affirmEligible,
                },
              ];
              return methods.map((pm, idx, arr) => (
                <TouchableOpacity
                  key={pm.id}
                  style={[styles.pmRow, idx < arr.length - 1 && styles.pmRowBorder, pm.disabled && { opacity: 0.45 }]}
                  onPress={() => { if (!pm.disabled) setPaymentMethod(pm.id); }}
                  disabled={pm.disabled}
                  activeOpacity={0.7}
                >
                  <View style={[styles.pmRadio, paymentMethod === pm.id && styles.pmRadioSelected]}>
                    {paymentMethod === pm.id && <View style={styles.pmRadioDot} />}
                  </View>
                  <Ionicons name={pm.icon} size={18} color={paymentMethod === pm.id ? '#CA8A04' : '#6B7280'} style={{ marginRight: 10 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.pmLabel, paymentMethod === pm.id && styles.pmLabelSelected]}>{pm.label}</Text>
                    {pm.sub && <Text style={styles.pmSub}>{pm.sub}</Text>}
                  </View>
                </TouchableOpacity>
              ));
            })()}
          </View>
        </View>

        {/* Inline card entry — rendered below the selector when card is selected */}
        {paymentMethod === 'card' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Card Details</Text>
            <CardField
              postalCodeEnabled={true}
              style={{ height: 52, width: '100%' }}
              cardStyle={{
                backgroundColor: '#FFFFFF',
                textColor: '#1C1917',
                placeholderColor: '#9CA3AF',
                borderColor: '#E5E3DC',
                borderWidth: 1,
                borderRadius: 12,
              }}
              onCardChange={details => setCardDetails(details)}
            />
            {__DEV__ && (
              <Text style={{ fontSize: 11, color: '#9CA3AF', marginTop: 6 }}>
                Test mode: use card 4242 4242 4242 4242
              </Text>
            )}
          </View>
        )}

        {/* Affirm inline info block */}
        {paymentMethod === 'affirm' && (
          <View style={styles.section}>
            <View style={styles.affirmCard}>
              <Text style={styles.affirmTitle}>Affirm</Text>
              <Text style={styles.affirmSubtitle}>Pay over time · Subject to approval</Text>
              {affirmError ? (
                <Text style={styles.affirmError}>{affirmError}</Text>
              ) : liveVerifying ? (
                <Text style={styles.affirmSubtitle}>Verifying live availability…</Text>
              ) : ((isInventoryFallback && !liveVerified) || isInventoryStale) ? (
                <Text style={styles.affirmError}>
                  Affirm is unavailable until delivery and inventory are verified. Please try again or use a card.
                </Text>
              ) : null}
              {__DEV__ && affirmDevDetail ? (
                <Text style={{ fontSize: 11, color: '#92400E', marginTop: 4, fontFamily: 'monospace' }}>[dev] {affirmDevDetail}</Text>
              ) : null}
              <TouchableOpacity
                style={[styles.affirmBtn, (affirmLoading || liveVerifying || !selectedAddress || !activePlan || fulfillmentChoice === null || (isInventoryFallback && !liveVerified) || isInventoryStale || !isEmailVerified || deliveryUnavailable) && { opacity: 0.6 }]}
                disabled={affirmLoading || liveVerifying || !selectedAddress || !activePlan || fulfillmentChoice === null || (isInventoryFallback && !liveVerified) || isInventoryStale || !isEmailVerified || deliveryUnavailable}
                onPress={handleAffirmPayment}
                activeOpacity={0.8}
              >
                <Text style={styles.affirmBtnText}>
                  {affirmLoading ? 'Opening Affirm...' : 'Continue with Affirm'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Order Summary */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Review</Text>
            <TouchableOpacity onPress={() => navigation.goBack()}>
              <Text style={styles.editLink}>Edit</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={styles.card}
            onPress={() => setReviewExpanded(v => !v)}
            activeOpacity={0.7}
          >
            {!reviewExpanded ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={styles.summaryLabel}>
                  {orderItems.length} {orderItems.length === 1 ? 'item' : 'items'} · ${formatAmount(subtotal)}
                </Text>
                <Ionicons name="chevron-down-outline" size={16} color="#9CA3AF" />
              </View>
            ) : (
              <>
                {orderItems.map((item, idx) => (
                  <View
                    key={`${item.productId}-${idx}`}
                    style={[styles.orderItem, idx === orderItems.length - 1 && { borderBottomWidth: 0 }]}
                  >
                    <Image source={{ uri: variantUrl(item.img, { width: 320 }) }} style={styles.orderImg} cachePolicy="memory-disk" transition={150} />
                    <View style={styles.orderInfo}>
                      <Text style={styles.itemName} numberOfLines={2}>{item.name}</Text>
                      <Text style={styles.itemVariants}>
                        {[item.color, item.size].filter(Boolean).join(' · ')}
                      </Text>
                      <View style={styles.itemBottom}>
                        <Text style={styles.itemPrice}>${formatAmount(item.price * item.qty)}</Text>
                        <Text style={styles.itemQty}>Qty: {item.qty}</Text>
                      </View>
                    </View>
                  </View>
                ))}
                <View style={{ alignItems: 'center', paddingTop: 8 }}>
                  <Ionicons name="chevron-up-outline" size={16} color="#9CA3AF" />
                </View>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Summary + CTA */}
        <View style={styles.summaryCard}>
          <View style={styles.summaryLines}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Subtotal</Text>
              <Text style={styles.summaryValue}>${formatAmount(subtotal)}</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>
                {deliveryLoading ? 'Delivery' : isPickup ? 'Pickup' : shippingGroupCount > 1 ? `Delivery (${shippingGroupCount} warehouses)` : 'Delivery'}
              </Text>
              {deliveryLoading
                ? <Text style={styles.summaryCalculating}>Calculating…</Text>
                : !fulfillmentPlan
                  ? <Text style={styles.summaryCalculating}>–</Text>
                  : isPickup
                    ? <Text style={[styles.summaryFree, { color: '#CA8A04' }]}>Free</Text>
                    : deliveryUnavailable
                      ? <Text style={[styles.summaryCalculating, { color: '#B45309' }]}>Unavailable</Text>
                      : <Text style={styles.summaryValue}>${formatAmount(shipping)}</Text>}
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Tax</Text>
              <Text style={styles.summaryValue}>${formatAmount(tax)}</Text>
            </View>
            {isBuyNow && shoppingCredit > 0 && (
              <TouchableOpacity style={styles.summaryRow} onPress={() => setBuyNowCreditApplied(v => !v)}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <Ionicons name={buyNowCreditApplied ? 'checkmark-circle' : 'ellipse-outline'} size={15} color="#EAB320" />
                  <Text style={styles.summaryLabel}>Shopping credit</Text>
                </View>
                <Text style={[styles.summaryValue, { color: buyNowCreditApplied ? '#CA8A04' : '#9CA3AF' }]}>
                  {buyNowCreditApplied ? `Tap to remove` : `$${shoppingCredit.toFixed(2)} available`}
                </Text>
              </TouchableOpacity>
            )}
            {appliedCredit > 0 && (
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryLabel, { color: '#CA8A04' }]}>Shopping credit applied</Text>
                <Text style={[styles.summaryValue, { color: '#CA8A04' }]}>-${formatAmount(appliedCredit)}</Text>
              </View>
            )}
          </View>
          <View style={styles.summaryTotalBlock}>
            {/* Hairline between the line items and the figure they add up to. Everything above is
                detail; everything below is what gets charged. */}
            <View style={styles.summaryDivider} />
            <View style={styles.summaryTotalRow}>
              <Text style={styles.summaryTotalLabel}>Total</Text>
              <View style={styles.summaryTotalAmountWrap}>
                <Text style={styles.summaryTotalValue}>${formatAmount(total)}</Text>
                <Text style={styles.summaryTotalCurrency}>USD</Text>
              </View>
            </View>
            {isPickup && <Text style={styles.summaryTotalSub}>Pickup — no shipping fee</Text>}
            {reserveTimeLeft ? (
              <Text style={styles.reserveText}>🔒 Your price is reserved for {reserveTimeLeft}</Text>
            ) : null}
          </View>
          {!deliveryLoading && selectedAddress && !fulfillmentPlan && !isInventoryStale && (
            <View style={styles.placeOrderErrorNote}>
              <Text style={styles.placeOrderErrorText}>
                {deliveryErrorKind === 'geocode_failed'
                  ? "We couldn't verify this address. Please check the address and try again."
                  : deliveryErrorKind === 'fulfillment_unavailable'
                  ? "This item isn't available for delivery right now. Please choose another item or contact us."
                  : "We're having trouble checking this item right now. Please try again in a moment."}
              </Text>
            </View>
          )}
          {recheckError && (
            <View style={styles.placeOrderErrorNote}>
              <Text style={styles.placeOrderErrorText}>{recheckError}</Text>
            </View>
          )}
          {isInventoryStale && !deliveryLoading && (
            <View style={styles.placeOrderErrorNote}>
              <Text style={styles.placeOrderErrorText}>
                Availability is being updated. Please try again in a moment.
              </Text>
              <TouchableOpacity
                onPress={() => { setIsInventoryStale(false); setFulfillRetryKey(k => k + 1); }}
                style={{ marginTop: 6, alignSelf: 'flex-start' }}
                activeOpacity={0.7}
              >
                <Text style={styles.editLink}>Try Again →</Text>
              </TouchableOpacity>
            </View>
          )}
          {paymentMethod !== 'affirm' && (<><TouchableOpacity
            style={[styles.placeOrderBtn, (!selectedAddress || placing || deliveryLoading || rechecking || !activePlan || fulfillmentChoice === null || (paymentMethod === 'card' && !cardDetails?.complete) || isInventoryStale || !isEmailVerified || deliveryUnavailable) && { opacity: 0.6 }]}
            disabled={!selectedAddress || placing || deliveryLoading || rechecking || !activePlan || fulfillmentChoice === null || (paymentMethod === 'card' && !cardDetails?.complete) || isInventoryStale || !isEmailVerified || deliveryUnavailable}
            onPress={async () => {
              console.log('[Payment] button pressed', { hasAddress: !!selectedAddress, placing, deliveryLoading, rechecking, hasActivePlan: !!activePlan, fulfillmentChoice, amountCents: Math.round(total * 100) });
              if (!selectedAddress) {
                console.log('[Payment] blocked: no address selected');
                setShowAddForm(true); setAddrModalVisible(true); return;
              }
              if (placing || deliveryLoading || rechecking || !activePlan || fulfillmentChoice === null || deliveryUnavailable) {
                console.log('[Payment] blocked:', { placing, deliveryLoading, rechecking, hasActivePlan: !!activePlan, fulfillmentChoice });
                return;
              }
              if (!isEmailVerified) {
                console.log('[Payment] blocked: contact email not verified');
                return;
              }

              setRecheckError(null);
              setPlacing(true);

              if (debugEnabled(DEBUG_FLAGS.forcePaymentFailure)) {
                setRecheckError('Payment failed. Please try again.');
                setPlacing(false);
                return;
              }

              const result = await callCreateCheckoutOrder(paymentMethod);
              if (!result) {
                setRecheckError(priceChangedMsgRef.current ?? 'Unable to prepare your order. Please try again.');
                setPlacing(false);
                return;
              }

              const { clientSecret, paymentIntentId } = result;

              const _stripeKeyMode = (process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '').startsWith('pk_live') ? 'LIVE' : 'test';
              if (_stripeKeyMode === 'test') { console.warn('[Payment] Stripe is in test mode — set pk_live key before App Store submission'); }
              console.log('[Payment] selected method:', paymentMethod);
              console.log('[Payment] Stripe publishable key mode:', _stripeKeyMode);

              // ── Apple Pay: Platform Pay flow ──────────────────────────────────
              if (paymentMethod === 'apple_pay') {
                if (__DEV__) {
                  console.warn('[Payment] Apple Pay requires a development build / EAS build — will not work in Expo Go.');
                }
                const applePaySupported = await isPlatformPaySupported();
                if (!applePaySupported) {
                  setRecheckError('Apple Pay is not available on this device or build.');
                  setPlacing(false);
                  return;
                }
                const _merchantId = process.env.EXPO_PUBLIC_APPLE_MERCHANT_ID ?? 'merchant.com.xself.home';
                console.log('[Payment] Apple merchantIdentifier:', _merchantId);
                console.log('[Payment] merchantCountryCode: US | currencyCode: USD');
                const { error: applePayError } = await confirmPlatformPayPayment(clientSecret, {
                  applePay: {
                    cartItems: [
                      {
                        label: 'Xself',
                        amount: total.toFixed(2),
                        paymentType: PlatformPay.PaymentType.Immediate,
                      },
                    ],
                    merchantCountryCode: 'US',
                    currencyCode: 'USD',
                  },
                });
                console.log('[Payment] confirmPlatformPayPayment result:', applePayError?.message ?? 'ok', '| code:', (applePayError as any)?.code ?? null);
                if (applePayError) {
                  if ((applePayError as any).code === 'Canceled') {
                    setPlacing(false);
                    return;
                  }
                  setRecheckError(applePayError.message ?? 'Apple Pay failed. Please try again.');
                  setPlacing(false);
                  return;
                }
                // Apple Pay succeeded — fall through to order recording below
              } else {
                // ── Card: inline CardField ────────────────────────────────────────
                console.log('[CardPayment] confirming payment with inline card field');
                const { error: confirmError } = await confirmPayment(clientSecret, {
                  paymentMethodType: 'Card',
                  paymentMethodData: {
                    billingDetails: selectedAddress ? {
                      name: `${selectedAddress.first_name} ${selectedAddress.last_name}`,
                      address: {
                        line1: selectedAddress.address_line_1,
                        line2: selectedAddress.address_line_2 ?? undefined,
                        city: selectedAddress.city,
                        state: selectedAddress.state,
                        postalCode: selectedAddress.zip,
                        country: selectedAddress.country ?? 'US',
                      },
                    } : undefined,
                  },
                });
                console.log('[CardPayment] confirm result:', confirmError?.message ?? 'ok');
                if (confirmError) {
                  setRecheckError(confirmError.message ?? 'Payment failed. Please try again.');
                  setPlacing(false);
                  return;
                }
              }

              // Payment succeeded — webhook will finalize; navigate to OrderSuccess
              if (appliedCredit > 0) {
                recordCreditSpend(orderId.current, checkoutSessionId.current, appliedCredit);
              }
              orderItems.forEach(item => {
                if (item.productId) incrementProductCounter(item.productId, 'order_count');
              });
              if (!isBuyNow) clearCart();
              navigation.navigate('OrderSuccess', {
                total,
                orderId: orderId.current,
                orderNumber: orderNumber.current,
                checkoutSessionId: checkoutSessionId.current,
                userEmail: user?.email ?? '',
                paymentIntentId,
              });
            }}
          >
            <Text style={styles.placeOrderText}>{ctaLabel}</Text>
          </TouchableOpacity>
          <Text style={styles.placeOrderTrust}>Secured by Stripe · Your payment info is encrypted</Text>
          </>)}
        </View>
      </ScrollView>

      {/* Address Modal */}
      <Modal visible={addrModalVisible} transparent animationType="slide" onRequestClose={() => setAddrModalVisible(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <TouchableOpacity style={styles.addrOverlay} activeOpacity={1} onPress={() => setAddrModalVisible(false)}>
            <TouchableOpacity style={[styles.addrPanel, { paddingBottom: insets.bottom + 16 }]} activeOpacity={1} onPress={() => {}}>
              <View style={styles.addrHandleBar} />

              {!showAddForm ? (
                <>
                  <View style={styles.addrPanelHeader}>
                    <Text style={styles.addrPanelTitle}>Saved Addresses</Text>
                    <TouchableOpacity onPress={() => setAddrModalVisible(false)}>
                      <Ionicons name="close" size={20} color="#6B7280" />
                    </TouchableOpacity>
                  </View>

                  {addresses.length === 0 ? (
                    <Text style={styles.addrEmptyHint}>No saved addresses yet</Text>
                  ) : (
                    addresses.map(addr => (
                      <TouchableOpacity
                        key={addr.id}
                        style={styles.addrListItem}
                        onPress={() => { setSelectedAddress(addr); setAddrModalVisible(false); }}
                      >
                        <View style={[styles.addrRadio, selectedAddress?.id === addr.id && styles.addrRadioActive]}>
                          {selectedAddress?.id === addr.id && <View style={styles.addrRadioDot} />}
                        </View>
                        <View style={{ flex: 1, marginLeft: 10 }}>
                          <Text style={styles.addrName}>{addr.first_name} {addr.last_name}  ·  {addr.phone}</Text>
                          <Text style={styles.addrLine}>{addr.address_line_1}{addr.address_line_2 ? `, ${addr.address_line_2}` : ''}</Text>
                          <Text style={styles.addrLine}>{addr.city}, {addr.state} {addr.zip}</Text>
                        </View>
                      </TouchableOpacity>
                    ))
                  )}

                  <TouchableOpacity style={styles.addrAddBtn} onPress={() => setShowAddForm(true)}>
                    <Ionicons name="add" size={16} color="#CA8A04" />
                    <Text style={styles.addrAddBtnText}>Add New Address</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <View style={styles.addrPanelHeader}>
                    <TouchableOpacity onPress={() => setShowAddForm(false)} style={{ marginRight: 8 }}>
                      <Ionicons name="arrow-back" size={20} color="#6B7280" />
                    </TouchableOpacity>
                    <Text style={styles.addrPanelTitle}>Contact &amp; Delivery</Text>
                  </View>

                  <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                    <View style={styles.addrFormRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.infoLabel}>First Name</Text>
                        <TextInput style={styles.infoInput} value={addrFirstName} onChangeText={setAddrFirstName} placeholder="Jane" placeholderTextColor="#9CA3AF" autoCapitalize="words" />
                      </View>
                      <View style={{ width: 10 }} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.infoLabel}>Last Name</Text>
                        <TextInput style={styles.infoInput} value={addrLastName} onChangeText={setAddrLastName} placeholder="Smith" placeholderTextColor="#9CA3AF" autoCapitalize="words" />
                      </View>
                    </View>
                    <View style={styles.addrFormField}>
                      <Text style={styles.infoLabel}>Phone</Text>
                      <TextInput style={styles.infoInput} value={addrPhone} onChangeText={setAddrPhone} placeholder="(555) 000-0000" placeholderTextColor="#9CA3AF" keyboardType="phone-pad" />
                    </View>
                    {/* Email + OTP — verified contact email (logged-in session, or a
                        guest who completes the code here). Email input + Send share one
                        row; the code + Verify row appears only once a code is sent.
                        Editing the email after sending resets back to the send step. */}
                    <View style={styles.addrFormField}>
                      <Text style={styles.infoLabel}>Email</Text>
                      {isEmailVerified ? (
                        <View style={styles.otpVerifiedRow}>
                          <Ionicons name="checkmark-circle" size={15} color="#059669" />
                          <Text style={styles.otpVerifiedText} numberOfLines={1}>Verified · {user?.email}</Text>
                        </View>
                      ) : (
                        <>
                          <View style={styles.otpEmailRow}>
                            <TextInput
                              style={[styles.infoInput, { flex: 1 }]}
                              value={contactEmail}
                              onChangeText={t => { setContactEmail(t); if (otpStep === 'code') { setOtpStep('email'); setOtpCode(''); setOtpError(null); } }}
                              editable={!otpSending && !otpVerifying}
                              placeholder="you@email.com"
                              placeholderTextColor="#9CA3AF"
                              keyboardType="email-address"
                              autoCapitalize="none"
                              autoCorrect={false}
                              textContentType="emailAddress"
                            />
                            <TouchableOpacity
                              style={[styles.otpSendBtn, (!contactEmailValid || otpSending || otpCooldown > 0) && { opacity: 0.5 }]}
                              disabled={!contactEmailValid || otpSending || otpCooldown > 0}
                              onPress={handleSendOtp}
                              activeOpacity={0.85}
                            >
                              <Text style={styles.otpSendBtnText}>
                                {otpSending ? 'Sending…' : otpCooldown > 0 ? `${otpCooldown}s` : otpStep === 'code' ? 'Resend' : 'Send'}
                              </Text>
                            </TouchableOpacity>
                          </View>
                          {otpStep === 'code' && (
                            <View style={styles.otpCodeRow}>
                              <TextInput
                                ref={otpCodeRef}
                                style={[styles.infoInput, { flex: 1, letterSpacing: 4, textAlign: 'center' }]}
                                value={otpCode}
                                onChangeText={t => setOtpCode(t.replace(/\D/g, '').slice(0, 6))}
                                placeholder="6-digit code"
                                placeholderTextColor="#9CA3AF"
                                keyboardType="number-pad"
                                maxLength={6}
                                textContentType="oneTimeCode"
                                autoComplete="one-time-code"
                              />
                              <TouchableOpacity
                                style={[styles.otpSendBtn, (otpCode.length < 6 || otpVerifying) && { opacity: 0.5 }]}
                                disabled={otpCode.length < 6 || otpVerifying}
                                onPress={handleVerifyOtp}
                                activeOpacity={0.85}
                              >
                                <Text style={styles.otpSendBtnText}>{otpVerifying ? 'Verifying…' : 'Verify'}</Text>
                              </TouchableOpacity>
                            </View>
                          )}
                          {otpError ? <Text style={styles.otpErrorText}>{otpError}</Text> : null}
                        </>
                      )}
                    </View>
                    <View style={styles.addrFormField}>
                      <Text style={styles.infoLabel}>Address Line 1</Text>
                      <TextInput style={styles.infoInput} value={addrLine1} onChangeText={setAddrLine1} placeholder="123 Main St" placeholderTextColor="#9CA3AF" autoCapitalize="words" />
                    </View>
                    <View style={styles.addrFormField}>
                      <Text style={styles.infoLabel}>Address Line 2 <Text style={{ color: '#9CA3AF', fontWeight: '400' }}>(optional)</Text></Text>
                      <TextInput style={styles.infoInput} value={addrLine2} onChangeText={setAddrLine2} placeholder="Apt, Suite, etc." placeholderTextColor="#9CA3AF" autoCapitalize="words" />
                    </View>
                    <View style={styles.addrFormRow}>
                      <View style={{ flex: 2 }}>
                        <Text style={styles.infoLabel}>City</Text>
                        <TextInput style={styles.infoInput} value={addrCity} onChangeText={setAddrCity} placeholder="New York" placeholderTextColor="#9CA3AF" autoCapitalize="words" />
                      </View>
                      <View style={{ width: 10 }} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.infoLabel}>State</Text>
                        <TextInput style={styles.infoInput} value={addrStateVal} onChangeText={setAddrStateVal} placeholder="NY" placeholderTextColor="#9CA3AF" autoCapitalize="characters" maxLength={2} />
                      </View>
                      <View style={{ width: 10 }} />
                      <View style={{ flex: 1.2 }}>
                        <Text style={styles.infoLabel}>ZIP</Text>
                        <TextInput style={styles.infoInput} value={addrZip} onChangeText={t => setAddrZip(t.replace(/\D/g, '').slice(0, 5))} placeholder="10001" placeholderTextColor="#9CA3AF" keyboardType="number-pad" maxLength={5} />
                      </View>
                    </View>
                    <TouchableOpacity
                      style={[styles.addrSaveBtn, (!addrFormValid || addrSaving || !isEmailVerified) && { opacity: 0.5 }]}
                      disabled={!addrFormValid || addrSaving || !isEmailVerified}
                      onPress={async () => {
                        if (addrSaving) return;
                        setAddrSaveError(null);
                        setAddrSaving(true);
                        try {
                          if (debugEnabled(DEBUG_FLAGS.forceAddressSaveFailure)) {
                            throw new Error('DEBUG_FORCE_ADDRESS_SAVE_FAILURE');
                          }
                          const input = {
                            first_name: addrFirstName.trim(),
                            last_name: addrLastName.trim(),
                            phone: addrPhone.trim(),
                            address_line_1: addrLine1.trim(),
                            address_line_2: addrLine2.trim() || null,
                            city: addrCity.trim(),
                            state: addrStateVal.trim().toUpperCase(),
                            zip: addrZip,
                            is_default: addresses.length === 0,
                          };
                          let saved: Address;
                          if (user) {
                            saved = await insertAddress(user.id, input);
                          } else {
                            // Guest: local only
                            saved = { ...input, id: `local-${Date.now()}`, user_id: '', country: 'US',
                              address_line_2: input.address_line_2 ?? null,
                              is_default: input.is_default ?? false,
                              created_at: '', updated_at: '' };
                          }
                          setAddresses(prev => [...prev, saved]);
                          setSelectedAddress(saved);
                          setAddrFirstName(''); setAddrLastName(''); setAddrPhone('');
                          setAddrLine1(''); setAddrLine2(''); setAddrCity(''); setAddrStateVal(''); setAddrZip('');
                          setAddrSaveError(null);
                          setShowAddForm(false);
                          setAddrModalVisible(false);
                        } catch {
                          setAddrSaveError('Failed to save address. Please try again.');
                        } finally {
                          setAddrSaving(false);
                        }
                      }}
                    >
                      <Text style={styles.addrSaveBtnText}>Save & Use</Text>
                    </TouchableOpacity>
                    {addrSaveError && (
                      <Text style={styles.addrSaveError}>{addrSaveError}</Text>
                    )}
                  </ScrollView>
                </>
              )}
            </TouchableOpacity>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F3F1EB' },
  title: { fontSize: 22, fontWeight: '600', color: '#1C1917', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 2 },
  titleSub: { fontSize: 13, color: '#9CA3AF', paddingHorizontal: 20, paddingBottom: 10 },

  // Contact-email OTP verify (guest checkout)
  otpHelp: { fontSize: 12, color: '#6B7280', marginBottom: 10, lineHeight: 17 },
  otpErrorText: { fontSize: 12, color: '#B45309', marginTop: 8 },
  otpVerifiedRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#ECFDF5', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12 },
  otpVerifiedText: { fontSize: 13, color: '#065F46', fontWeight: '500', flex: 1 },
  emailVerifiedNote: { fontSize: 11, color: '#9CA3AF', marginTop: 6 },
  // Email + Send / code + Verify share a row; default stretch makes the compact
  // button match the input height.
  otpEmailRow: { flexDirection: 'row', gap: 8 },
  otpCodeRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  otpSendBtn: { backgroundColor: '#EAB320', borderRadius: 6, paddingHorizontal: 16, minWidth: 80, alignItems: 'center', justifyContent: 'center' },
  otpSendBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },

  section: { paddingHorizontal: 20, paddingBottom: 8 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: '#1C1917', marginBottom: 12 },
  editLink: { fontSize: 13, color: '#CA8A04', fontWeight: '500' },

  card: { backgroundColor: 'white', borderRadius: 6, padding: 16 },
  cardRow: { flexDirection: 'row', alignItems: 'center' },

  addressName: { fontSize: 14, fontWeight: '600', color: '#1C1917' },
  addressText: { fontSize: 13, color: '#6B7280', marginTop: 3 },
  deliveryEstimate: { fontSize: 12, color: '#CA8A04', marginTop: 7, fontWeight: '500' },

  pmRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  pmRowBorder: { borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  pmRadio: {
    width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#D1D5DB',
    alignItems: 'center', justifyContent: 'center', marginRight: 10,
  },
  pmRadioSelected: { borderColor: '#EAB320' },
  pmRadioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#EAB320' },
  pmLabel: { fontSize: 14, color: '#1C1917', fontWeight: '500' },
  pmLabelSelected: { color: '#92400E' },
  pmSub: { fontSize: 11, color: '#9CA3AF', marginTop: 1 },

  paymentRow: { flexDirection: 'row', alignItems: 'center' },
  cardIcon: { fontSize: 18, marginRight: 8 },
  cardText: { fontSize: 14, color: '#1C1917', fontWeight: '500' },
  secureRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  secureText: { fontSize: 11, color: '#CA8A04' },

  orderItem: { flexDirection: 'row', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  orderImg: { width: 56, height: 56, borderRadius: 6, backgroundColor: '#F3F4F6' },
  orderInfo: { flex: 1, marginLeft: 10 },
  itemName: { fontSize: 13, color: '#1C1917', fontWeight: '500', lineHeight: 18 },
  itemVariants: { fontSize: 11, color: '#9CA3AF', marginTop: 2 },
  itemBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 },
  itemPrice: { fontSize: 15, fontWeight: '700', color: '#1C1917' },
  itemQty: { fontSize: 11, color: '#9CA3AF' },

  summaryCard: { marginHorizontal: 20, marginBottom: 8, backgroundColor: 'white', borderRadius: 6, padding: 16 },
  summaryLines: { marginBottom: 4 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  summaryLabel: { fontSize: 13, lineHeight: 20, color: '#9CA3AF' },
  summaryValue: { fontSize: 13, lineHeight: 20, color: '#4B5563', textAlign: 'right' as const },
  summaryFree: { fontSize: 13, lineHeight: 20, color: '#4B5563', textAlign: 'right' as const },
  summaryTotalBlock: { paddingTop: 6, paddingBottom: 20 },
  summaryDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#E7E5E4', marginBottom: 14 },
  summaryTotalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  summaryTotalAmountWrap: { alignItems: 'flex-end' },
  summaryTotalCurrency: { fontSize: 11, lineHeight: 14, color: '#9CA3AF', marginTop: 2 },
  summaryTotalLabel: { fontSize: 16, lineHeight: 28, color: '#1C1917', fontWeight: '600' as const },
  // Same size as its own label; the emphasis comes from weight, not scale. Three points above
  // the detail rows is enough to read as "this is the one that matters" without becoming a
  // headline price.
  summaryTotalValue: { fontSize: 16, lineHeight: 28, fontWeight: '700' as const, color: '#111111' },
  summaryTotalSub: { fontSize: 11, color: '#9CA3AF', marginTop: 4 },


  gateBackBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 4 },
  gateBackText: { fontSize: 14, color: '#6B7280' },
  gateWrap: { flex: 1, alignItems: 'center', paddingHorizontal: 32, paddingTop: 36, paddingBottom: 32 },
  gateIconWrap: { width: 52, height: 52, borderRadius: 16, backgroundColor: '#FFFBEB', alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  gateTitle: { fontSize: 22, fontWeight: '700', color: '#1C1917', textAlign: 'center', marginBottom: 10 },
  gateSub: { fontSize: 14, color: '#6B7280', textAlign: 'center', lineHeight: 20, marginBottom: 32 },
  gateSignInBtn: { backgroundColor: '#EAB320', paddingVertical: 15, borderRadius: 8, alignItems: 'center', alignSelf: 'stretch', marginBottom: 12 },
  gateSignInText: { color: 'white', fontSize: 15, fontWeight: '700' },
  gateGuestBtn: { paddingVertical: 14, borderRadius: 8, alignItems: 'center', alignSelf: 'stretch', borderWidth: 1, borderColor: '#E5E7EB', backgroundColor: '#F9FAFB', marginBottom: 28 },
  gateGuestText: { fontSize: 15, fontWeight: '500', color: '#374151' },
  gateDivider: { alignSelf: 'stretch', height: 1, backgroundColor: '#F3F4F6', marginBottom: 20 },
  gateBenefits: { gap: 6, alignItems: 'center' },
  gateBenefit: { fontSize: 12, color: '#9CA3AF' },
  placeOrderBtn: { backgroundColor: '#EAB320', paddingVertical: 16, borderRadius: 10, alignItems: 'center', marginTop: 4 },
  placeOrderText: { color: 'white', fontSize: 15, fontWeight: '700' },
  placeOrderTrust: { fontSize: 11, color: '#9CA3AF', textAlign: 'center', marginTop: 10 },

  affirmCard: { backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1, borderColor: '#E5E3DC', padding: 18 },
  affirmTitle: { fontSize: 16, fontWeight: '600' as const, color: '#1C1917', marginBottom: 4 },
  affirmSubtitle: { fontSize: 13, color: '#6B7280', lineHeight: 18, marginBottom: 6 },
  affirmDivider: { height: 1, backgroundColor: '#E5E3DC', marginVertical: 10 },
  affirmDetail: { fontSize: 13, color: '#4B5563', lineHeight: 22 },
  affirmError: { fontSize: 13, color: '#DC2626', marginTop: 10, lineHeight: 18 },
  affirmBtn: { marginTop: 16, backgroundColor: '#1C1917', borderRadius: 10, paddingVertical: 14, alignItems: 'center' as const },
  affirmBtnText: { fontSize: 15, fontWeight: '600' as const, color: '#FFFFFF', letterSpacing: 0.2 },
  reserveText: { fontSize: 11, color: '#CA8A04', fontWeight: '500', marginTop: 6 },
  demoBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 20, marginBottom: 8, backgroundColor: '#FFFBEB', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: '#FDE68A' },
  demoBannerText: { fontSize: 12, color: '#92660A', flex: 1 },

  infoLabel: { fontSize: 11, fontWeight: '600', color: '#6B7280', letterSpacing: 0.6, textTransform: 'uppercase' as const, marginBottom: 6 },
  infoInput: { fontSize: 14, color: '#1C1917', backgroundColor: '#F9FAFB', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: '#E5E7EB' },

  addrRow: { flexDirection: 'row', alignItems: 'flex-start' },
  addrName: { fontSize: 13, fontWeight: '600', color: '#1C1917', marginBottom: 3 },
  addrLine: { fontSize: 13, color: '#6B7280', lineHeight: 18 },
  addrChangeBtn: { fontSize: 13, color: '#CA8A04', fontWeight: '600', paddingLeft: 12 },
  addrOverlay: { flex: 1, backgroundColor: 'rgba(64,63,61,0.4)', justifyContent: 'flex-end' },
  addrPanel: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, maxHeight: '85%' as any },
  addrHandleBar: { width: 36, height: 4, backgroundColor: '#C8C6BF', borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  addrPanelHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  addrPanelTitle: { flex: 1, fontSize: 16, fontWeight: '600', color: '#1C1917' },
  addrEmptyHint: { fontSize: 13, color: '#9CA3AF', textAlign: 'center', paddingVertical: 16 },
  addrListItem: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#F3F4F6' },
  addrRadio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#D1CFC9', alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  addrRadioActive: { borderColor: '#EAB320' },
  addrRadioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#EAB320' },
  addrAddBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#F3F4F6', marginTop: 8 },
  addrAddBtnText: { fontSize: 14, color: '#CA8A04', fontWeight: '500' },
  addrFormRow: { flexDirection: 'row', marginBottom: 12 },
  addrFormField: { marginBottom: 12 },
  addrSaveBtn: { backgroundColor: '#EAB320', borderRadius: 8, height: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8, marginBottom: 16 },
  addrSaveBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },

  fulfillGroupLabel: { fontSize: 11, fontWeight: '600', color: '#9CA3AF', letterSpacing: 0.5, textTransform: 'uppercase' as const, marginBottom: 6 },
  fulfillItemList: { marginTop: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#F3F4F6' },
  fulfillItemRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 3 },
  fulfillItemName: { flex: 1, fontSize: 12, color: '#6B7280', marginRight: 8 },
  fulfillItemQty: { fontSize: 12, color: '#9CA3AF', fontWeight: '500' },
  fulfillErrorBanner: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#FEF2F2', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: '#FECACA' },
  fulfillErrorText: { flex: 1, fontSize: 13, color: '#B45309', lineHeight: 18 },
  placeOrderErrorNote: { backgroundColor: '#FEF2F2', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 10, borderWidth: 1, borderColor: '#FECACA' },
  placeOrderErrorText: { fontSize: 12, color: '#B45309', textAlign: 'center' as const, lineHeight: 17 },
  fulfillFallbackBanner: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 8, backgroundColor: '#FFFBEB', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1, borderColor: '#FDE68A' },
  fulfillFallbackText: { flex: 1, fontSize: 12, color: '#92660A', lineHeight: 17 },
  addrSaveError: { marginTop: 8, fontSize: 13, color: '#B45309', textAlign: 'center' },
  debugBadge: { backgroundColor: '#92660A', paddingVertical: 4, paddingHorizontal: 12, alignSelf: 'center', borderRadius: 4, marginVertical: 4 },
  debugBadgeText: { color: '#FFFBEB', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },

  summaryCalculating: { fontSize: 13, lineHeight: 20, color: '#9CA3AF', fontStyle: 'italic' as const },
  fulfillRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  radioOuter: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#D1CFC9', alignItems: 'center', justifyContent: 'center' },
  radioOuterActive: { borderColor: '#EAB320' },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#EAB320' },
  fulfillLabel: { fontSize: 13, fontWeight: '500', color: '#6B7280' },
  fulfillLabelActive: { color: '#1C1917', fontWeight: '600' },
  fulfillSub: { fontSize: 12, color: '#9CA3AF', marginTop: 1 },
  fulfillWarehouse: { fontSize: 11, color: '#9CA3AF', marginTop: 3 },
  fulfillStock: { fontSize: 11, color: '#B5B5B5', marginTop: 4 },
  fulfillDivider: { height: 1, backgroundColor: '#F3F4F6', marginVertical: 2 },

  // Fulfillment option selector (req 9 — explicit choice)
  fulfillChoiceHint: { fontSize: 12, color: '#6B7280', fontWeight: '500', marginBottom: 8 },
  fulfillOptionCard: {
    backgroundColor: 'white', borderRadius: 6, padding: 14,
    flexDirection: 'row', alignItems: 'flex-start',
    borderWidth: 1.5, borderColor: '#E5E7EB',
  },
  fulfillOptionSelected: { borderColor: '#EAB320', backgroundColor: '#FFFDF0' },
  fulfillOptionLabel: { fontSize: 13, fontWeight: '600', color: '#1C1917', marginBottom: 3 },
  fulfillOptionSub: { fontSize: 12, color: '#6B7280', lineHeight: 17, marginTop: 1 },

  // Pickup-specific display (req 15)
  pickupDatesRow: { flexDirection: 'row', alignItems: 'center', marginTop: 5 },
  pickupDateLabel: { fontSize: 12, color: '#374151', fontWeight: '500' },
  pickupDateSep: { fontSize: 12, color: '#9CA3AF' },
  pickupTimeWindow: { fontSize: 12, color: '#CA8A04', fontWeight: '500', marginTop: 3 },
  pickupNotice: { fontSize: 11, color: '#9CA3AF', marginTop: 5, fontStyle: 'italic' as const },
});
