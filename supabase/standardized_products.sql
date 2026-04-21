-- Standardized products table
-- Clean, normalized product data derived from supplier_products.
-- The normalization pipeline reads supplier_products and writes here.
-- The app reads ONLY from this table (never supplier_products directly).
-- Run this in the Supabase SQL Editor before running normalizeProducts.ts.

create table if not exists public.standardized_products (
  id                     uuid primary key default gen_random_uuid(),

  -- Reference to the source row (not a hard FK to allow independent lifecycle)
  supplier_product_id    text not null unique,

  product_title          text not null,
  short_description      text not null default '',

  key_features_json      jsonb not null default '[]',   -- string[]
  specifications_json    jsonb not null default '{}',   -- Record<string,string>

  sku_custom             text not null default '',
  sku_search             text null,                             -- uppercase, non-alphanumeric stripped; for partial SKU matching

  category_label         text null,                             -- normalized label: Cabinet | Dresser | TV Stand | … | Other
  category_priority      integer null,                          -- UI sort order: Dresser=10, Cabinet=20, …, Other=999
  is_new_arrival         boolean not null default false,        -- true when API or recency signals a new product
  new_arrival_source     text null,                             -- 'api' | 'raw' | 'fallback' | 'none'

  category_code          text not null default '',
  scene_code             text not null default '',

  color                  text not null default '',
  color_options_json     jsonb not null default '[]',   -- string[]
  has_multiple_colors    boolean not null default false,
  show_color_selector    boolean not null default false,

  material               text not null default '',
  dimensions             text not null default '',
  weight                 text not null default '',

  primary_image          text not null default '',
  gallery_images_json    jsonb not null default '[]',   -- string[]

  price                  numeric(10, 2) not null default 0,
  original_price         numeric(10, 2) null,              -- list price when a discount exists; null = no discount

  normalization_status   text not null default 'pending',  -- 'pending' | 'done' | 'error'

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists standardized_products_supplier_id_idx
  on public.standardized_products(supplier_product_id);

create index if not exists standardized_products_category_idx
  on public.standardized_products(category_code);

create index if not exists standardized_products_status_idx
  on public.standardized_products(normalization_status);

-- Auto-update updated_at (reuses the function created in supplier_products.sql)
drop trigger if exists standardized_products_set_updated_at on public.standardized_products;
create trigger standardized_products_set_updated_at
  before update on public.standardized_products
  for each row execute function public.set_updated_at();

-- Row Level Security
-- The normalization script uses a service-role key and bypasses RLS.
-- App users can read rows that have been fully normalized.
alter table public.standardized_products enable row level security;

create policy "Public can read normalized products"
  on public.standardized_products for select
  using (normalization_status = 'done');

-- ── Migration: add category/new-arrival fields to existing deployments ──────────
-- Run once in the Supabase SQL Editor if the table already exists:
--
--   alter table public.standardized_products
--     add column if not exists category_label     text null,
--     add column if not exists category_priority  integer null,
--     add column if not exists is_new_arrival     boolean not null default false,
--     add column if not exists new_arrival_source text null;
--
-- After running the migration, re-run scripts/normalizeProducts.ts to backfill.

-- ── Migration: add sku_search to existing deployments ───────────────────────────
-- Run this once in the Supabase SQL Editor if the table already exists:
--
--   alter table public.standardized_products
--     add column if not exists sku_search text null;
--
-- After running the migration, re-run scripts/normalizeProducts.ts to backfill.

-- ── Migration: add original_price to existing deployments ─────────────────────
-- Run this once in the Supabase SQL Editor if the table already exists:
--
--   alter table public.standardized_products
--     add column if not exists original_price numeric(10, 2) null;
--
-- After running the migration, re-run scripts/normalizeProducts.ts so the
-- pipeline backfills original_price for all existing rows.
