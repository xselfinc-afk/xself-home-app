import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import {
  XONE_PRODUCT_READER_SCHEMA_VERSION,
  buildCustomerServiceProductSnapshot,
  buildSearchResults,
  sourceEnvironmentFingerprint,
  validateReaderQuery,
  validateSku,
  type CustomerServiceProductSnapshot,
  type StandardizedProductRow,
} from '../src/services/customerServiceProductSnapshot';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const SELECT_FIELDS = [
  'id', 'sku_custom', 'product_title', 'selling_price', 'price',
  'inventory_status', 'total_available_qty', 'inventory_last_synced_at',
  'fulfillment_buffer', 'estimated_payment_fee', 'estimated_net_profit',
  'estimated_net_margin', 'primary_image', 'specifications_json',
  'key_features_json', 'published', 'normalization_status',
].join(',');

type ReaderRequest =
  | { schema_version: '1.0'; operation: 'search'; query: string; limit?: number }
  | { schema_version: '1.0'; operation: 'snapshot'; sku: string; product_id?: string };

type ReaderErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_QUERY'
  | 'INVALID_SKU'
  | 'NOT_CONFIGURED'
  | 'PRODUCT_NOT_FOUND'
  | 'SKU_CONFLICT'
  | 'READ_FAILED';

export async function executeProductReader(
  request: ReaderRequest,
  client: SupabaseClient,
  sourceEnvironment: string,
  now = new Date(),
): Promise<Record<string, unknown>> {
  if (request.schema_version !== XONE_PRODUCT_READER_SCHEMA_VERSION) {
    return failure('INVALID_REQUEST', '请求协议版本不受支持');
  }
  if (request.operation === 'search') {
    const query = validateReaderQuery(request.query);
    const limit = Math.min(30, Math.max(1, Number(request.limit ?? 20)));
    const [skuRows, titleRows] = await Promise.all([
      readRows(client, 'sku_custom', query, limit),
      readRows(client, 'product_title', query, limit),
    ]);
    const combined = dedupeRows([...skuRows, ...titleRows]);
    const snapshots = await snapshotsForRows(client, combined, sourceEnvironment, now);
    return {
      schema_version: '1.0',
      ok: true,
      operation: 'search',
      results: buildSearchResults(snapshots, query).slice(0, limit),
      source_snapshot_at: now.toISOString(),
      platform_write_attempted: false,
    };
  }
  if (request.operation === 'snapshot') {
    const sku = validateSku(request.sku);
    const { data, error } = await client
      .from('standardized_products')
      .select(SELECT_FIELDS)
      .eq('sku_custom', sku)
      .limit(20);
    if (error) throw new Error('READ_FAILED');
    const rows = (data ?? []) as StandardizedProductRow[];
    if (!rows.length) return failure('PRODUCT_NOT_FOUND', '没有找到该 SKU');
    const selectedRows = request.product_id
      ? rows.filter((row) => String(row.id ?? '') === request.product_id)
      : rows;
    if (request.product_id && !selectedRows.length) {
      return failure('PRODUCT_NOT_FOUND', 'SKU 与 product_id 不匹配');
    }
    if (!request.product_id && rows.length > 1) {
      const snapshots = await snapshotsForRows(client, rows, sourceEnvironment, now);
      return {
        ...failure('SKU_CONFLICT', '该 SKU 对应多个商品，必须明确选择 product_id'),
        conflicts: buildSearchResults(snapshots, sku),
      };
    }
    const snapshots = await snapshotsForRows(client, selectedRows, sourceEnvironment, now);
    return {
      schema_version: '1.0',
      ok: true,
      operation: 'snapshot',
      snapshot: snapshots[0],
      platform_write_attempted: false,
    };
  }
  return failure('INVALID_REQUEST', '不支持的固定操作');
}

async function readRows(
  client: SupabaseClient,
  field: 'sku_custom' | 'product_title',
  query: string,
  limit: number,
): Promise<StandardizedProductRow[]> {
  const escaped = query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  const result = await client
    .from('standardized_products')
    .select(SELECT_FIELDS)
    .ilike(field, `%${escaped}%`)
    .limit(limit);
  if (result.error) throw new Error('READ_FAILED');
  return (result.data ?? []) as StandardizedProductRow[];
}

async function snapshotsForRows(
  client: SupabaseClient,
  rows: StandardizedProductRow[],
  sourceEnvironment: string,
  now: Date,
): Promise<CustomerServiceProductSnapshot[]> {
  const ids = rows.map((row) => String(row.id ?? '')).filter(Boolean);
  const sellableIds = new Set<string>();
  if (ids.length) {
    const result = await client.from('sellable_products').select('id').in('id', ids);
    if (result.error) throw new Error('READ_FAILED');
    for (const row of result.data ?? []) sellableIds.add(String(row.id ?? ''));
  }
  const snapshots: CustomerServiceProductSnapshot[] = [];
  for (const row of rows) {
    try {
      snapshots.push(buildCustomerServiceProductSnapshot(row, {
        now,
        sourceEnvironment,
        inSellableView: sellableIds.has(String(row.id ?? '')),
      }));
    } catch {
      // One malformed product must not break the entire customer-service workspace.
    }
  }
  return snapshots;
}

function dedupeRows(rows: StandardizedProductRow[]): StandardizedProductRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const id = String(row.id ?? '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function failure(code: ReaderErrorCode, message: string): Record<string, unknown> {
  return {
    schema_version: '1.0',
    ok: false,
    error: { code, message },
    platform_write_attempted: false,
  };
}

function parseRequest(raw: string): ReaderRequest {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST');
  const allowed = value.operation === 'search'
    ? new Set(['schema_version', 'operation', 'query', 'limit'])
    : new Set(['schema_version', 'operation', 'sku', 'product_id']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('INVALID_REQUEST');
  if (value.operation !== 'search' && value.operation !== 'snapshot') throw new Error('INVALID_REQUEST');
  return value as ReaderRequest;
}

async function main(): Promise<void> {
  let response: Record<string, unknown>;
  try {
    const raw = await readStdin();
    const request = parseRequest(raw);
    const url = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
      ?? process.env.SUPABASE_SERVICE_KEY
      ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY
      ?? '';
    if (!url || !key) {
      response = failure('NOT_CONFIGURED', '生产商品读取器尚未配置');
    } else {
      const client = createClient(url, key, { auth: { persistSession: false } });
      response = await executeProductReader(
        request,
        client,
        sourceEnvironmentFingerprint(url),
      );
    }
  } catch (error) {
    const code = error instanceof Error && ['INVALID_QUERY', 'INVALID_SKU', 'INVALID_REQUEST'].includes(error.message)
      ? error.message as ReaderErrorCode
      : 'READ_FAILED';
    response = failure(code, code === 'READ_FAILED' ? '生产商品读取失败' : '读取请求无效');
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim() || raw.length > 16_384) throw new Error('INVALID_REQUEST');
  return raw;
}

if (process.argv[1]?.endsWith('xoneCustomerServiceProductRead.ts')) {
  void main();
}
