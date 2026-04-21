-- Supplier products table
-- Stores raw product data synced from the supplier pickup API.
-- Products here are NOT published to the storefront until reviewed.
-- Run this in the Supabase SQL Editor before running syncPickup.ts.

create table if not exists public.supplier_products (
  id                   uuid primary key default gen_random_uuid(),
  supplier_product_id  text not null unique,
  title                text not null,
  description          text,
  price                numeric(10, 2) not null,
  images               text[] not null default '{}',
  inventory            integer not null default 0,
  pickup_address       text,
  raw_payload          jsonb,
  published            boolean not null default false,
  synced_at            timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists supplier_products_supplier_id_idx
  on public.supplier_products(supplier_product_id);

create index if not exists supplier_products_published_idx
  on public.supplier_products(published);

-- Auto-update updated_at (reuse the function from addresses.sql if already created)
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists supplier_products_set_updated_at on public.supplier_products;
create trigger supplier_products_set_updated_at
  before update on public.supplier_products
  for each row execute function public.set_updated_at();

-- Row Level Security
-- The sync script uses a service-role key and bypasses RLS.
-- Authenticated app users can only read published products.
alter table public.supplier_products enable row level security;

create policy "Public can read published supplier products"
  on public.supplier_products for select
  using (published = true);

-- No insert/update/delete policies for app users — only service role can write.
