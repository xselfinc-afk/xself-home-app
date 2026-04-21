import crypto from 'crypto';

const BASE_URL = process.env.SUPPLIER_API_BASE_URL!;
const CLIENT_ID = process.env.SUPPLIER_CLIENT_ID!;
const CLIENT_SECRET = process.env.SUPPLIER_CLIENT_SECRET!;

function generateNonce(length = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function hmacSha256Hex(message: string, key: string) {
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

function generateSign(path: string, timestamp: string, nonce: string) {
  const msg = `${CLIENT_ID}&${path}&${timestamp}&${nonce}`;
  const key = `${CLIENT_ID}&${CLIENT_SECRET}&${nonce}`;
  const hex = hmacSha256Hex(msg, key);

  return Buffer.from(hex, 'utf8').toString('base64');
}

export async function gigaRequest(path: string, bizBody: Record<string, unknown>) {
  const timestamp = Date.now().toString();
  const nonce = generateNonce();
  const sign = generateSign(path, timestamp, nonce);

  const url = `${BASE_URL}${path}`;

  console.log('[GIGA] Request URL:', url);
  console.log('[GIGA] Request headers:', {
    'Content-Type': 'application/json',
    'client-id': CLIENT_ID,
    timestamp,
    nonce,
    sign: '[hidden]',
  });
  console.log('[GIGA] Request body:', JSON.stringify(bizBody));

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'client-id': CLIENT_ID,
      timestamp,
      nonce,
      sign,
    },
    body: JSON.stringify(bizBody),
  });

  const rawText = await res.text();

  console.log('[GIGA] Status:', res.status);
  console.log('[GIGA] Raw response:', rawText.slice(0, 1000));

  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`[GIGA] Expected JSON but got: ${rawText.slice(0, 300)}`);
  }

  if (!res.ok) {
    throw new Error(`[GIGA HTTP ERROR] ${JSON.stringify(data)}`);
  }

  if (data?.success === false || (data?.code && String(data.code) !== '200')) {
    throw new Error(`[GIGA BUSINESS ERROR] ${JSON.stringify(data)}`);
  }

  return data;
}

export async function fetchProductDetails(skuList: string[]) {
  return gigaRequest(
    '/b2b-overseas-api/v1/buyer/product/detailInfo/v1',
    {
      skus: skuList,
    },
  );
}

export async function fetchProductPrices(skuList: string[]) {
  return gigaRequest(
    '/b2b-overseas-api/v1/buyer/product/price/v1',
    {
      skus: skuList,
    },
  );
}

/**
 * Fetch the supplier's own "New Arrivals" SKU list (supports pagination).
 * Returns records with firstArrivalDate, addedTime, updateTime per SKU.
 */
export async function fetchNewArrivalSkuList(page = 1) {
  return gigaRequest(
    '/b2b-overseas-api/v1/buyer/product/skus/v1',
    { page, pageSize: 100, isNewArrival: true },
  );
}