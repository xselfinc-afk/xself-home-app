/**
 * Probe: specified warehouse / full-connection API paths under b2b-api namespace.
 * The b2b-overseas-api paths were all "path does not exist".
 * The b2b-api server gave a proper Spring 404, meaning the gateway is different.
 * This tests paths that a Full Connection / Myself account might use.
 *
 * Run: npx tsx scripts/probeSpecifiedWarehouse.ts
 */

import 'dotenv/config';
import { gigaRequest } from '../src/services/gigaApiClient';

const TEST_SKU = process.env.TEST_SKU ?? 'SG000640AAL';

async function probe(label: string, path: string, body: Record<string, unknown>) {
  process.stdout.write(`  ${label.padEnd(65)} `);
  try {
    const res = await (gigaRequest as any).__raw?.(path, body) ?? await probeRaw(path, body);
    process.stdout.write(`← ${JSON.stringify(res).slice(0, 120)}\n`);
  } catch (err: any) {
    const msg = err.message ?? '';
    let summary = msg.slice(0, 200);
    try {
      const j = JSON.parse(msg.replace('[GIGA HTTP ERROR] ', '').replace('[GIGA BUSINESS ERROR] ', ''));
      summary = `HTTP${j.status ?? '?'} code=${j.code ?? j.error ?? '?'} msg="${j.msg ?? j.message ?? j.error ?? ''}"`;
    } catch { /* use raw msg */ }
    process.stdout.write(`← ${summary}\n`);
  }
}

// Direct fetch without the business-error check, to see raw status + body
async function probeRaw(path: string, body: Record<string, unknown>) {
  const BASE_URL = process.env.SUPPLIER_API_BASE_URL!;
  const CLIENT_ID = process.env.SUPPLIER_CLIENT_ID!;
  const CLIENT_SECRET = process.env.SUPPLIER_CLIENT_SECRET!;

  function nonce(n = 10) {
    const c = 'abcdefghijklmnopqrstuvwxyz0123456789'; let r = '';
    for (let i = 0; i < n; i++) r += c[Math.floor(Math.random() * c.length)];
    return r;
  }
  function hmac(msg: string, key: string) {
    const crypto = require('crypto');
    return crypto.createHmac('sha256', key).update(msg).digest('hex');
  }
  const ts = Date.now().toString();
  const nc = nonce();
  const msg = `${CLIENT_ID}&${path}&${ts}&${nc}`;
  const k = `${CLIENT_ID}&${CLIENT_SECRET}&${nc}`;
  const sign = Buffer.from(hmac(msg, k), 'utf8').toString('base64');

  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'client-id': CLIENT_ID, timestamp: ts, nonce: nc, sign },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text.slice(0, 200); }
  return { httpStatus: res.status, ...( typeof data === 'object' ? data : { body: data }) };
}

async function run() {
  console.log(`\nSpecified-warehouse API probe for SKU: ${TEST_SKU}`);
  console.log(`BASE_URL: ${process.env.SUPPLIER_API_BASE_URL}`);
  console.log('');

  // ── Previously tried (all b2b-overseas-api) ─────────────────────────────────
  console.log('── Already confirmed FAILING (b2b-overseas-api namespace) ─────────────────');
  await probe('overseas /stock/warehouseStock/v1', '/b2b-overseas-api/v1/buyer/stock/warehouseStock/v1', { skus: [TEST_SKU] });

  // ── b2b-api namespace — different server, worth probing ─────────────────────
  console.log('\n── b2b-api namespace (separate gateway, showed Spring 404 before) ──────────');
  await probe('b2b-api /stock/warehouseStock/v1', '/b2b-api/v1/buyer/stock/warehouseStock/v1', { skus: [TEST_SKU] });
  await probe('b2b-api /stock/warehouseStock/v1 + skuList', '/b2b-api/v1/buyer/stock/warehouseStock/v1', { skuList: [TEST_SKU] });
  await probe('b2b-api /warehouse/stock/v1', '/b2b-api/v1/buyer/warehouse/stock/v1', { skus: [TEST_SKU] });
  await probe('b2b-api /warehouse/inventory/v1', '/b2b-api/v1/buyer/warehouse/inventory/v1', { skus: [TEST_SKU] });
  await probe('b2b-api /inventory/warehouseStock/v1', '/b2b-api/v1/buyer/inventory/warehouseStock/v1', { skus: [TEST_SKU] });
  await probe('b2b-api /inventory/list/v1', '/b2b-api/v1/buyer/inventory/list/v1', { skus: [TEST_SKU] });
  await probe('b2b-api /product/stock/v1', '/b2b-api/v1/buyer/product/stock/v1', { skus: [TEST_SKU] });

  // ── Specified warehouse specific paths ──────────────────────────────────────
  console.log('\n── Specified warehouse / self-arranged shipping style paths ────────────────');
  await probe('overseas /stock/specifiedWarehouseStock/v1', '/b2b-overseas-api/v1/buyer/stock/specifiedWarehouseStock/v1', { skus: [TEST_SKU] });
  await probe('overseas /stock/selfWarehouseStock/v1', '/b2b-overseas-api/v1/buyer/stock/selfWarehouseStock/v1', { skus: [TEST_SKU] });
  await probe('overseas /stock/fullconnection/warehouseStock/v1', '/b2b-overseas-api/v1/buyer/stock/fullconnection/warehouseStock/v1', { skus: [TEST_SKU] });
  await probe('b2b-api /stock/specifiedWarehouseStock/v1', '/b2b-api/v1/buyer/stock/specifiedWarehouseStock/v1', { skus: [TEST_SKU] });
  await probe('b2b-api /specified-warehouse/stock/v1', '/b2b-api/v1/buyer/specified-warehouse/stock/v1', { skus: [TEST_SKU] });

  // ── Seller perspective (maybe stock is queried as seller, not buyer) ─────────
  console.log('\n── Seller-perspective paths (Full Connection may use seller role) ──────────');
  await probe('overseas /seller/stock/warehouseStock/v1', '/b2b-overseas-api/v1/seller/stock/warehouseStock/v1', { skus: [TEST_SKU] });
  await probe('b2b-api /seller/stock/warehouseStock/v1', '/b2b-api/v1/seller/stock/warehouseStock/v1', { skus: [TEST_SKU] });
  await probe('b2b-api /seller/warehouse/stock/v1', '/b2b-api/v1/seller/warehouse/stock/v1', { skus: [TEST_SKU] });

  // ── Working reference to confirm sign/auth still OK ─────────────────────────
  console.log('\n── Working reference (confirm auth still valid) ────────────────────────────');
  await probe('overseas /product/price/v1 (KNOWN WORKING)', '/b2b-overseas-api/v1/buyer/product/price/v1', { skus: [TEST_SKU] });

  console.log('\nDone.');
}

run().catch(console.error);
