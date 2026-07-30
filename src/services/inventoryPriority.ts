/**
 * California-first browse priority (Scope F) — pure, no I/O. Canonical priority value
 * for later browse ranking. NOTHING here changes UI behavior; consumers opt in.
 *
 *   P1 = verified California warehouse inventory        (highest)
 *   P2 = verified out-of-state inventory, shippable
 *   P3 = unknown OR stale (and any non-authoritative failure) — degrade/suppress by freshness
 *   P4 = confirmed out of stock                          (must not be shown)
 */
import type { InventoryResultStatus } from './inventoryResult';

export type PriorityClass = 'P1' | 'P2' | 'P3' | 'P4';

/** Lower rank = higher browse priority. */
export const PRIORITY_RANK: Record<PriorityClass, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };

export function classifyPriority(status: InventoryResultStatus): PriorityClass {
  if (status === 'confirmed_in_stock_ca') return 'P1';
  if (status === 'confirmed_in_stock_out_of_state') return 'P2';
  if (status === 'confirmed_out_of_stock') return 'P4';
  // inventory_unknown, stale, authentication_required, captcha_required, parse_failed,
  // network_failed, supplier_unavailable — all P3 (never P4: a failure is not a zero).
  return 'P3';
}

/** P4 (confirmed out of stock) must not be shown; everything else may show (P3 degraded). */
export const shouldHideFromBrowse = (p: PriorityClass): boolean => p === 'P4';
