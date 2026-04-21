import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const BASE_URL = Deno.env.get('SUPPLIER_API_BASE_URL') ?? '';
const CLIENT_ID = Deno.env.get('SUPPLIER_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('SUPPLIER_CLIENT_SECRET') ?? '';

const GIGA_PATH = '/b2b-overseas-api/v1/buyer/stock/warehouseStock/v1';

function generateNonce(length = 10): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

async function hmacSha256Hex(message: string, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function generateSign(path: string, timestamp: string, nonce: string): Promise<string> {
  const msg = `${CLIENT_ID}&${path}&${timestamp}&${nonce}`;
  const key = `${CLIENT_ID}&${CLIENT_SECRET}&${nonce}`;
  const hex = await hmacSha256Hex(msg, key);
  // Encode the hex string as base64 (matching Node: Buffer.from(hex,'utf8').toString('base64'))
  return btoa(hex);
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (!BASE_URL || !CLIENT_ID || !CLIENT_SECRET) {
      return new Response(
        JSON.stringify({ error: 'Supplier API credentials not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { skus } = await req.json() as { skus: string[] };

    if (!Array.isArray(skus) || skus.length === 0) {
      return new Response(
        JSON.stringify({ error: 'skus array is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const timestamp = Date.now().toString();
    const nonce = generateNonce();
    const sign = await generateSign(GIGA_PATH, timestamp, nonce);

    const res = await fetch(`${BASE_URL}${GIGA_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'client-id': CLIENT_ID,
        timestamp,
        nonce,
        sign,
      },
      body: JSON.stringify({ skus }),
    });

    const rawText = await res.text();

    let data: unknown;
    try {
      data = JSON.parse(rawText);
    } catch {
      return new Response(
        JSON.stringify({ error: `GIGA returned non-JSON: ${rawText.slice(0, 300)}` }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `GIGA HTTP ${res.status}`, detail: data }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
