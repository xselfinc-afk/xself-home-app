import React, { createContext, useContext, useState, useEffect } from 'react';
import { Linking } from 'react-native';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export type AuthUser = {
  /** Supabase user UUID — stable identity for ledger self-referral checks */
  id: string;
  email: string;
  displayName: string;
  source: 'email' | 'apple';
};

type AuthCtx = {
  user: AuthUser | null;
  session: Session | null;
  isGuest: boolean;
  /**
   * True once cold-start session restoration has resolved. The root gate renders
   * nothing (native splash stays held) until this flips true, so it never shows the
   * wrong first screen before we know whether a persisted session exists.
   */
  authReady: boolean;
  /**
   * Step 1: send OTP to the given email via Supabase Auth.
   * Returns { error } — null on success, message string on failure.
   */
  sendOtp: (email: string) => Promise<{ error: string | null }>;
  /**
   * Step 2: verify the 6-digit OTP token.
   * Creates and persists the authenticated session on success.
   */
  verifyOtp: (email: string, token: string) => Promise<{ error: string | null }>;
  continueAsGuest: () => void;
  signOut: () => Promise<void>;
  /**
   * Permanently delete the signed-in user's account via the delete-account
   * edge function, then sign out and return to guest state. Resolves with
   * `{ error }` — null on success, message string on failure.
   */
  deleteAccount: () => Promise<{ error: string | null }>;
  updateDisplayName: (name: string) => void;
};

const AuthContext = createContext<AuthCtx>(null!);

function deriveDisplayName(email: string): string {
  const raw = email.split('@')[0].replace(/[._-]/g, ' ');
  return raw.replace(/\b\w/g, c => c.toUpperCase());
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isGuest, setIsGuest] = useState(false);
  const [authReady, setAuthReady] = useState(false);

  // ── Session restore + live auth state + magic link handler ────────────────
  useEffect(() => {
    // Restore persisted session on cold start. If a session exists → authenticated.
    // If none exists → remain NEITHER authenticated NOR guest (guest is now an explicit
    // choice), so the root gate shows the standalone LoginEntry. `authReady` flips true
    // once this resolves (success or failure), releasing the native splash.
    supabase.auth.getSession()
      .then(({ data: { session: s } }) => { if (s) applySession(s); })
      .catch(() => {})
      .finally(() => setAuthReady(true));

    // Keep in sync with Supabase session lifecycle (token refresh, sign-out)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s) {
        applySession(s);
      } else {
        setUser(null);
      }
    });

    // Magic link deep link handler
    // Supabase redirects to xselfhome://...#access_token=...&refresh_token=...
    async function handleMagicLink(url: string) {
      const hash = url.split('#')[1];
      if (!hash) return;
      const params: Record<string, string> = {};
      hash.split('&').forEach(pair => {
        const [k, v] = pair.split('=');
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
      });
      if (params.access_token && params.refresh_token) {
        console.log('[Auth] Magic link received, setting session');
        await supabase.auth.setSession({
          access_token: params.access_token,
          refresh_token: params.refresh_token,
        });
        // onAuthStateChange fires after setSession and calls applySession
      }
    }

    // Cold start: app was closed when the magic link was tapped
    Linking.getInitialURL().then(url => { if (url) handleMagicLink(url); });
    // Foreground: app was open or backgrounded when the link was tapped
    const linkSub = Linking.addEventListener('url', ({ url }) => handleMagicLink(url));

    return () => {
      subscription.unsubscribe();
      linkSub.remove();
    };
  }, []);

  function applySession(s: Session) {
    const email = s.user.email ?? '';
    console.log('[Auth] Session restored:', s.user.id);
    setSession(s);
    setUser({ id: s.user.id, email, displayName: deriveDisplayName(email), source: 'email' });
    setIsGuest(false);
    // Guest cart merge: in-memory CartContext state is already preserved on sign-in.
    // For server-side cart sync, call your cart merge API here.
  }

  // ── OTP flow ───────────────────────────────────────────────────────────────
  const sendOtp = async (email: string): Promise<{ error: string | null }> => {
    console.log('[Auth] Sending OTP to', email);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    if (error) console.log('[Auth] sendOtp error:', error.message);
    return { error: error?.message ?? null };
  };

  const verifyOtp = async (email: string, token: string): Promise<{ error: string | null }> => {
    console.log('[Auth] Verifying OTP for', email);
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'email',
    });
    if (error) {
      console.log('[Auth] verifyOtp error:', error.message);
      return { error: error.message };
    }
    if (data.session) applySession(data.session);
    return { error: null };
  };

  const continueAsGuest = () => {
    setUser(null);
    setIsGuest(true);
  };

  const updateDisplayName = (name: string) => {
    setUser(prev => prev ? { ...prev, displayName: name } : null);
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
    // Explicit sign-out returns to the standalone LoginEntry (NOT silent guest):
    // user=null + isGuest=false makes the root gate unmount Main and show LoginEntry.
    setIsGuest(false);
  };

  const deleteAccount = async (): Promise<{ error: string | null }> => {
    if (!session) return { error: 'You must be signed in to delete your account.' };
    console.log('[Auth] Deleting account', session.user.id);
    const { data, error } = await supabase.functions.invoke('delete-account', { body: {} });
    if (error) {
      console.log('[Auth] deleteAccount error:', error.message);
      return { error: error.message };
    }
    if (data && (data as { error?: string }).error) {
      const msg = (data as { message?: string; error: string }).message ?? (data as { error: string }).error;
      console.log('[Auth] deleteAccount server error:', msg);
      return { error: msg };
    }
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
    // Account deleted → return to the standalone LoginEntry (not silent guest).
    setIsGuest(false);
    return { error: null };
  };

  return (
    <AuthContext.Provider value={{ user, session, isGuest, authReady, sendOtp, verifyOtp, continueAsGuest, signOut, deleteAccount, updateDisplayName }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthCtx {
  return useContext(AuthContext);
}
