/**
 * Manual GIGA session importer — converts cookies you already have in your
 * normal Chrome into the Playwright storageState file the scraper expects.
 *
 * Why no automated browser: GIGA's captcha vendor flags any browser launched
 * by Playwright (the "Chrome is being controlled by automated test software"
 * banner is enough to fail validation), so we no longer try to log in from a
 * Playwright window. Instead, you log in once inside your real Chrome and
 * hand the cookies to this script.
 *
 * Output (unchanged): scripts/.giga-session.json — the existing scraper
 * loads this with `browser.newContext({ storageState: SESSION_FILE })`, so
 * the file format MUST be a valid Playwright storageState
 * ({ cookies: [...], origins: [...] }).
 *
 * Run (interactive paste):
 *   npx tsx scripts/saveGigaSession.ts
 *   # then paste the cookies and press Ctrl+D
 *
 * Run (from a file you exported with a Chrome cookie extension):
 *   GIGA_COOKIES_FILE=~/Downloads/gigab2b-cookies.json \
 *     npx tsx scripts/saveGigaSession.ts
 *
 * Accepted input formats (auto-detected):
 *   1. Raw `Cookie:` header value
 *        PHPSESSID=abc; user_token=xyz; ...
 *      Easiest: in Chrome DevTools → Network → click any gigab2b.com request
 *      → Request Headers → copy everything after "Cookie: ".
 *   2. JSON array exported by "EditThisCookie" or "Cookie-Editor" extensions
 *        [{ "name":"PHPSESSID", "value":"...", "domain":".gigab2b.com", ... }, ...]
 *   3. Netscape "cookies.txt" exported by "Get cookies.txt LOCALLY"
 *        # Netscape HTTP Cookie File
 *        .gigab2b.com   TRUE   /   TRUE   1764500000   PHPSESSID   abc
 *
 * Env vars (all optional):
 *   GIGA_SESSION_FILE — output path (default: scripts/.giga-session.json)
 *   GIGA_COOKIES_FILE — read cookies from this path instead of stdin
 *   GIGA_DOMAIN       — fallback cookie domain when input lacks one
 *                       (default: .gigab2b.com)
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_FILE = process.env.GIGA_SESSION_FILE
  ?? path.join(process.cwd(), 'scripts', '.giga-session.json');

const COOKIES_FILE = process.env.GIGA_COOKIES_FILE ?? '';

const DEFAULT_DOMAIN = process.env.GIGA_DOMAIN ?? '.gigab2b.com';

// ── Types ─────────────────────────────────────────────────────────────────────

type PWCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since epoch. -1 = session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax' | 'None' | 'Strict';
};

type PWStorageState = {
  cookies: PWCookie[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_EXPIRES_SECS = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

function normalizeSameSite(v: unknown): 'Lax' | 'None' | 'Strict' {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'no_restriction' || s === 'none' || s === 'unspecified') return 'None';
  return 'Lax';
}

function makeCookie(partial: Partial<PWCookie> & { name: string; value: string }): PWCookie {
  return {
    name: partial.name,
    value: partial.value,
    domain: partial.domain ?? DEFAULT_DOMAIN,
    path: partial.path ?? '/',
    expires: partial.expires ?? DEFAULT_EXPIRES_SECS,
    httpOnly: partial.httpOnly ?? false,
    secure: partial.secure ?? true,
    sameSite: partial.sameSite ?? 'Lax',
  };
}

// ── Parsers ───────────────────────────────────────────────────────────────────

/** Parse a raw "Cookie:" header value: "a=1; b=2; ...". */
function parseCookieHeader(raw: string): PWCookie[] {
  // Strip leading "Cookie:" if user copy-pasted the whole header line
  const cleaned = raw.replace(/^cookie:\s*/i, '').trim();
  return cleaned
    .split(/;\s*/)
    .map(p => p.trim())
    .filter(p => p && p.includes('='))
    .map(pair => {
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      return makeCookie({ name, value });
    });
}

/** Parse a JSON array from extensions like EditThisCookie / Cookie-Editor. */
function parseJsonCookies(raw: string): PWCookie[] {
  const data = JSON.parse(raw);
  const arr: unknown[] = Array.isArray(data) ? data : Array.isArray((data as Record<string, unknown>)?.cookies) ? (data as { cookies: unknown[] }).cookies : [];
  if (arr.length === 0) throw new Error('JSON input did not contain a cookie array');

  return arr.map((raw): PWCookie => {
    const c = raw as Record<string, unknown>;
    const expires =
      typeof c.expirationDate === 'number' ? Math.floor(c.expirationDate as number)
      : typeof c.expires === 'number' ? (c.expires as number)
      : typeof c.expirationDate === 'string' ? Math.floor(Number(c.expirationDate))
      : DEFAULT_EXPIRES_SECS;

    return makeCookie({
      name: String(c.name ?? ''),
      value: String(c.value ?? ''),
      domain: typeof c.domain === 'string' && c.domain ? c.domain : DEFAULT_DOMAIN,
      path: typeof c.path === 'string' && c.path ? c.path : '/',
      expires: Number.isFinite(expires) ? expires : DEFAULT_EXPIRES_SECS,
      httpOnly: c.httpOnly === true,
      secure: c.secure === false ? false : true,
      sameSite: normalizeSameSite(c.sameSite),
    });
  }).filter(c => c.name && c.value);
}

/** Parse a Netscape "cookies.txt" file body. */
function parseNetscape(raw: string): PWCookie[] {
  return raw.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('\t'))
    .filter(p => p.length >= 7 && p[5] && p[6])
    .map(p => makeCookie({
      domain:  p[0],
      path:    p[2] || '/',
      secure:  p[3].toUpperCase() === 'TRUE',
      expires: parseInt(p[4], 10) || DEFAULT_EXPIRES_SECS,
      name:    p[5],
      value:   p[6],
    }));
}

function detectAndParse(raw: string): PWCookie[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // JSON: starts with [ or {
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return parseJsonCookies(trimmed);
  }

  // Netscape: header comment OR at least one tab-separated line beginning with a host
  if (/^# Netscape HTTP Cookie File/i.test(trimmed) || /^\.?[\w.-]+\.\w+\t/m.test(trimmed)) {
    return parseNetscape(trimmed);
  }

  // Default: treat as raw Cookie header
  return parseCookieHeader(trimmed);
}

// ── stdin reader ──────────────────────────────────────────────────────────────

function readStdinUntilEOF(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
    // If nothing arrives within a few minutes, the user can Ctrl+C — no timeout here.
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' GIGA SESSION IMPORT (no automated browser)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` Session output : ${SESSION_FILE}`);
  console.log(` Default domain : ${DEFAULT_DOMAIN}`);
  console.log(` Cookies file   : ${COOKIES_FILE || '(none — reading from stdin)'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  let raw = '';

  if (COOKIES_FILE) {
    if (!fs.existsSync(COOKIES_FILE)) {
      console.error(`[saveGigaSession] ERROR: GIGA_COOKIES_FILE does not exist: ${COOKIES_FILE}`);
      process.exit(1);
    }
    raw = fs.readFileSync(COOKIES_FILE, 'utf8');
    console.log(`[saveGigaSession] Read ${raw.length} chars from ${COOKIES_FILE}`);
  } else {
    console.log(' HOW TO GET THE COOKIES');
    console.log(' ───────────────────────────────────────────────────────────');
    console.log(' Option A — easiest (raw Cookie header):');
    console.log('   1. In your normal Chrome, sign in at https://www.gigab2b.com/');
    console.log('      and complete any captcha. Stay logged in.');
    console.log('   2. Cmd+Option+I → Network tab.');
    console.log('   3. Reload the seller dashboard. In the request list, click any');
    console.log('      request to gigab2b.com.');
    console.log('   4. Scroll to "Request Headers" and find the line `Cookie: ...`.');
    console.log('   5. Copy EVERYTHING after `Cookie: ` (one long line).');
    console.log('   6. Paste it below, press Enter, then press Ctrl+D to submit.');
    console.log('');
    console.log(' Option B — JSON / cookies.txt export:');
    console.log('   Use a Chrome extension such as "Cookie-Editor" or "Get');
    console.log('   cookies.txt LOCALLY", export cookies for gigab2b.com, and');
    console.log('   paste the full file content below (Ctrl+D when done).');
    console.log('   Or save it to a file and re-run with:');
    console.log('     GIGA_COOKIES_FILE=/path/to/cookies.json npx tsx scripts/saveGigaSession.ts');
    console.log('');
    console.log(' PASTE BELOW (then Ctrl+D):');
    console.log(' ───────────────────────────────────────────────────────────');
    raw = await readStdinUntilEOF();
  }

  let cookies: PWCookie[];
  try {
    cookies = detectAndParse(raw);
  } catch (err) {
    console.error('[saveGigaSession] ERROR parsing input:',
      err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (cookies.length === 0) {
    console.error('[saveGigaSession] ERROR: No cookies parsed from input.');
    console.error('  Make sure you pasted a Cookie header, JSON array, or');
    console.error('  cookies.txt content — not just a single name=value.');
    process.exit(1);
  }

  // Heuristic warning if the input looks unlikely to be a real session.
  const looksLikeSession = cookies.some(c =>
    /phpsessid|sessid|session|token|auth|jwt|login|user/i.test(c.name),
  );
  if (!looksLikeSession) {
    console.log('[saveGigaSession] ⚠  No session-shaped cookie (PHPSESSID / session / token / auth / user) detected.');
    console.log('[saveGigaSession]    Saving anyway, but the scraper may immediately treat this as expired.');
  }

  console.log(`\n[saveGigaSession] Parsed ${cookies.length} cookie(s):`);
  for (const c of cookies) {
    const masked = c.value.length > 12
      ? `${c.value.slice(0, 6)}…${c.value.slice(-3)}`
      : '…';
    const exp = c.expires === -1 ? 'session' : new Date(c.expires * 1000).toISOString();
    console.log(`  ${c.name.padEnd(28)} domain=${c.domain.padEnd(20)} secure=${c.secure ? 'y' : 'n'} expires=${exp} value=${masked}`);
  }

  const storageState: PWStorageState = {
    cookies,
    origins: [],
  };

  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2), 'utf8');

  console.log(`\n[saveGigaSession] ✓ Wrote storageState to ${SESSION_FILE}`);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' VERIFY + DEPLOY');
  console.log('───────────────────────────────────────────────────────────');
  console.log(' 1. Verify locally (dry run, 2 products, no DB writes):');
  console.log('      DRY_RUN=1 INVENTORY_LIMIT=2 HEADED=1 \\');
  console.log('        npx tsx scripts/syncGigaFurnitureInventory.ts');
  console.log('    Look for `Specified Warehouse` clicks and warehouse rows.');
  console.log('    If you see "Session expired" the cookies are missing the');
  console.log('    real auth cookie — repeat the export.');
  console.log('');
  console.log(' 2. Update the GitHub Actions secret so the scheduled sync');
  console.log('    workflow picks up the new session. Copy the encoded file');
  console.log('    to your clipboard with:');
  console.log('');
  console.log('      base64 -i scripts/.giga-session.json | pbcopy');
  console.log('');
  console.log('    Then paste into GitHub → Settings → Secrets and variables');
  console.log('    → Actions → GIGA_SESSION_B64.');
  console.log('═══════════════════════════════════════════════════════════\n');
}

run().catch(err => {
  console.error('[saveGigaSession] Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
