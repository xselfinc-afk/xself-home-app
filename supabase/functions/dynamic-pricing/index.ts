import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Pricing constants ─────────────────────────────────────────────────────────

const STRIPE_FEE_RATE            = 0.033;
const SALES_TAX_ON_FEE_RATE      = 0.0775;  // CA applied to Stripe processing fee
const PAYMENT_FEE_RATE           = STRIPE_FEE_RATE * (1 + SALES_TAX_ON_FEE_RATE); // ≈ 0.03556
const ORIGINAL_PRICE_MULTIPLIER  = 1.35;    // anchor / MSRP shown as strikethrough

// ── Types ─────────────────────────────────────────────────────────────────────

interface Product {
  supplier_product_id: string;
  sku_custom:          string;
  price:               number;         // supplier/wholesale cost — never shown to customers
  selling_price:       number | null;  // AI-managed retail price; null = not yet priced
  original_price:      number | null;  // anchor/MSRP price
  view_count:          number;
  click_count:         number;
  add_to_cart_count:   number;
  order_count:         number;
  created_at:          string;
}

type DemandState = 'high_demand' | 'medium_demand' | 'low_interest' | 'overstock' | 'neutral';

interface PricingResult {
  supplier_product_id:   string;
  sku:                   string;
  old_price:             number;
  new_price:             number;
  original_price:        number;
  base_retail_price:     number;
  pricing_markup:        number;
  fulfillment_buffer:    number;
  estimated_payment_fee: number;
  estimated_net_profit:  number;
  estimated_net_margin:  number;
  state:                 DemandState;
  margin:                number;
  stock_override:        boolean;
  margin_protected:      boolean;
}

// ── Markup and buffer tiers ───────────────────────────────────────────────────

function getMarkup(cost: number): number {
  if (cost <= 50)  return 2.20;
  if (cost <= 150) return 1.80;
  if (cost <= 400) return 1.55;
  if (cost <= 800) return 1.40;
  return 1.28;
}

function getBuffer(cost: number): number {
  if (cost <= 100) return 20;
  if (cost <= 300) return 30;
  if (cost <= 800) return 50;
  return 80;
}

// ── Psychological price rounding ──────────────────────────────────────────────
//  <$100     → X.99           e.g. $47.23 → $47.99
//  $100–$299 → decade + 9     e.g. $127   → $129
//  $300+     → hundred+{49,79,99}  e.g. $409 → $449

function psychologicalRound(price: number): number {
  if (price < 100) {
    return Math.floor(price) + 0.99;
  }
  if (price < 300) {
    const decadeFloor = Math.floor(price / 10) * 10;
    const candidate   = decadeFloor + 9;
    return candidate >= price ? candidate : candidate + 10;
  }
  const floor100 = Math.floor(price / 100) * 100;
  for (const suffix of [49, 79, 99]) {
    if (floor100 + suffix >= price) return floor100 + suffix;
  }
  return floor100 + 149;  // spill into next hundred's 49
}

// ── Base retail price ─────────────────────────────────────────────────────────
// 1. raw     = cost × markup + fulfillment buffer
// 2. grossed = raw / (1 − PAYMENT_FEE_RATE)   → after-fee yield = raw
// 3. psychological rounding
// 4. 25% gross-margin floor: price ≥ cost / 0.75

function calculateBaseRetail(cost: number): {
  baseRetailPrice: number;
  markup:          number;
  buffer:          number;
  paymentFee:      number;
} {
  const markup = getMarkup(cost);
  const buffer = getBuffer(cost);

  const rawBase       = cost * markup + buffer;
  const grossed       = rawBase / (1 - PAYMENT_FEE_RATE);
  let   baseRetail    = psychologicalRound(grossed);

  // Hard margin floor: (price − cost) / price ≥ 0.25  →  price ≥ cost / 0.75
  const marginFloor = cost / 0.75;
  if (baseRetail < marginFloor) {
    baseRetail = psychologicalRound(marginFloor);
  }

  return {
    baseRetailPrice: baseRetail,
    markup,
    buffer,
    paymentFee: baseRetail * PAYMENT_FEE_RATE,
  };
}

// ── Demand-state detection ────────────────────────────────────────────────────

function demandState(
  ctr:        number,
  atcRate:    number,
  convRate:   number,
  stock:      number,
  orderCount: number,
): DemandState {
  if (convRate > 0.05)                 return 'high_demand';
  if (atcRate  > 0.10)                 return 'medium_demand';
  if (ctr      < 0.02)                 return 'low_interest';
  if (stock    > 200 && orderCount === 0) return 'overstock';
  return 'neutral';
}

// ── Dynamic pricing adjustments ───────────────────────────────────────────────
// Multipliers are applied ON TOP of base retail price — never on raw cost.

function applyDynamic(
  baseRetailPrice: number,
  costPrice:       number,
  state:           DemandState,
  stock:           number,
): { newPrice: number; stockOverride: boolean; marginProtected: boolean; margin: number } {
  let price = baseRetailPrice;

  // Demand multiplier
  switch (state) {
    case 'high_demand':   price *= 1.08; break;
    case 'medium_demand': price *= 1.05; break;
    case 'low_interest':  price *= 0.90; break;
    case 'overstock':     price *= 0.88; break;
    // neutral: no adjustment
  }

  // Low-stock scarcity premium
  let stockOverride = false;
  if (stock < 20) {
    price *= 1.10;
    stockOverride = true;
  }

  // Hard floor: never drop below cost × 1.30 regardless of markdowns
  let marginProtected = false;
  const hardFloor = costPrice * 1.30;
  if (price < hardFloor) {
    price = hardFloor;
    marginProtected = true;
  }

  // Psychological rounding on the final adjusted price
  price = psychologicalRound(price);

  const margin = costPrice > 0 && price > 0 ? (price - costPrice) / price : 0;

  return { newPrice: price, stockOverride, marginProtected, margin };
}

// ── Anchor / MSRP price ───────────────────────────────────────────────────────

function calcOriginalPrice(sellingPrice: number): number {
  return psychologicalRound(sellingPrice * ORIGINAL_PRICE_MULTIPLIER);
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(
        JSON.stringify({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const runAt    = new Date().toISOString();
    console.log('[DynamicPricing] Run started at', runAt);

    // ── Fetch products ──────────────────────────────────────────────────────
    const { data: products, error: prodError } = await supabase
      .from('standardized_products')
      .select(
        'supplier_product_id, sku_custom, price, selling_price, original_price, ' +
        'view_count, click_count, add_to_cart_count, order_count, created_at',
      )
      .eq('normalization_status', 'done')
      .gt('price', 0);

    if (prodError) throw new Error(`Products fetch failed: ${prodError.message}`);
    if (!products?.length) {
      console.log('[DynamicPricing] No products found — exiting');
      return new Response(
        JSON.stringify({ message: 'No products to price', updated: 0, triggered_at: runAt }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    console.log(`[DynamicPricing] Loaded ${products.length} products`);

    // ── Fetch stock totals from inventory_cache ─────────────────────────────
    const { data: cacheRows } = await supabase
      .from('inventory_cache')
      .select('product_id, quantity');

    const stockMap = new Map<string, number>();
    for (const row of (cacheRows ?? [])) {
      if (!row.product_id) continue;
      stockMap.set(row.product_id, (stockMap.get(row.product_id) ?? 0) + (row.quantity ?? 0));
    }

    // ── Price each product ──────────────────────────────────────────────────
    const results: PricingResult[] = [];

    for (const p of products as Product[]) {
      const cost  = p.price;
      const stock = stockMap.get(p.supplier_product_id) ?? 0;

      // Engagement metrics (guard /0)
      const ctr      = p.view_count  > 0 ? p.click_count       / p.view_count  : 0;
      const atcRate  = p.click_count > 0 ? p.add_to_cart_count / p.click_count : 0;
      const convRate = p.click_count > 0 ? p.order_count       / p.click_count : 0;

      // Step 1 — profit-based base retail from supplier cost
      const { baseRetailPrice, markup, buffer, paymentFee } = calculateBaseRetail(cost);

      // Step 2 — demand state
      const state = demandState(ctr, atcRate, convRate, stock, p.order_count);

      // Step 3 — dynamic adjustment on top of base retail (not cost)
      const { newPrice, stockOverride, marginProtected, margin } = applyDynamic(
        baseRetailPrice, cost, state, stock,
      );

      // Step 4 — anchor / MSRP (strikethrough price shown to customer)
      const origPrice = calcOriginalPrice(newPrice);

      // Transparency columns
      const netProfit = newPrice - cost - buffer - (newPrice * PAYMENT_FEE_RATE);
      const netMargin = newPrice > 0 ? netProfit / newPrice : 0;

      console.log(
        `[DynamicPricing] ${p.sku_custom} ` +
        `cost=$${cost} base=$${baseRetailPrice} state=${state} ` +
        `selling=$${newPrice} orig=$${origPrice} ` +
        `net=${(netMargin * 100).toFixed(1)}%` +
        (stockOverride   ? ' [stock<20]'   : '') +
        (marginProtected ? ' [hard-floor]' : ''),
      );

      // Skip write if nothing changed and already priced
      const priceChanged = Math.abs(newPrice   - (p.selling_price  ?? 0)) > 0.005;
      const origChanged  = Math.abs(origPrice  - (p.original_price ?? 0)) > 0.005;
      const neverPriced  = p.selling_price === null;
      if (!priceChanged && !origChanged && !neverPriced) continue;

      const { error: updateError } = await supabase
        .from('standardized_products')
        .update({
          selling_price:          newPrice,
          original_price:         origPrice,
          base_retail_price:      baseRetailPrice,
          pricing_markup:         markup,
          fulfillment_buffer:     buffer,
          estimated_payment_fee:  paymentFee,
          estimated_net_profit:   netProfit,
          estimated_net_margin:   netMargin,
          last_priced_at:         runAt,
        })
        .eq('supplier_product_id', p.supplier_product_id);

      if (updateError) {
        console.error(`[DynamicPricing] Update failed for ${p.sku_custom}: ${updateError.message}`);
        continue;
      }

      results.push({
        supplier_product_id:   p.supplier_product_id,
        sku:                   p.sku_custom,
        old_price:             p.selling_price ?? cost,
        new_price:             newPrice,
        original_price:        origPrice,
        base_retail_price:     baseRetailPrice,
        pricing_markup:        markup,
        fulfillment_buffer:    buffer,
        estimated_payment_fee: paymentFee,
        estimated_net_profit:  netProfit,
        estimated_net_margin:  netMargin,
        state,
        margin,
        stock_override:        stockOverride,
        margin_protected:      marginProtected,
      });
    }

    // ── Batch insert audit log ──────────────────────────────────────────────
    if (results.length > 0) {
      const { error: logError } = await supabase
        .from('pricing_audit_log')
        .insert(
          results.map(r => ({
            supplier_product_id: r.supplier_product_id,
            sku:             r.sku,
            old_price:       r.old_price,
            new_price:       r.new_price,
            state:           r.state,
            margin:          r.margin,
            stock_override:  r.stock_override,
            margin_protected: r.margin_protected,
            triggered_at:    runAt,
          })),
        );

      if (logError) {
        console.error('[DynamicPricing] Audit log insert failed:', logError.message);
      }
    }

    // ── Return summary ──────────────────────────────────────────────────────
    const stateCounts = results.reduce(
      (acc, r) => { acc[r.state] = (acc[r.state] ?? 0) + 1; return acc; },
      {} as Record<string, number>,
    );

    const summary = {
      processed:    (products as Product[]).length,
      updated:      results.length,
      states:       stateCounts,
      triggered_at: runAt,
    };

    console.log('[DynamicPricing] Run complete:', JSON.stringify(summary));

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[DynamicPricing] Unhandled error:', message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
