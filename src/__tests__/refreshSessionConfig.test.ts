/**
 * Focused tests for the SESSION_ONLY / GIGA_SESSION_FILE env branching added to
 * scripts/refreshGigaSession.ts. Pure/offline — importing the module does NOT run
 * main() (direct-invocation guard), so no Chromium/gh/DB is touched.
 * Run: npx tsx src/__tests__/refreshSessionConfig.test.ts
 */
import assert from 'node:assert/strict';
import * as path from 'path';
import { resolveSessionConfig } from '../../scripts/refreshGigaSession';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('refreshGigaSession SESSION_ONLY / GIGA_SESSION_FILE tests');

it('1. default: no envs → default session path, sessionOnly=false', () => {
  const c = resolveSessionConfig({});
  assert.equal(c.sessionOnly, false);
  assert.ok(c.sessionFile.endsWith(path.join('scripts', '.giga-session.json')), c.sessionFile);
});
it('2. GIGA_SESSION_FILE overrides the output path', () => {
  const c = resolveSessionConfig({ GIGA_SESSION_FILE: 'scripts/.giga-session-pickup.json' });
  assert.equal(c.sessionFile, 'scripts/.giga-session-pickup.json');
});
it('3. SESSION_ONLY=1 → sessionOnly=true', () => {
  assert.equal(resolveSessionConfig({ SESSION_ONLY: '1' }).sessionOnly, true);
});
it('4. SESSION_ONLY only true for exactly "1"', () => {
  assert.equal(resolveSessionConfig({ SESSION_ONLY: '0' }).sessionOnly, false);
  assert.equal(resolveSessionConfig({ SESSION_ONLY: 'true' }).sessionOnly, false);
  assert.equal(resolveSessionConfig({}).sessionOnly, false);
});
it('5. both together: pickup path + session-only', () => {
  const c = resolveSessionConfig({ GIGA_SESSION_FILE: 'scripts/.giga-session-pickup.json', SESSION_ONLY: '1' });
  assert.equal(c.sessionFile, 'scripts/.giga-session-pickup.json');
  assert.equal(c.sessionOnly, true);
});
it('6. importing the module did NOT execute main() (guard holds)', () => {
  // If main() ran on import it would launch Chromium / require gh and never reach here.
  assert.equal(typeof resolveSessionConfig, 'function');
});

console.log(`\n${passed} passed`);
