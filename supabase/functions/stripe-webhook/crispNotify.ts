// ─────────────────────────────────────────────────────────────────────────────
// Internal Crisp notification for PAID orders.
//
// Mirrors the proven Crisp REST pattern in supabase/functions/support-chat/index.ts
// (same base URL, Basic auth, X-Crisp-Tier, conversation/message/meta endpoints).
// Kept self-contained so the working support-chat function is not touched.
//
// SAFETY: every network call is guarded and the whole entry point is wrapped in
// try/catch — notifyPaidOrder() NEVER throws. A Crisp outage must never break the
// Stripe webhook (the order is already paid/confirmed by the time we get here).
//
// Env (already used by support-chat; must also be set on THIS function's secrets):
//   CRISP_WEBSITE_ID, CRISP_IDENTIFIER, CRISP_KEY, CRISP_TOKEN_TIER (default 'website')
// ─────────────────────────────────────────────────────────────────────────────

const WEBSITE_ID = (Deno.env.get('CRISP_WEBSITE_ID') ?? '').trim();
const IDENTIFIER = (Deno.env.get('CRISP_IDENTIFIER') ?? '').trim();
const KEY        = (Deno.env.get('CRISP_KEY')        ?? '').trim();
const CRISP_TIER = ((Deno.env.get('CRISP_TOKEN_TIER') ?? 'website').trim() || 'website');
const CRISP_API_BASE = 'https://api.crisp.chat/v1';

const crispConfigured = (): boolean =>
  WEBSITE_ID.length > 0 && IDENTIFIER.length > 0 && KEY.length > 0;

function crispHeaders(): Record<string, string> {
  return {
    'Authorization': 'Basic ' + btoa(`${IDENTIFIER}:${KEY}`),
    'X-Crisp-Tier':  CRISP_TIER,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
    'User-Agent':    'XselfHome-OrderNotify/1.0 (+supabase-edge)',
  };
}

async function crispFetch(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; data: any; raw: string }> {
  const res = await fetch(`${CRISP_API_BASE}${path}`, {
    ...init,
    headers: { ...crispHeaders(), ...(init.headers ?? {}) },
  });
  const raw = await res.text();
  let data: any = null;
  try { data = JSON.parse(raw); } catch { /* leave null */ }
  if (res.status >= 400) {
    console.warn('[order-notify] Crisp', res.status, (init.method ?? 'GET'), path, raw.slice(0, 300));
  }
  return { status: res.status, data, raw };
}

const money = (cents: number): string => `$${(Number(cents || 0) / 100).toFixed(2)}`;

// Post a Crisp message; swallow any error so one failed line never aborts the rest.
async function postMessage(sessionId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await crispFetch(`/website/${WEBSITE_ID}/conversation/${sessionId}/message`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn('[order-notify] message post failed (non-fatal):', e instanceof Error ? e.message : e);
  }
}

/**
 * Builds and posts an internal Crisp notification for a paid order:
 *   • one conversation per order (subject + 'order' segment + contact meta)
 *   • a summary message (order id, customer, fulfillment + address, total, time)
 *   • per line item: a product image (file message) + a detail note
 *
 * Data sources:
 *   orders            → customer, fulfillment, address, total, created_at
 *   order_items       → product_id (SELECTED variant), supplier_sku, title, qty, prices
 *   standardized_products (joined by product_id == supplier_product_id)
 *                     → primary_image, color, product_title  (variant-accurate)
 *
 * Never throws.
 */
export async function notifyPaidOrder(
  supabase: any,
  orderId: string,
  customerName?: string | null,
): Promise<void> {
  try {
    if (!crispConfigured()) {
      console.warn('[order-notify] Crisp env not configured — skipping notification for', orderId);
      return;
    }
    if (!orderId) return;

    const { data: orderRows } = await supabase
      .from('orders')
      .select('order_id, order_number, customer_email, customer_phone, fulfillment_method, fulfillment_plan, address_json, total, total_cents, created_at')
      .eq('order_id', orderId)
      .limit(1);
    const order = orderRows?.[0];
    if (!order) {
      console.warn('[order-notify] order not found, skipping:', orderId);
      return;
    }

    const { data: itemRows } = await supabase
      .from('order_items')
      .select('product_id, supplier_sku, title, quantity, unit_price_cents, total_cents')
      .eq('order_id', orderId);
    const lines: any[] = itemRows ?? [];

    // Join standardized_products for variant-accurate image / color / title.
    // product_id is the SELECTED variant's supplier_product_id (see commit 665083b5).
    const productIds = [...new Set(lines.map((l) => l.product_id).filter(Boolean))];
    const stdById = new Map<string, any>();
    if (productIds.length > 0) {
      const { data: std } = await supabase
        .from('standardized_products')
        .select('supplier_product_id, primary_image, color, product_title')
        .in('supplier_product_id', productIds);
      for (const s of std ?? []) stdById.set(s.supplier_product_id, s);
    }

    // Create a fresh conversation for this order (no pre-existing customer session here).
    const conv = await crispFetch(`/website/${WEBSITE_ID}/conversation`, { method: 'POST' });
    const sessionId: string | undefined = conv.data?.data?.session_id;
    if (!sessionId) {
      console.error('[order-notify] create conversation failed:', conv.status, conv.raw.slice(0, 200));
      return;
    }

    const totalCents = order.total_cents ?? Math.round(Number(order.total ?? 0) * 100);

    // Conversation meta: subject + 'order' segment (filterable) + contact + quick data.
    try {
      await crispFetch(`/website/${WEBSITE_ID}/conversation/${sessionId}/meta`, {
        method: 'PATCH',
        body: JSON.stringify({
          subject: `Order ${order.order_number ?? order.order_id} — ${order.customer_email ?? 'guest'}`.slice(0, 200),
          segments: ['order'],
          nickname: String(order.customer_email ?? 'Guest').slice(0, 200),
          ...(order.customer_email ? { email: String(order.customer_email).slice(0, 200) } : {}),
          data: {
            order_id:    String(order.order_id),
            fulfillment: String(order.fulfillment_method ?? ''),
            total:       money(totalCents),
          },
        }),
      });
    } catch { /* meta is non-fatal */ }

    // Summary message — who placed it, how to reach them, where it goes, what they bought.
    const addr = (order.address_json ?? {}) as Record<string, any>;
    const addrStr = [
      addr.line1,
      addr.line2,
      [addr.city, addr.state].filter(Boolean).join(', ') + (addr.zip ? ` ${addr.zip}` : ''),
    ].filter((s) => s && String(s).trim().length > 0).join(' · ');
    const created = order.created_at
      ? new Date(order.created_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
      : 'n/a';

    // Fulfillment: the data model stores pickup vs delivery (delivery = ship-to-address);
    // there is no separate "shipping" method value. Pickup details come from fulfillment_plan.
    const plan = (order.fulfillment_plan ?? {}) as Record<string, any>;
    const isPickup = order.fulfillment_method === 'pickup' || plan.usePickup === true;
    const methodLabel = isPickup ? 'PICKUP' : 'DELIVERY (ship to address)';

    let fulfillmentDetail = '';
    if (isPickup) {
      const wh = (plan.selectedWarehouse ?? {}) as Record<string, any>;
      const loc = [wh.label, wh.address].filter(Boolean).join(' — ');
      const win = plan.pickupWindow?.earliest
        ? `${plan.pickupWindow.earliest} → ${plan.pickupWindow.latest}`
        : (plan.estimatedDelivery ?? '');
      fulfillmentDetail =
        (loc ? `Pickup at: ${loc}\n` : '') +
        (win ? `Pickup window: ${win}\n` : '');
    } else {
      fulfillmentDetail =
        `Ship to: ${addrStr || '(no address on file)'}\n` +
        (plan.estimatedDelivery ? `ETA: ${plan.estimatedDelivery}\n` : '');
    }

    const summary =
      `🧾 New PAID order — ${order.order_number ?? order.order_id}\n` +
      `Placed: ${created} · Total: ${money(totalCents)}\n` +
      `\n👤 Customer\n` +
      `Name: ${(customerName && String(customerName).trim()) || 'not available'}\n` +
      `Email: ${order.customer_email ?? '—'}\n` +
      `Phone: ${order.customer_phone ?? '—'}\n` +
      `\n🚚 Fulfillment: ${methodLabel}\n` +
      fulfillmentDetail +
      `\n📦 ${lines.length} item${lines.length === 1 ? '' : 's'} ↓`;
    await postMessage(sessionId, { type: 'text', from: 'operator', origin: 'chat', content: summary });

    // Per line item: image (so you can visually confirm the exact variant) + detail note.
    for (const l of lines) {
      const s = stdById.get(l.product_id) ?? {};
      const img = typeof s.primary_image === 'string' && /^https?:\/\//i.test(s.primary_image)
        ? s.primary_image
        : null;
      if (img) {
        await postMessage(sessionId, {
          type: 'file', from: 'operator', origin: 'chat',
          content: { name: `${l.product_id}.jpg`, type: 'image/jpeg', url: img },
        });
      }
      const name = l.title || s.product_title || l.product_id;
      const color = s.color ? ` — ${s.color}` : '';
      const note =
        `${name}${color}\n` +
        `product_id: ${l.product_id} · SKU: ${l.supplier_sku ?? '—'}\n` +
        `Qty ${l.quantity} × ${money(l.unit_price_cents)} = ${money(l.total_cents)}`;
      await postMessage(sessionId, { type: 'text', from: 'operator', origin: 'chat', content: note });
    }

    console.log('[order-notify] posted Crisp notification for order', orderId, '→ conversation', sessionId);
  } catch (e) {
    // Absolute backstop — must never propagate to the webhook handler.
    console.error('[order-notify] notifyPaidOrder failed (non-fatal):', e instanceof Error ? e.message : e);
  }
}
