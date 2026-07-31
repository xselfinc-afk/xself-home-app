/**
 * Stage 1A candidate-scorer tests (pure; no I/O). Enforces the Bible laws the scorer must uphold:
 * hard safeguards block favoriting; a confirmed negative → ignore; missing/fixable evidence →
 * request_more_evidence; UNKNOWN is never converted into a rejection; scoring is deterministic and
 * config-driven.
 * Run: npx tsx src/__tests__/stage1CandidateScore.test.ts
 */
import assert from 'node:assert/strict';
import {
  scoreCandidate, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS,
  type CandidateFeatures,
} from '../services/stage1CandidateScore';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

/** A fresh, non-duplicate, newly-saved candidate with commercial data still UNKNOWN (the common case). */
function freshCandidate(over: Partial<CandidateFeatures> = {}): CandidateFeatures {
  return {
    supplierProductId: 'W1445P360668', identityResolved: true, duplicate: false,
    isNewlySaved: true, daysSinceSaved: 1, priority: 'unknown', hasShipping: null,
    marginState: 'unknown', costKnown: false, complete: null, usableImages: null,
    differentiated: null, fulfillmentPossible: null, slotCost: 1, ...over,
  };
}

function main() {
  it('deterministic: same input → identical output', () => {
    const f = freshCandidate();
    assert.deepEqual(scoreCandidate(f), scoreCandidate(f));
  });

  // ── UNKNOWN IS NOT ZERO ──
  it('fresh candidate with all commercial data UNKNOWN is NEVER ignored for being unknown', () => {
    const r = scoreCandidate(freshCandidate());
    assert.notEqual(r.verdict, 'ignore');
    assert.equal(r.blocked, false);
    assert.ok(r.missingEvidence.includes('inventory_unverified'));
    assert.ok(r.missingEvidence.includes('cost_or_margin_unknown'));
    // newly-saved + recent → at least a candidate
    assert.ok(['candidate', 'favorite_immediately'].includes(r.verdict), r.verdict);
  });

  // ── CONFIRMED-NEGATIVE BLOCKS → ignore ──
  it('duplicate (already imported) → blocked → ignore', () => {
    const r = scoreCandidate(freshCandidate({ duplicate: true }));
    assert.equal(r.blocked, true);
    assert.equal(r.verdict, 'ignore');
    assert.ok(r.blockReasons.includes('already_imported_duplicate'));
  });

  it('P4 confirmed unavailable → blocked → ignore (never favorited)', () => {
    const r = scoreCandidate(freshCandidate({ priority: 'P4' }));
    assert.equal(r.verdict, 'ignore');
    assert.ok(r.blockReasons.includes('confirmed_unavailable'));
  });

  it('KNOWN low/negative margin → ignore; UNKNOWN margin → not a block', () => {
    assert.equal(scoreCandidate(freshCandidate({ costKnown: true, marginState: 'low' })).verdict, 'ignore');
    assert.equal(scoreCandidate(freshCandidate({ costKnown: true, marginState: 'negative' })).verdict, 'ignore');
    assert.equal(scoreCandidate(freshCandidate({ costKnown: false, marginState: 'unknown' })).blocked, false);
  });

  it('confirmed fulfillment impossible → ignore', () => {
    assert.equal(scoreCandidate(freshCandidate({ fulfillmentPossible: false })).verdict, 'ignore');
  });

  // ── MISSING / FIXABLE EVIDENCE → request_more_evidence ──
  it('unresolved identity → request_more_evidence (fixable, not a rejection)', () => {
    const r = scoreCandidate(freshCandidate({ supplierProductId: '', identityResolved: false }));
    assert.equal(r.verdict, 'request_more_evidence');
    assert.ok(r.blockReasons.includes('unresolved_identity'));
  });

  it('confirmed-bad media / incompleteness → request_more_evidence (fixable), not ignore', () => {
    assert.equal(scoreCandidate(freshCandidate({ usableImages: false })).verdict, 'request_more_evidence');
    assert.equal(scoreCandidate(freshCandidate({ complete: false })).verdict, 'request_more_evidence');
  });

  it('confirmed-negative takes precedence over fixable-missing', () => {
    const r = scoreCandidate(freshCandidate({ duplicate: true, usableImages: false }));
    assert.equal(r.verdict, 'ignore');
  });

  // ── POSITIVE PATH ──
  it('P1 (verified CA) + newly-saved + complete + images + differentiated → favorite_immediately', () => {
    const r = scoreCandidate(freshCandidate({ priority: 'P1', costKnown: true, marginState: 'acceptable', complete: true, usableImages: true, differentiated: true, hasShipping: true }));
    assert.equal(r.verdict, 'favorite_immediately');
    assert.ok(r.reasons.includes('verified_california'));
    assert.equal(r.blocked, false);
  });

  it('favorite_immediately requires a strong signal (score alone with no P1/P2/differentiation is capped at candidate)', () => {
    // high newness weight but no strong signal → not favorite_immediately
    const r = scoreCandidate(freshCandidate({ isNewlySaved: true, daysSinceSaved: 1, differentiated: null }), { ...DEFAULT_WEIGHTS, newlySaved: 100 });
    assert.notEqual(r.verdict, 'favorite_immediately');
  });

  it('dual-slot cost lowers the score (scarcity penalty applied)', () => {
    const base = scoreCandidate(freshCandidate({ priority: 'P1' }));
    const dual = scoreCandidate(freshCandidate({ priority: 'P1', slotCost: 2 }));
    assert.ok(dual.score < base.score);
    assert.ok(dual.reasons.includes('dual_slot_cost'));
  });

  it('low overall signal → waitlist or ignore, but never negative for unknowns alone', () => {
    const r = scoreCandidate(freshCandidate({ isNewlySaved: false, daysSinceSaved: null }));
    assert.ok(['waitlist', 'ignore', 'candidate'].includes(r.verdict));
    assert.equal(r.blocked, false);
  });

  // ── CONFIG-DRIVEN ──
  it('thresholds/weights are configurable (not hardcoded verdicts)', () => {
    const f = freshCandidate({ priority: 'P1', complete: true, usableImages: true, differentiated: true, costKnown: true, marginState: 'acceptable' });
    const strict = scoreCandidate(f, DEFAULT_WEIGHTS, { ...DEFAULT_THRESHOLDS, favoriteImmediately: 9999 });
    assert.notEqual(strict.verdict, 'favorite_immediately'); // same input, stricter threshold → different verdict
  });

  it('every result carries an explanation surface (reasons or blockReasons + missingEvidence array)', () => {
    for (const f of [freshCandidate(), freshCandidate({ duplicate: true }), freshCandidate({ priority: 'P1', complete: true })]) {
      const r = scoreCandidate(f);
      assert.ok(Array.isArray(r.reasons) && Array.isArray(r.missingEvidence) && Array.isArray(r.blockReasons));
      assert.ok(r.reasons.length + r.blockReasons.length > 0 || r.missingEvidence.length > 0);
    }
  });

  console.log(`\n${passed} passed`);
}
main();
