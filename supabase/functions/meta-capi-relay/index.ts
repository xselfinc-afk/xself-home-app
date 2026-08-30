/**
 * meta-capi-relay — App-facing forwarder for low-risk Meta App Events.
 *
 * The app calls this (anon key) for ViewContent / AddToCart only; the Meta access
 * token lives exclusively in function secrets and NEVER reaches the client.
 * Purchase / InitiateCheckout are NOT accepted here — those fire only from their
 * authoritative server nodes (stripe-webhook / create-checkout-order).
 *
 * Fire-and-forget by design: any failure returns ok:false but 200, and the app
 * ignores the response entirely. event_id arrives from the client so the iOS SDK
 * twin event dedupes (view:{sku}:{minuteBucket} — stable, not random).
 *
 * Body: { events: [{ event_name: 'ViewContent'|'AddToCart', event_id, sku, value? }] }
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { sendMetaEvents, type MetaAppEvent } from '../_shared/metaCapi.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const ALLOWED = new Set(['ViewContent', 'AddToCart']);
const SKU_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_EVENTS = 10;

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  let body: { events?: Array<{ event_name?: string; event_id?: string; sku?: string; value?: number }> };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const events: MetaAppEvent[] = (body.events ?? [])
    .slice(0, MAX_EVENTS)
    .filter((e) => ALLOWED.has(String(e.event_name)) && SKU_RE.test(String(e.sku ?? '')) && String(e.event_id ?? '').length > 0 && String(e.event_id).length <= 120)
    .map((e) => ({
      event_name: e.event_name as MetaAppEvent['event_name'],
      event_id: String(e.event_id),
      custom_data: {
        content_type: 'product',
        content_ids: [String(e.sku)],
        currency: 'USD',
        ...(typeof e.value === 'number' && Number.isFinite(e.value) && e.value >= 0 && e.value < 100000 ? { value: e.value } : {}),
      },
    }));

  if (!events.length) return json({ ok: false, error: 'no_valid_events' }, 400);
  const result = await sendMetaEvents(events, 'relay');
  return json({ ok: result.ok, skipped: result.skipped, events_received: result.events_received ?? 0 });
});
