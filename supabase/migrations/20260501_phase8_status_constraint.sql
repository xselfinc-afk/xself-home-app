-- Phase 8: Extend orders.status check constraint with Phase 8 lifecycle values.
-- The existing constraint only covers the pre-Phase-8 status set.
-- This migration drops and recreates the constraint to include Phase 8 values.
-- Safe to re-run: IF NOT EXISTS on the new constraint name.

-- Drop the existing constraint (name may vary — try both common patterns)
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check1;

-- Recreate with the full set: existing values + Phase 8 additions
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    -- Pre-Phase-8 (preserved for backward compatibility)
    'pending',
    'processing',
    'shipped',
    'delivered',
    'pending_pickup',
    'ready_for_pickup',
    'picked_up',
    'failed',
    'cancelled',
    -- Phase 8 additions
    'pending_payment',   -- order created, awaiting Stripe confirmation
    'paid',              -- webhook confirmed payment (non-pickup)
    'canceled',          -- Stripe PI canceled (American spelling for new code)
    'abandoned'          -- TTL expired / PI creation failed
  ));
