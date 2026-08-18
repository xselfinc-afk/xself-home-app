/**
 * Order-level savings — a DISPLAY figure only.
 *
 * This must never enter a total. Subtotal, Delivery, Tax and the PaymentIntent amount are all
 * computed server-side in create-checkout-order, which re-reads selling_price and never receives
 * any amount from the client. Feeding savings into the on-screen total would therefore make the
 * displayed number disagree with what Stripe charges — the exact failure mode that shipped once
 * already via appliedCredit.
 *
 * Same arithmetic the PDP already uses for its "Save $X" badge, summed over the cart.
 */
export interface SavingsLine {
  price: number;
  /** Compare-at price. Absent for products that were never discounted. */
  originalPrice?: number | null;
  qty: number;
}

export function orderSavings(lines: readonly SavingsLine[]): number {
  const total = lines.reduce((sum, l) => {
    const original = typeof l.originalPrice === 'number' ? l.originalPrice : null;
    // No compare-at price means no claim to make. Never fall back to another field: base_retail_price
    // equals selling_price on much of the catalogue, which would silently render "You saved $0.00".
    if (original == null || original <= l.price) return sum;
    return sum + (original - l.price) * Math.max(0, l.qty);
  }, 0);
  return Math.round(total * 100) / 100;
}
