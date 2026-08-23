/**
 * review-login — Apple App Review 专用固定验证码登录。
 *
 * 存在的唯一理由：App Store 审核员无法收取 test@xselfhome.com 的邮件验证码。
 * 这个函数让审核员用一个「服务端固定 6 位码」换取一个与普通用户完全一致的
 * 真实 Supabase Session —— 不伪造 JWT，不直写任何 auth 表。
 *
 * 官方链路（全部标准 API）：
 *   admin.generateLink({ type:'magiclink' })  → 拿到 properties.email_otp（GoTrue 生成，不发信）
 *   → admin.auth.verifyOtp({ email, token: email_otp, type:'magiclink' })
 *   → GoTrue 签发真实 { access_token, refresh_token }
 *
 * 安全边界：
 *   * 只对 test@xselfhome.com 生效，其它邮箱一律 401。
 *   * 固定码只来自 Secret REVIEW_LOGIN_CODE，永不进客户端/仓库。
 *   * REVIEW_LOGIN_ENABLED 默认 fail-closed：未显式设为 'true' 就全部拒绝。
 *   * 常量时间比对 + 每实例滑动窗口限流，收敛暴力尝试面。
 *   * 绝不 console 输出 code / token / session。
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const REVIEW_LOGIN_ENABLED      = Deno.env.get('REVIEW_LOGIN_ENABLED') ?? '';
const REVIEW_LOGIN_CODE         = Deno.env.get('REVIEW_LOGIN_CODE') ?? '';

/** 唯一被允许的审核邮箱。硬编码，绝不从请求体或 env 读取，防止被放大到其它账号。 */
const ALLOWED_EMAIL = 'test@xselfhome.com';

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

/** 常量时间字符串比较，避免用 === 提前返回泄露长度/前缀信息。 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // 长度不同也走满整轮异或，比较结果仍为 false，但不因长度差异提前返回。
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// ── 每实例滑动窗口限流 ────────────────────────────────────────────────────────
// 单邮箱 + 服务端固定码，主要防的是对该邮箱的在线暴力猜码。Edge 实例内存即可，
// 实例回收会重置计数 —— 不是强隔离，但配合固定码熵值足以把在线爆破压到无意义。
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;
const attempts: number[] = [];
function rateLimited(now: number): boolean {
  while (attempts.length && now - attempts[0] > WINDOW_MS) attempts.shift();
  if (attempts.length >= MAX_ATTEMPTS) return true;
  attempts.push(now);
  return false;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405);

  // 1) 总开关 fail-closed：未显式 'true' 一律拒绝，且不泄露是「关闭」还是「码错」。
  if (REVIEW_LOGIN_ENABLED !== 'true' || !REVIEW_LOGIN_CODE || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'review_login_unavailable' }, 403);
  }

  // 2) 限流。
  if (rateLimited(Date.now())) return json({ error: 'too_many_attempts' }, 429);

  // 3) 解析请求。
  let body: { email?: unknown; code?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_request' }, 400);
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const code  = typeof body.code === 'string' ? body.code : '';

  // 4) 邮箱白名单（单一常量）。错误邮箱与错误码返回同一种模糊错误，不区分。
  //    先算 code 比较再判邮箱，两者都用常量时间，避免通过响应时间区分「邮箱对不对」。
  const codeOk  = timingSafeEqual(code, REVIEW_LOGIN_CODE);
  const emailOk = timingSafeEqual(email, ALLOWED_EMAIL);
  if (!emailOk || !codeOk) return json({ error: 'invalid_credentials' }, 401);

  // 5) 官方链路换真实 Session。service-role 客户端，不持久化会话。
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    // 5a) 生成 magiclink，拿明文 email_otp（GoTrue 生成，不发信）。
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: ALLOWED_EMAIL,
    });
    if (linkErr || !linkData?.properties?.email_otp) {
      console.error('[review-login] generateLink failed', linkErr?.message ?? 'no email_otp');
      return json({ error: 'session_setup_failed' }, 500);
    }

    // 5b) 用 email_otp 走标准 verifyOtp，换真实 Session。
    const { data: verifyData, error: verifyErr } = await admin.auth.verifyOtp({
      email: ALLOWED_EMAIL,
      token: linkData.properties.email_otp,
      type: 'magiclink',
    });
    if (verifyErr || !verifyData?.session) {
      console.error('[review-login] verifyOtp failed', verifyErr?.message ?? 'no session');
      return json({ error: 'session_setup_failed' }, 500);
    }

    // 6) 只回客户端 setSession 需要的两个 token，别的一律不返回。
    return json({
      access_token: verifyData.session.access_token,
      refresh_token: verifyData.session.refresh_token,
    });
  } catch (e) {
    console.error('[review-login] unexpected error', e instanceof Error ? e.message : 'unknown');
    return json({ error: 'session_setup_failed' }, 500);
  }
});
