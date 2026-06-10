/**
 * gigaSavedItems.ts — shared helper: single source of truth for fetching the GIGA buyer's
 * "My Saved Items" list. Used by planGigaSavedItems.ts (membership report), giga-saved-baseline.ts
 * (baseline snapshot), and giga-saved-delta.ts (baseline→current delta).
 *
 * Source endpoint: /b2b-overseas-api/v1/buyer/product/skus/v1 ("Product List Query"). Per the GIGA
 * Open API 2.0 docs this endpoint IS the account-scoped saved list (queryTimeType=2 == "Added time:
 * the latest time when a product was added to My Saved Items"); there is no separate favorites
 * endpoint. Canonical SKU field per record: `sku` (verified against a real 200 capture).
 *
 * Credentials: the saved-items list is GIGA-account-scoped, so SUPPLIER_* creds decide WHOSE list is
 * read. Only the alt account (.env.giga-alt.local) can read this endpoint; the default .env.local
 * account returns a GIGA server error. So creds loading DEFAULTS to alt: .env.giga-alt.local is
 * loaded FIRST (its SUPPLIER_* win, since dotenv never overrides set vars), while .env.local still
 * supplies the Supabase service-role key. Pass forceDefault / GIGA_SAVED_USE_ALT_CREDS=0 to opt out.
 *
 * This helper performs NO database writes and NO filesystem writes. It only reads the GIGA API.
 * It FAILS LOUDLY (throws GigaSavedItemsError) on: API error, unexpected response shape, ambiguous
 * SKU field, or an empty/zero-record list — so callers never persist a partial/corrupt snapshot.
 */
import { config as loadEnv } from 'dotenv';
import * as fs from 'node:fs';

export const ENDPOINT_PATH = '/b2b-overseas-api/v1/buyer/product/skus/v1';
export const SKU_FIELD = 'sku';
export const TITLE_FIELD = 'productName';
export const PAGE_SIZE = 100;          // skus/v1 requires pageSize=100 (see syncGigaFurnitureCatalog.ts)
const PAGE_DELAY_MS = 400;             // be polite to the supplier API
const ALT_CREDS_FILE = '.env.giga-alt.local';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

export type SavedItem = {
  sku: string;
  title: string;
  addedTime: string | null;
  updateTime: string | null;
  firstArrivalDate: string | null;
};

export type SavedItemsFetch = {
  items: SavedItem[];           // deduped by sku, first occurrence kept, source order preserved
  reportedTotal: number | null; // pageInfo.totalNum, or null if absent/non-numeric
  pagesFetched: number;
  credsSource: string;          // '.env.giga-alt.local' or '.env.local'
  endpointPath: string;
  skuField: string;
};

/** Loud, structured failure carrying machine-readable details for the caller's error report. */
export class GigaSavedItemsError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GigaSavedItemsError';
    this.details = details;
  }
}

let credsLoaded = false;
let credsSourceCache = '.env.local';

/**
 * Load GIGA + Supabase credentials with the alt-default cascade. Idempotent (loads once per process).
 * Returns the resolved creds source label. MUST run before importing gigaApiClient (which reads
 * SUPPLIER_* env at module-eval time).
 */
export function loadSavedItemsCreds(opts?: { forceDefault?: boolean }): string {
  if (credsLoaded) return credsSourceCache;
  const forceDefault = opts?.forceDefault ?? (process.env.GIGA_SAVED_USE_ALT_CREDS === '0');
  const useAlt = !forceDefault && fs.existsSync(ALT_CREDS_FILE);
  if (useAlt) loadEnv({ path: ALT_CREDS_FILE });
  loadEnv({ path: '.env.local' });
  loadEnv({ path: '.env' });
  credsSourceCache = useAlt ? ALT_CREDS_FILE : '.env.local';
  credsLoaded = true;
  return credsSourceCache;
}

/**
 * Fetch ALL pages of the saved-items list, extract the canonical SKU, dedupe, and return.
 * Throws GigaSavedItemsError (never resolves with partial/empty data) so callers can abort safely.
 */
export async function fetchAllSavedItems(opts?: {
  maxPages?: number;
  forceDefaultCreds?: boolean;
  silenceClientLogs?: boolean;
}): Promise<SavedItemsFetch> {
  const maxPages = opts?.maxPages ?? Infinity;
  const credsSource = loadSavedItemsCreds({ forceDefault: opts?.forceDefaultCreds });

  const giga = await import('../../src/services/gigaApiClient');
  const fetchSavedSkuList = (giga as any).fetchSavedSkuList as (p: number, ps: number) => Promise<any>;
  if (typeof fetchSavedSkuList !== 'function') {
    throw new GigaSavedItemsError('fetchSavedSkuList not exported from gigaApiClient', { endpoint_path: ENDPOINT_PATH });
  }

  // gigaApiClient logs verbosely (headers/body/raw); silence while paging unless told otherwise.
  const silence = opts?.silenceClientLogs !== false;
  const realLog = console.log;
  if (silence) console.log = () => {};

  const collected: SavedItem[] = [];
  let totalPage = 1;
  let reportedTotal: number | null = null;
  let pagesFetched = 0;
  try {
    for (let page = 1; page <= totalPage && page <= maxPages; page++) {
      const res = await fetchSavedSkuList(page, PAGE_SIZE);
      const data = res?.data;
      const records = data?.records;
      if (!data || !Array.isArray(records)) {
        throw new GigaSavedItemsError('unexpected saved-items response shape (data.records[] missing)', {
          endpoint_path: ENDPOINT_PATH, creds_source: credsSource, page,
          api_success: res?.success, api_code: res?.code,
          api_msg: res?.msg ?? res?.error ?? '', api_subMsg: res?.subMsg ?? '',
          response_keys: res ? Object.keys(res) : 'null',
          data_keys: data ? Object.keys(data) : 'null',
        });
      }
      if (page === 1) {
        const total = Number(data?.pageInfo?.totalNum ?? NaN);
        reportedTotal = Number.isFinite(total) ? total : null;
        totalPage = Number(data?.pageInfo?.totalPage ?? 1) || 1;
        // SKU-field ambiguity guard: confirm the canonical field exists on the first record.
        const first = records[0];
        if (first && (first[SKU_FIELD] == null || first[SKU_FIELD] === '')) {
          throw new GigaSavedItemsError('canonical SKU field ambiguous on saved-items records', {
            expected_sku_field: SKU_FIELD, candidate_fields: Object.keys(first),
          });
        }
      }
      for (const r of records) {
        const sku = String(r?.[SKU_FIELD] ?? '').trim();
        if (!sku) continue;
        collected.push({
          sku,
          title: String(r?.[TITLE_FIELD] ?? '').trim(),
          addedTime: r?.addedTime != null ? String(r.addedTime) : null,
          updateTime: r?.updateTime != null ? String(r.updateTime) : null,
          firstArrivalDate: r?.firstArrivalDate != null ? String(r.firstArrivalDate) : null,
        });
      }
      pagesFetched = page;
      if (page < totalPage && page < maxPages) await delay(PAGE_DELAY_MS);
    }
  } catch (e) {
    if (e instanceof GigaSavedItemsError) throw e;
    throw new GigaSavedItemsError(`saved-items fetch failed: ${e instanceof Error ? e.message : String(e)}`, {
      endpoint_path: ENDPOINT_PATH, creds_source: credsSource,
    });
  } finally {
    if (silence) console.log = realLog;
  }

  if (collected.length === 0) {
    throw new GigaSavedItemsError('saved-items list returned zero records', { endpoint_path: ENDPOINT_PATH, creds_source: credsSource });
  }

  // Dedupe by SKU (keep first occurrence; preserve source order).
  const bySku = new Map<string, SavedItem>();
  for (const it of collected) if (!bySku.has(it.sku)) bySku.set(it.sku, it);

  return {
    items: [...bySku.values()],
    reportedTotal,
    pagesFetched,
    credsSource,
    endpointPath: ENDPOINT_PATH,
    skuField: SKU_FIELD,
  };
}
