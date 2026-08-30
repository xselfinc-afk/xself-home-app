/**
 * Meta App Events — server-side Conversions API sender (shared).
 *
 * Design contract (Meta App Events A-layer):
 *  - Fire-and-forget: sendMetaEvents NEVER throws and NEVER blocks business logic
 *    beyond a hard 4s fetch timeout; callers do not await critical paths on it.
 *  - Unconfigured-safe: when META_CAPI_ACCESS_TOKEN is absent the sender logs once
 *    and returns { skipped: true } — checkout/payment/inventory are never affected.
 *  - Deduplication: every event carries a STABLE event_id derived from the business
 *    identity (purchase:{order_id}, ic:{checkout_session_id}, …). The iOS SDK sends
 *    the SAME ids so Meta dedupes client+server into one event. Never random.
 *  - PII: email/phone are normalized then SHA-256 hashed per Meta spec before send.
 *
 * Secrets (Supabase function secrets — NEVER shipped to the app):
 *   META_CAPI_ACCESS_TOKEN  — system-user token for app 1328313489508243 with the
 *                             App Events / ads permissions.
 *   META_TEST_EVENT_CODE    — optional; when set, events land in Events Manager's
 *                             Test Events tab instead of production ingestion.
 */

const META_APP_ID = '1328313489508243';
// CAPI for App Events posts to the DATASET, not the app id. The dataset is created
// by linking the app's Events Manager data source ("Link to dataset"); its id comes
// from function secrets so environments can differ. App-id fallback keeps the sender
// contained (it would be rejected upstream, logged, and skipped — never thrown).
const META_DATASET_ID = Deno.env.get('META_DATASET_ID') ?? META_APP_ID;
const META_CAPI_ACCESS_TOKEN = Deno.env.get('META_CAPI_ACCESS_TOKEN') ?? '';
const META_TEST_EVENT_CODE = Deno.env.get('META_TEST_EVENT_CODE') ?? '';
const GRAPH = 'https://graph.facebook.com/v21.0';

// action_source=app REQUIRES app_data with advertiser_tracking_enabled and a
// 16-element extinfo array. Server-side we only claim what we reliably know
// (platform marker, bundle id); device-specific slots stay empty strings — Meta's
// documented format for unavailable values. advertiser_tracking_enabled=0 is the
// legally conservative server-side value (we cannot assert the user's ATT grant
// here); the iOS SDK twin event carries the real ATT state for attribution.
const SERVER_APP_DATA = {
  advertiser_tracking_enabled: 0,
  application_tracking_enabled: 0,
  // Probed against the live dataset (2026-08-30): version slots must be non-empty.
  // [2]=app build, [3]=app version are real; [4]=OS version uses the non-assertive
  // placeholder '0.0' (we cannot know the device OS server-side; empty is rejected).
  extinfo: ['i2', 'com.xself.home', '52', '1.0.16', '0.0', '', '', '', '', '', '', '', '', '', '', ''],
};

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Meta-normalized hashes: email lowercased/trimmed; phone digits-only with country code. */
export async function hashedUserData(input: { email?: string | null; phone?: string | null }): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const email = (input.email ?? '').trim().toLowerCase();
  if (email) out.em = [await sha256Hex(email)];
  const phone = (input.phone ?? '').replace(/[^0-9]/g, '');
  if (phone) out.ph = [await sha256Hex(phone)];
  return out;
}

export interface MetaAppEvent {
  event_name: 'Purchase' | 'InitiateCheckout' | 'ViewContent' | 'AddToCart';
  /** STABLE dedup id shared with the iOS SDK — business-derived, never random. */
  event_id: string;
  event_time?: number;
  user_data?: Record<string, unknown>;
  custom_data?: Record<string, unknown>;
}

export interface MetaSendResult {
  ok: boolean;
  skipped: boolean;
  events_received?: number;
  error?: string;
}

/** Send one batch. Safe to call without awaiting; all failure modes are contained. */
export async function sendMetaEvents(events: MetaAppEvent[], source: string): Promise<MetaSendResult> {
  if (!META_CAPI_ACCESS_TOKEN) {
    console.log(`[metaCapi:${source}] skipped — META_CAPI_ACCESS_TOKEN not configured`);
    return { ok: false, skipped: true };
  }
  if (!events.length) return { ok: true, skipped: false, events_received: 0 };
  try {
    const body: Record<string, unknown> = {
      data: events.map((e) => ({
        event_name: e.event_name,
        event_time: e.event_time ?? Math.floor(Date.now() / 1000),
        event_id: e.event_id,
        action_source: 'app',
        app_data: SERVER_APP_DATA,
        user_data: e.user_data ?? {},
        custom_data: e.custom_data ?? {},
      })),
      access_token: META_CAPI_ACCESS_TOKEN,
    };
    if (META_TEST_EVENT_CODE) body.test_event_code = META_TEST_EVENT_CODE;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch(`${GRAPH}/${META_DATASET_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error(`[metaCapi:${source}] send failed (${resp.status}):`, JSON.stringify(json?.error ?? json).slice(0, 300));
      return { ok: false, skipped: false, error: `http_${resp.status}` };
    }
    console.log(`[metaCapi:${source}] events_received=${json?.events_received ?? '?'} ids=${events.map((e) => e.event_id).join(',')}`);
    return { ok: true, skipped: false, events_received: Number(json?.events_received ?? 0) };
  } catch (e) {
    console.error(`[metaCapi:${source}] send threw:`, e instanceof Error ? e.message : String(e));
    return { ok: false, skipped: false, error: 'exception' };
  }
}
