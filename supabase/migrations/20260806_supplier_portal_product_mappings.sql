-- ============================================================================
-- Supplier SKU → website product_id mapping  (website identity layer)
--
-- WHY A NEW TABLE RATHER THAN A COLUMN ON AN EXISTING ONE
-- -------------------------------------------------------
-- The website's numeric product_id belongs to the FAVORITES chain, not the inventory chain. It
-- exists so the wishlist XHR can address the right product; nothing about stock, price or
-- publication depends on it. Putting it on standardized_products or supplier_products would wire a
-- website-scrape identity into tables the API inventory chain owns, which is exactly the coupling
-- the favorites/inventory separation exists to prevent.
--
-- It is emphatically NOT inventory_cache.product_id. That column holds a copy of
-- supplier_product_id — every row of it — and a handful of SKUs that happen to be all digits would
-- pass a naive numeric check and address an unrelated product. This table is the only acceptable
-- source of a website identity.
--
-- ADDITIVE ONLY. No existing table, view, function, policy or row is altered.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.supplier_portal_product_mappings (
  supplier_product_id text        PRIMARY KEY,

  -- The site's numeric product_id. Stored as bigint so a SKU can never masquerade as one.
  website_product_id  bigint      NOT NULL,

  -- The SKU the product's own portal detail page reported. The mapping is only trustworthy while
  -- this equals supplier_product_id, and that is re-checked on every read.
  portal_sku          text        NOT NULL,

  source              text        NOT NULL DEFAULT 'supplier_portal',
  confidence          text        NOT NULL DEFAULT 'exact',

  resolved_at         timestamptz NOT NULL DEFAULT now(),
  last_verified_at    timestamptz NOT NULL DEFAULT now(),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- Only portal-proven, exactly-matched mappings may exist at all. A looser row cannot be written.
  CONSTRAINT sppm_source_chk     CHECK (source = 'supplier_portal'),
  CONSTRAINT sppm_confidence_chk CHECK (confidence = 'exact'),
  CONSTRAINT sppm_pid_positive   CHECK (website_product_id > 0),
  -- The reverse check, enforced by the database and not only by application code.
  CONSTRAINT sppm_reverse_chk    CHECK (portal_sku = supplier_product_id),
  -- A SKU echoed as its own id is the inventory_cache failure mode. Reject it structurally.
  CONSTRAINT sppm_not_self_copy  CHECK (website_product_id::text <> supplier_product_id)
);

COMMENT ON TABLE public.supplier_portal_product_mappings IS
  'Supplier SKU → website numeric product_id, proven per SKU against the supplier portal and '
  'verified in reverse. Owned by the favorites/website-identity chain. Never populated from '
  'inventory_cache, and never read by the inventory chain.';

COMMENT ON COLUMN public.supplier_portal_product_mappings.website_product_id IS
  'The site product_id used by account/wishlist/{addProductsToWish,delProductsFromWish}.';

COMMENT ON COLUMN public.supplier_portal_product_mappings.portal_sku IS
  'SKU reported by the product detail page for website_product_id. Must equal supplier_product_id.';

CREATE INDEX IF NOT EXISTS sppm_last_verified_idx
  ON public.supplier_portal_product_mappings (last_verified_at);
