/**
 * delete-account — Apple-compliant account deletion entry point.
 *
 * Verifies the caller's JWT, then uses the service role to delete the auth
 * user. ON DELETE CASCADE on addresses removes the user's saved addresses;
 * orders.user_id has ON DELETE SET NULL so completed orders are anonymised
 * but retained for fulfillment / accounting.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'missing_authorization' }, 401);

  // Identify the caller using the anon client + their JWT.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: 'invalid_token' }, 401);

  const userId = userData.user.id;

  // Service-role client performs the privileged deletion.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Best-effort explicit cleanup of user-owned rows that don't cascade.
  // addresses cascades automatically; orders.user_id is set null automatically.
  // Listed here so future tables can be added without changing client code.
  try {
    await admin.from('addresses').delete().eq('user_id', userId);
  } catch (e) {
    console.warn('[delete-account] addresses cleanup failed', e);
  }

  const { error: delErr } = await admin.auth.admin.deleteUser(userId);
  if (delErr) {
    console.error('[delete-account] admin.deleteUser failed', delErr);
    return json({ error: 'delete_failed', message: delErr.message }, 500);
  }

  return json({ ok: true });
});
