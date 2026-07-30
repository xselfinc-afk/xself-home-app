/**
 * Server-authoritative checkout inventory revalidation (Phase 1, Scope G) — pure, no I/O.
 *
 * Reused by create-checkout-order (Deno) behind the default-off remote-config flag
 * `inventory_checkout_revalidation_enabled`, and unit-tested from node/tsx. It NEVER trusts
 * client inventory state; it classifies each cart line from the server's own inventory_cache
 * rows + freshness and returns a STRUCTURED per-line decision. It touches only inventory —
 * fulfillment / Apple Pay / Stripe / Affirm / pickup / shipping paths are untouched.
 *
 * Guarantees:
 *  - confirmed out of stock (rows present, total qty 0) → BLOCK.
 *  - insufficient qty (0 < total < requested) → BLOCK.
 *  - recent confirmed stock (total >= qty, fresh) → ALLOW.
 *  - stale (rows present but all older than threshold) → status 'stale', never reported as
 *    confirmed stock; BLOCKED only when policy.enabled (else surfaced but allowed = current
 *    fail-open behavior, so nothing changes until the flag is turned on).
 *  - unknown (no rows / no usable timestamp) → status 'unknown', BLOCK (never "in stock").
 */

export type LineStatus = 'ok' | 'out_of_stock' | 'insufficient_qty' | 'stale' | 'unknown';

export interface CheckoutLineRow {
  quantity: number | null;
  lastSyncedAt: string | null; // ISO; null = no usable freshness → unknown/stale
}

export interface CheckoutLineInventory {
  productId: string;
  sku: string;
  qty: number;                 // requested quantity
  rows: CheckoutLineRow[];     // this product's trusted (website_scrape/official_api, ok) cache rows
}

export interface RevalidationPolicy {
  enabled: boolean;            // remote-config inventory_checkout_revalidation_enabled
  staleThresholdMs: number;    // e.g. 24h
  nowMs: number;               // injected for determinism
}

export interface LineDecision {
  productId: string;
  sku: string;
  status: LineStatus;
  allow: boolean;
  reason: string;
}

const q = (r: CheckoutLineRow): number => {
  const n = Number(r.quantity ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Pure per-line decision. */
export function evaluateCheckoutLine(line: CheckoutLineInventory, policy: RevalidationPolicy): LineDecision {
  const base = { productId: line.productId, sku: line.sku };
  if (line.rows.length === 0)
    return { ...base, status: 'unknown', allow: false, reason: 'inventory_unknown' };

  const total = line.rows.reduce((s, r) => s + q(r), 0);
  if (total === 0) return { ...base, status: 'out_of_stock', allow: false, reason: 'confirmed_out_of_stock' };
  if (total < line.qty) return { ...base, status: 'insufficient_qty', allow: false, reason: 'insufficient_qty' };

  // Freshest row age (a null/invalid timestamp is treated as infinitely old → not fresh).
  const minAge = Math.min(...line.rows.map(r => {
    const t = r.lastSyncedAt ? Date.parse(r.lastSyncedAt) : NaN;
    return Number.isFinite(t) ? policy.nowMs - t : Number.POSITIVE_INFINITY;
  }));
  if (minAge > policy.staleThresholdMs)
    return { ...base, status: 'stale', allow: !policy.enabled, reason: policy.enabled ? 'inventory_stale' : 'stale_allowed_flag_off' };

  return { ...base, status: 'ok', allow: true, reason: 'recent_confirmed_stock' };
}

/** Evaluate a whole cart; identifies ONLY the affected line items. */
export function evaluateCheckoutCart(lines: CheckoutLineInventory[], policy: RevalidationPolicy): {
  allAllowed: boolean; decisions: LineDecision[]; failures: LineDecision[];
} {
  const decisions = lines.map(l => evaluateCheckoutLine(l, policy));
  const failures = decisions.filter(d => !d.allow);
  return { allAllowed: failures.length === 0, decisions, failures };
}
