/**
 * ConciergeContext — app-level unread + new-message detection for the Xself
 * Concierge (Crisp) support chat.
 *
 * PHASE 1, IN-APP ONLY. This provider:
 *   • Polls the customer's EXISTING Crisp session (read-only `getSupportMessages`)
 *     while the app is foregrounded.
 *   • Tracks unread operator (merchant/Concierge) messages vs a persisted
 *     last-read fingerprint (AsyncStorage, email-scoped).
 *   • Exposes the latest message preview + a `lastEvent` so an in-app banner
 *     (wired separately) can surface a new message; and `markRead()` for
 *     SupportScreen to clear unread on focus.
 *
 * HARD BOUNDARIES (do not change):
 *   • NEVER creates a Crisp session (no `createSupportSession`). Session creation
 *     stays SupportScreen's responsibility — this only READS an existing session
 *     id so we never spawn empty Crisp conversations.
 *   • Touches NO quote / offer / cart / checkout / support_quotes logic. It only
 *     reads chat messages via supportService.
 *   • No push notifications, no device tokens, no DB writes (Phase 2 is separate).
 */

import React, { createContext, useContext, useState, useRef, useEffect, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSupportMessages, SupportMessage } from '../services/supportService';
import { useAuth } from './AuthContext';

// Must match SupportScreen's key EXACTLY so we read the same persisted session.
const SESSION_KEY_PREFIX = 'xself_support_session_id_v2';
const LAST_READ_KEY_PREFIX = 'xself_concierge_last_read_v1';
const POLL_INTERVAL_MS = 15000; // gentle; SupportScreen has its own faster poll when focused

function scopedKey(prefix: string, email: string | null | undefined): string {
  const normalized = (email ?? '').trim().toLowerCase();
  return `${prefix}:${normalized || 'anon'}`;
}

// Mirror of SupportScreen.isInternalMessage so unread/banner ignore internal
// operator notes (admin URLs, product-inquiry echoes, offer-link macros).
const ADMIN_URL_REGEX =
  /https?:\/\/[^\s]*(?:netlify\.app|vercel\.app|pages\.dev|gorgeous-mermaid-80b26a)[^\s]*/i;
const PRODUCT_INQUIRY_REGEX = /^\s*Product inquiry:/i;
const OFFER_LABEL_REGEX     = /Create Special Offer/i;
const ADMIN_HTML_REGEX      = /mobile-create-quote\.html/i;

function isInternalMessage(content: string): boolean {
  if (typeof content !== 'string') return false;
  return (
    ADMIN_URL_REGEX.test(content)       ||
    PRODUCT_INQUIRY_REGEX.test(content) ||
    OFFER_LABEL_REGEX.test(content)     ||
    ADMIN_HTML_REGEX.test(content)
  );
}

/** A customer-visible operator (Concierge/merchant) message. */
function isVisibleOperatorMessage(m: SupportMessage): boolean {
  return m.from === 'operator' && !!m.content && !isInternalMessage(m.content);
}

export interface ConciergeNewMessageEvent {
  fingerprint: number;
  preview: string;
}

interface ConciergeContextValue {
  /** Count of unread customer-visible operator messages. */
  unreadCount: number;
  /** Newest customer-visible operator message text (trimmed), or null. */
  latestPreview: string | null;
  /** Fires (changes identity) when a NEW operator message arrives and banner is not suppressed. */
  lastEvent: ConciergeNewMessageEvent | null;
  /** Mark everything up to the latest operator message as read; clears unread. */
  markRead: () => void;
  /** Force an immediate poll (e.g. on SupportScreen focus). */
  refresh: () => void;
  /** SupportScreen calls setActive(true) on focus → suppresses banner + auto-marks read. */
  setActive: (active: boolean) => void;
}

const ConciergeContext = createContext<ConciergeContextValue | null>(null);

export function ConciergeProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const email = user?.email ?? null;

  const [unreadCount, setUnreadCount] = useState(0);
  const [latestPreview, setLatestPreview] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<ConciergeNewMessageEvent | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const lastReadRef = useRef<number>(0);      // highest operator fingerprint marked read
  const lastSeenRef = useRef<number>(0);       // highest operator fingerprint observed (for new-event detection)
  const activeRef = useRef<boolean>(false);    // true while SupportScreen is focused
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);

  const persistLastRead = useCallback(async (fp: number) => {
    try { await AsyncStorage.setItem(scopedKey(LAST_READ_KEY_PREFIX, email), String(fp)); } catch { /* ignore */ }
  }, [email]);

  // Core read: pull messages for the existing session and recompute unread.
  const poll = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || pollingRef.current) return;
    pollingRef.current = true;
    try {
      const msgs = await getSupportMessages(sid);
      if (!mountedRef.current) return;
      const operators = (msgs ?? []).filter(isVisibleOperatorMessage);
      if (operators.length === 0) return;
      const newest = operators[operators.length - 1];
      const maxFp = operators.reduce((m, x) => Math.max(m, x.id), 0);

      setLatestPreview(newest.content.trim());

      // If SupportScreen is focused, treat everything as read (no banner).
      if (activeRef.current) {
        lastReadRef.current = Math.max(lastReadRef.current, maxFp);
        lastSeenRef.current = Math.max(lastSeenRef.current, maxFp);
        persistLastRead(lastReadRef.current);
        setUnreadCount(0);
        return;
      }

      const unread = operators.filter(o => o.id > lastReadRef.current).length;
      setUnreadCount(unread);

      // Emit a banner event only for a genuinely new (not-yet-seen) operator message.
      if (maxFp > lastSeenRef.current && newest.id > lastReadRef.current) {
        lastSeenRef.current = maxFp;
        setLastEvent({ fingerprint: maxFp, preview: newest.content.trim() });
      } else {
        lastSeenRef.current = Math.max(lastSeenRef.current, maxFp);
      }
    } catch {
      /* network/session error — keep last known state, retry next tick */
    } finally {
      pollingRef.current = false;
    }
  }, [persistLastRead]);

  const refresh = useCallback(() => { void poll(); }, [poll]);

  const markRead = useCallback(() => {
    lastReadRef.current = Math.max(lastReadRef.current, lastSeenRef.current);
    persistLastRead(lastReadRef.current);
    setUnreadCount(0);
    setLastEvent(null);
  }, [persistLastRead]);

  const setActive = useCallback((active: boolean) => {
    activeRef.current = active;
    if (active) {
      // Entering the chat clears unread + dismisses any pending banner.
      lastReadRef.current = Math.max(lastReadRef.current, lastSeenRef.current);
      persistLastRead(lastReadRef.current);
      setUnreadCount(0);
      setLastEvent(null);
    }
  }, [persistLastRead]);

  // Resolve session id + last-read whenever the signed-in email changes.
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const [sid, lr] = await Promise.all([
          AsyncStorage.getItem(scopedKey(SESSION_KEY_PREFIX, email)),
          AsyncStorage.getItem(scopedKey(LAST_READ_KEY_PREFIX, email)),
        ]);
        if (cancelled) return;
        sessionIdRef.current = sid;             // may be null → poller idles, no session created
        lastReadRef.current = lr ? Number(lr) || 0 : 0;
        lastSeenRef.current = lastReadRef.current;
        setUnreadCount(0);
        setLatestPreview(null);
        setLastEvent(null);
        if (sid) void poll();
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [email, poll]);

  // Foreground-only polling loop (pause on background/inactive).
  useEffect(() => {
    const start = () => {
      if (timerRef.current) return;
      timerRef.current = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    };
    const onChange = (state: AppStateStatus) => {
      if (state === 'active') { void poll(); start(); } else { stop(); }
    };
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', onChange);
    return () => { sub.remove(); stop(); };
  }, [poll]);

  useEffect(() => () => { mountedRef.current = false; }, []);

  return (
    <ConciergeContext.Provider
      value={{ unreadCount, latestPreview, lastEvent, markRead, refresh, setActive }}
    >
      {children}
    </ConciergeContext.Provider>
  );
}

export function useConcierge(): ConciergeContextValue {
  const ctx = useContext(ConciergeContext);
  if (!ctx) throw new Error('useConcierge must be used within ConciergeProvider');
  return ctx;
}
