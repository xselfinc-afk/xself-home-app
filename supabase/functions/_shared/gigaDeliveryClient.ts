// 🔒 SERVER-ONLY Delivery (GIGA one-click dropship) API client — SCAFFOLD.
//
// NOT WIRED into any live function, NOT deployed, NOT called by the running app.
// Uses the DELIVERY account (Buyer 82482447) credentials, read from SUPPLIER_DELIVERY_*
// env (Deno secrets). It NEVER reads the Pickup account creds (SUPPLIER_CLIENT_*), so the
// two GIGA accounts can never be mixed. Signing mirrors src/services/gigaApiClient.ts
// (message `clientId&path&ts&nonce`, key `clientId&secret&nonce` → hex → base64).
//
// SAFETY: dropship submission is hard-blocked from production and requires an explicit
// sandbox opt-in. Read-only calls are allowed in sandbox. See docs/delivery-architecture.md.
//
// Deno runtime (Web Crypto). Excluded from the app TypeScript build (tsconfig excludes
// supabase/functions) and from the app bundle by location.

const SANDBOX_HOST = 'openapi-sandbox.gigab2b.com';
const PRODUCTION_HOST = 'openapi.gigab2b.com';
const MONEY_MOVING = [
  'order/dropShip-sync',
  'order/pickUpSelfLabel-sync',
  'order/giScSupplyLabel-sync',
  'order/create',
];

type Env = 'sandbox' | 'production';

function baseUrl(): string {
  return Deno.env.get('SUPPLIER_DELIVERY_API_BASE_URL') ?? `https://${SANDBOX_HOST}`;
}

function creds(env: Env): { clientId: string; clientSecret: string } {
  const idName = env === 'sandbox' ? 'SUPPLIER_DELIVERY_SANDBOX_CLIENT_ID' : 'SUPPLIER_DELIVERY_PRODUCTION_CLIENT_ID';
  const secName = env === 'sandbox' ? 'SUPPLIER_DELIVERY_SANDBOX_CLIENT_SECRET' : 'SUPPLIER_DELIVERY_PRODUCTION_CLIENT_SECRET';
  const clientId = Deno.env.get(idName) ?? '';
  const clientSecret = Deno.env.get(secName) ?? '';
  if (!clientId || !clientSecret) throw new Error(`[gigaDelivery] missing ${idName}/${secName}`);
  return { clientId, clientSecret };
}

function generateNonce(length = 10): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function sign(clientId: string, clientSecret: string, path: string, timestamp: string, nonce: string): Promise<string> {
  const msg = `${clientId}&${path}&${timestamp}&${nonce}`;
  const keyStr = `${clientId}&${clientSecret}&${nonce}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  const hex = Array.from(new Uint8Array(sigBuf), (b) => b.toString(16).padStart(2, '0')).join('');
  // base64 of the hex string (matches the Pickup client + GIGA docs)
  return btoa(hex);
}

function isProduction(url: string): boolean { return url.includes(PRODUCTION_HOST); }
function isMoneyMoving(path: string): boolean { return MONEY_MOVING.some((f) => path.includes(f)); }

/**
 * Low-level signed request against the Delivery account. `env` selects which credential
 * set to use. Order-creating paths are blocked here unless `opts.allowOrderSubmit` is
 * explicitly true AND env === 'sandbox' (see submitDropshipOrderSandbox).
 */
export async function gigaDeliveryRequest(
  path: string,
  body: Record<string, unknown>,
  opts: { env?: Env; allowOrderSubmit?: boolean } = {},
): Promise<unknown> {
  const env: Env = opts.env ?? 'sandbox';
  const url = `${baseUrl()}${path}`;

  if (isMoneyMoving(path)) {
    if (isProduction(url) || env === 'production') {
      throw new Error('[gigaDelivery] BLOCKED: production order-creating endpoint is not permitted.');
    }
    if (!opts.allowOrderSubmit) {
      throw new Error('[gigaDelivery] BLOCKED: order-creating endpoint requires explicit allowOrderSubmit + sandbox.');
    }
  }

  const { clientId, clientSecret } = creds(env);
  const timestamp = Date.now().toString();
  const nonce = generateNonce();
  const signature = await sign(clientId, clientSecret, path, timestamp, nonce);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'client-id': clientId, timestamp, nonce, sign: signature },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error(`[gigaDelivery] non-JSON response: ${text.slice(0, 200)}`); }
  return data;
}

/** Read-only sandbox helper — verify the Delivery sandbox credentials authenticate. */
export function deliveryProductPriceSandbox(skus: string[]): Promise<unknown> {
  return gigaDeliveryRequest('/b2b-overseas-api/v1/buyer/product/price/v1', { skus }, { env: 'sandbox' });
}

/** Read-only sandbox helper — order status / tracking by our orderNo (no money movement). */
export function deliveryOrderStatusQuerySandbox(orderNo: string): Promise<unknown> {
  return gigaDeliveryRequest('/b2b-overseas-api/v1/buyer/order/status/v1', { orderNo }, { env: 'sandbox' });
}

/**
 * SCAFFOLD — sandbox-only dropship submission. Hard-refuses production. Intentionally
 * requires the caller to pass `{ allowOrderSubmit: true }` AND will only ever run against
 * sandbox. NOT wired into checkout/order flow. Do not enable for production without an
 * explicit, separately-approved change.
 */
export function submitDropshipOrderSandbox(payload: Record<string, unknown>): Promise<unknown> {
  return gigaDeliveryRequest('/b2b-overseas-api/v1/buyer/order/dropShip-sync/v1', payload, {
    env: 'sandbox',
    allowOrderSubmit: true,
  });
}
