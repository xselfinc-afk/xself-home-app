// ─────────────────────────────────────────────────────────────────────────────
// send-order-notification — MANUAL internal order-notification sender (Phase 3 + 5).
//
// A standalone, manually-invoked Edge Function that delivers a paid-order
// notification on the row's channel. It is the "sender" half of the queue whose
// "enqueue" half lives in stripe-webhook (Phase 2): the webhook writes a pending
// row into order_notifications; THIS function reads that row and sends.
//
// CHANNEL-AWARE (order_notifications.channel):
//   • 'email' (Phase 5, preferred) → sends an HTML email via Resend to NOTIFY_EMAIL_TO.
//   • 'crisp' (Phase 3, optional fallback) → posts operator stealth notes to Crisp.
//   • anything else / null → defaults to 'crisp'.
//
// MANUAL ONLY — there is intentionally NO auto-trigger, NO cron, NO database
// webhook wired to this function. You invoke it yourself with one order_id.
//
// Request (POST):  { "order_id": "ORD_...", "force"?: true }
//
// Behavior:
//   • Loads the order_notifications row for order_id (404-style error if missing).
//   • If status='sent' and force!==true → returns { ok:true, already_sent:true } and
//     does NOT resend.
//   • Loads orders + order_items, enriches each item with product image/title/color
//     from standardized_products (best-effort; missing rows are tolerated).
//   • Sends on the row's channel: email via Resend (HTML w/ product images), or a
//     fresh Crisp conversation with one file message per item image + a text note.
//   • Success → order_notifications.status='sent', sent_at=now(), last_error=null.
//   • Failure → order_notifications.attempts=attempts+1, status='failed', last_error=<msg>.
//
// HARD GUARANTEES:
//   • NEVER reads/writes orders payment/status fields (only SELECTs order data).
//   • NEVER touches checkout / payment / stripe-webhook / create-checkout-order.
//   • Only table this function MUTATES is order_notifications.
//
// AUTH: service-role only. The caller MUST present
//   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
// (Supabase edge functions otherwise accept any valid anon/user JWT, and this
// endpoint returns customer PII — so we gate it explicitly.)
//
// Crisp integration mirrors supabase/functions/support-chat/index.ts:
//   REST base https://api.crisp.chat/v1, Basic auth btoa(IDENTIFIER:KEY),
//   X-Crisp-Tier header, all secrets .trim()'d (pasted-newline guard).
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL              = (Deno.env.get('SUPABASE_URL')              ?? '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();

// Crisp secrets — same names/handling as support-chat.
const WEBSITE_ID = (Deno.env.get('CRISP_WEBSITE_ID') ?? '').trim();
const IDENTIFIER = (Deno.env.get('CRISP_IDENTIFIER') ?? '').trim();
const KEY        = (Deno.env.get('CRISP_KEY')        ?? '').trim();
const CRISP_TIER = ((Deno.env.get('CRISP_TOKEN_TIER') ?? 'website').trim() || 'website') as
  | 'website' | 'plugin' | 'user';

const CRISP_API_BASE = 'https://api.crisp.chat/v1';
const MAX_IMAGE_MESSAGES = 8; // cap file-message posts so a large order can't spam the inbox

// Resend (email channel) secrets — set via Supabase function secrets.
const RESEND_API_KEY    = (Deno.env.get('RESEND_API_KEY')    ?? '').trim();
const NOTIFY_EMAIL_TO   = (Deno.env.get('NOTIFY_EMAIL_TO')   ?? '').trim();
const NOTIFY_EMAIL_FROM = (Deno.env.get('NOTIFY_EMAIL_FROM') ?? '').trim();
const RESEND_API_BASE   = 'https://api.resend.com';

// Shown on pickup-order notifications so ops know the customer flow.
const PICKUP_INSTRUCTION =
  'The customer will receive a pickup pass within 24 hours after placing the order. '
  + 'They must bring the pickup pass to the warehouse for pickup.';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// ── Crisp helpers (mirror support-chat) ──────────────────────────────────────
function crispHeaders(): Record<string, string> {
  return {
    'Authorization': 'Basic ' + btoa(`${IDENTIFIER}:${KEY}`),
    'X-Crisp-Tier':  CRISP_TIER,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
    'User-Agent':    'XselfHome-OrderNotify/1.0 (+supabase-edge)',
  };
}

async function crispFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; data: T | null; raw: string }> {
  const res = await fetch(`${CRISP_API_BASE}${path}`, {
    ...init,
    headers: { ...crispHeaders(), ...(init.headers ?? {}) },
  });
  const raw = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* leave null */ }
  if (res.status >= 400) {
    console.warn(`[send-order-notification] Crisp ${res.status} ${init.method ?? 'GET'} ${path}`, raw.slice(0, 300));
  }
  return { status: res.status, data: parsed as T, raw };
}

// ── Formatting helpers ───────────────────────────────────────────────────────
function money(cents: number | null | undefined, dollarsFallback?: number | null): string {
  if (typeof cents === 'number' && Number.isFinite(cents)) return `$${(cents / 100).toFixed(2)}`;
  if (typeof dollarsFallback === 'number' && Number.isFinite(dollarsFallback)) return `$${dollarsFallback.toFixed(2)}`;
  return 'n/a';
}

function pick(obj: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

// Render pickup info from fulfillment_plan defensively.
function renderPickup(plan: Record<string, unknown> | null): string {
  if (!plan || typeof plan !== 'object') return '(no pickup plan on order)';
  const wh = (plan as Record<string, unknown>).selectedWarehouse as Record<string, unknown> | undefined;
  const label   = pick(wh ?? null, ['label', 'name', 'code']);
  const address = pick(wh ?? null, ['address', 'addr', 'location']);
  const window  = pick(plan, ['pickupWindow', 'pickup_window', 'window']);
  const eta     = pick(plan, ['estimatedDelivery', 'estimated_delivery', 'eta']);
  const lines = [
    label   ? `Warehouse: ${label}`     : null,
    address ? `Address: ${address}`     : null,
    window  ? `Pickup window: ${window}`: null,
    eta     ? `Estimated: ${eta}`       : null,
  ].filter((s): s is string => !!s);
  return lines.length ? lines.join('\n') : '(pickup plan present but unrecognized shape)';
}

interface OrderRow {
  order_id: string;
  order_number: string | null;
  user_id: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  fulfillment_method: string | null;
  fulfillment_plan: Record<string, unknown> | null;
  address_json: Record<string, unknown> | null;
  total_cents: number | null;
  total: number | null;
}

// public.addresses — the app's source of truth for customer name/phone/line2,
// which orders does NOT persist. Used for sender-side enrichment (Phase 5.1).
interface AddressRow {
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  is_default: boolean | null;
}

// Renders the CUSTOMER's address. Prefers the order's own address_json (the
// authoritative order address) and supplements line2 from the matched addresses
// row when address_json omits it.
function renderCustomerAddress(
  addrJson: Record<string, unknown> | null,
  addr: AddressRow | null,
): string {
  const line1 = pick(addrJson, ['line1', 'address1', 'address_line_1', 'street']) || (addr?.address_line_1 ?? null);
  const line2 = pick(addrJson, ['line2', 'address2', 'address_line_2', 'apt', 'unit']) || (addr?.address_line_2 ?? null);
  const city  = pick(addrJson, ['city', 'town', 'locality']) || (addr?.city ?? null);
  const state = pick(addrJson, ['state', 'region', 'province']) || (addr?.state ?? null);
  const zip   = pick(addrJson, ['zip', 'postalCode', 'postal_code', 'zipCode']) || (addr?.zip ?? null);
  const cityStateZip = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const parts = [line1, line2, cityStateZip].filter((s): s is string => !!s && s.length > 0);
  return parts.length ? parts.join('\n') : '(no address on order)';
}
interface ItemRow {
  product_id: string | null;
  supplier_sku: string | null;
  title: string | null;
  quantity: number | null;
  unit_price_cents: number | null;
  total_cents: number | null;
}
interface EnrichedItem extends ItemRow {
  product_title: string | null;
  color: string | null;
  image: string | null;
}

// ── Email (Resend) helpers ────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// Builds the HTML body. Sections: Customer (name/email/phone/address), then a
// channel-appropriate fulfillment block — Pickup (warehouse + window + pickup-pass
// instruction) or Delivery (delivery address) — then the unchanged product table
// (image + URL, title, supplier_product_id, SKU, color, qty, unit, subtotal) + total.
function buildEmailHtml(p: {
  order: OrderRow;
  enriched: EnrichedItem[];
  orderNumber: string | null;
  customerName: string;
  customerPhone: string | null;
  customerAddress: string;
  isPickup: boolean;
  pickupDetail: string;
  totalStr: string;
}): string {
  const { order, enriched, orderNumber, customerName, customerPhone, customerAddress, isPickup, pickupDetail, totalStr } = p;
  const esc = escapeHtml;
  // One card per item — image (clickable, no raw URL text) + details + line total.
  const rows = enriched.map((it) => {
    const title = esc(it.product_title || it.title || '(untitled)');
    const qty   = Number(it.quantity ?? 0);
    const unit  = money(it.unit_price_cents);
    const sub   = money(it.total_cents);
    const sku   = esc(it.supplier_sku || '(no sku)');
    const pid   = esc(it.product_id || '(no product_id)');
    const color = esc(it.color || '—');
    const hasImg = !!(it.image && /^https?:\/\//i.test(it.image));
    const imgCell = hasImg
      ? `<a href="${esc(it.image as string)}" target="_blank" style="text-decoration:none;">`
        + `<img src="${esc(it.image as string)}" alt="${title}" width="84" height="84" style="width:84px;height:84px;object-fit:cover;border-radius:10px;display:block;border:1px solid #ECE7DA;" /></a>`
      : `<div style="width:84px;height:84px;border-radius:10px;background:#F3F1EB;border:1px solid #ECE7DA;color:#b4ac99;font-size:10px;text-align:center;line-height:84px;">No image</div>`;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;background:#ffffff;border:1px solid #ECE7DA;border-radius:14px;margin:0 0 10px;">`
      + `<tr>`
      + `<td valign="top" style="padding:14px;width:84px;">${imgCell}</td>`
      + `<td valign="top" style="padding:14px 16px 14px 2px;">`
      + `<div style="font-size:15px;font-weight:600;color:#2b2b2b;line-height:1.35;">${title}</div>`
      + `<div style="margin-top:6px;font-size:13px;color:#7a7568;line-height:1.6;">`
      + `Color: <span style="color:#2b2b2b;">${color}</span>&nbsp;&nbsp;·&nbsp;&nbsp;Qty: <span style="color:#2b2b2b;">${qty}</span><br/>`
      + `SKU: <span style="color:#2b2b2b;">${sku}</span><br/>`
      + `Supplier ID: <span style="color:#2b2b2b;">${pid}</span>`
      + `</div>`
      + `<div style="margin-top:10px;font-size:14px;color:#2b2b2b;">`
      + `${unit} <span style="color:#9a9384;">× ${qty}</span> = <strong style="color:#1d1d1f;">${sub}</strong>`
      + `</div>`
      + `</td></tr></table>`;
  }).join('');

  const fulfillmentLabel = isPickup ? 'Pickup' : 'Delivery';

  // Reusable inline-styled fragments (email-safe: tables + inline CSS, no external CSS/JS).
  const cardStyle  = 'background:#ffffff;border:1px solid #ECE7DA;border-radius:14px;';
  const labelStyle = 'font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#9a9384;margin:0 0 10px;';
  const paidPill   = `<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:#E7F4EC;color:#1B7F3B;font-size:12px;font-weight:600;">Paid</span>`;

  const summaryRows =
      `<tr><td style="padding:6px 0;font-size:13px;color:#8a8579;">Order number</td><td style="padding:6px 0;font-size:14px;color:#2b2b2b;text-align:right;font-weight:600;">${orderNumber ? esc(orderNumber) : '—'}</td></tr>`
    + `<tr><td style="padding:6px 0;font-size:13px;color:#8a8579;">Payment</td><td style="padding:6px 0;text-align:right;">${paidPill}</td></tr>`
    + `<tr><td style="padding:6px 0;font-size:13px;color:#8a8579;">Fulfillment</td><td style="padding:6px 0;font-size:14px;color:#2b2b2b;text-align:right;">${fulfillmentLabel}</td></tr>`
    + `<tr><td style="padding:8px 0 0;font-size:13px;color:#8a8579;border-top:1px solid #F0ECE0;">Total</td><td style="padding:8px 0 0;font-size:18px;color:#1d1d1f;text-align:right;font-weight:700;border-top:1px solid #F0ECE0;">${esc(totalStr)}</td></tr>`;

  const fulfillmentCard = isPickup
    ? `<div style="${labelStyle}">Pickup</div>`
      + `<div style="font-size:14px;color:#444;line-height:1.7;white-space:pre-line;">${esc(pickupDetail)}</div>`
      + `<div style="margin-top:12px;padding:12px 14px;background:#FBF4DD;border:1px solid #F0E2B6;border-radius:10px;font-size:13px;color:#7a5c00;line-height:1.55;">📌 ${esc(PICKUP_INSTRUCTION)}</div>`
    : `<div style="${labelStyle}">Delivery</div>`
      + `<div style="font-size:14px;color:#444;line-height:1.7;white-space:pre-line;">${esc(customerAddress)}</div>`;

  const card = (inner: string): string =>
    `<tr><td style="padding:0 0 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${cardStyle}"><tr><td style="padding:18px;">${inner}</td></tr></table></td></tr>`;

  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>`
    + `<body style="margin:0;padding:0;background:#F3F1EB;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F1EB;">`
    + `<tr><td align="center" style="padding:24px 12px;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">`

    // Header
    + `<tr><td style="text-align:center;padding:4px 8px 18px;">`
    + `<div style="font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#CA8A04;">Xself Home</div>`
    + `<div style="font-size:24px;font-weight:700;color:#1d1d1f;margin-top:8px;">New Paid Order</div>`
    + `<div style="font-size:15px;color:#2b2b2b;margin-top:8px;">${orderNumber ? `<strong>${esc(orderNumber)}</strong>` : ''} &nbsp;·&nbsp; <strong style="color:#CA8A04;">${esc(totalStr)}</strong></div>`
    + `<div style="font-size:11px;color:#b4ac99;margin-top:6px;">${esc(order.order_id)}</div>`
    + `</td></tr>`

    // Order summary card
    + card(`<div style="${labelStyle}">Order summary</div>`
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${summaryRows}</table>`)

    // Customer card
    + card(`<div style="${labelStyle}">Customer</div>`
        + `<div style="font-size:16px;font-weight:600;color:#1d1d1f;">${esc(customerName)}</div>`
        + `<div style="margin-top:6px;font-size:14px;"><a href="mailto:${esc(order.customer_email || '')}" style="color:#CA8A04;text-decoration:none;">${esc(order.customer_email || '(none)')}</a></div>`
        + `<div style="font-size:14px;color:#2b2b2b;">${esc(customerPhone || '(none)')}</div>`
        + `<div style="margin-top:8px;font-size:14px;color:#6b675c;line-height:1.6;white-space:pre-line;">${esc(customerAddress)}</div>`)

    // Fulfillment card (Pickup or Delivery)
    + card(fulfillmentCard)

    // Items
    + `<tr><td style="padding:0 0 6px;"><div style="${labelStyle}">Items (${enriched.length})</div>`
    + `${rows || `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${cardStyle}"><tr><td style="padding:16px;color:#9a9384;font-size:14px;">(no items found)</td></tr></table>`}`
    + `</td></tr>`

    // Total strip
    + `<tr><td style="padding:0 0 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${cardStyle}"><tr>`
    + `<td style="padding:16px 18px;font-size:14px;color:#8a8579;">Order total</td>`
    + `<td style="padding:16px 18px;font-size:20px;font-weight:700;color:#1d1d1f;text-align:right;">${esc(totalStr)}</td>`
    + `</tr></table></td></tr>`

    // Footer
    + `<tr><td style="text-align:center;padding:20px 12px 4px;font-size:11px;color:#b4ac99;line-height:1.7;">`
    + `Xself Home · Internal order notification<br/>`
    + `Automated internal alert — not sent to the customer.`
    + `</td></tr>`

    + `</table></td></tr></table></body></html>`;
}

// Sends the email via Resend's HTTPS API. Returns the Resend message id, or
// throws on any non-2xx / malformed response (caught by the send try/catch).
async function sendViaResend(subject: string, html: string): Promise<string> {
  const res = await fetch(`${RESEND_API_BASE}/emails`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: NOTIFY_EMAIL_FROM, to: [NOTIFY_EMAIL_TO], subject, html }),
  });
  const raw = await res.text();
  let parsed: { id?: string; message?: string } | null = null;
  try { parsed = JSON.parse(raw); } catch { /* leave null */ }
  if (res.status >= 400 || !parsed?.id) {
    throw new Error(`resend send failed (${res.status}): ${raw.slice(0, 300)}`);
  }
  return parsed.id;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'server_not_configured', detail: 'missing Supabase env' }, 500);
  }

  // ── Service-role-only gate ──────────────────────────────────────────────────
  const auth = req.headers.get('Authorization') ?? '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (bearer !== SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'unauthorized', detail: 'service-role bearer required' }, 401);
  }

  // Per-channel credential checks happen inside the send branch below (so an
  // 'email' send does not require Crisp creds, and vice-versa).

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body: { order_id?: unknown; force?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const orderId = typeof body.order_id === 'string' ? body.order_id.trim() : '';
  const force   = body.force === true;
  if (!orderId) return json({ error: 'order_id_required' }, 400);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // ── 1. Load the queue row (must exist) ──────────────────────────────────────
  const { data: notif, error: notifErr } = await supabase
    .from('order_notifications')
    .select('order_id, status, attempts, customer_name, channel')
    .eq('order_id', orderId)
    .maybeSingle();

  if (notifErr) {
    console.error('[send-order-notification] queue read error:', notifErr.message);
    return json({ error: 'queue_read_failed', detail: notifErr.message }, 500);
  }
  if (!notif) {
    return json({ error: 'notification_not_found', order_id: orderId,
      detail: 'No order_notifications row. Was the order paid (Phase 2 enqueue)?' }, 404);
  }
  if (notif.status === 'sent' && !force) {
    return json({ ok: true, already_sent: true, order_id: orderId,
      detail: 'Already sent. Pass force:true to resend.' });
  }

  // markFailed centralizes the failure bookkeeping. Best-effort; if even this
  // write fails we still surface the original error to the caller.
  const markFailed = async (msg: string): Promise<void> => {
    const { error } = await supabase
      .from('order_notifications')
      .update({ status: 'failed', attempts: (notif.attempts ?? 0) + 1, last_error: msg.slice(0, 1000) })
      .eq('order_id', orderId);
    if (error) console.error('[send-order-notification] markFailed write failed:', error.message);
  };

  try {
    // ── 2. Load order + items ─────────────────────────────────────────────────
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('order_id, order_number, user_id, customer_email, customer_phone, fulfillment_method, fulfillment_plan, address_json, total_cents, total')
      .eq('order_id', orderId)
      .maybeSingle<OrderRow>();
    if (orderErr) throw new Error(`orders read failed: ${orderErr.message}`);
    if (!order)   throw new Error('order row not found');

    const { data: itemRows, error: itemsErr } = await supabase
      .from('order_items')
      .select('product_id, supplier_sku, title, quantity, unit_price_cents, total_cents')
      .eq('order_id', orderId);
    if (itemsErr) throw new Error(`order_items read failed: ${itemsErr.message}`);
    const items: ItemRow[] = Array.isArray(itemRows) ? itemRows : [];

    // ── 3. Enrich items from standardized_products (best-effort) ──────────────
    const productIds = items.map(i => i.product_id).filter((p): p is string => !!p);
    const productMap = new Map<string, { product_title: string | null; color: string | null; primary_image: string | null }>();
    if (productIds.length > 0) {
      const { data: prods, error: prodErr } = await supabase
        .from('standardized_products')
        .select('supplier_product_id, product_title, color, primary_image')
        .in('supplier_product_id', productIds);
      if (prodErr) {
        console.warn('[send-order-notification] product enrichment failed (non-fatal):', prodErr.message);
      } else {
        for (const p of (prods ?? [])) {
          productMap.set(p.supplier_product_id as string, {
            product_title: (p.product_title as string) ?? null,
            color:         (p.color as string) ?? null,
            primary_image: (p.primary_image as string) ?? null,
          });
        }
      }
    }
    const enriched: EnrichedItem[] = items.map(i => {
      const p = i.product_id ? productMap.get(i.product_id) : undefined;
      return {
        ...i,
        product_title: p?.product_title ?? null,
        color:         p?.color ?? null,
        image:         p?.primary_image ?? null,
      };
    });

    // ── 3b. Enrich customer identity from public.addresses (best-effort) ──────
    // orders does not persist customer name/phone; the app stores them in the
    // addresses table. Match on user_id + address_line_1 + zip; fall back to the
    // user's default address. Non-fatal — on any miss the fields stay null and we
    // fall back to order_notifications.customer_name / address_json.
    let addr: AddressRow | null = null;
    const userId = (order.user_id && String(order.user_id).trim()) || null;
    if (userId) {
      const { data: addrRows, error: addrErr } = await supabase
        .from('addresses')
        .select('first_name, last_name, phone, address_line_1, address_line_2, city, state, zip, country, is_default')
        .eq('user_id', userId);
      if (addrErr) {
        console.warn('[send-order-notification] address enrichment failed (non-fatal):', addrErr.message);
      } else if (Array.isArray(addrRows) && addrRows.length > 0) {
        const oLine1 = (pick(order.address_json, ['line1', 'address1', 'address_line_1', 'street']) ?? '').toLowerCase().trim();
        const oZip   = (pick(order.address_json, ['zip', 'postalCode', 'postal_code', 'zipCode']) ?? '').toLowerCase().trim();
        const exact = (addrRows as AddressRow[]).find((r) => {
          const l1 = String(r.address_line_1 ?? '').toLowerCase().trim();
          const z  = String(r.zip ?? '').toLowerCase().trim();
          return !!oLine1 && l1 === oLine1 && (!oZip || z === oZip);
        });
        addr = exact
          ?? (addrRows as AddressRow[]).find((r) => r.is_default === true)
          ?? (addrRows[0] as AddressRow);
      }
    }

    // ── 4. Shared fields + plaintext summary (used by Crisp; email uses HTML) ──
    const orderNumber = (order.order_number && String(order.order_number).trim()) || null;
    const totalStr = money(order.total_cents, order.total);
    const addrName = addr ? `${addr.first_name ?? ''} ${addr.last_name ?? ''}`.trim() : '';
    const customerName = (notif.customer_name && String(notif.customer_name).trim())
      || (addrName || null)
      || pick(order.address_json, ['name', 'fullName', 'full_name', 'recipient'])
      || '(name not provided)';
    const customerPhone = (addr?.phone && String(addr.phone).trim())
      || (order.customer_phone && String(order.customer_phone).trim())
      || null;
    const customerAddress = renderCustomerAddress(order.address_json, addr);
    const method = (order.fulfillment_method ?? '').toLowerCase();
    const isPickup = method === 'pickup';
    const pickupDetail = renderPickup(order.fulfillment_plan);

    const itemLines = enriched.map((it, idx) => {
      const title = it.product_title || it.title || '(untitled)';
      const qty   = Number(it.quantity ?? 0);
      const unit  = money(it.unit_price_cents);
      const sub   = money(it.total_cents);
      const sku   = it.supplier_sku || '(no sku)';
      const pid   = it.product_id || '(no product_id)';
      const color = it.color || '—';
      return [
        `${idx + 1}. ${title}`,
        `   SKU: ${sku}  |  supplier_product_id: ${pid}`,
        `   Color: ${color}  |  Qty: ${qty}`,
        `   Unit: ${unit}  |  Subtotal: ${sub}`,
      ].join('\n');
    });

    const summary = [
      `🛎️ NEW PAID ORDER — ${orderNumber ? `${orderNumber} (${order.order_id})` : order.order_id}`,
      ``,
      `Customer: ${customerName}`,
      `Email: ${order.customer_email || '(none)'}`,
      `Phone: ${customerPhone || '(none)'}`,
      `Address:`,
      customerAddress,
      ``,
      isPickup ? `Pickup:` : `Delivery:`,
      isPickup ? pickupDetail : customerAddress,
      ...(isPickup ? [PICKUP_INSTRUCTION] : []),
      ``,
      `Order total: ${totalStr}`,
      ``,
      `Items (${enriched.length}):`,
      itemLines.length ? itemLines.join('\n\n') : '(no items found)',
    ].join('\n');

    // ── 5. Send on the row's channel ──────────────────────────────────────────
    const channel = ((notif.channel as string | null) ?? 'crisp').toLowerCase();
    let sendMeta: Record<string, unknown>;

    if (channel === 'email') {
      // EMAIL via Resend (preferred channel).
      if (!RESEND_API_KEY || !NOTIFY_EMAIL_TO || !NOTIFY_EMAIL_FROM) {
        // Operator misconfiguration, not a delivery failure — do NOT mark failed.
        return json({ error: 'email_not_configured',
          detail: 'RESEND_API_KEY / NOTIFY_EMAIL_TO / NOTIFY_EMAIL_FROM must be set' }, 500);
      }
      const subject = `New paid order: ${orderNumber || order.order_id} - ${totalStr}`;
      const html = buildEmailHtml({
        order, enriched, orderNumber, customerName, customerPhone, customerAddress, isPickup, pickupDetail, totalStr,
      });
      const emailId = await sendViaResend(subject, html); // throws on failure → caught below
      sendMeta = { channel: 'email', email_id: emailId };
      console.log('[send-order-notification] email sent', orderId, '| resend id', emailId);

    } else {
      // CRISP (optional fallback).
      if (!WEBSITE_ID || !IDENTIFIER || !KEY) {
        return json({ error: 'crisp_not_configured' }, 500);
      }
      const conv = await crispFetch<{ data?: { session_id?: string } }>(
        `/website/${WEBSITE_ID}/conversation`, { method: 'POST' });
      const sessionId = conv.data?.data?.session_id;
      if (conv.status >= 400 || !sessionId) {
        throw new Error(`crisp create conversation failed (${conv.status}): ${conv.raw.slice(0, 200)}`);
      }

      // Subject + customer meta so the inbox row is self-descriptive (non-fatal).
      await crispFetch(`/website/${WEBSITE_ID}/conversation/${sessionId}/meta`, {
        method: 'PATCH',
        body: JSON.stringify({
          subject:  `New paid order ${orderNumber || order.order_id}`,
          nickname: customerName.slice(0, 200),
          ...(order.customer_email ? { email: order.customer_email.slice(0, 200) } : {}),
          segments: ['order-notification', isPickup ? 'pickup' : 'delivery'],
        }),
      }).catch(() => { /* non-fatal */ });

      // One file message per item image (operator, stealth), capped. Non-fatal.
      let imagesPosted = 0;
      for (const it of enriched) {
        if (imagesPosted >= MAX_IMAGE_MESSAGES) break;
        if (!it.image || !/^https?:\/\//i.test(it.image)) continue;
        await crispFetch(`/website/${WEBSITE_ID}/conversation/${sessionId}/message`, {
          method: 'POST',
          body: JSON.stringify({
            type: 'file', from: 'operator', origin: 'chat', stealth: true,
            content: {
              name: `${(it.product_title || it.title || 'product').slice(0, 60)}.jpg`,
              type: 'image/jpeg',
              url:  it.image,
            },
          }),
        }).catch(() => { /* non-fatal: image is a nicety */ });
        imagesPosted++;
      }

      // The text summary — REQUIRED. A failure here fails the whole send.
      const note = await crispFetch(`/website/${WEBSITE_ID}/conversation/${sessionId}/message`, {
        method: 'POST',
        body: JSON.stringify({
          type: 'text', from: 'operator', origin: 'chat', stealth: true,
          content: summary.slice(0, 4000),
        }),
      });
      if (note.status >= 400) {
        throw new Error(`crisp text note failed (${note.status}): ${note.raw.slice(0, 200)}`);
      }
      sendMeta = { channel: 'crisp', session_id: sessionId, images_posted: imagesPosted };
    }

    // ── 6. Mark sent ──────────────────────────────────────────────────────────
    const { error: sentErr } = await supabase
      .from('order_notifications')
      .update({ status: 'sent', sent_at: new Date().toISOString(), last_error: null })
      .eq('order_id', orderId);
    if (sentErr) {
      // The notification DID send; we just couldn't record it. Surface, don't mark failed.
      console.error('[send-order-notification] sent but status update failed:', sentErr.message);
      return json({ ok: true, sent: true, status_update_failed: true, order_id: orderId, ...sendMeta });
    }

    console.log('[send-order-notification] sent', orderId, '| channel', channel);
    return json({ ok: true, sent: true, order_id: orderId,
      resent: force && notif.status === 'sent', ...sendMeta });

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[send-order-notification] send failed:', msg);
    await markFailed(msg);
    return json({ ok: false, error: 'send_failed', order_id: orderId, detail: msg }, 502);
  }
});
