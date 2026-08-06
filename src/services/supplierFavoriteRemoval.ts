/**
 * Supplier Favorites removal executor — DISABLED BY DEFAULT, single item only.
 *
 * The supplier exposes no official Open API for un-favouriting. The only channel is the website's
 * own internal Wishlist XHR, read directly out of its public front-end bundle
 * (`product-wishlist-*.js`):
 *
 *   POST https://www.gigab2b.com/index.php?route=account/wishlist/delProductsFromWish
 *   body: { product_ids }        // the site's NUMERIC product_id — NOT the supplier SKU
 *
 * That makes this the single most dangerous call in the codebase: it is irreversible, it may
 * affect negotiated pricing, it is an undocumented internal route with no compatibility promise,
 * and its parameter is plural — one malformed value could clear many items at once.
 *
 * So the design is deliberately hostile to itself:
 *
 *   1. TWO independent gates. The env switch AND a complete per-item approval record. Either one
 *      missing means no request is sent.
 *   2. Single item, always. Arrays, comma lists and any batch-shaped parameter are rejected
 *      before a request is ever built — not filtered, not truncated. Rejected.
 *   3. Identity is verified, not assumed. The caller must supply the SKU the product_id actually
 *      resolves to, and it must match the SKU we intended to remove.
 *   4. Preview always works. Session checks, mapping checks and payload construction run with the
 *      gates closed, so the whole path can be exercised without touching the supplier.
 */

export const REMOVAL_ENDPOINT =
  'https://www.gigab2b.com/index.php?route=account/wishlist/delProductsFromWish';

/** The switch. Absent or anything other than the exact string 'true' means disabled. */
export const REMOVAL_ENABLED_ENV = 'SUPPLIER_FAVORITE_REMOVAL_ENABLED';

export function removalEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[REMOVAL_ENABLED_ENV] === 'true';
}

export type RemovalRejectionCode =
  | 'removal_disabled'
  | 'batch_request_rejected'
  | 'product_id_invalid'
  | 'sku_missing'
  | 'identity_mismatch'
  | 'approval_missing'
  | 'approval_incomplete'
  | 'asset_not_removable'
  | 'session_missing';

export interface RemovalApproval {
  asset_state: string | null;
  founder_status: string | null;
  approved_at: string | null;
  approved_by: string | null;
}

export interface RemovalRequest {
  /** The supplier SKU we intend to remove. */
  supplier_product_id: string;
  /** The website's numeric product_id that `supplier_product_id` maps to. */
  product_id: unknown;
  /** The SKU the product_id was independently confirmed to resolve back to. */
  verified_sku_for_product_id: string | null;
  approval: RemovalApproval;
  /** Whether an authenticated website session is available. */
  session_present: boolean;
}

export interface RemovalPreview {
  ok: boolean;
  would_send: boolean;
  endpoint: string;
  method: 'POST';
  /** Built only when every check passed; otherwise null so there is nothing to replay. */
  payload: { product_ids: number } | null;
  supplier_product_id: string;
  product_id: number | null;
  rejections: RemovalRejectionCode[];
  removal_enabled: boolean;
  notes: string[];
}

/**
 * A batch-shaped `product_ids` is rejected outright rather than normalised. Accepting "123,456"
 * and silently taking the first would be the exact failure this guard exists to prevent.
 */
function coerceSingleProductId(value: unknown): { id: number | null; batch: boolean } {
  if (Array.isArray(value)) return { id: null, batch: true };
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? { id: value, batch: false } : { id: null, batch: false };
  }
  if (typeof value === 'string') {
    const raw = value.trim();
    // Any separator at all means the caller was thinking in batches.
    if (/[,;\s|]/.test(raw)) return { id: null, batch: true };
    if (!/^\d+$/.test(raw)) return { id: null, batch: false };
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? { id: n, batch: false } : { id: null, batch: false };
  }
  return { id: null, batch: false };
}

/**
 * Evaluate one removal without contacting anything. Safe to call at any time — this is what the
 * panel's "验证取消准备状态" button runs.
 */
export function previewRemoval(
  request: RemovalRequest,
  env: Record<string, string | undefined> = process.env,
): RemovalPreview {
  const rejections: RemovalRejectionCode[] = [];
  const notes: string[] = [];
  const enabled = removalEnabled(env);

  const { id, batch } = coerceSingleProductId(request.product_id);
  if (batch) {
    rejections.push('batch_request_rejected');
    notes.push('product_ids 必须是单个数字；数组、逗号或空格分隔的批量参数一律拒绝');
  } else if (id === null) {
    rejections.push('product_id_invalid');
  }

  const sku = request.supplier_product_id.trim();
  if (!sku) rejections.push('sku_missing');

  // The mapping must be proven in the reverse direction, or we do not know what we would delete.
  if (!request.verified_sku_for_product_id || request.verified_sku_for_product_id.trim() !== sku || !sku) {
    rejections.push('identity_mismatch');
    notes.push('product_id 反查得到的 SKU 与目标 SKU 不一致，拒绝取消');
  }

  const { asset_state, founder_status, approved_at, approved_by } = request.approval;
  if (asset_state !== 'REMOVABLE') rejections.push('asset_not_removable');
  if (founder_status !== 'approved') rejections.push('approval_missing');
  if (!approved_at || !approved_by) rejections.push('approval_incomplete');

  if (!request.session_present) rejections.push('session_missing');

  const gatesClear = rejections.length === 0;
  if (!enabled) {
    rejections.push('removal_disabled');
    notes.push(`${REMOVAL_ENABLED_ENV} 未开启，本次只生成预览，不会发送任何请求`);
  }

  return {
    ok: gatesClear,
    would_send: gatesClear && enabled,
    endpoint: REMOVAL_ENDPOINT,
    method: 'POST',
    payload: gatesClear && id !== null ? { product_ids: id } : null,
    supplier_product_id: sku,
    product_id: id,
    rejections,
    removal_enabled: enabled,
    notes,
  };
}

export interface RemovalResult {
  attempted: boolean;
  succeeded: boolean;
  preview: RemovalPreview;
  response_code: number | null;
  error: string | null;
}

export type RemovalFetcher = (
  url: string,
  init: { method: string; body: string; headers: Record<string, string> },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

/**
 * Execute ONE removal. Sends a request only when `previewRemoval` cleared every gate AND the env
 * switch is on. With the switch off this is a pure preview and the fetcher is never invoked.
 *
 * There is no batch entry point, and there is deliberately no way to pass more than one SKU.
 */
export async function executeRemoval(
  request: RemovalRequest,
  fetcher: RemovalFetcher,
  env: Record<string, string | undefined> = process.env,
): Promise<RemovalResult> {
  const preview = previewRemoval(request, env);
  if (!preview.would_send || !preview.payload) {
    return { attempted: false, succeeded: false, preview, response_code: null, error: null };
  }

  try {
    const response = await fetcher(REMOVAL_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify(preview.payload),
      headers: { 'Content-Type': 'application/json' },
    });
    const body = (await response.json()) as { code?: unknown } | null;
    const code = Number((body as { code?: unknown })?.code ?? response.status);
    return {
      attempted: true,
      succeeded: code === 200,
      preview,
      response_code: Number.isFinite(code) ? code : null,
      error: code === 200 ? null : `supplier returned code ${code}`,
    };
  } catch (error) {
    return {
      attempted: true,
      succeeded: false,
      preview,
      response_code: null,
      error: error instanceof Error ? error.message : 'removal_request_failed',
    };
  }
}
