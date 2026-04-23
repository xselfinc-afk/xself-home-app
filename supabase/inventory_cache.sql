-- inventory_cache: warehouse-level stock per product.
-- Sources:
--   'price_synthesis'  — synthesised from GIGA price/v1 skuAvailable signal
--   'website_scrape'   — scraped directly from the GIGA seller portal (Playwright)
-- sync_status: 'pending' | 'ok' | 'error'

CREATE TABLE IF NOT EXISTS inventory_cache (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id          text NOT NULL,           -- supplier_product_id (GIGA native SKU)
  supplier_product_id text NOT NULL,
  warehouse_code      text NOT NULL,           -- e.g. 'CA2', 'NJ1', 'AT1'
  warehouse_state     text,                    -- 'CA' | 'NJ' | 'MD' | 'GA' | 'TX'
  warehouse_city      text,
  quantity            integer,                 -- final usable quantity (exact or totalAvailable override)
  quantity_floor      integer,                 -- floor from raw text ("10+" → 10)
  quantity_raw        text,                    -- original cell text, e.g. "10+", "100+", "8"
  quantity_exact      boolean NOT NULL DEFAULT false,   -- true when quantity is exact (no "+")
  total_available     integer,                 -- top-level "N Available" from product page
  is_available        boolean NOT NULL DEFAULT false,
  supports_pickup     boolean NOT NULL DEFAULT false,
  supports_shipping   boolean NOT NULL DEFAULT true,
  last_synced_at      timestamptz NOT NULL DEFAULT now(),
  sync_status         text NOT NULL DEFAULT 'pending',
  source_type         text NOT NULL DEFAULT 'price_synthesis',
  raw_payload         jsonb,
  CONSTRAINT uq_inventory_cache_product_warehouse UNIQUE (product_id, warehouse_code)
);

-- Migration: add new columns to existing installs (safe to run multiple times)
ALTER TABLE inventory_cache ADD COLUMN IF NOT EXISTS quantity_floor    integer;
ALTER TABLE inventory_cache ADD COLUMN IF NOT EXISTS quantity_raw      text;
ALTER TABLE inventory_cache ADD COLUMN IF NOT EXISTS quantity_exact    boolean NOT NULL DEFAULT false;
ALTER TABLE inventory_cache ADD COLUMN IF NOT EXISTS total_available   integer;

-- Fast lookup by product_id (used by checkout and ranking queries)
CREATE INDEX IF NOT EXISTS idx_inventory_cache_product_id
  ON inventory_cache (product_id);

-- CA pickup availability — used for product ranking on Home/Discover
CREATE INDEX IF NOT EXISTS idx_inventory_cache_ca_pickup
  ON inventory_cache (product_id, is_available)
  WHERE warehouse_state = 'CA' AND is_available = true;

-- Staleness check — find entries older than TTL
CREATE INDEX IF NOT EXISTS idx_inventory_cache_synced_at
  ON inventory_cache (last_synced_at DESC);
