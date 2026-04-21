/**
 * GIGA B2B Open API integration
 *
 * Env vars required (add to .env for local, CI secrets for production):
 *   GIGA_TOKEN_URL      — OAuth token endpoint
 *                         (e.g. https://open.gigab2b.com/oauth/token)
 *   GIGA_API_BASE_URL   — Products API base URL
 *                         (e.g. https://open.gigab2b.com/api/v1)
 *   GIGA_CLIENT_ID      — OAuth client_id issued by GIGA
 *   GIGA_CLIENT_SECRET  — OAuth client_secret issued by GIGA
 *
 * Adjust field names in normalizeProduct() once you have the actual API response.
 */

const TOKEN_URL    = process.env.GIGA_TOKEN_URL      ?? '';
const API_BASE_URL = process.env.GIGA_API_BASE_URL   ?? '';
const CLIENT_ID    = process.env.GIGA_CLIENT_ID      ?? '';
const CLIENT_SECRET = process.env.GIGA_CLIENT_SECRET ?? '';

// ── In-memory token cache ─────────────────────────────────────────────────────
type TokenCache = { accessToken: string; expiresAt: number };
let _tokenCache: TokenCache | null = null;

/**
 * Fetch (or return cached) OAuth2 Bearer token using client_credentials flow.
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (_tokenCache && now < _tokenCache.expiresAt - 30_000) {
    return _tokenCache.accessToken;
  }

  if (!TOKEN_URL || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      '[GigaService] Missing GIGA_TOKEN_URL, GIGA_CLIENT_ID, or GIGA_CLIENT_SECRET. ' +
      'Add them to .env and restart.',
    );
  }

  console.log('[GigaService] Requesting new access token');

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[GigaService] Token request failed ${res.status}: ${text}`);
  }

  const json = await res.json();
  const accessToken: string = json.access_token;
  const expiresIn: number   = json.expires_in ?? 3600;

  if (!accessToken) {
    throw new Error('[GigaService] Token response missing access_token');
  }

  _tokenCache = { accessToken, expiresAt: now + expiresIn * 1000 };
  console.log(`[GigaService] Token acquired (expires in ${expiresIn}s)`);
  return accessToken;
}

// ── Product shape returned by this service ────────────────────────────────────
// Matches the SupplierApiItem shape expected by supplierPickupService.
export type GigaProduct = {
  id: string;
  title: string;
  description: string | null;
  price: number;
  images: string[];
  stock: number;
  warehouse_address: string | null;
};

// ── Raw API response type — update field names to match actual GIGA response ──
type GigaApiProduct = {
  // Common GIGA/GigaCloud field names — verify against actual API docs
  product_id?:       string | number;
  id?:               string | number;
  product_name?:     string;
  name?:             string;
  title?:            string;
  description?:      string | null;
  price?:            number | string;
  sale_price?:       number | string;
  images?:           string[] | { url: string }[];
  image_urls?:       string[];
  stock_quantity?:   number | string;
  inventory?:        number | string;
  quantity?:         number | string;
  warehouse_address?: string | null;
  warehouse?:        string | null;
  [key: string]: unknown;
};

function normalizeProduct(raw: GigaApiProduct): GigaProduct {
  // ID — try product_id first, fall back to id
  const id = String(raw.product_id ?? raw.id ?? '');

  // Title
  const title = String(raw.product_name ?? raw.name ?? raw.title ?? '');

  // Price — prefer sale_price if present
  const price = Number(raw.sale_price ?? raw.price ?? 0);

  // Images — handle both string[] and {url}[] response shapes
  let images: string[] = [];
  const rawImages = raw.images ?? raw.image_urls;
  if (Array.isArray(rawImages)) {
    images = rawImages.map(img =>
      typeof img === 'string' ? img : (img as { url: string }).url ?? '',
    ).filter(Boolean);
  }

  // Stock
  const stock = Number(raw.stock_quantity ?? raw.inventory ?? raw.quantity ?? 0);

  // Warehouse address
  const warehouse_address = (raw.warehouse_address ?? raw.warehouse ?? null) as string | null;

  return {
    id,
    title,
    description: (raw.description as string | null) ?? null,
    price,
    images,
    stock,
    warehouse_address,
  };
}

/**
 * Fetch all products from the GIGA B2B API and return them normalized.
 * Handles pagination if the API returns a `next_page_url` or `page`/`total_pages`.
 */
export async function fetchProducts(): Promise<GigaProduct[]> {
  if (!API_BASE_URL) {
    throw new Error('[GigaService] Missing GIGA_API_BASE_URL');
  }

  const token = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const allProducts: GigaProduct[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const url = `${API_BASE_URL}/products?page=${page}&per_page=100`;
    console.log(`[GigaService] Fetching products page ${page} — ${url}`);

    const res = await fetch(url, { headers });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`[GigaService] Products request failed ${res.status}: ${text}`);
    }

    const json = await res.json();

    // Support both flat array and paginated envelope responses
    const items: GigaApiProduct[] = Array.isArray(json)
      ? json
      : (json.data ?? json.products ?? json.items ?? []);

    const normalized = items.map(normalizeProduct);
    allProducts.push(...normalized);

    // Pagination — stop when no more pages or last page received fewer items
    const totalPages: number = json.total_pages ?? json.last_page ?? 1;
    hasMore = page < totalPages && items.length > 0;
    page++;
  }

  console.log(`[GigaService] Total products fetched: ${allProducts.length}`);

  if (allProducts.length > 0) {
    const preview = allProducts[0];
    console.log('[GigaService] First product preview:', {
      id:    preview.id,
      title: preview.title,
      price: preview.price,
      stock: preview.stock,
    });
  }

  return allProducts;
}
