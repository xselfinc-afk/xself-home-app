/**
 * Persistent supplier-browser session MANAGER (impure; Playwright). Owns a dedicated
 * persistent Chromium profile per source and delegates ALL decisions to the pure, tested
 * core (health / identity / snapshot / lock). It NEVER bypasses CAPTCHA/MFA, NEVER touches
 * the user's normal Chrome profile, NEVER writes inventory_cache / publication state, and
 * NEVER logs cookie/token/storage values (reports use redacted summaries only).
 *
 * Not unit-tested here (requires a real browser + live supplier); correctness lives in the
 * pure core it delegates to. Live validation happens on the user's one-time headed login.
 */
import * as fs from 'fs';
import * as path from 'path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { sourceConfig, type SupplierSource, type SourceConfig } from './lib/supplierSession/sources';
import { classifyPageHealth, type HealthState, type HealthSignals, requiresHumanAction } from './lib/supplierSession/health';
import { type AccountEvidence } from './lib/supplierSession/identity';
import { verifyIdentity } from './lib/supplierSession/identity';
import { promoteSnapshot, redactStorageState, type StorageState, type PromoteResult } from './lib/supplierSession/snapshot';
import { acquireLock, releaseLock } from './lib/supplierSession/lock';
import { writeHealthState } from './lib/supplierSession/scanGate';
import { runLoginAndPromote, type LoginPromoteResult } from './lib/supplierSession/loginPromote';
import { pollForAuthentication, LOGIN_POLL_INTERVAL_MS, type CheckerPage, type CheckerObservation } from './lib/supplierSession/authPoll';

/** Known supplier Buyer IDs (public account numbers, never secrets; used only for identity match). */
const EXPECTED_BUYER_ID: Record<SupplierSource, string> = { pickup: '76938981', dropship: '82482447' };
const OTHER_BUYER_ID: Record<SupplierSource, string> = { pickup: '82482447', dropship: '76938981' };

export interface SessionOpResult {
  source: SupplierSource;
  health: HealthState;
  identityVerified: boolean;
  safeId: string | null;
  snapshotRefreshed: boolean;
  previousBackedUp: boolean;
  probeClassification: string | null;
  humanActionRequired: boolean;
  failureCategory: string | null;
  profileInitialized: boolean;
  redactedSnapshot?: ReturnType<typeof redactStorageState>;
}

function ensureProfileDir(cfg: SourceConfig): boolean {
  const created = !fs.existsSync(cfg.profileDir);
  fs.mkdirSync(cfg.profileDir, { recursive: true });
  return created;
}

async function launch(cfg: SourceConfig): Promise<BrowserContext> {
  // Headed: GIGA blocks headless. Dedicated user-data dir — NOT the user's Chrome profile.
  return chromium.launchPersistentContext(cfg.profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
}

/** Observe landing-page health + best-effort identity evidence. Raw identifiers are hashed
 *  by verifyIdentity and NEVER logged; only the safe hash leaves this function. */
async function observe(context: BrowserContext, cfg: SourceConfig): Promise<{ signals: HealthSignals; evidence: AccountEvidence }> {
  const page = await context.newPage();
  let httpStatus: number | null = null;
  let networkError = false;
  try {
    const resp = await page.goto(cfg.landingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    httpStatus = resp?.status() ?? null;
  } catch { networkError = true; }
  const url = page.url();
  const text = networkError ? '' : (await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 4000)).catch(() => '')) as string;

  const isLoginPage = /login|sign[-_]?in/i.test(url) || /\b(log\s*in|sign\s*in|password required)\b/i.test(text);
  const isCaptcha = /captcha|slider|安全验证|安全检查|verify to continue|aliyun|\bwaf\b|challenge/i.test(text);
  const isMfa = /verification code|two[-\s]?factor|one[-\s]?time|otp|sms code|authenticator/i.test(text);
  const authenticatedMarkersPresent = /\b(log\s*out|sign\s*out|my\s*account|dashboard|buyer)\b/i.test(text) && !isLoginPage;
  const layoutMarkersMissing = !networkError && !isLoginPage && !authenticatedMarkersPresent && !isCaptcha && !isMfa;

  // Best-effort identity evidence (raw stays local; never logged).
  const emailMatch = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const evidence: AccountEvidence = {
    accountId: null,
    maskedEmail: emailMatch ? emailMatch[0] : null,
    role: authenticatedMarkersPresent ? cfg.role : null,  // page-confirmed authenticated → treat as this source's role
    savedItemsListId: null,
  };
  await page.close().catch(() => {});
  return { signals: { networkError, httpStatus, isLoginPage, isCaptcha, isMfa, authenticatedMarkersPresent, layoutMarkersMissing }, evidence };
}

/** Bounded probe: write the freshly-extracted snapshot to a temp file, run it through the
 *  EXISTING XHR inventory fetcher (pickup) and require a CONFIRMED result. Returns probeOk. */
async function probePickupSnapshot(tempSnapshot: string, probeSku: string): Promise<{ probeOk: boolean; classification: string }> {
  const prev = process.env.GIGA_SESSION_FILE;
  process.env.GIGA_SESSION_FILE = tempSnapshot;
  try {
    const mod = await import('./fetchGigaWarehouseInventoryFromXhr'); // reads GIGA_SESSION_FILE at load
    const { productId, sku } = await mod.resolveProductId(probeSku);
    const r = await mod.fetchWarehouseRows(productId, sku ?? probeSku);
    const confirmed = r.result.status === 'confirmed_in_stock_ca' || r.result.status === 'confirmed_in_stock_out_of_state' || r.result.status === 'confirmed_out_of_stock';
    return { probeOk: confirmed, classification: r.result.status };
  } catch (e) {
    return { probeOk: false, classification: `probe_error:${(e as Error)?.message ?? 'unknown'}` };
  } finally {
    if (prev === undefined) delete process.env.GIGA_SESSION_FILE; else process.env.GIGA_SESSION_FILE = prev;
  }
}

/** Full refresh: lock → launch → observe → verify identity → extract → probe → promote. */
export async function refreshSession(source: SupplierSource, opts: { probeSku?: string } = {}): Promise<SessionOpResult> {
  const cfg = sourceConfig(source);
  const initialized = ensureProfileDir(cfg);
  const base: SessionOpResult = { source, health: 'unknown_failure', identityVerified: false, safeId: null, snapshotRefreshed: false, previousBackedUp: false, probeClassification: null, humanActionRequired: false, failureCategory: null, profileInitialized: initialized };

  const lock = acquireLock(cfg.lockPath, source);
  if (!lock.ok) return { ...base, health: 'profile_locked', failureCategory: 'profile_locked' };

  let context: BrowserContext | null = null;
  try {
    context = await launch(cfg);
    const { signals, evidence } = await observe(context, cfg);
    const pageHealth = classifyPageHealth(signals);
    if (pageHealth !== 'healthy') {
      const human = requiresHumanAction(pageHealth);
      // Leave the dedicated browser OPEN when a human must act; otherwise close.
      if (!human && context) { await context.close().catch(() => {}); context = null; }
      return { ...base, health: pageHealth, humanActionRequired: human, failureCategory: pageHealth };
    }
    const identity = verifyIdentity(evidence, { role: cfg.role });
    if (!identity.ok) return { ...base, health: identity.state, safeId: identity.safeId, failureCategory: identity.state };

    // Extract snapshot to a temp file for the bounded probe (never the live snapshot yet).
    const temp = `${cfg.snapshotPath}.probe-${process.pid}.json`;
    await context.storageState({ path: temp });
    const state = JSON.parse(fs.readFileSync(temp, 'utf8')) as StorageState;

    // Dropship cannot read the pickup warehouse XHR; its bounded confirmation is health+identity.
    let probeOk = true, classification = 'identity_confirmed';
    if (source === 'pickup') {
      if (!opts.probeSku) { try { fs.unlinkSync(temp); } catch { /* */ } return { ...base, health: 'unknown_failure', identityVerified: true, safeId: identity.safeId, failureCategory: 'no_probe_sku', redactedSnapshot: redactStorageState(state) }; }
      const probe = await probePickupSnapshot(temp, opts.probeSku);
      probeOk = probe.probeOk; classification = probe.classification;
    }

    let promo: PromoteResult = { promoted: false, backedUp: false, reason: 'not_promoted' };
    if (probeOk) promo = promoteSnapshot({ snapshotPath: cfg.snapshotPath, backupPath: cfg.backupPath }, state, { probeOk });
    try { fs.unlinkSync(temp); } catch { /* */ }

    if (context) { await context.close().catch(() => {}); context = null; }
    return {
      ...base, health: probeOk && promo.promoted ? 'healthy' : 'unknown_failure',
      identityVerified: true, safeId: identity.safeId,
      snapshotRefreshed: promo.promoted, previousBackedUp: promo.backedUp,
      probeClassification: classification, failureCategory: promo.promoted ? null : (promo.reason ?? 'probe_failed'),
      redactedSnapshot: redactStorageState(state),
    };
  } catch (e) {
    return { ...base, health: 'unknown_failure', failureCategory: `manager_error:${(e as Error)?.message ?? 'unknown'}` };
  } finally {
    if (context) await context.close().catch(() => {});
    releaseLock(cfg.lockPath, source);
  }
}

/** Health-only check (no promotion). Leaves the browser open only if a human must act. */
export async function healthCheck(source: SupplierSource): Promise<SessionOpResult> {
  const cfg = sourceConfig(source);
  const initialized = ensureProfileDir(cfg);
  const base: SessionOpResult = { source, health: 'not_initialized', identityVerified: false, safeId: null, snapshotRefreshed: false, previousBackedUp: false, probeClassification: null, humanActionRequired: false, failureCategory: null, profileInitialized: initialized };
  if (initialized) return { ...base, health: 'not_initialized', failureCategory: 'not_initialized' };
  const lock = acquireLock(cfg.lockPath, source);
  if (!lock.ok) return { ...base, health: 'profile_locked', failureCategory: 'profile_locked' };
  let context: BrowserContext | null = null;
  try {
    context = await launch(cfg);
    const { signals, evidence } = await observe(context, cfg);
    let health = classifyPageHealth(signals);
    let safeId: string | null = null, idVerified = false;
    if (health === 'healthy') { const id = verifyIdentity(evidence, { role: cfg.role }); health = id.state; safeId = id.safeId; idVerified = id.ok; }
    const human = requiresHumanAction(health);
    if (!human && context) { await context.close().catch(() => {}); context = null; }
    return { ...base, health, identityVerified: idVerified, safeId, humanActionRequired: human, failureCategory: health === 'healthy' ? null : health };
  } finally {
    if (context && !requiresHumanAction(base.health)) await context.close().catch(() => {});
    releaseLock(cfg.lockPath, source);
  }
}

/** Initialize the dedicated profile and open a headed browser for a ONE-TIME human login.
 *  Leaves the browser open (does not auto-close). Never copies cookies. */
export async function initProfileHeaded(source: SupplierSource): Promise<{ source: SupplierSource; profileDir: string; initialized: boolean; opened: boolean }> {
  const cfg = sourceConfig(source);
  const initialized = ensureProfileDir(cfg);
  const lock = acquireLock(cfg.lockPath, source);
  if (!lock.ok) return { source, profileDir: path.basename(cfg.profileDir), initialized, opened: false };
  const context = await launch(cfg);
  const page = await context.newPage();
  await page.goto(cfg.landingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  // Intentionally leave the browser OPEN for the user to log in once; lock released on exit
  // is handled by the CLI wrapper which keeps the process alive.
  return { source, profileDir: path.basename(cfg.profileDir), initialized, opened: true };
}

/**
 * Open a dedicated BACKGROUND checker page in the same context. This page — and ONLY this
 * page — is navigated to the harmless authenticated landing URL to detect context-wide
 * (OCSESSID) authentication. Creating a tab steals foreground focus in headed Chromium, so
 * immediately after creating the checker we bring the human's `loginPage` back to the front.
 * The login tab is never navigated, reloaded, closed, or focus-stolen by the checker.
 */
function makeCheckerFactory(context: BrowserContext, loginPage: Page): () => Promise<CheckerPage> {
  return async (): Promise<CheckerPage> => {
    const checker = await context.newPage();
    await loginPage.bringToFront().catch(() => {}); // undo the focus theft from opening the checker tab
    return {
      gotoAndRead: async (url: string): Promise<CheckerObservation> => {
        let httpStatus: number | null = null, networkError = false;
        try { const resp = await checker.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }); httpStatus = resp?.status() ?? null; }
        catch { networkError = true; }
        const curUrl = checker.url();
        const text = networkError ? '' : (await checker.evaluate(() => (document.body?.innerText ?? '').slice(0, 6000)).catch(() => '')) as string;
        return { networkError, httpStatus, url: curUrl, text };
      },
      close: async () => { await checker.close().catch(() => {}); },
    };
  };
}

/**
 * SINGLE-SESSION login → detect → verify identity → extract → probe → promote → close, all in
 * ONE live Playwright context (fixes the OCSESSID session-cookie loss from the init→refresh
 * restart). Never restarts the browser between login and extraction; leaves the window open
 * while waiting for the human; closes only after the final result. No secrets logged.
 */
export async function loginAndPromote(source: SupplierSource, opts: { probeSku: string; timeoutMs?: number }): Promise<LoginPromoteResult & { source: SupplierSource; redactedSnapshot?: ReturnType<typeof redactStorageState> }> {
  const cfg = sourceConfig(source);
  ensureProfileDir(cfg);
  let context: BrowserContext | null = null;
  let page: any = null;

  const result = await runLoginAndPromote({
    expectedRole: cfg.role,
    expectedBuyerId: EXPECTED_BUYER_ID[source],
    probeSku: opts.probeSku,
    timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000,
    acquireLock: () => acquireLock(cfg.lockPath, source).ok,
    releaseLock: () => releaseLock(cfg.lockPath, source),
    // Reuse the persistent context's initial page as the VISIBLE login tab (no extra blank tab).
    openContext: async () => { context = await launch(cfg); page = context.pages()[0] ?? await context.newPage(); await page.goto(cfg.landingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {}); },
    // Detect auth on a SEPARATE background checker page; the visible login tab is never navigated,
    // reloaded, closed, or left without focus (bringToFront restores it after every poll).
    waitForAuth: (timeoutMs) => pollForAuthentication({
      landingUrl: cfg.landingUrl,
      expectedBuyerId: EXPECTED_BUYER_ID[source],
      otherBuyerId: OTHER_BUYER_ID[source],
      role: cfg.role,
      timeoutMs,
      pollMs: LOGIN_POLL_INTERVAL_MS,
      now: () => Date.now(),
      sleep: (ms) => new Promise<void>(res => setTimeout(res, ms)),
      openChecker: makeCheckerFactory(context!, page!),
      visibleUrl: async () => { try { return page ? page.url() : ''; } catch { return ''; } },
      keepVisibleInFront: async () => { try { if (page) await page.bringToFront(); } catch { /* best effort */ } },
      onInstrument: (e) => console.log(`[supplier] poll#${e.attempt} visibleBefore=${e.visibleUrlBefore} visibleAfter=${e.visibleUrlAfter} checker=${e.checkerUrl} authed=${e.authed}`),
    }),
    extractSnapshot: async () => await context!.storageState() as unknown as StorageState, // in-memory → captures SESSION cookies
    probe: async (snapshot, sku) => probeViaFetcher(cfg, snapshot, sku),
    promote: (snapshot) => promoteSnapshot({ snapshotPath: cfg.snapshotPath, backupPath: cfg.backupPath }, snapshot, { probeOk: true }),
    persistHealth: (h) => writeHealthState(cfg.healthPath, source, h),
    closeContext: async () => { if (context) await context.close().catch(() => {}); },
  });
  return { ...result, source };
}

/** Write the live snapshot to a temp file and run it through the EXISTING XHR fetcher; require CONFIRMED. */
async function probeViaFetcher(cfg: SourceConfig, snapshot: StorageState, sku: string): Promise<{ probeOk: boolean; classification: string }> {
  const temp = `${cfg.snapshotPath}.login-probe-${process.pid}.json`;
  const prev = process.env.GIGA_SESSION_FILE;
  try {
    fs.writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
    process.env.GIGA_SESSION_FILE = temp;
    const mod = await import('./fetchGigaWarehouseInventoryFromXhr');
    const { productId, sku: resolved } = await mod.resolveProductId(sku);
    const r = await mod.fetchWarehouseRows(productId, resolved ?? sku);
    const ok = r.result.status === 'confirmed_in_stock_ca' || r.result.status === 'confirmed_in_stock_out_of_state' || r.result.status === 'confirmed_out_of_stock';
    return { probeOk: ok, classification: r.result.status };
  } catch (e) {
    return { probeOk: false, classification: `probe_error:${(e as Error)?.message ?? 'unknown'}` };
  } finally {
    if (prev === undefined) delete process.env.GIGA_SESSION_FILE; else process.env.GIGA_SESSION_FILE = prev;
    try { fs.unlinkSync(temp); } catch { /* */ }
  }
}
