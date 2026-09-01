-- Orders source attribution — where a paid customer order came from.
--
-- WHY
--   XOne「交易履约」becomes the single operations console over three storefronts
--   (XSELF App, xselfhome.com, Meta Shop) plus manually-entered Marketplace
--   deals. All three ecommerce fronts already land in this one `orders` table,
--   so the console cannot tell them apart. This column is the only thing the
--   order pipeline was missing.
--
-- SAFETY — this migration is deliberately the smallest possible change:
--   * ADD COLUMN only. Nothing dropped, nothing renamed, no existing column's
--     meaning changed.
--   * NULLABLE with no default. A client that has never heard of `source`
--     keeps inserting exactly as before and the row stays valid.
--   * No UPDATE of existing rows. Historical orders keep `source IS NULL`
--     because their true origin is not recoverable from the data — and a
--     guessed origin is worse than an absent one: it looks just as
--     authoritative in the console as a real one.
--   * No touch of amounts, inventory, tax, payment, webhook or status logic.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS source text;

-- NULL stays legal on purpose (see above). The constraint only stops a typo or
-- a hostile client from inventing a fourth storefront that the console would
-- then render as an unknown badge.
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_source_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_source_check
  CHECK (source IS NULL OR source IN ('app', 'web', 'meta', 'unknown'));

-- Partial: historical rows are all NULL and are never filtered on by source.
CREATE INDEX IF NOT EXISTS orders_source_idx
  ON public.orders (source)
  WHERE source IS NOT NULL;

COMMENT ON COLUMN public.orders.source IS
  'Storefront the order originated from, normalized server-side in '
  'create-checkout-order: app | web | meta | unknown. '
  'NULL = created before attribution existed; origin unknown and NOT guessed. '
  'Read-only reporting/ops field — no pricing, inventory, tax, payment or '
  'status logic reads it.';
