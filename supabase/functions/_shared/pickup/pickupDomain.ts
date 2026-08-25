/**
 * Authorization-then-capture policy for Pay-After-Pickup.
 *
 * Ported (not rewritten) from the verified Pay-After-Pickup app
 * (/Users/heliu/XOne/Apps/Pay-After-Pickup/src/lib/domain/authorization.ts).
 * Pure functions only — safe to import from both Deno edge functions and tsx tests.
 *
 * A card authorization is not open-ended. Stripe reports the exact instant it lapses
 * (`capture_before`); when it lapses the hold is released and the money is gone from
 * our reach. Every deadline here is derived from that provider expiry, never assumed.
 */

/** Minimal shape of a pickup authorization (subset of pickup_payment_authorizations). */
export interface AuthorizationRecord {
  status: 'REQUIRES_ACTION' | 'REQUIRES_CONFIRMATION' | 'AUTHORIZED' | 'CAPTURED' | 'VOIDED' | 'FAILED';
  amount_cents: number;
  capture_before: string | null;
  provider_payment_intent_id: string | null;
  void_reason?: string | null;
}

/**
 * Capture this far before the authorization expires. Stripe's own automatic delayed
 * capture fires ~6h out; matching that leaves room for a retry without racing the deadline.
 */
export const CAPTURE_SAFETY_MARGIN_MS = 6 * 3600_000;

/** An authorization is usable only while AUTHORIZED and not yet lapsed. */
export function isAuthorizationLive(p: AuthorizationRecord | undefined, at: Date = new Date()): boolean {
  if (!p || p.status !== 'AUTHORIZED') return false;
  if (!p.capture_before) return true;
  return new Date(p.capture_before).getTime() > at.getTime();
}

/** Live authorizations whose remaining time has fallen inside the safety margin. */
export function isAuthorizationExpiringSoon(p: AuthorizationRecord | undefined, at: Date = new Date()): boolean {
  if (!isAuthorizationLive(p, at) || !p?.capture_before) return false;
  return new Date(p.capture_before).getTime() - at.getTime() <= CAPTURE_SAFETY_MARGIN_MS;
}

export function hasAuthorizationLapsed(p: AuthorizationRecord | undefined, at: Date = new Date()): boolean {
  if (!p || p.status !== 'AUTHORIZED' || !p.capture_before) return false;
  return new Date(p.capture_before).getTime() <= at.getTime();
}

export interface CaptureSchedule {
  captureDueAt: string;
  basis: 'CUSTOMER_DEADLINE' | 'AUTHORIZATION_EXPIRY';
  shortenedByAuthorization: boolean;
  explanation: string;
}

/**
 * When capture must happen: the earlier of the customer's own deadline and the
 * authorization's expiry less the safety margin. The customer is promised 24h after
 * pickup; if the hold would lapse sooner the hold wins — capturing late captures nothing.
 */
export function computeCaptureSchedule(
  paymentDueAt: string | null,
  captureBefore: string | null,
): CaptureSchedule | null {
  const customer = paymentDueAt ? new Date(paymentDueAt).getTime() : null;
  const authLimit = captureBefore ? new Date(captureBefore).getTime() - CAPTURE_SAFETY_MARGIN_MS : null;

  if (customer === null && authLimit === null) return null;
  if (authLimit === null) {
    return {
      captureDueAt: new Date(customer!).toISOString(),
      basis: 'CUSTOMER_DEADLINE',
      shortenedByAuthorization: false,
      explanation: 'Capture due at the customer payment deadline; provider reported no authorization expiry.',
    };
  }
  if (customer === null || authLimit < customer) {
    return {
      captureDueAt: new Date(authLimit).toISOString(),
      basis: 'AUTHORIZATION_EXPIRY',
      shortenedByAuthorization: customer !== null,
      explanation:
        `Capture due ${Math.round(CAPTURE_SAFETY_MARGIN_MS / 3600_000)}h before the hold expires at ${captureBefore}` +
        (customer !== null ? `, EARLIER than the customer deadline ${paymentDueAt}; the hold would lapse first.` : '.'),
    };
  }
  return {
    captureDueAt: new Date(customer).toISOString(),
    basis: 'CUSTOMER_DEADLINE',
    shortenedByAuthorization: false,
    explanation: `Capture due at the customer payment deadline ${paymentDueAt}, inside the authorization window.`,
  };
}

export interface AuthReleaseCheck { passed: boolean; detail: string }

/**
 * The BOL-release precondition: a HELD authorization for THIS order's amount, right now.
 * A saved card only proved a card existed; a live hold proves the funds are secured.
 */
export function evaluateAuthorizationForRelease(input: {
  authorization: AuthorizationRecord | undefined;
  orderAmountCents: number;
  at?: Date;
}): AuthReleaseCheck {
  const { authorization, orderAmountCents, at = new Date() } = input;
  if (!authorization) return { passed: false, detail: 'No authorization on this order.' };
  if (authorization.status !== 'AUTHORIZED') {
    return { passed: false, detail: `Latest authorization is ${authorization.status}${authorization.void_reason ? ` (${authorization.void_reason})` : ''}; re-authorize before release.` };
  }
  if (hasAuthorizationLapsed(authorization, at)) {
    return { passed: false, detail: `Authorization lapsed at ${authorization.capture_before}; held funds released. Re-authorize.` };
  }
  if (authorization.amount_cents !== orderAmountCents) {
    return { passed: false, detail: `Authorized ${authorization.amount_cents}¢ but order is ${orderAmountCents}¢. Re-authorize for the correct amount.` };
  }
  const expiring = isAuthorizationExpiringSoon(authorization, at);
  return {
    passed: true,
    detail: `${authorization.amount_cents}¢ held (${authorization.provider_payment_intent_id ?? '?'}), expires ${authorization.capture_before ?? 'unknown'}` +
      (expiring ? ' — EXPIRING SOON.' : '.'),
  };
}

/**
 * Map a Stripe PaymentIntent status to our authorization status.
 * Ported handoff fix: `requires_payment_method` after a confirm attempt is a DECLINE
 * (FAILED), not an untouched intent; `requires_action`/`requires_confirmation` hand the
 * customer back to finish authentication; `requires_capture` is the successful hold.
 */
export function mapAuthorizationStatus(
  stripeStatus: string,
  opts: { afterConfirmAttempt: boolean } = { afterConfirmAttempt: false },
): AuthorizationRecord['status'] {
  switch (stripeStatus) {
    case 'requires_capture':       return 'AUTHORIZED';   // manual-capture hold placed
    case 'succeeded':              return 'CAPTURED';     // only true after capture
    case 'requires_action':        return 'REQUIRES_ACTION';
    case 'requires_confirmation':  return 'REQUIRES_CONFIRMATION';
    case 'canceled':               return 'VOIDED';
    case 'requires_payment_method':
      return opts.afterConfirmAttempt ? 'FAILED' : 'REQUIRES_ACTION';
    default:                       return 'REQUIRES_ACTION';
  }
}

/**
 * Payment-due policy for Pay-After-Pickup.
 *
 * Ported from the verified Pay-After-Pickup app
 * (/Users/heliu/XOne/Apps/Pay-After-Pickup/src/lib/domain/due-policy.ts). Pure functions.
 *
 * Customer-facing rule (fixed): "Payment is due within 24 hours after the customer picks
 * up the item." The 24h clock starts at the PICKUP — represented here by the operator's
 * Confirm Pickup, which supplies either a real pickup instant or a pickup date. It NEVER
 * starts at authorization success, BOL download, or any customer action.
 */

export type DueBasis = 'EXACT_PICKUP_TIME' | 'END_OF_NEXT_DAY';
export const FALLBACK_POLICY = 'END_OF_NEXT_DAY' as const;
export const DEFAULT_PAYMENT_TERM_HOURS = 24;

export interface DuePolicyConfig {
  paymentTermHours: number;
  /** "HH:MM" local warehouse time treated as the end of a calendar day. */
  dayEndLocalTime: string;
  /** Warehouse timezone offset from UTC, in minutes (e.g. -420 for PDT). */
  timezoneOffsetMinutes: number;
}

export interface DueInput {
  /** ISO timestamp of the actual pickup, if genuinely known. */
  pickedUpAt?: string | null;
  /** "YYYY-MM-DD" pickup day from the Signed BOL or scheduled pickup. */
  pickupDate?: string | null;
}

export interface DueResult {
  paymentDueAt: string;
  basis: DueBasis;
  displayPrecision: 'DATE_TIME' | 'DATE';
  explanation: string;
}

export class MissingPickupTimingError extends Error {
  constructor() {
    super('Cannot compute payment due: no actual pickup time and no pickup date. The system will not guess a time.');
    this.name = 'MissingPickupTimingError';
  }
}

export function computePaymentDue(input: DueInput, cfg: DuePolicyConfig): DueResult {
  if (input.pickedUpAt) {
    const anchor = new Date(input.pickedUpAt);
    if (Number.isNaN(anchor.getTime())) throw new Error(`Invalid picked_up_at: ${input.pickedUpAt}`);
    return {
      paymentDueAt: new Date(anchor.getTime() + cfg.paymentTermHours * 3600_000).toISOString(),
      basis: 'EXACT_PICKUP_TIME',
      displayPrecision: 'DATE_TIME',
      explanation: `${cfg.paymentTermHours}h from the recorded actual pickup time ${anchor.toISOString()}.`,
    };
  }
  if (input.pickupDate) {
    const dueAt = endOfDay(addDays(input.pickupDate, 1), cfg);
    return {
      paymentDueAt: dueAt.toISOString(),
      basis: 'END_OF_NEXT_DAY',
      displayPrecision: 'DATE',
      explanation: `FALLBACK ${FALLBACK_POLICY}: exact pickup time unknown; deadline is end of ${addDays(input.pickupDate, 1)} warehouse-local — at least ${cfg.paymentTermHours}h after any pickup on ${input.pickupDate}.`,
    };
  }
  throw new MissingPickupTimingError();
}

export function isPastDue(paymentDueAt: string | null, at: Date = new Date()): boolean {
  if (!paymentDueAt) return false;
  return at.getTime() > new Date(paymentDueAt).getTime();
}

function addDays(day: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`Invalid pickup_date: "${day}". Expected YYYY-MM-DD.`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function endOfDay(day: string, cfg: DuePolicyConfig): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)!;
  const t = /^(\d{1,2}):(\d{2})$/.exec(cfg.dayEndLocalTime);
  if (!t) throw new Error(`Invalid dayEndLocalTime: "${cfg.dayEndLocalTime}"`);
  const wallClockUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2]));
  return new Date(wallClockUtc - cfg.timezoneOffsetMinutes * 60_000);
}

/**
 * BOL release gate + capture eligibility for Pay-After-Pickup.
 *
 * Ported in spirit from the verified Pay-After-Pickup app
 * (/Users/heliu/XOne/Apps/Pay-After-Pickup/src/lib/domain/gates.ts) and adapted to the
 * shared `orders`/pickup tables. Pure functions — the server re-evaluates these at the
 * moment of release/capture; they never mutate.
 *
 * Releasing the Original BOL hands the customer the instrument to walk out of a warehouse
 * with goods we have not been paid for. Every precondition is checked here, server-side.
 * Fail-closed: any failed check blocks release.
 */


export interface GateCheck { key: string; label: string; passed: boolean; detail: string }
export interface GateResult { ok: boolean; checks: GateCheck[]; failed: GateCheck[] }

export interface ReleaseGateInput {
  order: {
    order_id: string;
    fulfillment_method: string | null;
    status: string | null;
    pickup_stage: string | null;
    total_cents: number | null;
    payment_method_saved_at: string | null;
    customer_email: string | null;
  };
  supplierOrderExists: boolean;
  originalBol: { document_type: string; released_at: string | null; superseded_at: string | null } | undefined;
  authorization: AuthorizationRecord | undefined;
  at?: Date;
}

export function evaluateReleaseGate(input: ReleaseGateInput): GateResult {
  const { order, supplierOrderExists, originalBol, authorization, at = new Date() } = input;
  const checks: GateCheck[] = [];

  checks.push({
    key: 'is_pickup',
    label: 'Order is a pickup order',
    passed: order.fulfillment_method === 'pickup',
    detail: `fulfillment_method=${order.fulfillment_method ?? 'null'}`,
  });

  checks.push({
    key: 'not_cancelled',
    label: 'Order is not cancelled',
    passed: order.status !== 'cancelled' && order.status !== 'canceled' && order.status !== 'abandoned',
    detail: `status=${order.status ?? 'null'}`,
  });

  checks.push({
    key: 'contact_ready',
    label: 'Customer contact present',
    passed: Boolean(order.customer_email),
    detail: order.customer_email ? order.customer_email : 'no customer email',
  });

  checks.push({
    key: 'payment_setup_ready',
    label: 'Payment method saved (SetupIntent complete)',
    passed: Boolean(order.payment_method_saved_at),
    detail: order.payment_method_saved_at ? `saved ${order.payment_method_saved_at}` : 'no saved payment method',
  });

  checks.push({
    key: 'supplier_order_exists',
    label: 'Supplier order recorded',
    passed: supplierOrderExists,
    detail: supplierOrderExists ? 'present' : 'no supplier order',
  });

  const bolOk = Boolean(originalBol) && originalBol!.document_type === 'ORIGINAL_BOL' && !originalBol!.superseded_at;
  checks.push({
    key: 'original_bol_present',
    label: 'Original BOL uploaded',
    passed: bolOk,
    detail: originalBol ? `${originalBol.document_type}` : 'no Original BOL',
  });

  checks.push({
    key: 'not_already_released',
    label: 'Original BOL not already released',
    passed: !originalBol?.released_at,
    detail: originalBol?.released_at ? `already released ${originalBol.released_at}` : 'not yet released',
  });

  // The decisive check: a LIVE hold for the order's CURRENT amount.
  const authCheck = evaluateAuthorizationForRelease({
    authorization,
    orderAmountCents: order.total_cents ?? -1,
    at,
  });
  checks.push({ key: 'payment_authorized', label: 'Live authorization holds the full amount', ...authCheck });

  const failed = checks.filter((c) => !c.passed);
  return { ok: failed.length === 0, checks, failed };
}

// ── Capture eligibility ───────────────────────────────────────────────────────
export interface CaptureEligibilityInput {
  order: { order_id: string; pickup_stage: string | null; pickup_confirmed_at: string | null };
  authorization: AuthorizationRecord | undefined;
  hasOpenIssue: boolean;
  at?: Date;
}
export interface CaptureEligibility { capturable: boolean; reason: string }

/**
 * Capture is allowed only when: pickup was CONFIRMED (24h basis exists), a live AUTHORIZED
 * hold is present, and no OPEN issue blocks it. Fail-closed on expiry. Idempotency (only
 * the original PI, never a second) is enforced at the call site via the stored PI id.
 */
export function evaluateCaptureEligibility(input: CaptureEligibilityInput): CaptureEligibility {
  const { order, authorization, hasOpenIssue, at = new Date() } = input;
  if (hasOpenIssue) return { capturable: false, reason: 'An open issue blocks capture.' };
  if (!order.pickup_confirmed_at) return { capturable: false, reason: 'Pickup not confirmed; 24h window has not started.' };
  if (!authorization) return { capturable: false, reason: 'No authorization to capture.' };
  if (authorization.status === 'CAPTURED') return { capturable: false, reason: 'Already captured (idempotent no-op).' };
  if (authorization.status !== 'AUTHORIZED') return { capturable: false, reason: `Authorization is ${authorization.status}, not AUTHORIZED.` };
  if (authorization.capture_before && new Date(authorization.capture_before).getTime() <= at.getTime()) {
    return { capturable: false, reason: 'Authorization has lapsed; capture window closed (fail-closed).' };
  }
  return { capturable: true, reason: `Capturable: original PI ${authorization.provider_payment_intent_id ?? '?'}.` };
}

// ── Checkout + webhook routing (shared by create-checkout-order & stripe-webhook) ──

/**
 * Pay-After-Pickup is taken ONLY when all three hold: the customer chose pickup, the client
 * declared the SetupIntent capability, and the planner produced a pickup plan. Any false → the
 * unchanged automatic-capture path (Delivery included).
 */
export function shouldUsePayAfterPickup(
  fulfillmentMethod: string,
  clientSupportsPayAfterPickup: boolean,
  planUsePickup: boolean,
): boolean {
  return fulfillmentMethod === 'pickup' && clientSupportsPayAfterPickup === true && planUsePickup === true;
}

/**
 * SetupIntent params for the $0-today, save-card pickup flow. No `amount` — a SetupIntent never
 * charges. usage=off_session so the saved method can back a later manual-capture authorization.
 */
export function buildSetupIntentParams(orderId: string, customerId: string): URLSearchParams {
  const p = new URLSearchParams();
  p.append('customer', customerId);
  p.append('usage', 'off_session');
  p.append('payment_method_types[]', 'card');
  p.append('metadata[order_id]', orderId);
  p.append('metadata[phase]', 'checkout_setup');
  return p;
}

export type WebhookPhase =
  | 'checkout_setup' | 'pickup_authorization' | 'pickup_capture'
  | 'delivery_payment' | 'admin_link' | 'unknown';

/**
 * What a Stripe event means, and whether it may set payment_status='paid'.
 * INVARIANT: only the admin Payment Link, a Delivery PaymentIntent success, and a Pay-After-Pickup
 * CAPTURE collect money (setsPaid=true). Card-save (SetupIntent) and the manual-capture
 * AUTHORIZATION never set paid — a held card is not collected money.
 */
export function classifyWebhookEvent(
  eventType: string,
  metadata: Record<string, string>,
): { phase: WebhookPhase; setsPaid: boolean } {
  const phase = metadata.phase ?? '';
  if (eventType === 'setup_intent.succeeded') return { phase: 'checkout_setup', setsPaid: false };
  if (eventType === 'payment_intent.amount_capturable_updated') return { phase: 'pickup_authorization', setsPaid: false };
  if (eventType === 'checkout.session.completed') return { phase: 'admin_link', setsPaid: true };
  if (eventType === 'payment_intent.succeeded') {
    if (phase === 'pickup_capture') return { phase: 'pickup_capture', setsPaid: true };
    if (phase === 'pickup_authorization') return { phase: 'pickup_authorization', setsPaid: false };
    return { phase: 'delivery_payment', setsPaid: true };
  }
  return { phase: 'unknown', setsPaid: false };
}
