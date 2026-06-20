/**
 * 🔒 Pickup rule lock — unit tests (pure functions/constants only; no React, no Supabase).
 *
 * Run with: npx tsx src/__tests__/pickupRules.test.ts
 *
 * These assertions FAIL if any LOCKED Pickup rule changes. They exist so a Delivery
 * redesign cannot silently alter pickup radius, fee, time window, or date window.
 * See docs/fulfillment-rules.md.
 */

import assert from 'node:assert/strict';

import {
  getPickupWindow,
  PICKUP_TIME_WINDOW,
  PICKUP_EARLIEST_BUSINESS_DAYS,
  PICKUP_LATEST_BUSINESS_DAYS,
} from '../services/pickupDateService';
import { PICKUP_RADIUS_MILES } from '../config/delivery';
import { PICKUP_FEE } from '../types/fulfillment';

let passed = 0;
function it(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('Pickup rule lock tests');

it('pickup time window is exactly "10:00 AM – 2:00 PM"', () => {
  assert.equal(PICKUP_TIME_WINDOW, '10:00 AM – 2:00 PM');
});

it('pickup radius is 100 miles', () => {
  assert.equal(PICKUP_RADIUS_MILES, 100);
});

it('pickup fee is 0 (free)', () => {
  assert.equal(PICKUP_FEE, 0);
});

it('pickup business-day offsets are +1 / +4', () => {
  assert.equal(PICKUP_EARLIEST_BUSINESS_DAYS, 1);
  assert.equal(PICKUP_LATEST_BUSINESS_DAYS, 4);
});

it('Wednesday order → earliest +1 / latest +4 business days, and NO same-day pickup', () => {
  const wed = new Date(2026, 5, 17); // Wed 2026-06-17 (local)
  const w = getPickupWindow(wed);
  assert.equal(w.earliest, '2026-06-18'); // Thu = +1 business day
  assert.equal(w.latest, '2026-06-23');   // Tue = +4 business days (skips Sat/Sun)
  assert.notEqual(w.earliest, '2026-06-17'); // no same-day pickup
});

it('Friday order skips the weekend → earliest is the following Monday', () => {
  const fri = new Date(2026, 5, 19); // Fri 2026-06-19 (local)
  const w = getPickupWindow(fri);
  assert.equal(w.earliest, '2026-06-22'); // Mon (Sat/Sun skipped)
  assert.equal(w.latest, '2026-06-25');   // Thu
});

it('earliest and latest never land on a weekend (Mon–Fri only)', () => {
  for (let day = 15; day <= 21; day++) {
    const base = new Date(2026, 5, day);
    const w = getPickupWindow(base);
    for (const iso of [w.earliest, w.latest]) {
      const [y, mo, d] = iso.split('-').map(Number);
      const dow = new Date(y, mo - 1, d).getDay();
      assert.ok(dow !== 0 && dow !== 6, `${iso} fell on a weekend (dow=${dow})`);
    }
  }
});

console.log(`\n${passed} pickup-lock assertions passed.`);
