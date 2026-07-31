/**
 * Saved Asset control-model tests (pure + static; no database, no supplier, no I/O).
 *
 * Covers the 16 required cases from the schema sprint. Behavioural rules are tested against the
 * pure decision layer; database-enforced guarantees (unique identity, CHECK constraints, RLS,
 * view scope) are asserted statically against the migration SQL, since they cannot be exercised
 * without applying DDL — which is deliberately not done here.
 *
 * Run: npx tsx src/__tests__/savedAssetVerification.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  planVerification,
  classifyMembershipFact,
  canMarkRemovalDone,
  isTransitionAllowed,
  blockedStatusFor,
  ALL_SAVED_ASSET_STATES,
  XONE_ALLOWED_TRANSITION,
  type SavedAssetRow,
  type MembershipFact,
  type SyncStatus,
} from '../services/savedAssetVerification';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const ROOT = path.resolve(__dirname, '../..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260801_saved_asset_control_model.sql'), 'utf8');

const NOW = '2026-08-01T12:00:00.000Z';
const MARKED = '2026-08-01T10:00:00.000Z';
const AFTER = '2026-08-01T11:00:00.000Z';
const BEFORE = '2026-08-01T09:00:00.000Z';

function asset(over: Partial<SavedAssetRow> = {}): SavedAssetRow {
  return {
    id: 'a1', supplier_product_id: 'W123', supplier_account: 'pickup',
    asset_state: 'AWAITING_REMOVAL_VERIFICATION', founder_marked_done_at: MARKED,
    verification_attempts: 0, version: 3, ...over,
  };
}
function fact(over: Partial<MembershipFact> = {}): MembershipFact {
  return {
    supplier_product_id: 'W123', supplier_account: 'pickup',
    is_saved: false, sync_status: 'ok', observed_at: AFTER, ...over,
  };
}

function main() {
  // ── 1. unique SKU × account identity (DB-enforced) ────────────────────────
  it('1. identity is UNIQUE (supplier_product_id, supplier_account) on both layers', () => {
    assert.match(SQL, /CONSTRAINT sfm_identity_uniq UNIQUE \(supplier_product_id, supplier_account\)/);
    assert.match(SQL, /CONSTRAINT sa_identity_uniq UNIQUE \(supplier_product_id, supplier_account\)/);
  });

  // ── 2. pickup and dropship independent ────────────────────────────────────
  it('2. pickup and dropship are independent rows; account is CHECK-constrained', () => {
    assert.match(SQL, /CONSTRAINT sfm_account_chk CHECK \(supplier_account IN \('pickup','dropship'\)\)/);
    assert.match(SQL, /CONSTRAINT sa_account_chk CHECK \(supplier_account IN \('pickup','dropship'\)\)/);
    // The pure layer keys verification on the asset row it was handed — never a sibling.
    const p = planVerification({ asset: asset({ supplier_account: 'pickup' }), fact: fact({ supplier_account: 'pickup' }), nowIso: NOW });
    assert.equal(p.nextState, 'REMOVED');
    const d = planVerification({ asset: asset({ supplier_account: 'dropship', asset_state: 'ACTIVE_ASSET' }), fact: fact(), nowIso: NOW });
    assert.equal(d.needsWrite, false, 'a sibling-account asset in another state is untouched');
  });

  // ── 3. failed supplier sync requires is_saved NULL ────────────────────────
  it('3. a failed sync must leave is_saved NULL — enforced by CHECK and by the classifier', () => {
    assert.match(SQL, /CONSTRAINT sfm_failure_implies_unknown_chk CHECK \(sync_status = 'ok' OR is_saved IS NULL\)/);
    // Even if a bad writer smuggled is_saved=false past the app layer, a non-ok sync proves nothing.
    assert.equal(classifyMembershipFact(fact({ sync_status: 'auth_failed', is_saved: false })), 'unknown');
    assert.equal(classifyMembershipFact(fact({ is_saved: null })), 'unknown');
  });

  // ── 4. REMOVABLE cannot transition directly to REMOVED ────────────────────
  it('4. the direct REMOVABLE → REMOVED edge is impossible (pure + DB CHECK)', () => {
    assert.equal(isTransitionAllowed('REMOVABLE', 'REMOVED'), false);
    assert.match(SQL, /sat_no_direct_removable_to_removed_chk CHECK \(\s*NOT \(from_state = 'REMOVABLE' AND to_state = 'REMOVED'\)/);
    assert.match(SQL, /sat_removed_source_chk CHECK \(\s*to_state <> 'REMOVED' OR from_state = 'AWAITING_REMOVAL_VERIFICATION'/);
    // A REMOVABLE asset is never verified into REMOVED either.
    const p = planVerification({ asset: asset({ asset_state: 'REMOVABLE' }), fact: fact(), nowIso: NOW });
    assert.equal(p.nextState, 'REMOVABLE');
    assert.equal(p.needsWrite, false);
  });

  // ── 5. narrow RPC allows only REMOVABLE → AWAITING_REMOVAL_VERIFICATION ───
  it('5. the narrow action permits exactly one transition', () => {
    assert.deepEqual(XONE_ALLOWED_TRANSITION, { from: 'REMOVABLE', to: 'AWAITING_REMOVAL_VERIFICATION' });
    const ok = canMarkRemovalDone({ currentState: 'REMOVABLE', currentVersion: 3, expectedVersion: 3, idempotencyKey: 'k1', lastIdempotencyKey: null });
    assert.equal(ok.ok, true);
    for (const s of ALL_SAVED_ASSET_STATES.filter(x => x !== 'REMOVABLE')) {
      const r = canMarkRemovalDone({ currentState: s, currentVersion: 3, expectedVersion: 3, idempotencyKey: 'k1', lastIdempotencyKey: null });
      assert.equal(r.ok, false, `must refuse from ${s}`);
    }
    // SQL refuses anything that is not REMOVABLE, and hardcodes the target state.
    assert.match(SQL, /IF v_row\.asset_state <> 'REMOVABLE' THEN/);
    assert.match(SQL, /asset_state\s*=\s*'AWAITING_REMOVAL_VERIFICATION'/);
  });

  // ── 6. stale expected_version rejected ────────────────────────────────────
  it('6. a stale expected_version is rejected with no write', () => {
    const r = canMarkRemovalDone({ currentState: 'REMOVABLE', currentVersion: 7, expectedVersion: 3, idempotencyKey: 'k1', lastIdempotencyKey: null });
    assert.equal(r.ok, false);
    assert.match(r.reason, /version_conflict/);
    assert.match(SQL, /IF v_row\.version <> p_expected_version THEN/);
    assert.match(SQL, /AND version = p_expected_version/, 'the UPDATE itself is version-guarded');
  });

  // ── 7. repeated same idempotency key → no-op success ──────────────────────
  it('7. replaying the same idempotency key is a success no-op', () => {
    const r = canMarkRemovalDone({
      currentState: 'AWAITING_REMOVAL_VERIFICATION', currentVersion: 4, expectedVersion: 3,
      idempotencyKey: 'k1', lastIdempotencyKey: 'k1',
    });
    assert.equal(r.ok, true);
    assert.equal(r.idempotentReplay, true, 'even with a now-stale version, the replay is a no-op success');
    assert.match(SQL, /idempotent_replay', true/);
  });

  // ── 8. different key after the transition → rejected ──────────────────────
  it('8. a different key on an already-acknowledged row is refused', () => {
    const r = canMarkRemovalDone({
      currentState: 'AWAITING_REMOVAL_VERIFICATION', currentVersion: 4, expectedVersion: 4,
      idempotencyKey: 'k2', lastIdempotencyKey: 'k1',
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /state_mismatch/);
  });

  // ── 9. is_saved=false + ok → REMOVED ──────────────────────────────────────
  it('9. a successful is_saved=false observation verifies removal', () => {
    const p = planVerification({ asset: asset(), fact: fact(), nowIso: NOW });
    assert.equal(p.nextState, 'REMOVED');
    assert.equal(p.verificationStatus, 'verified_removed');
    assert.equal(p.transitions, true);
    assert.equal(p.removedAt, NOW);
    assert.equal(p.lastSavedVerifiedAt, AFTER, 'records the verifying observation');
  });

  // ── 10. is_saved=true preserves the waiting state ─────────────────────────
  it('10. is_saved=true keeps the asset waiting and counts a failed attempt', () => {
    const p = planVerification({ asset: asset({ verification_attempts: 2 }), fact: fact({ is_saved: true }), nowIso: NOW });
    assert.equal(p.nextState, 'AWAITING_REMOVAL_VERIFICATION');
    assert.equal(p.verificationStatus, 'still_saved');
    assert.equal(p.attemptsDelta, 1);
    assert.equal(p.transitions, false);
    assert.ok(p.failureReason);
  });

  // ── 11. auth/network/parse failure preserves state ────────────────────────
  it('11. every failure mode preserves state and never infers removal', () => {
    const failures: SyncStatus[] = ['auth_failed', 'captcha_required', 'network_failed', 'parse_failed', 'permission_denied', 'rate_limited', 'supplier_unavailable'];
    for (const s of failures) {
      const p = planVerification({ asset: asset(), fact: fact({ sync_status: s, is_saved: null }), nowIso: NOW });
      assert.equal(p.nextState, 'AWAITING_REMOVAL_VERIFICATION', s);
      assert.equal(p.transitions, false, s);
      assert.equal(p.removedAt, null, s);
      assert.equal(p.attemptsDelta, 0, `${s}: a blocked read is not a failed attempt`);
      assert.match(p.verificationStatus, /^blocked_/, s);
    }
    assert.equal(blockedStatusFor('auth_failed'), 'blocked_by_auth');
    assert.equal(blockedStatusFor('network_failed'), 'blocked_other');
  });

  it('11b. a missing fact, or one predating the acknowledgement, never verifies', () => {
    assert.equal(planVerification({ asset: asset(), fact: null, nowIso: NOW }).needsWrite, false);
    const stale = planVerification({ asset: asset(), fact: fact({ observed_at: BEFORE }), nowIso: NOW });
    assert.equal(stale.nextState, 'AWAITING_REMOVAL_VERIFICATION');
    assert.equal(stale.reason, 'fact_predates_founder_acknowledgement');
  });

  // ── 12. seller-automation cannot write asset_state ────────────────────────
  it('12. seller_automation can never author a transition', () => {
    assert.match(SQL, /sat_seller_automation_never_transitions_chk CHECK \(actor_type <> 'seller_automation'\)/);
    assert.match(SQL, /sat_removed_actor_chk CHECK \(to_state <> 'REMOVED' OR actor_type = 'xself_home'\)/);
    assert.match(SQL, /sat_ack_actor_chk CHECK \(to_state <> 'AWAITING_REMOVAL_VERIFICATION' OR actor_type = 'xone_operator'\)/);
  });

  // ── 13. XOne view excludes non-action states ──────────────────────────────
  it('13. the XOne view exposes only the three action states', () => {
    const where = SQL.split('CREATE OR REPLACE VIEW public.xone_supplier_favorite_actions')[1] ?? '';
    assert.match(where, /WHERE sa\.asset_state IN \('REMOVABLE','AWAITING_REMOVAL_VERIFICATION','REMOVED'\)/);
    for (const s of ['SAVED_CANDIDATE', 'EVALUATING', 'ACTIVE_ASSET', 'HOLD', 'REVIEW_REQUIRED', 'RETIRE_CANDIDATE']) {
      assert.ok(!where.includes(`'${s}'`), `view must not surface ${s}`);
    }
  });

  // ── 14. XOne view exposes no secret / service-only fields ─────────────────
  it('14. the XOne view leaks no cost, margin, credential or raw-payload field', () => {
    const view = (SQL.split('CREATE OR REPLACE VIEW public.xone_supplier_favorite_actions')[1] ?? '').split(';')[0];
    for (const forbidden of ['raw_payload', 'selling_price', 'price', 'cost', 'margin', 'estimated_net', 'client_secret', 'service_role', 'session', 'cookie', 'token', 'sign']) {
      assert.ok(!new RegExp(`\\b${forbidden}`, 'i').test(view), `view must not expose ${forbidden}`);
    }
    // Canonical tables are service-role only.
    assert.match(SQL, /ALTER TABLE public\.saved_assets\s+ENABLE ROW LEVEL SECURITY/);
    assert.match(SQL, /ALTER TABLE public\.supplier_favorite_memberships ENABLE ROW LEVEL SECURITY/);
    assert.match(SQL, /ALTER TABLE public\.saved_asset_transitions\s+ENABLE ROW LEVEL SECURITY/);
    assert.ok(!/CREATE POLICY/.test(SQL), 'no policy => service-role only');
  });

  // ── 15. one account cannot mutate its sibling ─────────────────────────────
  it('15. the narrow action addresses exactly one row by id', () => {
    assert.match(SQL, /WHERE id = p_saved_asset_id/);
    assert.ok(!/UPDATE public\.saved_assets[\s\S]{0,400}WHERE supplier_product_id/.test(SQL),
      'must never update by SKU alone — that could touch the sibling account');
  });

  // ── 16. nothing publication/inventory related is written ──────────────────
  it('16. the migration writes no publication or inventory resource', () => {
    // Comments document the boundary (e.g. "refresh_product_inventory_status() remains the sole
    // publication authority"); only EXECUTABLE SQL may be asserted against.
    const EXEC = SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    for (const forbidden of [
      /UPDATE\s+public\.standardized_products/i,
      /UPDATE\s+public\.supplier_products/i,
      /UPDATE\s+public\.inventory_cache/i,
      /INSERT\s+INTO\s+public\.standardized_products/i,
      /refresh_product_inventory_status\s*\(/i,
      /CREATE\s+TRIGGER/i,
      /CREATE\s+OR\s+REPLACE\s+TRIGGER/i,
    ]) {
      assert.ok(!forbidden.test(EXEC), `executable SQL must not contain ${forbidden}`);
    }
    // Additive only: no ALTER on pre-existing tables (the 3 ALTERs are RLS on the new tables).
    const alters = EXEC.match(/ALTER TABLE public\.(\w+)/g) ?? [];
    const allowed = new Set(['supplier_favorite_memberships', 'saved_assets', 'saved_asset_transitions']);
    for (const a of alters) {
      const t = a.replace('ALTER TABLE public.', '');
      assert.ok(allowed.has(t), `must not ALTER pre-existing table: ${t}`);
    }
  });

  // ── structural guarantees ─────────────────────────────────────────────────
  it('17. all 9 approved states are present in both the type and the CHECK', () => {
    assert.equal(ALL_SAVED_ASSET_STATES.length, 9);
    for (const s of ALL_SAVED_ASSET_STATES) assert.ok(SQL.includes(`'${s}'`), `missing from SQL: ${s}`);
  });

  it('18. REMOVED requires recorded evidence at the database level', () => {
    assert.match(SQL, /sa_removed_requires_evidence_chk[\s\S]{0,220}verification_status = 'verified_removed'/);
  });

  it('19. no backfill, seed, or scheduler is present', () => {
    assert.ok(!/INSERT INTO public\.saved_assets/.test(SQL), 'no seed rows');
    assert.ok(!/cron\.schedule/.test(SQL), 'no scheduler');
  });

  console.log(`\n${passed} passed`);
}
main();
