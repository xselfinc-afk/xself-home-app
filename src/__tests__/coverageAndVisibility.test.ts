/**
 * Coverage gate + visibility enforcement tests (pure/static; no database, no network).
 *
 * The catastrophe this prevents: enabling the visibility rule before evidence exists would take the
 * storefront from 353 products to ~23. The gate must make that impossible by accident, in the
 * migration itself — not merely by convention in a runbook.
 *
 * Run: npx tsx src/__tests__/coverageAndVisibility.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_MIN_COVERAGE_PERCENT,
  evaluateCoverage,
  readyForVisibilityEnforcement,
} from '../services/coverageGate';
import { INVENTORY_AUTOMATION_DEFAULTS } from '../services/inventoryAutomationConfig';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const V2 = 'supabase/migrations/20260807_sellable_requires_fresh_availability_v2.sql';
const V1 = 'supabase/migrations/20260803_sellable_requires_fresh_availability.sql';

const T = (h: number) => new Date(Date.UTC(2026, 7, 2, 0, 0, 0) + h * 3_600_000).toISOString();
const NOW = T(0);
const skus = (n: number, p = 'S') => Array.from({ length: n }, (_, i) => `${p}${i}`);
const fresh = (list: string[], hoursAgo = 1) => list.map(s => ({ sku: s, checkedAt: T(-hoursAgo) }));

function main(): void {
  it('1. the default coverage requirement is 95%', () => {
    assert.equal(DEFAULT_MIN_COVERAGE_PERCENT, 95);
    assert.equal(INVENTORY_AUTOMATION_DEFAULTS.minCoveragePercent, 95);
    assert.equal(INVENTORY_AUTOMATION_DEFAULTS.visibilityEnforcementEnabled, false);
  });

  it('2. TODAY\'S REAL STATE (26 of 353) is blocked', () => {
    const published = skus(353);
    const r = evaluateCoverage({ publishedSkus: published, evidence: fresh(published.slice(0, 26)), nowIso: NOW });
    assert.equal(r.coveredCount, 26);
    assert.equal(r.coveragePercent, 7.37);
    assert.equal(r.ready, false);
    assert.ok(r.blocks.includes('insufficient_coverage'));
    assert.equal(r.uncoveredSkus.length, 327);
  });

  it('3. full coverage with a healthy failure rate is ready', () => {
    const published = skus(353);
    const r = evaluateCoverage({ publishedSkus: published, evidence: fresh(published), nowIso: NOW, lastRunFailurePercent: 0.85 });
    assert.equal(r.coveragePercent, 100);
    assert.equal(r.ready, true);
    assert.deepEqual(r.blocks, []);
  });

  it('4. high coverage with a high failure rate is NOT ready', () => {
    const published = skus(100);
    const r = evaluateCoverage({ publishedSkus: published, evidence: fresh(published), nowIso: NOW, lastRunFailurePercent: 25 });
    assert.equal(r.coveragePercent, 100);
    assert.equal(r.ready, false);
    assert.ok(r.blocks.includes('excessive_failure_rate'));
  });

  it('5. stale evidence does not count toward coverage', () => {
    const published = skus(10);
    const r = evaluateCoverage({ publishedSkus: published, evidence: fresh(published, 100), nowIso: NOW });
    assert.equal(r.coveredCount, 0);
    assert.equal(r.staleCount, 10);
    assert.ok(r.blocks.includes('no_evidence'));
  });

  it('6. unparseable timestamps never inflate coverage', () => {
    const r = evaluateCoverage({ publishedSkus: ['A'], evidence: [{ sku: 'A', checkedAt: 'garbage' }], nowIso: NOW });
    assert.equal(r.coveredCount, 0);
    assert.equal(r.staleCount, 1);
  });

  it('7. evidence for unpublished SKUs does not inflate coverage', () => {
    const r = evaluateCoverage({ publishedSkus: ['A', 'B'], evidence: fresh(['A', 'X', 'Y', 'Z']), nowIso: NOW });
    assert.equal(r.coveredCount, 1);
    assert.equal(r.coveragePercent, 50);
  });

  it('8. enforcement is refused when it would remove more than the coverage gap explains', () => {
    const published = skus(100);
    const report = evaluateCoverage({ publishedSkus: published, evidence: fresh(published), nowIso: NOW, lastRunFailurePercent: 0 });
    // 60 removals with NO confirmed-unavailable answers to explain them → unsafe.
    const bad = readyForVisibilityEnforcement(report, 100, 40, 0);
    assert.equal(bad.ready, false);
    assert.ok(bad.blocks.includes('unexplained_removals_exceed_coverage_gap'));
    assert.equal(bad.wouldRemove, 60);
    assert.equal(bad.unexplainedRemovals, 60);
    // The SAME 60 removals are fine when the supplier confirmed all 60 unavailable — that is the
    // feature working. An earlier guard blocked this, which would have made enforcement
    // impossible whenever more than ~6% of the catalogue was genuinely out of stock.
    const good = readyForVisibilityEnforcement(report, 100, 40, 60);
    assert.equal(good.ready, true);
    assert.equal(good.explainedByUnavailable, 60);
    assert.equal(good.unexplainedRemovals, 0);
    // Partially explained: 40 confirmed unavailable, 20 unexplained → still unsafe.
    assert.equal(readyForVisibilityEnforcement(report, 100, 40, 40).ready, false);
    // A small, explainable reduction is fine.
    assert.equal(readyForVisibilityEnforcement(report, 100, 98, 2).ready, true);
  });

  it('9. an empty catalogue is never "ready"', () => {
    const r = evaluateCoverage({ publishedSkus: [], evidence: [], nowIso: NOW });
    assert.equal(r.ready, false);
    assert.ok(r.blocks.includes('no_published_products'));
  });

  // ── The migration must enforce the gate itself ──────────────────────────────

  it('10. v2 refuses to apply below the coverage threshold', () => {
    const src = read(V2);
    assert.match(src, /RAISE EXCEPTION/);
    assert.match(src, /Visibility enforcement refused/);
    assert.match(src, /v_min\s+numeric\s*:=\s*95/);
    // The guard must run BEFORE the view is replaced.
    assert.ok(src.indexOf('RAISE EXCEPTION') < src.indexOf('CREATE OR REPLACE VIEW public.sellable_products'),
      'the coverage guard must precede the view replacement');
  });

  it('11. v2 requires available AND within_grace', () => {
    const src = read(V2);
    assert.match(src, /AND la\.available IS TRUE/);
    assert.match(src, /AND la\.within_grace IS TRUE/);
    // Every pre-existing quality gate survives.
    for (const gate of ['normalization_status', 'published = true', 'inventory_status', 'total_available_qty',
                        'product_title', 'primary_image', 'price > 0', 'selling_price']) {
      assert.ok(src.includes(gate), `v2 dropped an existing gate: ${gate}`);
    }
  });

  it('12. v2 ships rollback restoring the pre-enforcement view', () => {
    const src = read(V2);
    assert.match(src, /ROLLBACK/);
    assert.match(src, /-- CREATE OR REPLACE VIEW public\.sellable_products AS/);
  });

  it('13. the superseded v1 migration now refuses to run', () => {
    const src = read(V1);
    assert.match(src, /SUPERSEDED/);
    assert.match(src, /RAISE EXCEPTION/);
    assert.ok(src.indexOf('RAISE EXCEPTION') < src.indexOf('CREATE OR REPLACE VIEW public.sellable_products'),
      'the superseded guard must fire before the view is touched');
  });

  it('14. failures can never hide a product — the view reads only confirmed answers', () => {
    const persistence = read('supabase/migrations/20260802_open_api_availability.sql');
    // latest_product_availability is built from product_availability_current, whose CHECK constraint
    // admits only the two confirmed statuses. A failure therefore cannot appear in the view at all.
    assert.match(persistence, /pav_confirmed_only_chk CHECK \(status IN \('confirmed_available', 'confirmed_out_of_stock'\)\)/);
    assert.match(persistence, /FROM public\.product_availability_current/);
  });

  console.log(`\n${passed} passed`);
}
main();
