-- Orders table — persists checkout transactions with full order snapshot
-- Each row is created as 'pending' before Stripe is called, then updated
-- to 'processing'/'pending_pickup' after payment confirmation.

create table if not exists public.orders (
  id                        uuid primary key default gen_random_uuid(),
  order_id                  text not null unique,          -- internal idempotency key (ord_...)
  order_number              text not null,                 -- human-readable display (XS-12345)
  user_id                   uuid references auth.users(id) on delete set null,
  guest_email               text,                          -- nullable; set for guest checkouts
  status                    text not null default 'pending'
                            check (status in (
                              'pending','processing','shipped','delivered',
                              'pending_pickup','ready_for_pickup','picked_up',
                              'failed','cancelled'
                            )),
  payment_status            text not null default 'pending'
                            check (payment_status in ('pending','paid','failed')),
  stripe_payment_intent_id  text,
  total                     numeric(10,2) not null,
  subtotal                  numeric(10,2) not null default 0,
  shipping_total            numeric(10,2) not null default 0,
  tax                       numeric(10,2) not null default 0,
  date                      text,                          -- human-readable date string (Apr 15, 2026)
  address_json              jsonb,
  items_json                jsonb not null default '[]',
  fulfillment_groups_json   jsonb not null default '[]',
  checkout_session_id       text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- Keep updated_at current on every write
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- Indexes
create index if not exists orders_user_id_idx  on public.orders(user_id);
create index if not exists orders_order_id_idx on public.orders(order_id);
create index if not exists orders_stripe_pi_idx on public.orders(stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- ── Row Level Security ────────────────────────────────────────────────────────
alter table public.orders enable row level security;

-- Authenticated users can read their own orders
create policy "users_select_own_orders"
  on public.orders for select
  to authenticated
  using (auth.uid() = user_id);

-- Authenticated users can insert their own orders
create policy "users_insert_own_orders"
  on public.orders for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Authenticated users can update their own orders
-- (status transitions: pending → processing/cancelled, etc.)
create policy "users_update_own_orders"
  on public.orders for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Anonymous / guest: insert allowed (user_id must be null for anon inserts)
create policy "anon_insert_guest_orders"
  on public.orders for insert
  to anon
  with check (user_id is null);

-- No anon or cross-user select
