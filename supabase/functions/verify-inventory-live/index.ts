// ─────────────────────────────────────────────────────────────────────────────
// verify-inventory-live — checkout-time live inventory verification.
//
// Called by the app ONLY when checkout inventoryFreshness is stale/unknown. It probes
// the GIGA quantity API for the exact cart supplier_product_ids, and:
//   • success + in stock  → refresh inventory_cache (fresh last_synced_at, sync_status='ok')
//                           and return { verified:true, allInStock:true, perSku }
//   • out of stock        → return { verified:true, allInStock:false, perSku } (app blocks Affirm)
//   • API fail/timeout/bad-sign/missing-creds → return { verified:false, reason } (HTTP 200)
//
// The function NEVER throws to the client; on any failure it returns verified:false so the
// app keeps the existing fallback behavior (Affirm blocked; card/Apple Pay unaffected).
//
// Mirrors the proven GIGA quantity probe (scripts/runGigaAutoPublish.ts, seedPilotInventory.ts):
//   POST {SUPPLIER_API_BASE_URL}/b2b-overseas-api/v1/buyer/inventory/quantity/v2
//   HMAC: client-id/timestamp/nonce/sign headers.
//
// Reads (Supabase function secrets — must be the openapi.gigab2b.com creds, same as the
// inventory sync's .env.giga-alt.local): SUPPLIER_API_BASE_URL, SUPPLIER_CLIENT_ID,
// SUPPLIER_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// Does NOT touch create-checkout-order / stripe-webhook / Crisp.
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as crypto from 'node:crypto';

const GIGA_BASE = (Deno.env.get('SUPPLIER_API_BASE_URL') ?? '').trim();
const GIGA_CID  = (Deno.env.get('SUPPLIER_CLIENT_ID')     ?? '').trim();
const GIGA_SEC  = (Deno.env.get('SUPPLIER_CLIENT_SECRET')  ?? '').trim();
const QTY_PATH  = '/b2b-overseas-api/v1/buyer/inventory/quantity/v2';
const TIMEOUT_MS = 4000;
const MAX_SKUS   = 50;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Same guard the inventory sync uses: creds present AND the real openapi host.
const gigaReady = (): boolean =>
  !!(GIGA_BASE && GIGA_CID && GIGA_SEC && /openapi\.gigab2b\.com/.test(GIGA_BASE));

const gigaNonce = (n = 10): string => {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let r = ''; for (let i = 0; i < n; i++) r += c[Math.floor(Math.random() * c.length)]; return r;
};
const gigaSign = (p: string, ts: string, nc: string): string => {
  const msg = `${GIGA_CID}&${p}&${ts}&${nc}`, key = `${GIGA_CID}&${GIGA_SEC}&${nc}`;
  // base64 of the hex digest STRING (matches scripts' Buffer.from(hex,'utf8').toString('base64')).
  // Deno has no global Buffer; the hex string is ASCII, so btoa is equivalent.
  return btoa(crypto.createHmac('sha256', key).update(msg).digest('hex'));
};

// Warehouse → state / pickup (mirror seedPilotInventory.ts).
function warehouseState(code: string): string | null {
  if (/^CA/i.test(code))  return 'CA';
  if (/^NJX/i.test(code)) return 'MD';
  if (/^NJ/i.test(code))  return 'NJ';
  if (/^AT/i.test(code))  return 'GA';
  if (/^TX/i.test(code))  return 'TX';
  return null;
}
const supportsPickup = (code: string): boolean => warehouseState(code) === 'CA';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

interface GigaDist { warehouseCode: string; availableQtyMin: number; availableQtyMax: number }
interface GigaRec {
  sku: string;
  sellerInventoryInfo: null | {
    sellerAvailableInventory?: number | null;
    nextArrivalInventory?: number | null;
    sellerInventoryDistribution?: GigaDist[];
  };
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ verified: false, reason: 'method_not_allowed' }, 405);

  try {
    const body = await req.json().catch(() => null) as { skus?: unknown } | null;
    const skus = Array.isArray(body?.skus)
      ? (body!.skus as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map(s => s.trim())
      : [];
    if (skus.length === 0) return json({ verified: false, reason: 'no_skus' });
    if (skus.length > MAX_SKUS) return json({ verified: false, reason: 'too_many_skus' });

    if (!gigaReady()) {
      console.warn('[verify-inventory-live] GIGA creds/host not configured — fail-safe');
      return json({ verified: false, reason: 'giga_not_configured' });
    }

    // ── Live probe with hard timeout ──────────────────────────────────────────
    const ts = Date.now().toString(), nc = gigaNonce();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let gigaJson: { success?: boolean; data?: GigaRec[] } | null = null;
    let httpStatus = 0;
    try {
      const res = await fetch(`${GIGA_BASE}${QTY_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'client-id': GIGA_CID, timestamp: ts, nonce: nc, sign: gigaSign(QTY_PATH, ts, nc) },
        body: JSON.stringify({ skus }),
        signal: ctrl.signal,
      });
      httpStatus = res.status;
      gigaJson = await res.json().catch(() => null);
    } catch (e) {
      clearTimeout(timer);
      const reason = (e as Error)?.name === 'AbortError' ? 'giga_timeout' : 'giga_network_error';
      console.warn('[verify-inventory-live]', reason);
      return json({ verified: false, reason });
    }
    clearTimeout(timer);

    if (httpStatus !== 200 || gigaJson?.success !== true) {
      console.warn('[verify-inventory-live] giga non-200/success=false:', httpStatus);
      return json({ verified: false, reason: `giga_http_${httpStatus}` });
    }

    // ── Compute per-SKU stock + build inventory_cache rows ────────────────────
    const records = Array.isArray(gigaJson.data) ? gigaJson.data : [];
    const now = new Date().toISOString();
    const perSku: Record<string, { total: number; inStock: boolean; warehouses: { code: string; min: number; max: number }[] }> = {};
    const cacheRows: Record<string, unknown>[] = [];

    for (const rec of records) {
      const dist = rec.sellerInventoryInfo?.sellerInventoryDistribution ?? [];
      let total = 0;
      const warehouses: { code: string; min: number; max: number }[] = [];
      for (const w of dist) {
        const minQ = Math.max(0, Number(w.availableQtyMin) || 0);
        const maxQ = Math.max(0, Number(w.availableQtyMax) || 0);
        total += minQ;
        warehouses.push({ code: w.warehouseCode, min: minQ, max: maxQ });
        cacheRows.push({
          product_id: rec.sku,
          supplier_product_id: rec.sku,
          warehouse_code: w.warehouseCode,
          warehouse_state: warehouseState(w.warehouseCode),
          warehouse_city: null,
          quantity: minQ,
          quantity_floor: minQ,
          quantity_raw: minQ === maxQ ? String(minQ) : `${minQ}-${maxQ}`,
          quantity_exact: minQ === maxQ,
          total_available: rec.sellerInventoryInfo?.sellerAvailableInventory ?? null,
          is_available: maxQ > 0,
          supports_pickup: supportsPickup(w.warehouseCode),
          supports_shipping: true,
          last_synced_at: now,
          sync_status: 'ok',
          source_type: 'website_scrape',
          raw_payload: {
            source_note: 'verify_inventory_live',
            availableQtyMin: minQ,
            availableQtyMax: maxQ,
            sellerAvailableInventory: rec.sellerInventoryInfo?.sellerAvailableInventory ?? null,
          },
        });
      }
      perSku[rec.sku] = { total, inStock: total > 0, warehouses };
    }

    // Every requested SKU must be present AND in stock.
    const allInStock = skus.every(s => perSku[s]?.inStock === true);

    // ── Refresh inventory_cache (only when in stock; never write zero-stock rows here) ──
    if (allInStock && cacheRows.length > 0 && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
        const { error: upErr } = await sb
          .from('inventory_cache')
          .upsert(cacheRows, { onConflict: 'product_id,warehouse_code' });
        if (upErr) console.warn('[verify-inventory-live] cache upsert failed (non-fatal):', upErr.message);
      } catch (e) {
        console.warn('[verify-inventory-live] cache upsert threw (non-fatal):', e instanceof Error ? e.message : e);
      }
    }

    console.log('[verify-inventory-live] verified', skus.length, 'skus | allInStock:', allInStock);
    return json({ verified: true, allInStock, perSku });
  } catch (e) {
    // Absolute backstop — never 500 in a way that breaks checkout; fail safe.
    console.error('[verify-inventory-live] unexpected error (fail-safe):', e instanceof Error ? e.message : e);
    return json({ verified: false, reason: 'internal_error' });
  }
});
