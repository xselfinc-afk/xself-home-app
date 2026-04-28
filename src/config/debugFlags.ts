/**
 * Debug flags for development-only simulation of failure states.
 *
 * ALL flags must remain false in committed code.
 * Flags are guarded by __DEV__ — they have zero effect in production builds.
 *
 * Usage: flip a flag to true locally, test the failure path, then reset to false.
 */
export const DEBUG_FLAGS = {
  /** Force fulfillment plan to appear as a fallback (no live inventory). */
  forceInventoryFallback: false,
  /** Force inventory check to report unavailable (blocks checkout entirely). */
  forceInventoryUnavailable: false,
  /** Force address save to throw — tests the address save error banner. */
  forceAddressSaveFailure: false,
  /** Force payment to fail before any Stripe call is made. */
  forcePaymentFailure: false,
  /** Force completeOrder to throw — tests post-payment order-save error path. */
  forceOrderSaveFailure: false,
  /** Show a small DEBUG MODE badge on screens that read these flags. */
  showDebugBadges: __DEV__,
} as const;
