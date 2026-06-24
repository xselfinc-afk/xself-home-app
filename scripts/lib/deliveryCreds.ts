/**
 * deliveryCreds.ts — load + describe the DROPSHIP delivery-fee credentials.
 *
 * Distinct from .env.giga-alt.local (PICKUP / saved-list account). This loads
 * .env.giga-delivery.local (untracked) so `npm run fees:refresh` and the saved-to-live
 * apply fee-refresh step work in a fresh terminal without re-exporting secrets.
 *
 * NEVER prints the secret. maskClientId reveals at most a 4-char client-id prefix.
 */
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';

export const DELIVERY_ENV_FILE = '.env.giga-delivery.local';
export const MISSING_CREDS_HELP =
  `Missing dropship delivery credentials. Create ${DELIVERY_ENV_FILE} or export SUPPLIER_DELIVERY_PRODUCTION_CLIENT_ID/SECRET.`;

let loaded = false;
/**
 * Idempotent. Loads .env.giga-delivery.local FIRST (wins over .env.local for overlapping keys),
 * then .env.local (Supabase) and .env. dotenv never overrides an already-exported env var, so
 * terminal exports still take precedence.
 */
export function loadDeliveryCreds(): void {
  if (loaded) return;
  if (fs.existsSync(DELIVERY_ENV_FILE)) dotenv.config({ path: DELIVERY_ENV_FILE });
  dotenv.config({ path: '.env.local' });
  dotenv.config();
  loaded = true;
}

/** Mask a client id: at most a 4-char prefix; never reveals the full id or any secret. */
export function maskClientId(id: string | undefined | null): string {
  if (!id) return '(none)';
  return id.length <= 4 ? '****' : `${id.slice(0, 4)}…(${id.length} chars)`;
}

export interface DeliveryCredsStatus {
  present: boolean;
  clientIdMasked: string;
  baseUrl: string;
  line: string; // print-safe one-liner — never the secret
}

/** Reads process.env (does NOT load files). Returns a print-safe status line. */
export function deliveryCredsStatus(): DeliveryCredsStatus {
  const cid = process.env.SUPPLIER_DELIVERY_PRODUCTION_CLIENT_ID || '';
  const sec = process.env.SUPPLIER_DELIVERY_PRODUCTION_CLIENT_SECRET || '';
  const baseUrl = process.env.SUPPLIER_DELIVERY_API_BASE_URL || 'https://openapi.gigab2b.com';
  const present = Boolean(cid && sec);
  const line = present
    ? `dropship delivery creds loaded (client-id ${maskClientId(cid)}; base ${baseUrl})`
    : MISSING_CREDS_HELP;
  return { present, clientIdMasked: maskClientId(cid), baseUrl, line };
}
