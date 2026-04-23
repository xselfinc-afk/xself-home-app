-- giga_products: raw product catalog scraped from the GIGA seller portal.
-- Populated by scripts/syncGigaFurnitureCatalog.ts
-- The normalization pipeline reads this table and writes to standardized_products.

CREATE TABLE IF NOT EXISTS giga_products (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id          text NOT NULL UNIQUE,         -- from URL: product_id=N
  product_url         text NOT NULL,
  title               text NOT NULL DEFAULT '',
  price_text          text NOT NULL DEFAULT '',      -- raw price string, e.g. "$1,299.99"
  image_url           text NOT NULL DEFAULT '',
  item_code           text,                          -- visible item/model code on listing card
  top_category        text NOT NULL DEFAULT 'Furniture',
  sub_category        text,                          -- subcategory name, e.g. "Bedroom Furniture"
  source_page         text,                          -- listing page URL this card was found on
  raw_payload         jsonb,                         -- full card data for debugging / re-parsing
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_synced_at      timestamptz NOT NULL DEFAULT now()
);

-- Fast lookup by product_id (used by inventory and normalization pipelines)
CREATE INDEX IF NOT EXISTS idx_giga_products_product_id
  ON giga_products (product_id);

-- Filter by subcategory for partial syncs
CREATE INDEX IF NOT EXISTS idx_giga_products_sub_category
  ON giga_products (sub_category);

-- Staleness check
CREATE INDEX IF NOT EXISTS idx_giga_products_last_synced
  ON giga_products (last_synced_at DESC);
