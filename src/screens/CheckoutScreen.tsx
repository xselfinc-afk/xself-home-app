import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, Image, TouchableOpacity, ScrollView, StyleSheet, TextInput, Modal, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useCart } from '../context/CartContext';
import { formatPrice } from '../data/products';
import { useRewards } from '../context/RewardsContext';
import { useAuth } from '../context/AuthContext';
import { useOrders } from '../context/OrdersContext';
import { Address, fetchAddresses, insertAddress } from '../services/addressService';
import { fetchSkuWarehouseStock } from '../services/gigaInventoryService';
import { planFulfillment, planFulfillmentFallback, FulfillmentPlan, SHIPPING_FEE } from '../services/fulfillmentPlanner';

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

export default function CheckoutScreen({ route, navigation }: any) {
  const { cart, reserveExpiry } = useCart();
  const { shoppingCredit, recordCreditSpend } = useRewards();
  const { user, isGuest, continueAsGuest } = useAuth();
  const { addOrder } = useOrders();
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
  const { mode, product, qty: buyQty, selectedVariant } = route?.params ?? {};


  const today = new Date();
  const d1 = new Date(today); d1.setDate(today.getDate() + 2);
  const d2 = new Date(today); d2.setDate(today.getDate() + 5);
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const deliveryRange = `${fmt(d1)}–${fmt(d2)}`;

  // ── Order items based on mode ──────────────────────────────────────────────
  const isBuyNow = mode === 'buy_now';

  type OrderItem = {
    sku: string;
    name: string;
    img: string;
    price: number;
    qty: number;
    color?: string;
    size?: string;
  };

  const orderItems: OrderItem[] = isBuyNow
    ? [{
        sku: selectedVariant?.sku ?? `product-${product?.id}`,
        name: product?.name ?? '',
        img: selectedVariant?.images?.[0] ?? product?.images?.[0] ?? '',
        price: selectedVariant?.price ?? product?.price ?? 0,
        qty: buyQty ?? 1,
        color: selectedVariant?.color,
        size: selectedVariant?.size,
      }]
    : cart.map(item => ({
        sku: item.sku,
        name: item.name,
        img: item.img,
        price: item.price,
        qty: item.qty,
        color: item.color,
        size: item.size,
      }));

  const [fulfillmentPlan, setFulfillmentPlan] = useState<FulfillmentPlan | null>(null);
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState<string | null>(null);
  // No default fee while loading — show 0 until the plan resolves
  const shipping = fulfillmentPlan?.totalShipping ?? 0;
  const isPickup = fulfillmentPlan !== null && fulfillmentPlan.groups.length > 0 && fulfillmentPlan.groups.every(g => g.isPickup);
  // Only non-pickup groups count as "shipments" for the label
  const shippingGroupCount = fulfillmentPlan ? fulfillmentPlan.groups.filter(g => !g.isPickup).length : 0;

  const subtotal = orderItems.reduce((sum, item) => sum + item.price * item.qty, 0);
  const tax = Math.round(subtotal * 0.075);
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

  // Address system
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<Address | null>(null);
  const [addrModalVisible, setAddrModalVisible] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addrSaving, setAddrSaving] = useState(false);

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

  // Stable key to detect cart content changes (SKU or quantity)
  const orderItemsKey = orderItems.map(i => `${i.sku}:${i.qty}`).join(',');

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

    const skus = orderItems.map(item => item.sku);
    console.log('[Checkout] Fetching inventory for SKUs:', skus);

    fetchSkuWarehouseStock(skus)
      .then(inventory => {
        if (cancelled) return;
        console.log('[Checkout] Inventory fetched, planning fulfillment...');
        return planFulfillment(
          orderItems.map(item => ({
            sku: item.sku,
            productId: item.sku,
            name: item.name,
            price: item.price,
            img: item.img,
            qty: item.qty,
          })),
          addressString,
          inventory,
        );
      })
      .catch(err => {
        if (cancelled) return undefined;
        console.log('[Checkout] Inventory/fulfillment error, falling back:', (err as Error).message);
        return planFulfillmentFallback(
          orderItems.map(item => ({
            sku: item.sku,
            productId: item.sku,
            name: item.name,
            price: item.price,
            img: item.img,
            qty: item.qty,
          })),
          addressString,
        );
      })
      .then(plan => {
        if (cancelled || !plan) return;
        console.log(
          `[Checkout] Fulfillment plan: ${plan.groups.length} group(s), totalShipping=$${plan.totalShipping}, fallback=${plan.isFallback}`,
        );
        plan.groups.forEach((g, i) => {
          console.log(
            `[Checkout]  Group ${i + 1}: ${g.warehouse.code} ${g.distanceMiles.toFixed(1)}mi — ${g.isPickup ? 'PICKUP' : 'SHIP $' + g.shipping} — ${g.items.length} item(s)`,
          );
        });
        setFulfillmentPlan(plan);
      })
      .catch(err => {
        if (cancelled) return;
        console.log('[Checkout] Fulfillment fallback also failed:', (err as Error).message);
        setFulfillmentPlan(null);
      })
      .finally(() => {
        if (!cancelled) setDeliveryLoading(false);
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAddress?.id, orderItemsKey]);
  const [addrFirstName, setAddrFirstName] = useState('');
  const [addrLastName, setAddrLastName] = useState('');
  const [addrPhone, setAddrPhone] = useState('');
  const [addrLine1, setAddrLine1] = useState('');
  const [addrLine2, setAddrLine2] = useState('');
  const [addrCity, setAddrCity] = useState('');
  const [addrStateVal, setAddrStateVal] = useState('');
  const [addrZip, setAddrZip] = useState('');
  const addrFormValid = addrFirstName.trim() && addrLastName.trim() && addrPhone.trim() &&
    addrLine1.trim() && addrCity.trim() && addrStateVal.trim() && addrZip.length === 5;

  type PaymentMethod = 'apple_pay' | 'card' | 'paypal';
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('apple_pay');

  // Prevent double-tap / duplicate recordCreditSpend calls
  const [placing, setPlacing] = useState(false);

  // Reset placing if user navigates back from OrderSuccess
  useFocusEffect(useCallback(() => { setPlacing(false); }, []));

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

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 140 }}>
        <Text style={styles.title}>Checkout</Text>
        <Text style={styles.titleSub}>Review your order before placing</Text>

        {/* Demo banner */}
        <View style={styles.demoBanner}>
          <Ionicons name="information-circle-outline" size={14} color="#92660A" />
          <Text style={styles.demoBannerText}>Demo mode — no payment will be charged</Text>
        </View>

        {/* Shipping Address */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Shipping Address</Text>
          {selectedAddress ? (
            <View style={styles.card}>
              <View style={styles.addrRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.addrName}>{selectedAddress.first_name} {selectedAddress.last_name}  ·  {selectedAddress.phone}</Text>
                  <Text style={styles.addrLine}>{selectedAddress.address_line_1}{selectedAddress.address_line_2 ? `, ${selectedAddress.address_line_2}` : ''}</Text>
                  <Text style={styles.addrLine}>{selectedAddress.city}, {selectedAddress.state} {selectedAddress.zip}</Text>
                </View>
                <TouchableOpacity onPress={() => { setShowAddForm(false); setAddrModalVisible(true); }}>
                  <Text style={styles.addrChangeBtn}>Change</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity style={styles.addrEmpty} onPress={() => { setShowAddForm(true); setAddrModalVisible(true); }}>
              <Ionicons name="add-circle-outline" size={18} color="#CA8A04" />
              <Text style={styles.addrEmptyText}>Add shipping address</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Delivery */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Delivery</Text>
          {deliveryLoading && (
            <View style={styles.card}>
              <Text style={styles.fulfillSub}>Checking availability…</Text>
            </View>
          )}
          {!deliveryLoading && !fulfillmentPlan && selectedAddress && (
            <View style={styles.fulfillErrorBanner}>
              <Ionicons name="alert-circle-outline" size={16} color="#B45309" />
              <Text style={styles.fulfillErrorText}>
                Unable to determine delivery options. Please check your address or try again.
              </Text>
            </View>
          )}
          {!deliveryLoading && fulfillmentPlan && fulfillmentPlan.groups.map((group, idx) => (
            <View key={group.warehouse.code} style={[styles.card, idx > 0 && { marginTop: 8 }]}>
              {fulfillmentPlan.groups.length > 1 && (
                <Text style={styles.fulfillGroupLabel}>
                  Shipment {idx + 1} of {fulfillmentPlan.groups.length}
                </Text>
              )}
              <View style={styles.fulfillRow}>
                <Ionicons
                  name={group.isPickup ? 'storefront-outline' : 'cube-outline'}
                  size={15}
                  color="#CA8A04"
                />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={[styles.fulfillLabel, styles.fulfillLabelActive]}>
                    {group.isPickup ? 'Warehouse Pickup — Free' : `Shipping — $${group.shipping}`}
                  </Text>
                  <Text style={styles.fulfillSub}>
                    {group.isPickup ? 'Pickup available at this warehouse' : 'Delivered to your address'}
                  </Text>
                  <Text style={styles.fulfillWarehouse}>
                    {group.warehouse.label ?? group.warehouse.code} · {group.distanceMiles.toFixed(1)} mi
                  </Text>
                  {group.isPickup && (
                    <Text style={styles.fulfillWarehouse}>
                      Pickup address: {group.warehouse.address.replace(', United States', '')}
                    </Text>
                  )}
                  <Text style={styles.fulfillWarehouse}>{group.estimatedDelivery}</Text>
                </View>
              </View>
              {fulfillmentPlan.groups.length > 1 && group.items.length > 0 && (
                <View style={styles.fulfillItemList}>
                  {group.items.map(item => (
                    <View key={item.sku} style={styles.fulfillItemRow}>
                      <Text style={styles.fulfillItemName} numberOfLines={1}>{item.name}</Text>
                      <Text style={styles.fulfillItemQty}>×{item.qty}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          ))}
          {!deliveryLoading && fulfillmentPlan?.isFallback && (
            <View style={styles.fulfillFallbackBanner}>
              <Ionicons name="warning-outline" size={13} color="#92660A" />
              <Text style={styles.fulfillFallbackText}>
                Live inventory unavailable — delivery estimate is based on location only
              </Text>
            </View>
          )}
        </View>

        {/* Payment */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Payment</Text>
          <View style={styles.card}>
            {([
              { id: 'apple_pay', icon: 'logo-apple', label: 'Apple Pay', sub: 'Recommended' },
              { id: 'card',      icon: 'card-outline',   label: 'Credit / Debit Card', sub: '•••• •••• •••• ––––' },
              { id: 'paypal',    icon: 'logo-paypal',    label: 'PayPal', sub: null },
            ] as { id: PaymentMethod; icon: any; label: string; sub: string | null }[]).map((pm, idx, arr) => (
              <TouchableOpacity
                key={pm.id}
                style={[styles.pmRow, idx < arr.length - 1 && styles.pmRowBorder]}
                onPress={() => setPaymentMethod(pm.id)}
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
            ))}
          </View>
        </View>

        {/* Order Summary */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Order Summary</Text>
            <TouchableOpacity onPress={() => navigation.goBack()}>
              <Text style={styles.editLink}>Edit</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.card}>
            {orderItems.map((item, idx) => (
              <View
                key={item.sku}
                style={[styles.orderItem, idx === orderItems.length - 1 && { borderBottomWidth: 0 }]}
              >
                <Image source={{ uri: item.img }} style={styles.orderImg} />
                <View style={styles.orderInfo}>
                  <Text style={styles.itemName} numberOfLines={2}>{item.name}</Text>
                  <Text style={styles.itemVariants}>
                    {[item.color, item.size].filter(Boolean).join(' · ')}
                  </Text>
                  <View style={styles.itemBottom}>
                    <Text style={styles.itemPrice}>${formatPrice(item.price * item.qty)}</Text>
                    <Text style={styles.itemQty}>Qty: {item.qty}</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* Summary + CTA */}
        <View style={styles.summaryCard}>
          <View style={styles.summaryLines}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Subtotal</Text>
              <Text style={styles.summaryValue}>${formatPrice(subtotal)}</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>
                {deliveryLoading ? 'Shipping' : isPickup ? 'Pickup' : shippingGroupCount > 1 ? `Shipping (${shippingGroupCount} shipments)` : 'Shipping'}
              </Text>
              {deliveryLoading
                ? <Text style={styles.summaryCalculating}>Calculating…</Text>
                : shipping === 0
                  ? <Text style={[styles.summaryFree, { color: '#CA8A04' }]}>Free</Text>
                  : <Text style={styles.summaryValue}>${formatPrice(shipping)}</Text>}
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Tax</Text>
              <Text style={styles.summaryValue}>${formatPrice(tax)}</Text>
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
                <Text style={[styles.summaryValue, { color: '#CA8A04' }]}>-${formatPrice(appliedCredit)}</Text>
              </View>
            )}
          </View>
          <View style={styles.summaryTotalBlock}>
            <Text style={styles.summaryTotalLabel}>Total</Text>
            <Text style={styles.summaryTotalValue}>${formatPrice(total)}</Text>
            {isPickup && <Text style={styles.summaryTotalSub}>Pickup — no shipping fee</Text>}
            {reserveTimeLeft ? (
              <Text style={styles.reserveText}>🔒 Your price is reserved for {reserveTimeLeft}</Text>
            ) : null}
          </View>
          {!deliveryLoading && selectedAddress && !fulfillmentPlan && (
            <View style={styles.placeOrderErrorNote}>
              <Text style={styles.placeOrderErrorText}>
                Delivery could not be resolved. Check your address and try again.
              </Text>
            </View>
          )}
          {recheckError && (
            <View style={styles.placeOrderErrorNote}>
              <Text style={styles.placeOrderErrorText}>{recheckError}</Text>
            </View>
          )}
          <TouchableOpacity
            style={[styles.placeOrderBtn, (!selectedAddress || placing || deliveryLoading || rechecking || (selectedAddress && !fulfillmentPlan)) && { opacity: 0.6 }]}
            disabled={placing || deliveryLoading || rechecking || (selectedAddress != null && !fulfillmentPlan)}
            onPress={async () => {
              if (!selectedAddress) { setShowAddForm(true); setAddrModalVisible(true); return; }
              if (placing || deliveryLoading || rechecking || !fulfillmentPlan) return;

              // Final inventory recheck before submission
              setRecheckError(null);
              setRechecking(true);
              try {
                const skus = orderItems.map(item => item.sku);
                const freshInventory = await fetchSkuWarehouseStock(skus);
                const addrParts = [
                  selectedAddress.address_line_1,
                  selectedAddress.address_line_2,
                  selectedAddress.city,
                  `${selectedAddress.state} ${selectedAddress.zip}`,
                  selectedAddress.country,
                ].filter(Boolean);
                const freshPlan = await planFulfillment(
                  orderItems.map(item => ({ sku: item.sku, productId: item.sku, name: item.name, price: item.price, img: item.img, qty: item.qty })),
                  addrParts.join(', '),
                  freshInventory,
                );
                const prevFp = planFingerprint(fulfillmentPlan);
                const freshFp = planFingerprint(freshPlan);
                console.log(`[Checkout] Recheck fingerprint — prev: ${prevFp}`);
                console.log(`[Checkout] Recheck fingerprint — fresh: ${freshFp}`);
                const changed = freshFp !== prevFp;
                if (changed) {
                  // Build a concise human-readable description of what changed
                  const reasons: string[] = [];

                  if (freshPlan.groups.length !== fulfillmentPlan.groups.length) {
                    reasons.push(`shipment count changed (${fulfillmentPlan.groups.length} → ${freshPlan.groups.length})`);
                  }
                  if (freshPlan.totalShipping !== fulfillmentPlan.totalShipping) {
                    reasons.push(`shipping fee changed ($${fulfillmentPlan.totalShipping} → $${freshPlan.totalShipping})`);
                  }

                  // SKU-level: detect warehouse reassignment and pickup↔shipping flips
                  const oldSkuMap = new Map<string, { code: string; isPickup: boolean }>();
                  for (const g of fulfillmentPlan.groups) {
                    for (const item of g.items) oldSkuMap.set(item.sku, { code: g.warehouse.code, isPickup: g.isPickup });
                  }
                  let warehouseReassigned = false;
                  let pickupFlipped = false;
                  for (const g of freshPlan.groups) {
                    for (const item of g.items) {
                      const prev = oldSkuMap.get(item.sku);
                      if (!prev) continue;
                      if (prev.code !== g.warehouse.code) warehouseReassigned = true;
                      if (prev.isPickup !== g.isPickup) pickupFlipped = true;
                    }
                  }
                  if (warehouseReassigned) reasons.push('warehouse assignment changed');
                  if (pickupFlipped) {
                    const hadPickup = fulfillmentPlan.groups.some(g => g.isPickup);
                    const hasPickup = freshPlan.groups.some(g => g.isPickup);
                    if (hadPickup && !hasPickup) reasons.push('pickup no longer available — shipping now required');
                    else if (!hadPickup && hasPickup) reasons.push('pickup now available at a nearby warehouse');
                    else reasons.push('pickup/shipping status changed');
                  }

                  const summary = reasons.length > 0 ? reasons.join('; ') : 'delivery details updated';
                  setFulfillmentPlan(freshPlan);
                  setRecheckError(`Delivery changed: ${summary}. Please review before placing your order.`);
                  setRechecking(false);
                  return;
                }
              } catch (err) {
                console.log('[Checkout] Recheck failed:', (err as Error).message);
                setRecheckError('Could not verify current inventory. Please try again.');
                setRechecking(false);
                return;
              }
              setRechecking(false);
              setPlacing(true);
              if (appliedCredit > 0) {
                recordCreditSpend(orderId.current, checkoutSessionId.current, appliedCredit);
              }

              // Build SKU → warehouseCode map for item enrichment
              const skuWarehouseMap = new Map<string, string>();
              fulfillmentPlan!.groups.forEach(g => {
                g.items.forEach(item => skuWarehouseMap.set(item.sku, g.warehouse.code));
              });

              addOrder({
                orderId: orderId.current,
                orderNumber: orderNumber.current,
                date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                total,
                status: 'processing',
                items: orderItems.map(item => ({
                  ...item,
                  warehouseCode: skuWarehouseMap.get(item.sku),
                })),
                address: selectedAddress ? {
                  firstName: selectedAddress.first_name,
                  lastName: selectedAddress.last_name,
                  line1: selectedAddress.address_line_1,
                  line2: selectedAddress.address_line_2 ?? undefined,
                  city: selectedAddress.city,
                  state: selectedAddress.state,
                  zip: selectedAddress.zip,
                  country: selectedAddress.country ?? 'US',
                } : undefined,
                fulfillmentGroups: fulfillmentPlan!.groups.map(g => ({
                  warehouseCode: g.warehouse.code,
                  warehouseLabel: g.warehouse.label,
                  warehouseAddress: g.warehouse.address,
                  distanceMiles: g.distanceMiles,
                  isPickup: g.isPickup,
                  shippingFee: g.shipping,
                  items: g.items.map(item => ({ sku: item.sku, name: item.name, qty: item.qty })),
                })),
                financials: {
                  subtotal,
                  shippingTotal: shipping,
                  tax,
                  total,
                },
              });
              navigation.navigate('OrderSuccess', {
                total,
                orderId: orderId.current,
                orderNumber: orderNumber.current,
                checkoutSessionId: checkoutSessionId.current,
                userEmail: user?.email ?? '',
              });
            }}
          >
            <Text style={styles.placeOrderText}>
              {deliveryLoading
                ? (fulfillmentPlan ? 'Updating delivery…' : 'Checking delivery…')
                : rechecking ? 'Verifying inventory…'
                : 'Place Order'}
            </Text>
          </TouchableOpacity>
          <Text style={styles.placeOrderTrust}>Preview only · no card required · nothing will ship</Text>
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
                    <Text style={styles.addrPanelTitle}>New Address</Text>
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
                      style={[styles.addrSaveBtn, (!addrFormValid || addrSaving) && { opacity: 0.5 }]}
                      disabled={!addrFormValid || addrSaving}
                      onPress={async () => {
                        if (addrSaving) return;
                        setAddrSaving(true);
                        try {
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
                          setShowAddForm(false);
                          setAddrModalVisible(false);
                        } catch {
                          // Keep modal open so user can retry
                        } finally {
                          setAddrSaving(false);
                        }
                      }}
                    >
                      <Text style={styles.addrSaveBtnText}>Save & Use</Text>
                    </TouchableOpacity>
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
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 },
  summaryLabel: { fontSize: 12, color: '#9CA3AF' },
  summaryValue: { fontSize: 12, color: '#6B7280', fontWeight: '500', textAlign: 'right' as const },
  summaryFree: { fontSize: 12, color: '#6B7280', fontWeight: '500', textAlign: 'right' as const },
  summaryTotalBlock: { paddingTop: 14, paddingBottom: 20 },
  summaryTotalLabel: { fontSize: 12, color: '#9CA3AF', fontWeight: '500', letterSpacing: 0.8, textTransform: 'uppercase' as const, marginBottom: 4 },
  summaryTotalValue: { fontSize: 21, fontWeight: '600', color: '#111111' },
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
  placeOrderBtn: { backgroundColor: '#EAB320', paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
  placeOrderText: { color: 'white', fontSize: 15, fontWeight: '700' },
  placeOrderTrust: { fontSize: 11, color: '#9CA3AF', textAlign: 'center', marginTop: 10 },
  reserveText: { fontSize: 11, color: '#CA8A04', fontWeight: '500', marginTop: 6 },
  demoBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 20, marginBottom: 8, backgroundColor: '#FFFBEB', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: '#FDE68A' },
  demoBannerText: { fontSize: 12, color: '#92660A', flex: 1 },

  infoLabel: { fontSize: 11, fontWeight: '600', color: '#6B7280', letterSpacing: 0.6, textTransform: 'uppercase' as const, marginBottom: 6 },
  infoInput: { fontSize: 14, color: '#1C1917', backgroundColor: '#F9FAFB', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: '#E5E7EB' },

  addrRow: { flexDirection: 'row', alignItems: 'flex-start' },
  addrName: { fontSize: 13, fontWeight: '600', color: '#1C1917', marginBottom: 3 },
  addrLine: { fontSize: 13, color: '#6B7280', lineHeight: 18 },
  addrChangeBtn: { fontSize: 13, color: '#CA8A04', fontWeight: '600', paddingLeft: 12 },
  addrEmpty: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'white', borderRadius: 6, padding: 16, borderWidth: 1, borderColor: '#E5E7EB' },
  addrEmptyText: { fontSize: 14, color: '#CA8A04', fontWeight: '500' },
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
  summaryCalculating: { fontSize: 12, color: '#9CA3AF', fontStyle: 'italic' as const },
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
});
