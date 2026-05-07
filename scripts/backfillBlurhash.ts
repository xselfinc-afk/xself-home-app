/**
 * Phase 2b backfill — populate primary_image_blurhash, primary_image_w/h,
 * primary_image_aspect for every standardized_products row.
 *
 *   npx tsx scripts/backfillBlurhash.ts
 *   LIMIT=20 npx tsx scripts/backfillBlurhash.ts
 *   FORCE=1 npx tsx scripts/backfillBlurhash.ts        # re-process rows even if blurhash already set
 *   CONCURRENCY=8 npx tsx scripts/backfillBlurhash.ts  # default 6
 *
 * Env required (loaded from .env.local):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   EXPO_PUBLIC_IMAGE_PROXY_BASE  (optional — used to fetch a small variant
 *                                  for fast decoding instead of pulling the
 *                                  multi-MB original)
 *
 * The script is idempotent. Failures (timeouts, decode errors, oversized
 * supplier images) are logged and skipped; re-running picks them up.
 */

import { createClient } from '@supabase/supabase-js';
import { encode as encodeBlurhash } from 'blurhash';
import sharp from 'sharp';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Env loading (.env.local first, then .env) ────────────────────────────────
function loadEnv(file: string) {
  if (!fs.existsSync(file)) return;
  const txt = fs.readFileSync(file, 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv(path.join(process.cwd(), '.env.local'));
loadEnv(path.join(process.cwd(), '.env'));

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const PROXY_BASE   = (process.env.EXPO_PUBLIC_IMAGE_PROXY_BASE ?? '').replace(/\/+$/, '');

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.');
  process.exit(1);
}

const LIMIT       = process.env.LIMIT ? Math.max(1, parseInt(process.env.LIMIT, 10)) : null;
const CONCURRENCY = process.env.CONCURRENCY ? Math.max(1, parseInt(process.env.CONCURRENCY, 10)) : 6;
const FORCE       = process.env.FORCE === '1';

// Decode size: small enough to be fast, large enough for blurhash detail.
const DECODE_WIDTH = 64;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = {
  supplier_product_id: string;
  primary_image: string;
  primary_image_blurhash: string | null;
};

function variantUrl(src: string, width: number): string {
  if (!PROXY_BASE) return src;
  const t = `w_${width},c_fill,q_auto,f_jpg,fl_progressive`;
  return `${PROXY_BASE}/${t}/${encodeURIComponent(src)}`;
}

async function fetchBuffer(url: string, timeoutMs = 20000): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`http ${r.status}`);
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  } finally {
    clearTimeout(timer);
  }
}

async function processOne(row: Row): Promise<{ ok: boolean; reason?: string }> {
  const original = row.primary_image;
  if (!original) return { ok: false, reason: 'no_primary_image' };

  // 1. Try small variant first (fast). Fallback to original on proxy failure.
  let buf: Buffer;
  try {
    buf = await fetchBuffer(variantUrl(original, 256));
  } catch {
    try { buf = await fetchBuffer(original); }
    catch (e) { return { ok: false, reason: `fetch_failed:${(e as Error).message}` }; }
  }

  // 2. Decode and read intrinsic dimensions BEFORE downscaling for blurhash.
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w <= 0 || h <= 0) return { ok: false, reason: 'no_dims' };

  // 3. Downscale to a small RGBA buffer for blurhash encoding.
  const decodeH = Math.max(1, Math.round((h / w) * DECODE_WIDTH));
  const { data, info } = await sharp(buf)
    .resize(DECODE_WIDTH, decodeH, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const blurhash = encodeBlurhash(
    new Uint8ClampedArray(data),
    info.width,
    info.height,
    4, // x components
    3, // y components
  );

  const aspect = Math.round((w / h) * 1000) / 1000;

  const { error } = await sb
    .from('standardized_products')
    .update({
      primary_image_blurhash: blurhash,
      primary_image_w: w,
      primary_image_h: h,
      primary_image_aspect: aspect,
    })
    .eq('supplier_product_id', row.supplier_product_id);

  if (error) return { ok: false, reason: `db:${error.message}` };
  return { ok: true };
}

async function main() {
  console.log(`[blurhash] decode width=${DECODE_WIDTH}px concurrency=${CONCURRENCY} force=${FORCE} limit=${LIMIT ?? 'all'}`);

  let q = sb
    .from('standardized_products')
    .select('supplier_product_id,primary_image,primary_image_blurhash')
    .not('primary_image', 'eq', '');
  if (!FORCE) q = q.is('primary_image_blurhash', null);
  if (LIMIT) q = q.limit(LIMIT);

  const { data, error } = await q;
  if (error) { console.error('query failed:', error); process.exit(1); }

  const rows = (data ?? []) as Row[];
  console.log(`[blurhash] ${rows.length} row(s) to process`);
  if (rows.length === 0) return;

  let done = 0, failed = 0;
  const fails: Array<{ id: string; reason: string }> = [];

  // Simple concurrency pool.
  const queue = [...rows];
  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      if (!row) return;
      const t0 = Date.now();
      try {
        const res = await processOne(row);
        if (res.ok) {
          done++;
          if (done % 10 === 0 || done === rows.length) {
            console.log(`  [${done}/${rows.length}] ok ${row.supplier_product_id} (${Date.now() - t0}ms)`);
          }
        } else {
          failed++;
          fails.push({ id: row.supplier_product_id, reason: res.reason ?? '?' });
          console.log(`  [skip] ${row.supplier_product_id} — ${res.reason}`);
        }
      } catch (e) {
        failed++;
        const reason = (e as Error).message;
        fails.push({ id: row.supplier_product_id, reason });
        console.log(`  [err]  ${row.supplier_product_id} — ${reason}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`\n[blurhash] done=${done} failed=${failed}`);
  if (fails.length) {
    console.log('[blurhash] failures:');
    for (const f of fails.slice(0, 30)) console.log(`  ${f.id} — ${f.reason}`);
    if (fails.length > 30) console.log(`  …and ${fails.length - 30} more`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
