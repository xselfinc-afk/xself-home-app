-- Migration: add product_family_key to standardized_products
-- Run this in the Supabase SQL Editor after standardized_products.sql has been applied.
-- After running, re-execute scripts/normalizeProducts.ts to populate the column.

alter table public.standardized_products
  add column if not exists product_family_key text not null default '';

create index if not exists standardized_products_family_key_idx
  on public.standardized_products(product_family_key);
