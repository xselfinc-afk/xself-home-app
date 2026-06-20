/**
 * Supplier (GIGA) account separation — Delivery vs Pickup.
 *
 * There are TWO separate GIGA buyer accounts. Their credentials must NEVER be mixed:
 *   • Pickup   (Buyer 76938981) — existing integration. Credentials: SUPPLIER_CLIENT_ID/SECRET.
 *                                 🔒 Pickup rules are LOCKED — see docs/fulfillment-rules.md.
 *   • Delivery (Buyer 82482447) — one-click dropship. Credentials: the SUPPLIER_DELIVERY_* names.
 *
 * This module holds ONLY env-var NAMES and PURE safety guards. It contains NO secret
 * values and performs NO env reads and NO network calls, so it is safe to unit-test and
 * to reference anywhere. Actual secrets are read only by server-side code
 * (supabase/functions/_shared/gigaDeliveryClient.ts) from these env names — never in the
 * app bundle. See docs/delivery-architecture.md.
 */

/** Env-var NAMES for the Delivery (dropship) account. Values live in server secrets only. */
export const DELIVERY_ENV = {
  baseUrl: 'SUPPLIER_DELIVERY_API_BASE_URL',
  sandboxClientId: 'SUPPLIER_DELIVERY_SANDBOX_CLIENT_ID',
  sandboxClientSecret: 'SUPPLIER_DELIVERY_SANDBOX_CLIENT_SECRET',
  productionClientId: 'SUPPLIER_DELIVERY_PRODUCTION_CLIENT_ID',
  productionClientSecret: 'SUPPLIER_DELIVERY_PRODUCTION_CLIENT_SECRET',
} as const;

/** Env-var NAMES for the existing Pickup account. Listed here only to keep the two sets distinct. */
export const PICKUP_ENV = {
  baseUrl: 'SUPPLIER_API_BASE_URL',
  clientId: 'SUPPLIER_CLIENT_ID',
  clientSecret: 'SUPPLIER_CLIENT_SECRET',
} as const;

export const GIGA_SANDBOX_HOST = 'openapi-sandbox.gigab2b.com';
export const GIGA_PRODUCTION_HOST = 'openapi.gigab2b.com';

/**
 * GIGA order-creating / money-moving path fragments. These must NEVER be called against
 * production during discovery/verification, and never from scripts or tests.
 */
export const MONEY_MOVING_PATH_FRAGMENTS = [
  'order/dropShip-sync',
  'order/pickUpSelfLabel-sync',
  'order/giScSupplyLabel-sync',
  'order/create',
  '/submit',
  '/cancel',
] as const;

function hostOf(baseUrl: string): string {
  try { return new URL(baseUrl).host; } catch { return baseUrl; }
}

export function isProductionHost(baseUrl: string): boolean {
  const h = hostOf(baseUrl);
  return h === GIGA_PRODUCTION_HOST || baseUrl.includes(GIGA_PRODUCTION_HOST);
}

export function isSandboxHost(baseUrl: string): boolean {
  const h = hostOf(baseUrl);
  return h === GIGA_SANDBOX_HOST || baseUrl.includes(GIGA_SANDBOX_HOST);
}

export function isMoneyMovingPath(path: string): boolean {
  return MONEY_MOVING_PATH_FRAGMENTS.some(f => path.includes(f));
}

/**
 * Hard guard for discovery/verification. Allows a request ONLY if it targets the GIGA
 * sandbox host AND is not an order-creating/money-moving path. Throws otherwise — wrap
 * every Delivery API call made during discovery/testing with this so a real/production
 * order can never be triggered by accident.
 */
export function assertSafeDiscoveryRequest(baseUrl: string, path: string): void {
  if (isProductionHost(baseUrl)) {
    throw new Error(`[delivery-guard] refused: production host (${GIGA_PRODUCTION_HOST}) is not allowed during discovery/verification.`);
  }
  if (!isSandboxHost(baseUrl)) {
    throw new Error(`[delivery-guard] refused: base URL is not the GIGA sandbox host (${GIGA_SANDBOX_HOST}). Got: ${baseUrl}`);
  }
  if (isMoneyMovingPath(path)) {
    throw new Error(`[delivery-guard] refused: "${path}" is an order-creating/money-moving endpoint; not allowed in discovery/verification.`);
  }
}
