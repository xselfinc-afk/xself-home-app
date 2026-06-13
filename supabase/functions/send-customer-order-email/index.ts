// ─────────────────────────────────────────────────────────────────────────────
// send-customer-order-email — MANUAL customer-facing order-confirmation sender.
//
// Sends the CUSTOMER their order confirmation via Resend. This is deliberately a
// SEPARATE function from send-order-notification (the internal ops alert) so that
// internal PII can never leak into a customer email: this function NEVER selects
// customer_phone / address_json / user_id and NEVER queries public.addresses, so
// the customer's name / phone / home address are not even in scope here.
//
// MANUAL ONLY — no auto-trigger, no cron, no DB webhook. Invoke with one order_id.
//
// Request (POST):  { "order_id": "<uuid>", "force"?: true }
//
// Behavior:
//   • Requires a row in public.customer_order_emails (404 if missing).
//   • If status='sent' and force!==true → { ok:true, already_sent:true } (no resend).
//   • Reads only SAFE order fields + order_items + standardized_products (image/
//     title/sku/color/price). Sends a short customer-facing HTML email.
//   • Success → customer_order_emails.status='sent', sent_at=now(), last_error=null.
//   • Failure → attempts=attempts+1, status='failed', last_error=<msg>.
//
// HARD GUARANTEES:
//   • Mutates ONLY public.customer_order_emails.
//   • Never reads/writes orders payment/status; never touches order_notifications,
//     stripe-webhook, create-checkout-order, or checkout/payment logic.
//
// AUTH: service-role only (Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>).
//
// Email "from": CUSTOMER_EMAIL_FROM if set, else NOTIFY_EMAIL_FROM. NOTE: a real
// customer send requires a VERIFIED Resend sending domain — the shared sandbox
// sender (onboarding@resend.dev) only delivers to the Resend account owner.
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL              = (Deno.env.get('SUPABASE_URL')              ?? '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();

// Resend + sender identity. Prefer a dedicated customer-from when configured.
const RESEND_API_KEY     = (Deno.env.get('RESEND_API_KEY')      ?? '').trim();
const CUSTOMER_EMAIL_FROM = (Deno.env.get('CUSTOMER_EMAIL_FROM') ?? '').trim()
  || (Deno.env.get('NOTIFY_EMAIL_FROM') ?? '').trim();
const SUPPORT_REPLY_TO   = (Deno.env.get('SUPPORT_REPLY_TO')     ?? '').trim();
const SUPPORT_EMAIL      = (Deno.env.get('SUPPORT_EMAIL')        ?? 'support@xself.com').trim();
const RESEND_API_BASE    = 'https://api.resend.com';

const PICKUP_INSTRUCTION =
  'You will receive a pickup pass within 24 hours after placing your order. '
  + 'Please bring the pickup pass to the warehouse for pickup.';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

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

// Pickup details from fulfillment_plan — ONLY the fields safe to show a customer
// (warehouse name/address = a store location, window, estimate). Never dumps the
// raw plan blob (which carries internal flags like inventoryFreshness).
function renderPickup(plan: Record<string, unknown> | null): string {
  if (!plan || typeof plan !== 'object') return '';
  const wh = (plan as Record<string, unknown>).selectedWarehouse as Record<string, unknown> | undefined;
  const label   = pick(wh ?? null, ['label', 'name', 'code']);
  const address = pick(wh ?? null, ['address', 'addr', 'location']);
  const window  = pick(plan, ['pickupWindow', 'pickup_window', 'window']);
  const eta     = pick(plan, ['estimatedDelivery', 'estimated_delivery', 'eta']);
  const lines = [
    label   ? `Location: ${label}`      : null,
    address ? `Address: ${address}`     : null,
    window  ? `Window: ${window}`       : null,
    eta     ? `Estimate: ${eta}`        : null,
  ].filter((s): s is string => !!s);
  return lines.join('\n');
}

// SAFE order shape — intentionally omits customer_phone / address_json / user_id.
interface OrderRow {
  order_id: string;
  order_number: string | null;
  customer_email: string | null;
  fulfillment_method: string | null;
  fulfillment_plan: Record<string, unknown> | null;
  total_cents: number | null;
  total: number | null;
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

// Customer-facing HTML. NO customer name/phone/address, NO supplier_product_id,
// NO internal notes. Shows order number, total, fulfillment, pickup info +
// pass instruction, product cards (image/title/SKU/color/qty/price), support note.
function buildCustomerHtml(p: {
  order: OrderRow;
  enriched: EnrichedItem[];
  orderNumber: string | null;
  isPickup: boolean;
  pickupDetail: string;
  totalStr: string;
}): string {
  const { order, enriched, orderNumber, isPickup, pickupDetail, totalStr } = p;
  const esc = escapeHtml;

  const rows = enriched.map((it) => {
    const title = esc(it.product_title || it.title || 'Item');
    const qty   = Number(it.quantity ?? 0);
    const unit  = money(it.unit_price_cents);
    const sub   = money(it.total_cents);
    const sku   = esc(it.supplier_sku || '—');
    const color = esc(it.color || '—');
    const hasImg = !!(it.image && /^https?:\/\//i.test(it.image));
    const imgCell = hasImg
      ? `<img src="${esc(it.image as string)}" alt="${title}" width="84" height="84" style="width:84px;height:84px;object-fit:cover;border-radius:10px;display:block;border:1px solid #ECE7DA;" />`
      : `<div style="width:84px;height:84px;border-radius:10px;background:#F3F1EB;border:1px solid #ECE7DA;color:#b4ac99;font-size:10px;text-align:center;line-height:84px;">No image</div>`;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;background:#ffffff;border:1px solid #ECE7DA;border-radius:14px;margin:0 0 10px;">`
      + `<tr>`
      + `<td valign="top" style="padding:14px;width:84px;">${imgCell}</td>`
      + `<td valign="top" style="padding:14px 16px 14px 2px;">`
      + `<div style="font-size:15px;font-weight:600;color:#2b2b2b;line-height:1.35;">${title}</div>`
      + `<div style="margin-top:6px;font-size:13px;color:#7a7568;line-height:1.6;">`
      + `Color: <span style="color:#2b2b2b;">${color}</span>&nbsp;&nbsp;·&nbsp;&nbsp;Qty: <span style="color:#2b2b2b;">${qty}</span><br/>`
      + `SKU: <span style="color:#2b2b2b;">${sku}</span>`
      + `</div>`
      + `<div style="margin-top:10px;font-size:14px;color:#2b2b2b;">`
      + `${unit} <span style="color:#9a9384;">× ${qty}</span> = <strong style="color:#1d1d1f;">${sub}</strong>`
      + `</div>`
      + `</td></tr></table>`;
  }).join('');

  const fulfillmentLabel = isPickup ? 'Pickup' : 'Delivery';
  const cardStyle  = 'background:#ffffff;border:1px solid #ECE7DA;border-radius:14px;';
  const labelStyle = 'font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#9a9384;margin:0 0 10px;';

  const summaryRows =
      `<tr><td style="padding:6px 0;font-size:13px;color:#8a8579;">Order number</td><td style="padding:6px 0;font-size:14px;color:#2b2b2b;text-align:right;font-weight:600;">${orderNumber ? esc(orderNumber) : '—'}</td></tr>`
    + `<tr><td style="padding:6px 0;font-size:13px;color:#8a8579;">Fulfillment</td><td style="padding:6px 0;font-size:14px;color:#2b2b2b;text-align:right;">${fulfillmentLabel}</td></tr>`
    + `<tr><td style="padding:8px 0 0;font-size:13px;color:#8a8579;border-top:1px solid #F0ECE0;">Total</td><td style="padding:8px 0 0;font-size:18px;color:#1d1d1f;text-align:right;font-weight:700;border-top:1px solid #F0ECE0;">${esc(totalStr)}</td></tr>`;

  const pickupCard = (isPickup && pickupDetail)
    ? `<tr><td style="padding:0 0 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${cardStyle}"><tr><td style="padding:18px;">`
      + `<div style="${labelStyle}">Pickup</div>`
      + `<div style="font-size:14px;color:#444;line-height:1.7;white-space:pre-line;">${esc(pickupDetail)}</div>`
      + `<div style="margin-top:12px;padding:12px 14px;background:#FBF4DD;border:1px solid #F0E2B6;border-radius:10px;font-size:13px;color:#7a5c00;line-height:1.55;">📌 ${esc(PICKUP_INSTRUCTION)}</div>`
      + `</td></tr></table></td></tr>`
    : '';

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
    + `<div style="font-size:24px;font-weight:700;color:#1d1d1f;margin-top:8px;">Order confirmed</div>`
    + `<div style="font-size:14px;color:#6b675c;margin-top:6px;">Thank you — your payment was successful.</div>`
    + `<div style="font-size:15px;color:#2b2b2b;margin-top:8px;">${orderNumber ? `<strong>${esc(orderNumber)}</strong>` : ''} &nbsp;·&nbsp; <strong style="color:#CA8A04;">${esc(totalStr)}</strong></div>`
    + `</td></tr>`

    // Summary card
    + card(`<div style="${labelStyle}">Order summary</div>`
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${summaryRows}</table>`)

    // Pickup card (pickup orders only)
    + pickupCard

    // Items
    + `<tr><td style="padding:0 0 6px;"><div style="${labelStyle}">Your items (${enriched.length})</div>`
    + `${rows || `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${cardStyle}"><tr><td style="padding:16px;color:#9a9384;font-size:14px;">(no items)</td></tr></table>`}`
    + `</td></tr>`

    // Total strip
    + `<tr><td style="padding:0 0 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${cardStyle}"><tr>`
    + `<td style="padding:16px 18px;font-size:14px;color:#8a8579;">Order total</td>`
    + `<td style="padding:16px 18px;font-size:20px;font-weight:700;color:#1d1d1f;text-align:right;">${esc(totalStr)}</td>`
    + `</tr></table></td></tr>`

    // Support note
    + card(`<div style="font-size:14px;color:#444;line-height:1.6;">Questions about your order? Just reply to this email or contact us at `
        + `<a href="mailto:${esc(SUPPORT_EMAIL)}" style="color:#CA8A04;text-decoration:none;">${esc(SUPPORT_EMAIL)}</a>.</div>`)

    // Footer
    + `<tr><td style="text-align:center;padding:8px 12px 4px;font-size:11px;color:#b4ac99;line-height:1.7;">`
    + `Xself Home · This is your order confirmation.`
    + `</td></tr>`

    + `</table></td></tr></table></body></html>`;
}

async function sendViaResend(to: string, subject: string, html: string): Promise<string> {
  const payload: Record<string, unknown> = { from: CUSTOMER_EMAIL_FROM, to: [to], subject, html };
  if (SUPPORT_REPLY_TO) payload.reply_to = SUPPORT_REPLY_TO;
  const res = await fetch(`${RESEND_API_BASE}/emails`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body: { order_id?: unknown; force?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const orderId = typeof body.order_id === 'string' ? body.order_id.trim() : '';
  const force   = body.force === true;
  if (!orderId) return json({ error: 'order_id_required' }, 400);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // ── 1. Load the customer-email queue row (must exist) ───────────────────────
  const { data: cust, error: custErr } = await supabase
    .from('customer_order_emails')
    .select('order_id, status, attempts, recipient_email')
    .eq('order_id', orderId)
    .maybeSingle();

  if (custErr) {
    console.error('[send-customer-order-email] queue read error:', custErr.message);
    return json({ error: 'queue_read_failed', detail: custErr.message }, 500);
  }
  if (!cust) {
    return json({ error: 'customer_notification_not_found', order_id: orderId,
      detail: 'No customer_order_emails row for this order.' }, 404);
  }
  if (cust.status === 'sent' && !force) {
    return json({ ok: true, already_sent: true, order_id: orderId,
      detail: 'Already sent. Pass force:true to resend.' });
  }

  const markFailed = async (msg: string): Promise<void> => {
    const { error } = await supabase
      .from('customer_order_emails')
      .update({ status: 'failed', attempts: (cust.attempts ?? 0) + 1, last_error: msg.slice(0, 1000) })
      .eq('order_id', orderId);
    if (error) console.error('[send-customer-order-email] markFailed write failed:', error.message);
  };

  try {
    if (!RESEND_API_KEY || !CUSTOMER_EMAIL_FROM) {
      // Operator misconfiguration, not a delivery failure — do NOT mark failed.
      return json({ error: 'email_not_configured',
        detail: 'RESEND_API_KEY and CUSTOMER_EMAIL_FROM (or NOTIFY_EMAIL_FROM) must be set' }, 500);
    }

    // ── 2. Load ONLY safe order fields (no phone / address_json / user_id) ─────
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('order_id, order_number, customer_email, fulfillment_method, fulfillment_plan, total_cents, total')
      .eq('order_id', orderId)
      .maybeSingle<OrderRow>();
    if (orderErr) throw new Error(`orders read failed: ${orderErr.message}`);
    if (!order)   throw new Error('order row not found');

    const recipient = (cust.recipient_email && String(cust.recipient_email).trim())
      || (order.customer_email && String(order.customer_email).trim())
      || '';
    if (!recipient || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) {
      throw new Error('no valid recipient email on order');
    }

    // ── 3. Items + product enrichment (image/title/color) ─────────────────────
    const { data: itemRows, error: itemsErr } = await supabase
      .from('order_items')
      .select('product_id, supplier_sku, title, quantity, unit_price_cents, total_cents')
      .eq('order_id', orderId);
    if (itemsErr) throw new Error(`order_items read failed: ${itemsErr.message}`);
    const items: ItemRow[] = Array.isArray(itemRows) ? itemRows : [];

    const productIds = items.map(i => i.product_id).filter((p): p is string => !!p);
    const productMap = new Map<string, { product_title: string | null; color: string | null; primary_image: string | null }>();
    if (productIds.length > 0) {
      const { data: prods, error: prodErr } = await supabase
        .from('standardized_products')
        .select('supplier_product_id, product_title, color, primary_image')
        .in('supplier_product_id', productIds);
      if (prodErr) {
        console.warn('[send-customer-order-email] product enrichment failed (non-fatal):', prodErr.message);
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
      return { ...i, product_title: p?.product_title ?? null, color: p?.color ?? null, image: p?.primary_image ?? null };
    });

    // ── 4. Build + send ───────────────────────────────────────────────────────
    const orderNumber = (order.order_number && String(order.order_number).trim()) || null;
    const totalStr = money(order.total_cents, order.total);
    const isPickup = (order.fulfillment_method ?? '').toLowerCase() === 'pickup';
    const pickupDetail = isPickup ? renderPickup(order.fulfillment_plan) : '';

    const subject = `Your Xself Home order is confirmed${orderNumber ? ` — ${orderNumber}` : ''}`;
    const html = buildCustomerHtml({ order, enriched, orderNumber, isPickup, pickupDetail, totalStr });
    const emailId = await sendViaResend(recipient, subject, html); // throws → caught below

    // ── 5. Mark sent ──────────────────────────────────────────────────────────
    const { error: sentErr } = await supabase
      .from('customer_order_emails')
      .update({ status: 'sent', sent_at: new Date().toISOString(), last_error: null, recipient_email: recipient })
      .eq('order_id', orderId);
    if (sentErr) {
      console.error('[send-customer-order-email] sent but status update failed:', sentErr.message);
      return json({ ok: true, sent: true, status_update_failed: true, order_id: orderId, email_id: emailId });
    }

    console.log('[send-customer-order-email] sent', orderId, '| resend id', emailId);
    return json({ ok: true, sent: true, order_id: orderId, email_id: emailId, resent: force && cust.status === 'sent' });

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[send-customer-order-email] send failed:', msg);
    await markFailed(msg);
    return json({ ok: false, error: 'send_failed', order_id: orderId, detail: msg }, 502);
  }
});
