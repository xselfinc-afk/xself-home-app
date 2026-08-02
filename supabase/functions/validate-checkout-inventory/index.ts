import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Built-in Supabase env vars — always available in Edge Functions
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Reject inventory data older than this
const STALE_THRESHOLD_HOURS = 24;

/**
 * Open API availability as the primary gate. DEFAULT OFF — while false this function behaves
 * exactly as before, so deploying it changes nothing until the secret is set.
 *
 * Why availability leads: `inventory_cache` carries warehouse quantities from the browser-based
 * sync, which has been failing; every published product currently has evidence older than 24h, so
 * the legacy path fails EVERY cart line with reason 'stale'. Open API availability is browser-free,
 * refreshed every 48h, and answers the only question checkout must ask — will the supplier sell it.
 * Warehouse quantity remains authoritative for HOW MANY and WHICH warehouse.
 */
const AVAILABILITY_GATE_ENABLED = Deno.env.get('INVENTORY_CHECKOUT_AVAILABILITY_ENABLED') === 'true';
/** Grace window for availability evidence — matches sellable_products and the 48h scan cadence. */
const AVAILABILITY_GRACE_HOURS = 72;
const MAX_CART_ITEMS = 20;
const MAX_QTY_PER_ITEM = 99;
const SKU_PATTERN = /^[A-Za-z0-9_-]{1,60}$/;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface CartItem {
  /** GIGA item code / display SKU — used only in failure messages */
  sku: string;
  /** supplier_product_id — the key into inventory_cache and standardized_products */
  productId: string;
  /** Requested quantity */
  qty: number;
}

type FailureReason =
  | 'out_of_stock'
  | 'stale'
  | 'unknown'
  | 'insufficient_qty'
  /** Supplier explicitly reports the SKU unavailable — a confirmed answer, not an absence. */
  | 'unavailable'
  /** We could not obtain trustworthy evidence. NOT a claim of zero stock; the caller should retry. */
  | 'unconfirmed';

interface FailureDetail {
  sku: string;
  productId: string;
  reason: FailureReason;
  /** Total available across all warehouses (0 when unknown/stale) */
  available: number;
}

interface ValidateResponse {
  valid: boolean;
  failures: FailureDetail[];
}

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    let body: { items?: CartItem[] };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ valid: false, failures: [], error: 'Invalid JSON' }, 400);
    }

    const items = body.items;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return jsonResponse({ valid: false, failures: [], error: 'items array is required' }, 400);
    }
    if (items.length > MAX_CART_ITEMS) {
      return jsonResponse({ valid: false, failures: [], error: `Cart cannot exceed ${MAX_CART_ITEMS} items` }, 400);
    }

    // Validate each item has the required fields
    for (const item of items) {
      if (!item.productId || typeof item.qty !== 'number' || item.qty < 1) {
        return jsonResponse({ valid: false, failures: [], error: 'Each item must have productId and qty >= 1' }, 400);
      }
      if (!SKU_PATTERN.test(item.productId)) {
        return jsonResponse({ valid: false, failures: [], error: 'Invalid product ID format' }, 400);
      }
      if (item.qty > MAX_QTY_PER_ITEM) {
        return jsonResponse({ valid: false, failures: [], error: `Quantity cannot exceed ${MAX_QTY_PER_ITEM} per item` }, 400);
      }
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Deduplicate productIds for the DB query
    const productIds = [...new Set(items.map((i) => i.productId))];
    const staleThreshold = new Date(
      Date.now() - STALE_THRESHOLD_HOURS * 60 * 60 * 1000,
    ).toISOString();

    // ── Query 1: Fresh website_scrape inventory ──────────────────────────────
    // Aggregate available qty across all warehouses per product.
    // Only 'website_scrape' source, sync_status = 'ok', last_synced_at within 24h.
    const { data: freshRows, error: freshError } = await supabase
      .from('inventory_cache')
      .select('product_id, quantity')
      .in('product_id', productIds)
      .eq('source_type', 'website_scrape')
      .eq('sync_status', 'ok')
      .gte('last_synced_at', staleThreshold);

    if (freshError) {
      console.error('[validate-checkout-inventory] DB error (fresh query):', freshError.message);
      return jsonResponse({ valid: false, failures: [], error: 'Database error' }, 500);
    }

    // Build: productId → total available qty (sum across all warehouses)
    const stockMap = new Map<string, number>();
    for (const row of freshRows ?? []) {
      const pid = row.product_id as string;
      const qty = Math.max(0, Number(row.quantity ?? 0));
      stockMap.set(pid, (stockMap.get(pid) ?? 0) + qty);
    }

    // ── Query 2: Stale check for products with no fresh data ─────────────────
    // Determines whether a missing product has stale data (scraper ran but expired)
    // vs truly unknown (scraper has never run for this product).
    const missingProductIds = productIds.filter((pid) => !stockMap.has(pid));
    const staleSet = new Set<string>();

    if (missingProductIds.length > 0) {
      const { data: staleRows } = await supabase
        .from('inventory_cache')
        .select('product_id')
        .in('product_id', missingProductIds)
        .eq('source_type', 'website_scrape')
        .eq('sync_status', 'ok');
        // No last_synced_at filter — we want ANY website_scrape row regardless of age

      for (const row of staleRows ?? []) {
        staleSet.add(row.product_id as string);
      }
    }

    // ── Query 3: Open API availability (primary gate when enabled) ───────────
    // Only CONFIRMED answers live in this view, so a failed supplier read cannot appear here and
    // cannot block a sale. Absence means "no confirmed answer", never "unavailable".
    const availabilityMap = new Map<string, { available: boolean; fresh: boolean }>();
    if (AVAILABILITY_GATE_ENABLED) {
      const graceThreshold = new Date(
        Date.now() - AVAILABILITY_GRACE_HOURS * 60 * 60 * 1000,
      ).toISOString();
      const { data: availRows, error: availError } = await supabase
        .from('product_availability_current')
        .select('supplier_product_id, available, checked_at')
        .in('supplier_product_id', productIds);

      if (availError) {
        // Fail closed on an infrastructure error — but as 'unconfirmed', never as out_of_stock.
        console.error('[validate-checkout-inventory] availability query failed:', availError.message);
        return jsonResponse({
          valid: false,
          failures: items.map((i) => ({
            sku: i.sku, productId: i.productId, reason: 'unconfirmed' as FailureReason, available: 0,
          })),
        });
      }
      for (const row of availRows ?? []) {
        availabilityMap.set(row.supplier_product_id as string, {
          available: row.available === true,
          fresh: String(row.checked_at) >= graceThreshold,
        });
      }
    }

    // ── Evaluate each cart item ───────────────────────────────────────────────
    const failures: FailureDetail[] = [];

    for (const item of items) {
      const available = stockMap.get(item.productId) ?? 0;

      // Availability gate first: a fresh confirmed answer decides whether the line may proceed.
      if (AVAILABILITY_GATE_ENABLED) {
        const avail = availabilityMap.get(item.productId);
        if (avail?.fresh) {
          if (!avail.available) {
            // Confirmed unavailable — block THIS line only. Other lines are evaluated normally.
            failures.push({ sku: item.sku, productId: item.productId, reason: 'unavailable', available: 0 });
            continue;
          }
          // Confirmed available. Warehouse quantity still governs quantity, but its ABSENCE or
          // staleness must not block the sale — the supplier has already confirmed it will sell.
          if (stockMap.has(item.productId) && available < item.qty) {
            failures.push({ sku: item.sku, productId: item.productId, reason: 'insufficient_qty', available });
          }
          continue;
        }
        // No fresh confirmed answer → fall through to the legacy warehouse path below, which
        // fails closed as 'stale' / 'unknown'. Never treated as unavailable.
      }

      if (!stockMap.has(item.productId)) {
        // No fresh data — distinguish stale from unknown
        const reason: FailureReason = staleSet.has(item.productId) ? 'stale' : 'unknown';
        failures.push({
          sku: item.sku,
          productId: item.productId,
          reason,
          available: 0,
        });
      } else if (available === 0) {
        failures.push({
          sku: item.sku,
          productId: item.productId,
          reason: 'out_of_stock',
          available: 0,
        });
      } else if (available < item.qty) {
        failures.push({
          sku: item.sku,
          productId: item.productId,
          reason: 'insufficient_qty',
          available,
        });
      }
      // else: item passes — sufficient fresh stock available
    }

    const response: ValidateResponse = {
      valid: failures.length === 0,
      failures,
    };

    return jsonResponse(response);
  } catch (err) {
    console.error('[validate-checkout-inventory] Unexpected error:', err);
    return jsonResponse({ valid: false, failures: [], error: 'Internal server error' }, 500);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
