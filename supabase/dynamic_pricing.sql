-- ── Dynamic Pricing Engine — Schema ──────────────────────────────────────────
-- Run this in the Supabase SQL Editor once to set up the pricing tables.
-- The Edge Function `dynamic-pricing` reads these columns and writes back
-- `selling_price` and `last_priced_at` after each pricing run.

-- ── 1. Analytics + pricing columns on standardized_products ──────────────────
alter table public.standardized_products
  add column if not exists view_count          integer      not null default 0,
  add column if not exists click_count         integer      not null default 0,
  add column if not exists add_to_cart_count   integer      not null default 0,
  add column if not exists order_count         integer      not null default 0,
  -- AI-managed selling price. NULL = not yet priced; app falls back to `price`.
  add column if not exists selling_price       numeric(10,2) null,
  add column if not exists last_priced_at      timestamptz   null;

-- Backfill selling_price to current price for existing rows
update public.standardized_products
  set selling_price = price
  where selling_price is null
    and normalization_status = 'done';

-- ── 2. Pricing audit log ──────────────────────────────────────────────────────
create table if not exists public.pricing_audit_log (
  id                   uuid         primary key default gen_random_uuid(),
  supplier_product_id  text         not null,
  sku                  text,
  old_price            numeric(10,2) not null,
  new_price            numeric(10,2) not null,
  state                text         not null,   -- high_demand | medium_demand | low_interest | overstock | neutral
  margin               numeric(8,4),            -- 0.0–1.0 e.g. 0.3250 = 32.5%
  stock_override       boolean      not null default false,
  margin_protected     boolean      not null default false,
  triggered_at         timestamptz  not null default now()
);

create index if not exists pricing_audit_log_sku_idx
  on public.pricing_audit_log (supplier_product_id);

create index if not exists pricing_audit_log_triggered_at_idx
  on public.pricing_audit_log (triggered_at desc);

-- Service role only; no public access to audit log
alter table public.pricing_audit_log enable row level security;

-- ── 3. Atomic counter increment RPC ──────────────────────────────────────────
-- Used by the frontend to atomically increment engagement counters.
-- SECURITY DEFINER runs as the table owner so anon users can UPDATE
-- without direct table UPDATE permission.

create or replace function public.increment_product_counter(
  p_supplier_product_id text,
  p_counter             text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Whitelist — only allowed counter names accepted
  if p_counter not in ('view_count', 'click_count', 'add_to_cart_count', 'order_count') then
    raise exception 'Invalid counter: %', p_counter;
  end if;

  execute format(
    'update public.standardized_products set %I = %I + 1 where supplier_product_id = $1',
    p_counter, p_counter
  ) using p_supplier_product_id;
end;
$$;

-- Allow frontend (anon + authenticated) to call the RPC
grant execute on function public.increment_product_counter(text, text) to anon;
grant execute on function public.increment_product_counter(text, text) to authenticated;

-- ── 3b. Profit-based pricing transparency columns ────────────────────────────
-- Run this section when upgrading from v1 (selling_price only) to v2 (profit-based).
-- All idempotent — safe to re-run.

alter table public.standardized_products
  -- MSRP / anchor price shown as strikethrough (set by pricing engine)
  add column if not exists original_price          numeric(10,2) null,
  -- Profit-based base retail before dynamic adjustments
  add column if not exists base_retail_price       numeric(10,2) null,
  -- Markup tier applied (e.g. 1.75 for $150–$400 cost range)
  add column if not exists pricing_markup          numeric(6,4)  null,
  -- Fulfillment/handling buffer added to base (e.g. $45)
  add column if not exists fulfillment_buffer      numeric(10,2) null,
  -- Estimated Stripe + tax fee amount at selling_price
  add column if not exists estimated_payment_fee   numeric(10,2) null,
  -- Net profit after cost, buffer, and payment fee
  add column if not exists estimated_net_profit    numeric(10,2) null,
  -- Net margin ratio (0.0–1.0)
  add column if not exists estimated_net_margin    numeric(8,4)  null;

-- Reset selling_price for all done products so the new engine prices from scratch.
-- The engine will overwrite with proper retail prices on its next run.
-- NOTE: This will temporarily show supplier cost on-screen until the engine runs.
-- Run the engine immediately after applying this migration.
update public.standardized_products
  set selling_price  = null,
      original_price = null
  where normalization_status = 'done';

-- ── 4. Schedule the pricing engine (run these manually in the SQL editor) ─────
--
-- Requires pg_cron and pg_net extensions enabled in the Supabase dashboard:
--   Dashboard → Database → Extensions → enable "pg_cron" and "pg_net"
--
-- Then run the following in the Supabase SQL Editor (replace <service_role_key>):
--
--   select cron.schedule(
--     'dynamic-pricing-6h',
--     '0 */6 * * *',
--     $$
--     select net.http_post(
--       url     := 'https://erbimgfbztkzmpamzwky.supabase.co/functions/v1/dynamic-pricing',
--       headers := jsonb_build_object(
--         'Content-Type',  'application/json',
--         'Authorization', 'Bearer <service_role_key>'
--       ),
--       body    := '{}'::jsonb
--     ) as request_id;
--     $$
--   );
--
-- To verify the schedule is registered:
--   select * from cron.job;
--
-- To unschedule:
--   select cron.unschedule('dynamic-pricing-6h');
--
-- To run immediately (without waiting for the schedule):
--   select net.http_post(
--     url     := 'https://erbimgfbztkzmpamzwky.supabase.co/functions/v1/dynamic-pricing',
--     headers := jsonb_build_object(
--       'Content-Type',  'application/json',
--       'Authorization', 'Bearer <service_role_key>'
--     ),
--     body    := '{}'::jsonb
--   );
