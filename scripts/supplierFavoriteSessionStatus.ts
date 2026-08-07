/**
 * READ ONLY account-area session probe for both supplier accounts.
 *
 * The stored `.giga-session-<source>.health.json` is produced by a warehouse XHR probe, which does
 * NOT prove the session is authenticated for `account/*` routes — that gap is what produced a 302
 * on a real removal attempt. This hits the wishlist GROUP LIST, a GET the wishlist UI itself calls:
 * same account-area auth as delProductsFromWish, but non-mutating.
 *
 * Sends no removal and writes nothing. Prints one machine-readable line for the XOne bridge:
 *
 *   SESSION_STATUS {"schema_version":"1.0","accounts":[{"account":"pickup","authenticated":true},…]}
 *
 * Usage: tsx scripts/supplierFavoriteSessionStatus.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ACCOUNTS = ['pickup', 'dropship'] as const;
type Account = (typeof ACCOUNTS)[number];

const GROUP_LIST_URL = 'https://www.gigab2b.com/index.php?route=account/wishlist_group/allGroup';
const PROBE_TIMEOUT_MS = 25_000;

function sessionFileFor(account: Account): string {
  return path.join(__dirname, `.giga-session-${account}.json`);
}

interface AccountStatus {
  account: Account;
  /** True only when the account area answered with business code 200. Never optimistic. */
  authenticated: boolean;
  session_present: boolean;
  reason: string | null;
}

async function probe(account: Account): Promise<AccountStatus> {
  const file = sessionFileFor(account);
  if (!fs.existsSync(file)) {
    return { account, authenticated: false, session_present: false, reason: 'session_missing' };
  }

  let cookies: Array<{ name: string; value: string }>;
  try {
    cookies = (JSON.parse(fs.readFileSync(file, 'utf8')) as { cookies?: typeof cookies }).cookies ?? [];
  } catch {
    return { account, authenticated: false, session_present: false, reason: 'session_unreadable' };
  }
  if (cookies.length === 0) {
    return { account, authenticated: false, session_present: false, reason: 'session_empty' };
  }

  const headers: Record<string, string> = {
    cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    accept: 'application/json, text/javascript, */*; q=0.01',
    'content-type': 'application/json;charset=UTF-8',
    'user-agent': 'Mozilla/5.0',
    'x-requested-with': 'XMLHttpRequest',
    'ori-status-in-response': 'code',
    origin: 'https://www.gigab2b.com',
    referer: 'https://www.gigab2b.com/index.php?route=account/wishlist',
  };
  // The site's own client injects this from the cookie; omit it rather than invent one.
  const deviceId = cookies.find((c) => c.name === 'gmd_device_id')?.value;
  if (deviceId) headers['x-gmd-device-id'] = deviceId;

  try {
    const res = await fetch(GROUP_LIST_URL, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await res.text();
    let body: { code?: unknown } | null = null;
    try { body = JSON.parse(text); } catch { /* non-JSON means not an authenticated API answer */ }
    if (body?.code === 200) return { account, authenticated: true, session_present: true, reason: null };
    return {
      account,
      authenticated: false,
      session_present: true,
      // 302 is the site's "redirecting to login" answer for account routes.
      reason: body?.code === 302 ? 'login_required' : `unexpected_code_${String(body?.code ?? 'none')}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { account, authenticated: false, session_present: true, reason: /timeout|abort/i.test(msg) ? 'probe_timeout' : 'probe_failed' };
  }
}

async function main(): Promise<void> {
  const accounts: AccountStatus[] = [];
  for (const account of ACCOUNTS) accounts.push(await probe(account));
  process.stdout.write(`SESSION_STATUS ${JSON.stringify({
    schema_version: '1.0',
    accounts,
    all_authenticated: accounts.every((a) => a.authenticated),
    production_write_attempted: false,
  })}\n`);
}

void main();
