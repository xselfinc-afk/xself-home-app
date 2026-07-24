/**
 * image-search — server-side proxy for the "photo → furniture search keywords"
 * vision call.
 *
 * The Anthropic API key lives ONLY as the Supabase Function Secret
 * ANTHROPIC_API_KEY and never reaches the React Native client. (The app
 * previously shipped EXPO_PUBLIC_ANTHROPIC_API_KEY inlined in the JS bundle,
 * which exposed the key to anyone who extracted the binary — removed.)
 *
 * Request  (POST JSON): { image_base64: string, media_type: string }
 * Response (200 JSON):  { keywords: string }   // '' when nothing is detected
 * Errors   (4xx/5xx):   { error: string }      // safe, non-sensitive message
 *
 * Callable with the project's anon or user JWT (Supabase verify_jwt gate).
 * Abuse mitigation for a leaked anon key: strict input validation, a hard
 * image-size cap, tiny max_tokens, and a request timeout — bounding per-call
 * cost. (A per-user rate limit backed by a table is a future enhancement.)
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const ANTHROPIC_API_KEY = (Deno.env.get('ANTHROPIC_API_KEY') ?? '').trim();

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_OUTPUT_TOKENS = 64;
const REQUEST_TIMEOUT_MS = 15_000;

// Anthropic caps a single image at ~5 MB. base64 inflates ~4/3, so reject any
// base64 payload larger than ~7 MB (≈ 5.25 MB decoded) before forwarding it.
const MAX_BASE64_CHARS = 7_000_000;
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// Kept identical to the former client-side prompt so keyword output is unchanged.
const PROMPT =
  'Identify the furniture or home decor item in this image. Return ONLY 2–3 ' +
  'search keywords that would find similar products in a furniture catalog. ' +
  'Focus on: item type, color, and material if visible. Examples: "white ' +
  'dresser", "modern TV stand", "wood dining chair", "blue sofa". Return ONLY ' +
  'the keywords as a short phrase, nothing else.';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Boot diagnostic — presence/length only, never the secret value.
console.log('[image-search] boot:', JSON.stringify({
  has_anthropic_key: ANTHROPIC_API_KEY.length > 0,
  key_len:           ANTHROPIC_API_KEY.length,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

interface ImageSearchBody {
  image_base64?: string;
  media_type?: string;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST')    return jsonResponse({ error: 'Method not allowed' }, 405);

  if (!ANTHROPIC_API_KEY) {
    console.error('[image-search] ANTHROPIC_API_KEY not configured on server');
    return jsonResponse({ error: 'Image search is temporarily unavailable.' }, 500);
  }

  let body: ImageSearchBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const imageBase64 = typeof body.image_base64 === 'string' ? body.image_base64 : '';
  const mediaType   = typeof body.media_type === 'string' ? body.media_type.trim() : '';

  // ── Input validation ────────────────────────────────────────────────────
  if (!imageBase64) {
    return jsonResponse({ error: 'image_base64 is required' }, 400);
  }
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    return jsonResponse({ error: 'Unsupported image type' }, 400);
  }
  if (imageBase64.length > MAX_BASE64_CHARS) {
    return jsonResponse({ error: 'Image too large' }, 413);
  }
  // Cheap sanity check that the payload looks like base64 (never log its content).
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64.slice(0, 128))) {
    return jsonResponse({ error: 'Malformed image data' }, 400);
  }

  // ── Upstream call with timeout ──────────────────────────────────────────
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    });

    if (!res.ok) {
      // Log the status only — never the upstream body (it can echo the request).
      console.warn('[image-search] Anthropic error status:', res.status);
      // Preserve the app's graceful-degradation contract: empty keywords.
      return jsonResponse({ keywords: '' });
    }

    const data = await res.json();
    const keywords = typeof data?.content?.[0]?.text === 'string'
      ? data.content[0].text.trim()
      : '';
    return jsonResponse({ keywords });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    console.warn('[image-search] upstream failed:', aborted ? 'timeout' : 'error');
    return jsonResponse({ keywords: '' });
  } finally {
    clearTimeout(timer);
  }
});
