/**
 * support-chat — server-side bridge to the Crisp REST API for the in-app
 * "Xself Concierge" support flow.
 *
 * Crisp credentials (CRISP_WEBSITE_ID + CRISP_IDENTIFIER + CRISP_KEY) live in
 * Supabase Function Secrets only — they never reach the React Native client.
 *
 * Actions (body.action):
 *   • create_session              → returns { session_id }
 *   • send_message { session_id, content [, nickname, email] }
 *                                 → returns { ok: true, fingerprint }
 *   • get_messages { session_id [, since_fingerprint] }
 *                                 → returns { messages: [...] }
 *
 * Reference: https://docs.crisp.chat/references/rest-api/v1/
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// IMPORTANT: env values from Supabase secrets sometimes carry a trailing
// newline/space when pasted from the dashboard, which breaks base64(id:key)
// (Crisp then returns 401 invalid_session even though credentials are
// otherwise correct). Always .trim() before using them.
const WEBSITE_ID = (Deno.env.get('CRISP_WEBSITE_ID') ?? '').trim();
const IDENTIFIER = (Deno.env.get('CRISP_IDENTIFIER') ?? '').trim();
const KEY        = (Deno.env.get('CRISP_KEY')        ?? '').trim();

// Tokens generated from Crisp Dashboard → Workspace Settings → Advanced
// Configuration → API Token are *Website tokens* and authenticate with
// `X-Crisp-Tier: website`. Plugin-build tokens use `plugin`; personal-user
// tokens (My Profile → API Tokens) use `user`. Default to `website` because
// that's the token type the Xself workspace uses.
//
// Override with: npx supabase secrets set CRISP_TOKEN_TIER=plugin
const CRISP_TIER = ((Deno.env.get('CRISP_TOKEN_TIER') ?? 'website').trim() || 'website') as
  | 'website'
  | 'plugin'
  | 'user';

const CRISP_API_BASE = 'https://api.crisp.chat/v1';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// One-time boot diagnostic. Secret values are never logged — only their
// length and whether the corresponding env var is present. This surfaces
// pasted-newline / empty-secret / wrong-tier issues immediately in the
// Supabase function logs.
console.log('[support-chat] boot:', JSON.stringify({
  has_website_id:  WEBSITE_ID.length > 0,
  has_identifier:  IDENTIFIER.length > 0,
  has_key:         KEY.length > 0,
  website_id_len:  WEBSITE_ID.length,
  identifier_len:  IDENTIFIER.length,
  key_len:         KEY.length,
  tier:            CRISP_TIER,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function authHeader(): string {
  // Basic base64(`${identifier}:${key}`) — per Crisp REST API spec.
  return 'Basic ' + btoa(`${IDENTIFIER}:${KEY}`);
}

function crispHeaders(): Record<string, string> {
  return {
    'Authorization':  authHeader(),
    'X-Crisp-Tier':   CRISP_TIER,
    'Content-Type':   'application/json',
    'Accept':         'application/json',
    'User-Agent':     'XselfHome-Support/1.0 (+supabase-edge)',
  };
}

async function crispFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; data: T | null; raw: string }> {
  const url = `${CRISP_API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...crispHeaders(), ...(init.headers ?? {}) },
  });
  const raw = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* leave null */ }
  if (res.status >= 400) {
    console.warn('[support-chat] Crisp ' + res.status + ' for ' + (init.method ?? 'GET') + ' ' + path,
      raw.slice(0, 400));
  }
  return { status: res.status, data: parsed as T, raw };
}

function crispErrorBody(action: string, status: number, raw: string): Record<string, unknown> {
  let upstream: unknown = null;
  try { upstream = JSON.parse(raw); } catch { /* leave null */ }
  return {
    error:           `Crisp ${action} failed (${status})`,
    crisp_status:    status,
    crisp_tier:      CRISP_TIER,
    crisp_response:  upstream ?? raw.slice(0, 300),
  };
}

// ── Action handlers ──────────────────────────────────────────────────────────

interface CreateSessionResp { error?: boolean; data?: { session_id: string } }

async function createSession(): Promise<Response> {
  const { status, data, raw } = await crispFetch<CreateSessionResp>(
    `/website/${WEBSITE_ID}/conversation`,
    { method: 'POST' },
  );
  if (status >= 400 || !data?.data?.session_id) {
    console.error('[support-chat] create_session failed:', status, raw.slice(0, 240));
    return jsonResponse(crispErrorBody('create_session', status, raw), 502);
  }
  return jsonResponse({ session_id: data.data.session_id });
}

interface SendMessageBody {
  session_id: string;
  content: string;
  nickname?: string;
  email?: string;
}

async function sendMessage(body: SendMessageBody): Promise<Response> {
  if (!body.session_id || !body.content) {
    return jsonResponse({ error: 'session_id and content are required' }, 400);
  }
  if (body.content.length > 4000) {
    return jsonResponse({ error: 'Message exceeds 4000 characters' }, 400);
  }

  // Optionally update the conversation meta with nickname/email so the
  // Crisp dashboard shows who the user is. Non-fatal if it fails.
  if (body.nickname || body.email) {
    const meta: Record<string, unknown> = {};
    if (body.nickname) meta.nickname = body.nickname;
    if (body.email)    meta.email    = body.email;
    await crispFetch(`/website/${WEBSITE_ID}/conversation/${body.session_id}/meta`, {
      method: 'PATCH',
      body: JSON.stringify(meta),
    }).catch(() => { /* ignore */ });
  }

  const { status, data, raw } = await crispFetch<{ error?: boolean; data?: { fingerprint: number } }>(
    `/website/${WEBSITE_ID}/conversation/${body.session_id}/message`,
    {
      method: 'POST',
      body: JSON.stringify({
        type:    'text',
        from:    'user',
        origin:  'chat',
        content: body.content,
      }),
    },
  );
  if (status >= 400) {
    console.error('[support-chat] send_message failed:', status, raw.slice(0, 240));
    return jsonResponse(crispErrorBody('send_message', status, raw), 502);
  }
  return jsonResponse({ ok: true, fingerprint: data?.data?.fingerprint ?? null });
}

interface CrispMessage {
  fingerprint?: number;
  type?: string;
  from?: 'user' | 'operator';
  origin?: string;
  content?: string | { text?: string };
  timestamp?: number;
  user?: { nickname?: string; user_id?: string };
}

interface GetMessagesBody {
  session_id: string;
  since_fingerprint?: number;
}

async function getMessages(body: GetMessagesBody): Promise<Response> {
  if (!body.session_id) {
    return jsonResponse({ error: 'session_id is required' }, 400);
  }
  const qs = body.since_fingerprint
    ? `?fingerprint=${encodeURIComponent(body.since_fingerprint)}`
    : '';
  const { status, data, raw } = await crispFetch<{ error?: boolean; data?: CrispMessage[] }>(
    `/website/${WEBSITE_ID}/conversation/${body.session_id}/messages${qs}`,
    { method: 'GET' },
  );
  if (status >= 400) {
    console.error('[support-chat] get_messages failed:', status, raw.slice(0, 240));
    return jsonResponse(crispErrorBody('get_messages', status, raw), 502);
  }

  // Normalize for the app: array of { id, from, content, ts } sorted oldest→newest.
  const list = Array.isArray(data?.data) ? data!.data : [];
  const messages = list
    .map((m): { id: number; from: 'user' | 'operator'; content: string; ts: number; nickname: string | null } => ({
      id:       Number(m.fingerprint ?? 0),
      from:     m.from === 'operator' ? 'operator' : 'user',
      content:  typeof m.content === 'string'
                  ? m.content
                  : (m.content?.text ?? ''),
      ts:       Number(m.timestamp ?? 0),
      nickname: m.user?.nickname ?? null,
    }))
    .filter(m => m.content && m.id > 0)
    .sort((a, b) => a.id - b.id);

  return jsonResponse({ messages });
}

// ── set_meta ────────────────────────────────────────────────────────────────
// Updates conversation-level metadata so the Crisp agent sees product
// context in the side panel instead of in the message stream. Customer-side
// message bubbles remain clean.

interface SetMetaBody {
  session_id: string;
  subject?:   string;
  segments?:  string[];
  data?:      Record<string, unknown>;
  nickname?:  string;
  email?:     string;
}

async function setMeta(body: SetMetaBody): Promise<Response> {
  if (!body.session_id) {
    return jsonResponse({ error: 'session_id is required' }, 400);
  }

  // Only include fields the caller provided so we don't unintentionally
  // overwrite existing meta with empty strings.
  const patch: Record<string, unknown> = {};
  if (typeof body.subject === 'string' && body.subject.length > 0) patch.subject = body.subject.slice(0, 200);
  if (Array.isArray(body.segments) && body.segments.length > 0) {
    patch.segments = body.segments
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .slice(0, 8)
      .map(s => s.slice(0, 60));
  }
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    const cleanedData: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.data)) {
      if (v == null) continue;
      const sv = String(v);
      if (sv.length === 0) continue;
      cleanedData[k.slice(0, 64)] = sv.slice(0, 400);
    }
    if (Object.keys(cleanedData).length > 0) patch.data = cleanedData;
  }
  if (typeof body.nickname === 'string' && body.nickname.length > 0) patch.nickname = body.nickname.slice(0, 200);
  if (typeof body.email === 'string'    && body.email.length > 0)    patch.email    = body.email.slice(0, 200);

  if (Object.keys(patch).length === 0) {
    return jsonResponse({ ok: true, noop: true });
  }

  const { status, raw } = await crispFetch(
    `/website/${WEBSITE_ID}/conversation/${body.session_id}/meta`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );

  if (status >= 400) {
    console.error('[support-chat] set_meta failed:', status, raw.slice(0, 240));
    return jsonResponse(crispErrorBody('set_meta', status, raw), 502);
  }
  return jsonResponse({ ok: true });
}

// ── send_product_context ────────────────────────────────────────────────────
// Posts a human-readable product summary into the Crisp conversation timeline
// as an operator-side **private note** (stealth=true). Visible to agents in
// their Crisp dashboard; not surfaced in the customer-facing chat. Used by
// SupportScreen to tell the agent which product the customer is asking about,
// without cluttering the customer's own chat thread.

interface SendProductContextBody {
  session_id: string;
  content: string;
  image_url?: string;
  image_name?: string;
  // Fields used to build a fully-resolved agent-only Create Special Offer
  // Quicklink URL. We resolve server-side because Crisp Message Shortcut
  // macros (`{{customer.email}}`, `{{conversation.data.product_id}}`, …) do
  // not reliably substitute on the agent's mobile Crisp app and on free
  // plans, leaving the admin tool to show "Product not detected".
  customer_email?: string;
  product_id?:     string;
  sku?:            string;
  title?:          string;
}

// Hosted mobile admin tool. The URL must match the Netlify production site.
const ADMIN_QUOTE_URL = 'https://gorgeous-mermaid-80b26a.netlify.app/mobile-create-quote.html';

function buildAdminQuoteUrl(p: {
  session_id: string;
  customer_email?: string;
  product_id?: string;
  sku?: string;
  title?: string;
}): string {
  const params: string[] = [];
  if (p.customer_email) params.push(`email=${encodeURIComponent(p.customer_email)}`);
  if (p.session_id)     params.push(`conversation_id=${encodeURIComponent(p.session_id)}`);
  if (p.product_id)     params.push(`product_id=${encodeURIComponent(p.product_id)}`);
  if (p.sku)            params.push(`sku=${encodeURIComponent(p.sku)}`);
  if (p.title)          params.push(`title=${encodeURIComponent(p.title)}`);
  return params.length ? `${ADMIN_QUOTE_URL}?${params.join('&')}` : ADMIN_QUOTE_URL;
}

async function sendProductContext(body: SendProductContextBody): Promise<Response> {
  if (!body.session_id || !body.content) {
    return jsonResponse({ error: 'session_id and content are required' }, 400);
  }
  if (body.content.length > 4000) {
    return jsonResponse({ error: 'Content exceeds 4000 characters' }, 400);
  }

  // 1. Optional image — sent as a Crisp file message so the agent sees an
  //    inline product photo at the top of the context. Image failure is
  //    NON-FATAL: we still proceed to post the text note even if Crisp
  //    rejects the image (e.g. URL not reachable, oversized, etc.).
  let imageError: { status: number; raw: string } | null = null;
  if (body.image_url && /^https?:\/\//i.test(body.image_url)) {
    const { status: imgStatus, raw: imgRaw } = await crispFetch(
      `/website/${WEBSITE_ID}/conversation/${body.session_id}/message`,
      {
        method: 'POST',
        body: JSON.stringify({
          type:    'file',
          from:    'operator',
          origin:  'chat',
          stealth: true,
          content: {
            name: (body.image_name && body.image_name.slice(0, 80)) || 'product.jpg',
            type: 'image/jpeg',
            url:  body.image_url,
          },
        }),
      },
    );
    if (imgStatus >= 400) {
      imageError = { status: imgStatus, raw: imgRaw };
      console.warn('[support-chat] send_product_context: image post failed:', imgStatus, imgRaw.slice(0, 240));
    }
  }

  // 2. Text note — always sent. Carries the human-readable product details.
  const { status, raw } = await crispFetch(
    `/website/${WEBSITE_ID}/conversation/${body.session_id}/message`,
    {
      method: 'POST',
      body: JSON.stringify({
        type:    'text',
        from:    'operator',
        origin:  'chat',
        stealth: true,
        content: body.content,
      }),
    },
  );
  if (status >= 400) {
    console.error('[support-chat] send_product_context: text post failed:', status, raw.slice(0, 240));
    return jsonResponse(crispErrorBody('send_product_context', status, raw), 502);
  }

  // 3. Agent-only "Create Special Offer" link — fully-resolved Quicklink URL
  //    so the agent doesn't depend on fragile Crisp macros for substitution.
  //    Non-fatal: if Crisp rejects the third post (rare), the image + text
  //    notes still landed.
  let offerLinkError: { status: number; raw: string } | null = null;
  if (body.customer_email || body.product_id || body.sku) {
    const offerUrl = buildAdminQuoteUrl({
      session_id:     body.session_id,
      customer_email: body.customer_email,
      product_id:     body.product_id,
      sku:            body.sku,
      title:          body.title,
    });
    const { status: linkStatus, raw: linkRaw } = await crispFetch(
      `/website/${WEBSITE_ID}/conversation/${body.session_id}/message`,
      {
        method: 'POST',
        body: JSON.stringify({
          type:    'text',
          from:    'operator',
          origin:  'chat',
          stealth: true,
          content: `[Create Special Offer](${offerUrl})`,
        }),
      },
    );
    if (linkStatus >= 400) {
      offerLinkError = { status: linkStatus, raw: linkRaw };
      console.warn('[support-chat] send_product_context: offer link post failed:', linkStatus, linkRaw.slice(0, 240));
    }
  }

  return jsonResponse({
    ok: true,
    image_failed:      !!imageError,
    offer_link_failed: !!offerLinkError,
  });
}

// ── Handler ──────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST')    return jsonResponse({ error: 'Method not allowed' }, 405);

  if (!WEBSITE_ID || !IDENTIFIER || !KEY) {
    return jsonResponse({ error: 'Crisp credentials not configured on server' }, 500);
  }

  let body: { action?: string } & Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  try {
    switch (body.action) {
      case 'create_session':
        return await createSession();
      case 'send_message':
        return await sendMessage(body as unknown as SendMessageBody);
      case 'get_messages':
        return await getMessages(body as unknown as GetMessagesBody);
      case 'set_meta':
        return await setMeta(body as unknown as SetMetaBody);
      case 'send_product_context':
        return await sendProductContext(body as unknown as SendProductContextBody);
      default:
        return jsonResponse({ error: `Unknown action: ${body.action}` }, 400);
    }
  } catch (err) {
    console.error('[support-chat] unexpected error:', err);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});
