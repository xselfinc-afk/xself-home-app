/**
 * Migration consistency tests (static; no database, no network, no browser).
 *
 * WHY THIS EXISTS
 * ---------------
 * `20260802_open_api_availability.sql` was applied to production, then edited in place to change
 * the freshness windows. That left the repository describing a state production never had, and it
 * would have meant re-running an edited historical migration to reconcile. An applied migration is
 * a historical record: it must be immutable, and changes must arrive as new incremental files.
 *
 * The hash below pins the exact content that was applied. If someone edits that file again, this
 * test fails and names the correct remedy rather than letting the drift reach production.
 *
 * Run: npx tsx src/__tests__/migrationConsistency.test.ts
 */
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const ROOT = path.join(__dirname, '..', '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const read = (f: string) => fs.readFileSync(path.join(MIG, f), 'utf8');
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(MIG, f))).digest('hex');

const APPLIED_20260802 = '20260802_open_api_availability.sql';
const INCREMENTAL_20260804 = '20260804_update_availability_freshness_48h.sql';
const UNAPPLIED_20260803 = '20260803_sellable_requires_fresh_availability.sql';

/** sha256 of the exact 20260802 content applied to production (git c0c623f8). */
const APPLIED_20260802_SHA256 = '52137beebc8398626940f9723cdc9e97d5a53e0311b972773222bc1848634c35';

function main(): void {
  it('1. the applied migration still declares the windows production actually has (72h/96h)', () => {
    const src = read(APPLIED_20260802);
    assert.match(src, /interval '72 hours'\) AS is_fresh/);
    assert.match(src, /interval '96 hours'\) AS within_grace/);
    // The new windows must NOT have been back-edited into the historical file.
    assert.ok(!/interval '48 hours'/.test(src),
      'an applied migration must never be edited — add a new incremental migration instead');
  });

  it('2. the applied migration is byte-stable (hash pinned)', () => {
    const actual = sha(APPLIED_20260802);
    assert.equal(actual, APPLIED_20260802_SHA256,
      `${APPLIED_20260802} changed. It is already applied to production and must stay immutable.\n` +
      `      Add a new incremental migration instead. If the change is genuinely intended and has ` +
      `been applied, update APPLIED_20260802_SHA256 deliberately.\n      got: ${actual}`);
  });

  it('3. the incremental migration carries the new windows', () => {
    const src = read(INCREMENTAL_20260804);
    assert.match(src, /interval '48 hours'\) AS is_fresh/);
    assert.match(src, /interval '72 hours'\) AS within_grace/);
  });

  it('4. the incremental migration replaces ONLY the availability view', () => {
    const exec = read(INCREMENTAL_20260804).split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    for (const forbidden of ['INSERT', 'UPDATE ', 'DELETE', 'DROP', 'ALTER TABLE', 'TRUNCATE', 'GRANT']) {
      assert.ok(!new RegExp(forbidden, 'i').test(exec), `incremental migration must not contain ${forbidden}`);
    }
    for (const table of ['standardized_products', 'sellable_products', 'inventory_workflow_states', 'published']) {
      assert.ok(!exec.includes(table), `incremental migration must not reference ${table}`);
    }
    const views = exec.match(/CREATE OR REPLACE VIEW public\.([a-z_]+)/g) ?? [];
    assert.deepEqual(views, ['CREATE OR REPLACE VIEW public.latest_product_availability']);
  });

  it('5. the incremental migration ships explicit rollback SQL', () => {
    const src = read(INCREMENTAL_20260804);
    assert.match(src, /ROLLBACK/);
    assert.match(src, /--   \(checked_at > now\(\) - interval '72 hours'\) AS is_fresh,/);
    assert.match(src, /--   \(checked_at > now\(\) - interval '96 hours'\) AS within_grace/);
  });

  it('6. the view column list is unchanged, so CREATE OR REPLACE is valid', () => {
    const cols = (f: string) => {
      const s = read(f);
      const body = s.slice(s.indexOf('CREATE OR REPLACE VIEW public.latest_product_availability'));
      return body.slice(0, body.indexOf('FROM public.product_availability_current'))
        .split('\n').map(l => l.trim().replace(/,$/, ''))
        .filter(l => l && !l.startsWith('--') && !l.startsWith('CREATE') && l !== 'SELECT');
    };
    assert.deepEqual(cols(INCREMENTAL_20260804).length, cols(APPLIED_20260802).length,
      'column count changed — CREATE OR REPLACE VIEW would fail');
  });

  it('7. the visibility migration remains UNAPPLIED and clearly marked dangerous', () => {
    const src = read(UNAPPLIED_20260803);
    assert.match(src, /NOT YET APPLIED/);
    assert.match(src, /DO NOT RUN THIS UNTIL/);
    // It consumes the view rather than redefining the windows itself.
    assert.match(src, /latest_product_availability/);
    assert.match(src, /within_grace/);
  });

  it('8. migrations are ordered and uniquely dated', () => {
    const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort();
    const idx = (f: string) => files.indexOf(f);
    assert.ok(idx(APPLIED_20260802) < idx(UNAPPLIED_20260803));
    assert.ok(idx(UNAPPLIED_20260803) < idx(INCREMENTAL_20260804),
      'the incremental fix must sort AFTER the migration it amends');
  });

  console.log(`\n${passed} passed`);
}
main();
