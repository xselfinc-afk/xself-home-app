/**
 * Phase 3.1 — mirror primary_image bytes from supplier CDN into our own
 * Supabase Storage bucket (`product-images`).
 *
 *   LIMIT=10 npx tsx scripts/mirrorImagesToStorage.ts        # smoke test
 *   npx tsx scripts/mirrorImagesToStorage.ts                 # all pending
 *   FORCE=1 npx tsx scripts/mirrorImagesToStorage.ts         # re-mirror everyone
 *   CONCURRENCY=4 npx tsx scripts/mirrorImagesToStorage.ts   # default 4
 *
 * Idempotent. Original `primary_image` column is never mutated; a successful
 * run sets `primary_image_mirror_path` (content-addressed) and status='mirrored'.
 *
 * Bucket layout: `images/<sha[0:2]>/<sha[2:4]>/<sha[4:]>.jpg` — content-addressed
 * so identical images across SKUs collapse to one stored object.
 *
 * Pre-requisite (one-time, in Supabase SQL Editor):
 *   alter table public.standardized_products
 *     add column if not exists primary_image_mirror_path  text,
 *     add column if not exists primary_image_mirror_sha   text,
 *     add column if not exists primary_image_mirror_at    timestamptz,
 *     add column if not exists primary_image_mirror_status text not null default 'pending'
 *       check (primary_image_mirror_status in ('pending','mirrored','oversize','fetch_failed','skip'));
 *
 * Pre-requisite: a public `product-images` bucket exists (Storage UI →
 * Create bucket → name product-images → toggle Public).
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Env loading (.env.local first, then .env) ────────────────────────────────
function loadEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv(path.join(process.cwd(), '.env.local'));
loadEnv(path.join(process.cwd(), '.env'));

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.');
  process.exit(1);
}

const BUCKET      = 'product-images';
const LIMIT       = process.env.LIMIT ? Math.max(1, parseInt(process.env.LIMIT, 10)) : null;
const CONCURRENCY = process.env.CONCURRENCY ? Math.max(1, parseInt(process.env.CONCURRENCY, 10)) : 4;
const FORCE       = process.env.FORCE === '1';
// 50 MiB — Supabase Storage hard limit on free / Pro plans for single objects.
const MAX_BYTES   = process.env.MAX_BYTES ? parseInt(process.env.MAX_BYTES, 10) : 52_428_800;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = {
  supplier_product_id: string;
  primary_image: string;
  primary_image_mirror_path: string | null;
  primary_image_mirror_status: string | null;
};

function pathFromSha(sha: string): string {
  return `images/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha.slice(4)}.jpg`;
}

async function fetchBuffer(url: string, timeoutMs = 30_000): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`http ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function objectExists(p: string): Promise<boolean> {
  // Storage API doesn't expose HEAD directly; use list filtered by name as a probe.
  // Cheap because content-addressed paths are predictable.
  const dir = p.substring(0, p.lastIndexOf('/'));
  const name = p.substring(p.lastIndexOf('/') + 1);
  const { data, error } = await sb.storage.from(BUCKET).list(dir, { search: name, limit: 1 });
  if (error) return false;
  return !!data?.some(item => item.name === name);
}

type OkResult  = { kind: 'ok'; reused: boolean; path: string; sha: string; bytes: number; ms: number };
type ErrResult = { kind: 'err'; status: 'fetch_failed' | 'oversize' | 'upload_failed' | 'db_failed' | 'skip'; reason: string };
type Result = OkResult | ErrResult;

async function processOne(row: Row): Promise<Result> {
  const t0 = Date.now();
  if (!row.primary_image) return { kind: 'err', status: 'skip', reason: 'empty_primary' };

  let buf: Buffer;
  try { buf = await fetchBuffer(row.primary_image); }
  catch (e) { return { kind: 'err', status: 'fetch_failed', reason: (e as Error).message }; }

  if (buf.length > MAX_BYTES) {
    return { kind: 'err', status: 'oversize', reason: `${buf.length} > ${MAX_BYTES}` };
  }

  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const objectPath = pathFromSha(sha);

  let reused = false;
  if (await objectExists(objectPath)) {
    reused = true;
  } else {
    const { error } = await sb.storage.from(BUCKET).upload(objectPath, buf, {
      contentType: 'image/jpeg',
      cacheControl: '31536000',
      upsert: false,
    });
    // 'upsert: false' returns "Duplicate" on race; treat as reused.
    if (error && !/duplicate/i.test(error.message)) {
      return { kind: 'err', status: 'upload_failed', reason: error.message };
    }
    if (error) reused = true;
  }

  return { kind: 'ok', reused, path: objectPath, sha, bytes: buf.length, ms: Date.now() - t0 };
}

async function main() {
  // Pre-flight: confirm new columns exist.
  const probe = await sb.from('standardized_products').select('primary_image_mirror_path').limit(1);
  if (probe.error) {
    console.error('\n❌  Column primary_image_mirror_path does not exist yet.');
    console.error('    Apply this in Supabase SQL Editor first, then re-run:\n');
    console.error('    alter table public.standardized_products');
    console.error('      add column if not exists primary_image_mirror_path  text,');
    console.error('      add column if not exists primary_image_mirror_sha   text,');
    console.error('      add column if not exists primary_image_mirror_at    timestamptz,');
    console.error("      add column if not exists primary_image_mirror_status text not null default 'pending'");
    console.error("        check (primary_image_mirror_status in ('pending','mirrored','oversize','fetch_failed','skip'));\n");
    process.exit(1);
  }

  // Pre-flight: confirm bucket exists.
  const bk = await sb.storage.getBucket(BUCKET);
  if (bk.error) {
    console.error(`\n❌  Bucket "${BUCKET}" does not exist or is not visible to the service role.`);
    console.error('    In Supabase Studio → Storage → Create bucket: name=product-images, Public=on.\n');
    console.error(`    (Underlying error: ${bk.error.message})\n`);
    process.exit(1);
  }

  console.log(`[mirror] bucket=${BUCKET} concurrency=${CONCURRENCY} force=${FORCE} limit=${LIMIT ?? 'all'}`);

  let q = sb
    .from('standardized_products')
    .select('supplier_product_id,primary_image,primary_image_mirror_path,primary_image_mirror_status')
    .not('primary_image', 'eq', '');
  if (!FORCE) q = q.is('primary_image_mirror_path', null);
  if (LIMIT) q = q.limit(LIMIT);

  const { data, error } = await q;
  if (error) { console.error('query failed:', error); process.exit(1); }
  const rows = (data ?? []) as Row[];
  console.log(`[mirror] ${rows.length} row(s) to process`);
  if (rows.length === 0) return;

  let mirrored = 0, reused = 0, oversize = 0, fetchFailed = 0, otherFailed = 0;
  const failures: string[] = [];

  const queue = [...rows];
  async function worker(workerId: number) {
    while (queue.length) {
      const row = queue.shift();
      if (!row) return;
      const res = await processOne(row);

      if (res.kind === 'err') {
        const failStatus = res.status;
        const failReason = res.reason;
        if (failStatus === 'oversize')      oversize++;
        else if (failStatus === 'fetch_failed') fetchFailed++;
        else                                    otherFailed++;

        // Persist non-OK status so re-runs don't retry indefinitely.
        await sb
          .from('standardized_products')
          .update({ primary_image_mirror_status: failStatus })
          .eq('supplier_product_id', row.supplier_product_id);

        failures.push(`${row.supplier_product_id} ${failStatus}: ${failReason}`);
        console.log(`  [w${workerId}][${failStatus}] ${row.supplier_product_id} — ${failReason}`);
        continue;
      }

      const upd = await sb
        .from('standardized_products')
        .update({
          primary_image_mirror_path: res.path,
          primary_image_mirror_sha: res.sha,
          primary_image_mirror_at: new Date().toISOString(),
          primary_image_mirror_status: 'mirrored',
        })
        .eq('supplier_product_id', row.supplier_product_id);
      if (upd.error) {
        otherFailed++;
        failures.push(`${row.supplier_product_id} db: ${upd.error.message}`);
        console.log(`  [w${workerId}][db]   ${row.supplier_product_id} — ${upd.error.message}`);
        continue;
      }
      if (res.reused) reused++; else mirrored++;
      const tag = res.reused ? 'dedupe' : 'upload';
      console.log(`  [w${workerId}][${tag}] ${row.supplier_product_id}  sha=${res.sha.slice(0, 8)}…  ${(res.bytes / 1024).toFixed(0)}KB  ${res.ms}ms`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));

  console.log('\n[mirror] summary');
  console.log(`  uploaded   ${mirrored}`);
  console.log(`  deduped    ${reused}`);
  console.log(`  oversize   ${oversize}`);
  console.log(`  fetch_fail ${fetchFailed}`);
  console.log(`  other_fail ${otherFailed}`);
  if (failures.length) {
    console.log('\n[mirror] notable rows:');
    for (const f of failures.slice(0, 20)) console.log(`  ${f}`);
    if (failures.length > 20) console.log(`  …and ${failures.length - 20} more`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
