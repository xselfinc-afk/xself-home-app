/**
 * Non-disruptive auth-poller tests (pure; injected fakes — no Playwright, no real timers).
 * Proves the poller detects context-wide (OCSESSID) authentication via a SEPARATE background
 * checker page and NEVER navigates/reloads/closes the human's visible login/CAPTCHA/MFA tab.
 * Run: npx tsx src/__tests__/supplierAuthPoll.test.ts
 */
import assert from 'node:assert/strict';
import {
  pollForAuthentication, deriveSignals, buildEvidence, LOGIN_POLL_INTERVAL_MS,
  type CheckerObservation, type CheckerPage, type AuthPollDeps, type AuthPollInstrument,
} from '../../scripts/lib/supplierSession/authPoll';

let passed = 0;
function it(name: string, fn: () => Promise<void>): Promise<void> { return fn().then(() => { passed++; console.log(`  ✓ ${name}`); }); }

const LANDING = 'https://www.gigab2b.com/index.php?route=account/account';
const AUTHED_TEXT = 'Welcome — My Account. Log Out. Buyer ID 76938981 dashboard';
const OTHER_AUTHED_TEXT = 'Welcome — My Account. Log Out. Buyer 82482447 dashboard';
const LOGIN_TEXT = 'Please log in with your password to continue';
const CAPTCHA_TEXT = 'Please complete the captcha slider challenge to continue';
const MFA_TEXT = 'Enter the verification code we sent via SMS code';

function obs(text: string, extra: Partial<CheckerObservation> = {}): CheckerObservation {
  return { networkError: false, httpStatus: 200, url: LANDING, text, ...extra };
}

interface Harness {
  deps: AuthPollDeps;
  visible: { navigations: number; closes: number };   // MUST stay 0
  checker: { opens: number; reads: number; closes: number };
}

/** Build a poller harness. `script` is the sequence of checker observations (last repeats). */
function makeHarness(script: CheckerObservation[], opts: { timeoutMs?: number; pollMs?: number; role?: 'pickup' | 'dropship' } = {}): Harness {
  const visible = { navigations: 0, closes: 0 };
  const checker = { opens: 0, reads: 0, closes: 0 };

  // Stand-in for the human's visible login tab. The poller holds NO reference to it; these
  // spies exist only to prove — by staying at 0 — that the poller never touches the login tab.
  const visibleLoginTab = {
    goto: async () => { visible.navigations++; },
    reload: async () => { visible.navigations++; },
    close: async () => { visible.closes++; },
  };
  void visibleLoginTab;

  let readIdx = 0;
  const openChecker = async (): Promise<CheckerPage> => {
    checker.opens++;
    return {
      gotoAndRead: async (url: string): Promise<CheckerObservation> => {
        assert.equal(url, LANDING);                 // checker only ever visits the harmless landing URL
        const o = script[Math.min(readIdx, script.length - 1)];
        readIdx++; checker.reads++;
        return o;
      },
      close: async () => { checker.closes++; },
    };
  };

  const pollMs = opts.pollMs ?? 10;
  let clock = 0;                                     // virtual clock — sleep advances it, now reads it
  const deps: AuthPollDeps = {
    landingUrl: LANDING,
    expectedBuyerId: '76938981',
    otherBuyerId: '82482447',
    role: opts.role ?? 'pickup',
    timeoutMs: opts.timeoutMs ?? 100,
    pollMs,
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    openChecker,
  };
  return { deps, visible, checker };
}

async function main() {
  await it('visible login tab is never navigated, reloaded, or closed by the poller', async () => {
    const h = makeHarness([obs(LOGIN_TEXT), obs(AUTHED_TEXT)]);
    const r = await pollForAuthentication(h.deps);
    assert.equal(r.authed, true);
    assert.equal(h.visible.navigations, 0);          // login tab untouched
    assert.equal(h.visible.closes, 0);
    assert.ok(h.checker.reads >= 1);                 // detection happened on the checker
  });

  await it('checker page detects context-wide session authentication (OCSESSID) and reads the buyer id', async () => {
    const h = makeHarness([obs(LOGIN_TEXT), obs(LOGIN_TEXT), obs(AUTHED_TEXT)]);
    const r = await pollForAuthentication(h.deps);
    assert.equal(r.authed, true);
    assert.equal(r.health, 'healthy');
    assert.equal(r.evidence.accountId, '76938981');
    assert.equal(r.evidence.role, 'pickup');
    assert.equal(h.checker.reads, 3);                // polled through two login states, then authed
  });

  await it('checker page is always cleaned up (closed exactly once, reused not reopened) on success AND timeout', async () => {
    const ok = makeHarness([obs(AUTHED_TEXT)]);
    await pollForAuthentication(ok.deps);
    assert.equal(ok.checker.opens, 1);               // single reused checker page
    assert.equal(ok.checker.closes, 1);

    const to = makeHarness([obs(LOGIN_TEXT)], { timeoutMs: 30, pollMs: 10 });
    const r = await pollForAuthentication(to.deps);
    assert.equal(r.authed, false);
    assert.equal(to.checker.opens, 1);
    assert.equal(to.checker.closes, 1);
  });

  await it('times out after the deadline and returns the last non-healthy health (never healthy)', async () => {
    const h = makeHarness([obs(LOGIN_TEXT)], { timeoutMs: 50, pollMs: 10 });
    const r = await pollForAuthentication(h.deps);
    assert.equal(r.authed, false);
    assert.equal(r.health, 'authentication_required');
    assert.deepEqual(r.evidence, {});
    assert.ok(h.checker.reads >= 2);                 // polled repeatedly before giving up
  });

  await it('CAPTCHA on the login tab: checker sees captcha_required, keeps waiting, visible tab untouched', async () => {
    const h = makeHarness([obs(CAPTCHA_TEXT), obs(CAPTCHA_TEXT), obs(AUTHED_TEXT)]);
    const r = await pollForAuthentication(h.deps);
    assert.equal(r.authed, true);                    // authed once the human clears the captcha
    assert.equal(h.visible.navigations, 0);          // CAPTCHA tab never touched (no reload wiping progress)
    assert.equal(h.visible.closes, 0);
  });

  await it('MFA on the login tab: checker sees mfa_required, keeps waiting, visible tab untouched', async () => {
    const h = makeHarness([obs(MFA_TEXT)], { timeoutMs: 30, pollMs: 10 });
    const r = await pollForAuthentication(h.deps);
    assert.equal(r.authed, false);
    assert.equal(r.health, 'mfa_required');
    assert.equal(h.visible.navigations, 0);
    assert.equal(h.visible.closes, 0);
  });

  await it('wrong account visible: evidence carries the OTHER buyer id (drives account_mismatch downstream)', async () => {
    const h = makeHarness([obs(OTHER_AUTHED_TEXT)]);
    const r = await pollForAuthentication(h.deps);
    assert.equal(r.authed, true);
    assert.equal(r.evidence.accountId, '82482447');  // NOT the expected pickup id → mismatch guard later
  });

  await it('deriveSignals classifies login / captcha / mfa / authed observations correctly', async () => {
    assert.equal(deriveSignals(obs(LOGIN_TEXT)).isLoginPage, true);
    assert.equal(deriveSignals(obs(CAPTCHA_TEXT)).isCaptcha, true);
    assert.equal(deriveSignals(obs(MFA_TEXT)).isMfa, true);
    assert.equal(deriveSignals(obs(AUTHED_TEXT)).authenticatedMarkersPresent, true);
    assert.equal(deriveSignals(obs('', { networkError: true })).networkError, true);
  });

  await it('buildEvidence prefers the expected buyer id and never returns a secret', async () => {
    const e = buildEvidence(AUTHED_TEXT, { expectedBuyerId: '76938981', otherBuyerId: '82482447', role: 'pickup' });
    assert.equal(e.accountId, '76938981');
    assert.equal(e.role, 'pickup');
    const none = buildEvidence('no ids here', { expectedBuyerId: '76938981', otherBuyerId: '82482447', role: 'pickup' });
    assert.equal(none.accountId, null);
  });

  // ── HARD non-disruption proofs: a fake login tab whose navigation / focus / form state is
  //    fully observable. The poller must leave ALL of it untouched while polling the checker. ──
  const LOGIN_URL = 'https://www.gigab2b.com/index.php?route=account/login';

  interface FakeLoginTab {
    url: string; navigations: number; closed: boolean; focused: boolean;
    fields: { username: string; password: string };
  }

  function makeFocusHarness(script: CheckerObservation[], opts: { timeoutMs?: number; pollMs?: number } = {}) {
    // The human's visible login tab: credentials typed in, tab focused, sitting on the login URL.
    const login: FakeLoginTab = {
      url: LOGIN_URL, navigations: 0, closed: false, focused: true,
      fields: { username: 'pickup-buyer@example.com', password: 'typed-by-human-do-not-touch' },
    };
    const checker = { opens: 0, closes: 0, reads: 0, url: 'about:blank', focused: false };
    const instrument: AuthPollInstrument[] = [];

    let readIdx = 0;
    const openChecker = async (): Promise<CheckerPage> => {
      checker.opens++;
      // Model Chromium stealing foreground focus to the newly-created tab.
      login.focused = false; checker.focused = true;
      return {
        gotoAndRead: async (url: string): Promise<CheckerObservation> => {
          // Navigating the CHECKER changes only the checker's URL — the login tab is not involved.
          checker.url = url; checker.reads++;
          const o = script[Math.min(readIdx, script.length - 1)]; readIdx++;
          return o;
        },
        close: async () => { checker.closes++; },
      };
    };

    const pollMs = opts.pollMs ?? LOGIN_POLL_INTERVAL_MS;
    let clock = 0;
    const deps: AuthPollDeps = {
      landingUrl: LANDING, expectedBuyerId: '76938981', otherBuyerId: '82482447', role: 'pickup',
      timeoutMs: opts.timeoutMs ?? 60_000, pollMs,
      now: () => clock, sleep: async (ms: number) => { clock += ms; },
      openChecker,
      visibleUrl: async () => login.url,                                   // READ ONLY — poller never writes it
      keepVisibleInFront: async () => { login.focused = true; checker.focused = false; }, // bringToFront model
      onInstrument: (e) => instrument.push(e),
    };
    return { deps, login, checker, instrument };
  }

  await it('HARD: visible login tab is never navigated, reloaded, closed, or emptied while polling', async () => {
    const h = makeFocusHarness([obs(LOGIN_TEXT), obs(LOGIN_TEXT), obs(AUTHED_TEXT)]);
    const r = await pollForAuthentication(h.deps);
    assert.equal(r.authed, true);
    assert.equal(h.login.navigations, 0);                    // never navigated/reloaded
    assert.equal(h.login.url, LOGIN_URL);                    // URL unchanged across every poll
    assert.equal(h.login.closed, false);                     // never closed
    assert.equal(h.login.fields.username, 'pickup-buyer@example.com'); // form fields retained…
    assert.equal(h.login.fields.password, 'typed-by-human-do-not-touch'); // …exactly
    assert.equal(h.checker.opens, 1);                        // one checker page, reused (not one-per-poll)
    assert.ok(h.checker.reads >= 3);
  });

  await it('HARD: checker never keeps focus — login tab is returned to the front after every poll', async () => {
    const h = makeFocusHarness([obs(LOGIN_TEXT), obs(CAPTCHA_TEXT), obs(LOGIN_TEXT)], { timeoutMs: 20_000 });
    await pollForAuthentication(h.deps);
    assert.equal(h.login.focused, true);                     // focus restored to the login tab
    assert.equal(h.checker.focused, false);                  // checker does not hold focus
    assert.equal(h.login.closed, false);
  });

  await it('HARD: poll interval is ≥5s and instrumentation shows a stable visible URL (before === after)', async () => {
    assert.ok(LOGIN_POLL_INTERVAL_MS >= 5000, 'poll interval must be at least 5 seconds');
    const h = makeFocusHarness([obs(LOGIN_TEXT), obs(LOGIN_TEXT), obs(AUTHED_TEXT)]);
    await pollForAuthentication(h.deps);
    assert.ok(h.instrument.length >= 2);
    for (const e of h.instrument) {
      assert.equal(e.visibleUrlBefore, LOGIN_URL);           // poller did not move the visible tab…
      assert.equal(e.visibleUrlAfter, LOGIN_URL);            // …before or after the checker poll
      assert.equal(typeof e.attempt, 'number');
      assert.equal(typeof e.authed, 'boolean');
    }
    // last poll authed; earlier polls not — the instrument is monotonic in attempt number
    assert.equal(h.instrument[h.instrument.length - 1].authed, true);
    assert.equal(h.instrument[0].attempt, 1);
  });

  await it('HARD: instrumentation carries only URLs — no cookie/token/credential material', async () => {
    const h = makeFocusHarness([obs(AUTHED_TEXT)]);
    await pollForAuthentication(h.deps);
    const dump = JSON.stringify(h.instrument);
    assert.equal(dump.includes('typed-by-human-do-not-touch'), false); // password never in instrumentation
    assert.equal(/cookie|token|password|ocsessid/i.test(dump), false);
  });

  console.log(`\n${passed} passed`);
}
main();
