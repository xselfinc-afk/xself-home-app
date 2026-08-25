/**
 * Stripe Tax — sales tax for the PaymentIntent checkout flow.
 *
 * Why the Calculation API and not `automatic_tax`
 * -----------------------------------------------
 * `automatic_tax` only exists on Checkout Sessions, Invoices and Subscriptions. This app charges
 * through a raw PaymentIntent, so the supported path is:
 *
 *   1. POST /v1/tax/calculations      → tax for this cart + address   (this file)
 *   2. add the tax to the PaymentIntent amount                        (create-checkout-order)
 *   3. POST /v1/tax/transactions/create_from_calculation on success   (stripe-webhook)
 *
 * Step 3 is what makes the sale show up in Stripe's tax reports. A calculation alone is a quote —
 * it files nothing. The calculation id therefore has to survive from step 1 to step 3; it rides on
 * the PaymentIntent metadata so no new database column is needed.
 *
 * What this file deliberately does NOT decide
 * -------------------------------------------
 * Rates, nexus, whether shipping is taxable, and product taxability all come from the Stripe Tax
 * settings on the account (head office, registrations, default product tax code, "taxes on
 * shipping = determine automatically"). Encoding any of that here would mean two sources of truth,
 * and the wrong one would be the one that is easy to edit. Where XSELF is not registered, Stripe
 * returns 0 — that is the correct answer, not a failure.
 */

// Base is env-overridable ONLY for local integration tests (fake Stripe). Default is the real API,
// so the Delivery tax path is byte-identical in production.
const STRIPE_API = `${Deno.env.get('STRIPE_API_BASE') ?? 'https://api.stripe.com'}/v1`;
/** Performance locations are gated on this API version (Stripe docs, in-person sales guide). */
const TAX_API_VERSION = '2025-05-28.basil';

/** A cart line priced with the SERVER's authoritative catalog price, never the client's snapshot. */
export interface TaxLineItem {
  /** supplier_product_id — echoed back as the Stripe line `reference`. */
  productId: string;
  qty: number;
  /** Unit price in cents, server-read. */
  unitPriceCents: number;
}

/**
 * A Stripe `tax.location` of type `performance`, cached per warehouse code.
 *
 * Pickup is an in-person sale: tax is assessed where the customer takes the goods, not at their
 * home address. Stripe's mechanism for that is a performance location attached to the line item —
 * NOT swapping the customer address, which must stay real for reverse-charge determination.
 */
const performanceLocationCache = new Map<string, string>();

export interface TaxAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
}

export interface TaxCalculationResult {
  taxCents: number;
  /** Pass to `createTaxTransaction` after the payment succeeds. null when tax was not calculated. */
  calculationId: string | null;
}

/** Thrown when Stripe Tax is reachable but rejects the request — callers fail closed on this. */
export class StripeTaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeTaxError';
  }
}

/**
 * Pull the US ZIP out of a warehouse address string.
 *
 * Warehouse rows carry `state` and `city` as columns but keep the rest as one string
 * (e.g. "1670 Etiwanda Ave #A, Ontario, CA 91761, United States"). California district taxes vary
 * below state level, so the ZIP is worth recovering. Returns null when there is nothing that looks
 * like a ZIP — callers then send city + state and let Stripe resolve what it can.
 */
export function extractUsZip(address: string | null | undefined): string | null {
  if (!address) return null;
  const matches = String(address).match(/\b\d{5}(?:-\d{4})?\b/g);
  return matches && matches.length ? matches[matches.length - 1] : null;
}

/**
 * Calculate tax for one cart. Returns 0 tax with a null id only when there is nothing to tax
 * (empty cart); everything else either produces a real calculation or throws.
 */
export async function calculateTax(
  stripeSecretKey: string,
  args: {
    lineItems: TaxLineItem[];
    shippingCents: number;
    address: TaxAddress;
    currency?: string;
    /** Pickup only: `taxloc_…` id. Attached to every line so tax lands at the pickup site. */
    performanceLocationId?: string | null;
  },
): Promise<TaxCalculationResult> {
  const { lineItems, shippingCents, address, currency = 'usd', performanceLocationId = null } = args;
  if (!lineItems.length) return { taxCents: 0, calculationId: null };

  const params = new URLSearchParams();
  params.append('currency', currency);

  lineItems.forEach((li, i) => {
    // `amount` is the whole line (unit × qty) — Stripe treats it as the taxable base.
    params.append(`line_items[${i}][amount]`, String(li.unitPriceCents * li.qty));
    params.append(`line_items[${i}][quantity]`, String(li.qty));
    params.append(`line_items[${i}][reference]`, li.productId);
    // Prices in this catalogue are tax-exclusive; tax is added on top.
    params.append(`line_items[${i}][tax_behavior]`, 'exclusive');
    // Only set for Pickup. Requires a tax code whose `performance_location` requirement is
    // `optional` — the account default (General - Physical Goods, txcd_99999999) qualifies.
    if (performanceLocationId) params.append(`line_items[${i}][performance_location]`, performanceLocationId);
  });

  // Shipping is handed over as-is. Whether it is taxable is the account's "taxes on shipping"
  // setting, not ours. Pickup passes 0 here, which is simply an untaxed shipping cost.
  params.append('shipping_cost[amount]', String(Math.max(0, Math.round(shippingCents))));
  params.append('shipping_cost[tax_behavior]', 'exclusive');

  params.append('customer_details[address][line1]', address.line1);
  if (address.line2) params.append('customer_details[address][line2]', address.line2);
  params.append('customer_details[address][city]', address.city);
  params.append('customer_details[address][state]', address.state);
  if (address.postalCode) params.append('customer_details[address][postal_code]', address.postalCode);
  params.append('customer_details[address][country]', address.country ?? 'US');
  // Always the CUSTOMER's own address — for Pickup too. Stripe requires it for reverse-charge
  // determination even when a performance location overrides where tax is assessed.
  params.append('customer_details[address_source]', 'shipping');

  const res = await fetch(`${STRIPE_API}/tax/calculations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': TAX_API_VERSION,
    },
    body: params.toString(),
  });

  const json = await res.json().catch(() => null) as
    | { id?: string; tax_amount_exclusive?: number; error?: { message?: string } }
    | null;

  if (!res.ok) {
    throw new StripeTaxError(json?.error?.message ?? `tax calculation failed (HTTP ${res.status})`);
  }
  if (typeof json?.tax_amount_exclusive !== 'number') {
    throw new StripeTaxError('tax calculation returned no tax_amount_exclusive');
  }

  return { taxCents: json.tax_amount_exclusive, calculationId: json.id ?? null };
}

/**
 * Resolve the Stripe performance location for a pickup warehouse, creating it on first use.
 *
 * Stripe's guidance is "create one location per site and reuse it across transactions", so the id
 * is looked up by description before creating, and cached per function instance. The description
 * carries the warehouse code so the mapping stays readable in the Stripe dashboard.
 *
 * Returns null on any failure: Pickup then falls back to normal destination sourcing rather than
 * failing the calculation outright. The caller decides how loud that is.
 */
export async function findOrCreatePerformanceLocation(
  stripeSecretKey: string,
  warehouseCode: string,
  address: TaxAddress,
): Promise<string | null> {
  const cached = performanceLocationCache.get(warehouseCode);
  if (cached) return cached;

  const description = `xself-warehouse:${warehouseCode}`;
  const headers = {
    Authorization: `Bearer ${stripeSecretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': TAX_API_VERSION,
  };

  try {
    const listRes = await fetch(`${STRIPE_API}/tax/locations?limit=100`, { headers });
    if (listRes.ok) {
      const listJson = await listRes.json() as { data?: { id?: string; type?: string; description?: string }[] };
      const hit = (listJson.data ?? []).find((l) => l.description === description && l.type === 'performance');
      if (hit?.id) {
        performanceLocationCache.set(warehouseCode, hit.id);
        return hit.id;
      }
    }

    const body = new URLSearchParams();
    body.append('type', 'performance');
    body.append('address[line1]', address.line1);
    body.append('address[city]', address.city);
    body.append('address[state]', address.state);
    if (address.postalCode) body.append('address[postal_code]', address.postalCode);
    body.append('address[country]', address.country ?? 'US');
    body.append('description', description);

    const createRes = await fetch(`${STRIPE_API}/tax/locations`, { method: 'POST', headers, body: body.toString() });
    const createJson = await createRes.json().catch(() => null) as { id?: string; error?: { message?: string } } | null;
    if (!createRes.ok || !createJson?.id) {
      console.error('[stripeTax] performance location create failed:', createJson?.error?.message ?? createRes.status);
      return null;
    }
    performanceLocationCache.set(warehouseCode, createJson.id);
    return createJson.id;
  } catch (err) {
    console.error('[stripeTax] performance location lookup failed:', (err as Error).message);
    return null;
  }
}

/**
 * Record the calculation as a filed transaction. Called after the payment succeeds — this is the
 * step that makes the sale appear in Stripe's tax reporting.
 *
 * `reference` must be unique per transaction; the order id is the natural key, and re-sending the
 * same one is how a duplicate webhook delivery stays harmless.
 */
export async function createTaxTransaction(
  stripeSecretKey: string,
  calculationId: string,
  reference: string,
): Promise<{ ok: true; transactionId: string } | { ok: false; error: string }> {
  const params = new URLSearchParams();
  params.append('calculation', calculationId);
  params.append('reference', reference);

  const res = await fetch(`${STRIPE_API}/tax/transactions/create_from_calculation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Same order retried → same transaction, never a second filing.
      'Idempotency-Key': `tax_txn_${reference}`,
    },
    body: params.toString(),
  });

  const json = await res.json().catch(() => null) as
    | { id?: string; error?: { message?: string } }
    | null;

  if (!res.ok || !json?.id) {
    return { ok: false, error: json?.error?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true, transactionId: json.id };
}
