/**
 * Minimal shell-aware cURL parser used by the GIGA inventory importer +
 * replayer scripts. Handles the kinds of cURL output Chrome DevTools emits
 * from "Copy as cURL" on macOS:
 *
 *   - line continuations:  `\\\n`
 *   - single-quoted args:  `-H 'cookie: a=b; c=d'`
 *   - double-quoted args:  `--data-raw "foo=bar"`
 *   - method override:     `-X POST` / `--request POST`
 *   - body flags:          `--data-raw` / `--data` / `--data-binary` / `-d`
 *   - cookie shorthand:    `-b 'PHPSESSID=…'`
 *
 * Unknown flags are skipped silently (no value consumed). That's safe for
 * Chrome's output because the flags it emits are a small known set.
 */

export interface ParsedCurl {
  url: string;
  method: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  body: string | null;
}

/** Shell-style tokenizer that honours `'…'` and `"…"` and `\\<char>` escapes. */
export function shellTokens(input: string): string[] {
  // First fold "\\\n" continuations into a single space.
  const text = input.replace(/\\\s*\r?\n/g, ' ');
  const out: string[] = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\' && quote === '"' && i + 1 < text.length) {
          buf += text[i + 1];
          i += 2;
          continue;
        }
        buf += text[i++];
      }
      i++; // skip closing quote
      continue;
    }
    if (/\s/.test(c)) {
      if (buf.length > 0) {
        out.push(buf);
        buf = '';
      }
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

const BODY_FLAGS = new Set([
  '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii',
]);

export function parseCurl(raw: string): ParsedCurl {
  const tokens = shellTokens(raw.trim());
  if (tokens[0] === 'curl') tokens.shift();

  let url = '';
  let method = 'GET';
  const headers: Record<string, string> = {};
  let body: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t === '-X' || t === '--request') {
      method = (tokens[++i] || 'GET').toUpperCase();
      continue;
    }

    if (t === '-H' || t === '--header') {
      const h = tokens[++i] ?? '';
      const colon = h.indexOf(':');
      if (colon > 0) {
        const name = h.slice(0, colon).trim().toLowerCase();
        const value = h.slice(colon + 1).trim();
        headers[name] = value;
      }
      continue;
    }

    if (t === '-b' || t === '--cookie') {
      headers['cookie'] = tokens[++i] ?? '';
      continue;
    }

    if (BODY_FLAGS.has(t)) {
      body = tokens[++i] ?? '';
      if (method === 'GET') method = 'POST';
      continue;
    }

    if (t.startsWith('-')) {
      // Unknown flag — ignore. (Chrome's cURL uses `--compressed`, `--location`,
      // `--insecure` etc.; none of these take a separately-quoted value the
      // parser would mis-consume.)
      continue;
    }

    if (!url) url = t;
  }

  const cookies: Record<string, string> = {};
  if (headers['cookie']) {
    headers['cookie']
      .split(/;\s*/)
      .filter(Boolean)
      .forEach((pair) => {
        const eq = pair.indexOf('=');
        if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      });
  }

  return { url, method, headers, cookies, body };
}

/** Mask sensitive header values + cookies for log output. */
export function redactForLog(parsed: ParsedCurl): ParsedCurl {
  const SENSITIVE = /^(cookie|authorization|x-csrf-token|x-xsrf-token|x-api-key)$/i;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.headers)) {
    if (SENSITIVE.test(k)) headers[k] = mask(v);
    else headers[k] = v;
  }
  const cookies: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.cookies)) cookies[k] = mask(v);
  return { ...parsed, headers, cookies };
}

function mask(v: string): string {
  if (v.length <= 6) return '…';
  return `${v.slice(0, 4)}…${v.slice(-2)} (${v.length}ch)`;
}

/** Quick heuristic: does this response body look like warehouse-stock data? */
export function looksLikeWarehouseStock(body: string): {
  warehouseCodes: string[];
  qtyTokens: string[];
} {
  const WH_CODE_RE = /\b(CA[A-Z]*\d+|NJX\d+|NJ[A-Z]*\d+|AT[A-Z]*\d+|TX[A-Z]*\d+)\b/g;
  const QTY_RE = /"(?:quantity|qty|stock|available|total)":\s*"?(\d+\+?)"?|>\s*(\d+\+?)\s*<|\b(\d+\+)\b/g;

  const warehouseCodes = Array.from(new Set(body.match(WH_CODE_RE) ?? []));

  const qtyTokens: string[] = [];
  let qm: RegExpExecArray | null;
  while ((qm = QTY_RE.exec(body)) !== null) {
    const v = qm[1] || qm[2] || qm[3];
    if (v) qtyTokens.push(v);
  }

  return { warehouseCodes, qtyTokens: Array.from(new Set(qtyTokens)).slice(0, 30) };
}
