/**
 * Pickup date calculation service.
 *
 * Rules (requirements 13–14):
 *  - Day 1 = order processing day — NO same-day pickup
 *  - Earliest pickup = 1 business day after order (Day 2, weekday-adjusted)
 *  - Latest pickup   = 4 business days after order (Day 5, weekday-adjusted)
 *  - Available Monday–Friday only; weekends are skipped
 *  - Pickup time window: 10:00 AM – 2:00 PM
 */

export type PickupWindow = {
  /** ISO date string YYYY-MM-DD, local time */
  earliest: string;
  /** ISO date string YYYY-MM-DD, local time */
  latest: string;
};

export const PICKUP_TIME_WINDOW = '10:00 AM – 2:00 PM';

// 🔒 LOCKED PICKUP RULE — pickup date window is +1 to +4 business days after the
// order day (Day 1 = order day, NO same-day pickup; weekends skipped, Mon–Fri only).
// Do NOT change while redesigning Delivery. Guarded by scripts/productionGuardrails.ts
// + src/__tests__/pickupRules.test.ts. See docs/fulfillment-rules.md.
export const PICKUP_EARLIEST_BUSINESS_DAYS = 1;
export const PICKUP_LATEST_BUSINESS_DAYS = 4;

function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6; // 0=Sunday, 6=Saturday
}

/**
 * Add exactly `n` business days (Mon–Fri) to `date`.
 * Each increment moves to the next calendar day and then skips weekends.
 */
function addBusinessDays(date: Date, n: number): Date {
  const result = new Date(date);
  let added = 0;
  while (added < n) {
    result.setDate(result.getDate() + 1);
    if (!isWeekend(result)) added++;
  }
  return result;
}

/** Returns a YYYY-MM-DD string using local time (avoids UTC-offset day shifts). */
function toLocalISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Compute the pickup window for an order placed on `orderDate` (default: now).
 *   earliest = 1 business day after orderDate  (Day 2)
 *   latest   = 4 business days after orderDate (Day 5)
 */
export function getPickupWindow(orderDate?: Date): PickupWindow {
  const base = orderDate ?? new Date();
  return {
    earliest: toLocalISO(addBusinessDays(base, PICKUP_EARLIEST_BUSINESS_DAYS)),
    latest:   toLocalISO(addBusinessDays(base, PICKUP_LATEST_BUSINESS_DAYS)),
  };
}

/**
 * Format a YYYY-MM-DD string for display, e.g. "Mon Apr 28".
 * Parses as local date to avoid UTC-offset shifting the day.
 */
export function formatPickupDate(isoDate: string): string {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const date = new Date(y, mo - 1, d);
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
