import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';

// ── Env vars (set in .env, prefixed EXPO_PUBLIC_ so Metro inlines them) ──────
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

// Detect missing or unfilled placeholder values
const CONFIGURED =
  SUPABASE_URL.startsWith('https://') &&
  !SUPABASE_URL.includes('your-project') &&
  SUPABASE_ANON_KEY.length > 20 &&
  !SUPABASE_ANON_KEY.includes('your-anon-key');

if (!CONFIGURED && __DEV__) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n[Supabase] ⚠️  Missing or placeholder credentials detected.\n' +
    'Open .env in the project root and fill in:\n' +
    '  EXPO_PUBLIC_SUPABASE_URL=https://<project>.supabase.co\n' +
    '  EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon-key>\n' +
    'Then restart with:\n' +
    '  npx expo start --clear\n'
  );
}

// ── SecureStore adapter ──────────────────────────────────────────────────────
const ExpoSecureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

// ── Safe stub ────────────────────────────────────────────────────────────────
// When credentials are missing the app must not crash at module load.
// Auth calls return a descriptive error so the UI can surface it.
const NOT_CONFIGURED_MSG =
  'Supabase not configured — add EXPO_PUBLIC_SUPABASE_URL and ' +
  'EXPO_PUBLIC_SUPABASE_ANON_KEY to .env, then run: npx expo start --clear';

function makeStub(): SupabaseClient {
  const err = () =>
    Promise.resolve({ data: { session: null, user: null }, error: { message: NOT_CONFIGURED_MSG } });
  return {
    auth: {
      getSession: err,
      onAuthStateChange: (_cb: unknown) => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
      signInWithOtp: err,
      verifyOtp: err,
      signOut: () => Promise.resolve({ error: null }),
    },
  } as unknown as SupabaseClient;
}

// ── Real client (only created when credentials are present) ──────────────────
export const supabase: SupabaseClient = CONFIGURED
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: ExpoSecureStoreAdapter,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false, // required for React Native
      },
    })
  : makeStub();

/** True once real credentials are set — use for conditional feature gating */
export const supabaseConfigured = CONFIGURED;
