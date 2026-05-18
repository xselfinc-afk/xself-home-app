/**
 * Thin client wrapper around the `support-chat` Supabase Edge Function.
 * All Crisp credentials live on the server — this file only knows the
 * Edge Function name and the action contract.
 */

import { supabase } from '../lib/supabase';

export interface SupportMessage {
  id: number;
  from: 'user' | 'operator';
  content: string;
  /** Unix seconds (Crisp returns seconds, not ms) */
  ts: number;
  nickname: string | null;
}

interface CreateSessionResp { session_id: string }
interface SendMessageResp   { ok: true; fingerprint: number | null }
interface GetMessagesResp   { messages: SupportMessage[] }

async function invoke<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke('support-chat', {
    body: { action, ...payload },
  });
  if (error) throw new Error(`support-chat:${action} — ${error.message}`);
  if (!data) throw new Error(`support-chat:${action} returned no data`);
  if ((data as { error?: string }).error) {
    throw new Error(`support-chat:${action} — ${(data as { error?: string }).error}`);
  }
  return data as T;
}

export async function createSupportSession(): Promise<string> {
  const { session_id } = await invoke<CreateSessionResp>('create_session');
  if (!session_id) throw new Error('No session_id returned');
  return session_id;
}

export async function sendSupportMessage(
  sessionId: string,
  message: string,
  meta?: { nickname?: string; email?: string },
): Promise<number | null> {
  const { fingerprint } = await invoke<SendMessageResp>('send_message', {
    session_id: sessionId,
    content:    message,
    nickname:   meta?.nickname,
    email:      meta?.email,
  });
  return fingerprint;
}

export async function getSupportMessages(
  sessionId: string,
  sinceFingerprint?: number,
): Promise<SupportMessage[]> {
  const payload: Record<string, unknown> = { session_id: sessionId };
  if (sinceFingerprint) payload.since_fingerprint = sinceFingerprint;
  const { messages } = await invoke<GetMessagesResp>('get_messages', payload);
  return messages ?? [];
}

export interface SupportSessionMeta {
  subject?:  string;
  segments?: string[];
  data?:     Record<string, string>;
  nickname?: string;
  email?:    string;
}

interface SetMetaResp { ok: true; noop?: boolean }

export async function setSupportSessionMeta(
  sessionId: string,
  meta: SupportSessionMeta,
): Promise<void> {
  await invoke<SetMetaResp>('set_meta', { session_id: sessionId, ...meta });
}

/**
 * Posts a human-readable product summary into the Crisp conversation timeline
 * as an agent-only private note. Visible to the support agent, not surfaced
 * in the customer-facing chat list. Used by SupportScreen to introduce which
 * product the customer is currently asking about.
 */
export async function sendSupportProductContext(
  sessionId: string,
  content: string,
  opts?: {
    imageUrl?: string;
    imageName?: string;
    customerEmail?: string;
    productId?: string;
    sku?: string;
    title?: string;
  },
): Promise<void> {
  const payload: Record<string, unknown> = {
    session_id: sessionId,
    content,
  };
  if (opts?.imageUrl)      payload.image_url      = opts.imageUrl;
  if (opts?.imageName)     payload.image_name     = opts.imageName;
  if (opts?.customerEmail) payload.customer_email = opts.customerEmail;
  if (opts?.productId)     payload.product_id     = opts.productId;
  if (opts?.sku)           payload.sku            = opts.sku;
  if (opts?.title)         payload.title          = opts.title;
  await invoke<{ ok: true; image_failed?: boolean; offer_link_failed?: boolean }>(
    'send_product_context',
    payload,
  );
}
