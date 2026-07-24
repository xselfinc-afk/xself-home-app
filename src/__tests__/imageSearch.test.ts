/**
 * Image-search secure-proxy invariants — source-structure test (the repo has no
 * React renderer in its test tooling, so we assert against App.tsx + the Edge
 * Function source). Proves the client no longer ships the Anthropic key and the
 * request is proxied through the `image-search` Supabase Edge Function.
 *
 * Run: npx tsx src/__tests__/imageSearch.test.ts   (from repo root)
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const app = readFileSync(join(process.cwd(), 'App.tsx'), 'utf8');
const fnPath = join(process.cwd(), 'supabase/functions/image-search/index.ts');

console.log('image-search secure-proxy tests');

it('1. client no longer reads the client-shipped Anthropic key', () => {
  assert.equal(app.includes('EXPO_PUBLIC_ANTHROPIC_API_KEY'), false, 'no EXPO_PUBLIC_ANTHROPIC_API_KEY reference in App.tsx');
});

it('2. client no longer calls the Anthropic API directly', () => {
  assert.equal(app.includes('api.anthropic.com'), false, 'no direct api.anthropic.com fetch in App.tsx');
  assert.equal(app.includes("'x-api-key'"), false, 'no anthropic x-api-key header in App.tsx');
});

it('3. client proxies image search through the Edge Function', () => {
  assert.ok(app.includes("functions.invoke('image-search'"), 'App.tsx calls the image-search Edge Function');
  assert.ok(app.includes('image_base64') && app.includes('media_type'), 'sends image_base64 + media_type');
});

it('4. client preserves graceful-degradation (returns empty keywords on failure)', () => {
  const fn = app.slice(app.indexOf('async function extractImageKeywords'), app.indexOf('const Tab = createBottomTabNavigator'));
  assert.ok(fn.includes("return '';"), 'extractImageKeywords still returns empty string on failure');
  assert.ok(fn.includes('extractImageKeywords'), 'extractImageKeywords still present');
});

it('5. Edge Function exists and reads the key from a server-only secret', () => {
  assert.ok(existsSync(fnPath), 'supabase/functions/image-search/index.ts exists');
  const fn = readFileSync(fnPath, 'utf8');
  assert.ok(fn.includes("Deno.env.get('ANTHROPIC_API_KEY')"), 'reads ANTHROPIC_API_KEY from Deno env (Supabase secret)');
  // The function may mention the old client var in a doc comment, but must never READ it.
  assert.equal(fn.includes("Deno.env.get('EXPO_PUBLIC"), false, 'server never reads an EXPO_PUBLIC client var');
  assert.equal(fn.includes('process.env.EXPO_PUBLIC'), false, 'no client-inlined env read on the server');
});

it('6. Edge Function validates input, caps size, and applies a timeout', () => {
  const fn = readFileSync(fnPath, 'utf8');
  assert.ok(fn.includes('MAX_BASE64_CHARS'), 'has a base64 size cap');
  assert.ok(fn.includes('ALLOWED_MEDIA_TYPES'), 'restricts allowed media types');
  assert.ok(fn.includes('AbortController') && fn.includes('REQUEST_TIMEOUT_MS'), 'applies a request timeout');
  assert.ok(fn.includes("media_type") && fn.includes("image_base64"), 'accepts the documented request shape');
});

it('7. Edge Function returns the { keywords } response shape', () => {
  const fn = readFileSync(fnPath, 'utf8');
  assert.ok(fn.includes('keywords'), 'responds with a keywords field');
});

console.log(`\n${passed} passed`);
