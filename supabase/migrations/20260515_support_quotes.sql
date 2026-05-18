-- ─────────────────────────────────────────────────────────────────────────────
-- Phase A — Custom Quote / Special Offer MVP
--
-- Adds the support_quotes table for agent-created custom prices, plus the
-- orders.quote_id reference column. Customer-side discovery and checkout
-- redemption flow are wired in subsequent migrations / code phases.
--
-- Guardrails (server-enforced via CHECK constraints):
--   - quoted_price_cents must be >= 5000 ($50 floor — never sell below this).
--   - quoted_price_cents must be >= 50% of original_price_cents (no deep
--     discounts via the quote tool).
--   - quoted_price_cents must be <= original_price_cents (quotes can't be
--     used to overcharge — the agent-create-quote edge function also
--     enforces this with a clear error message).
--   - max_qty between 1 and 10 (single-item buy-now scope).
--
-- RLS:
--   - Authenticated users read ONLY their own active, non-expired quotes.
--   - Service-role (edge functions) bypasses RLS for writes / reads.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists citext;     -- case-insensitive customer_email

create table if not exists support_quotes (
  id                   uuid        primary key default gen_random_uuid(),
  redeem_token         text        not null unique,
  product_id           text        not null,
  supplier_sku         text        not null,
  customer_email       citext      not null,
  user_id              uuid        null,
  quoted_price_cents   integer     not null check (quoted_price_cents >= 5000),
  original_price_cents integer     not null check (original_price_cents > 0),
  currency             text        not null default 'USD',
  max_qty              integer     not null default 1
                                   check (max_qty between 1 and 10),
  crisp_session_id     text        null,
  created_by_agent     text        not null,
  status               text        not null default 'active'
                                   check (status in ('active','used','expired','revoked')),
  -- orders.order_id is `text` (idempotency key, e.g. ord_xxx). Must match.
  order_id             text        null,
  used_at              timestamptz null,
  expires_at           timestamptz not null,
  revoked_at           timestamptz null,
  revoked_reason       text        null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint quoted_at_least_half_original
    check (quoted_price_cents * 2 >= original_price_cents),
  constraint quoted_at_most_original
    check (quoted_price_cents <= original_price_cents)
);

-- FK to product. Deferrable so cross-table edits in one txn don't trip.
alter table support_quotes
  add constraint support_quotes_product_id_fk
  foreign key (product_id) references standardized_products (supplier_product_id)
  deferrable initially deferred;

-- FK to orders for redemption audit trail.
alter table support_quotes
  add constraint support_quotes_order_id_fk
  foreign key (order_id) references orders (order_id);

-- Hot path: app fetches active quote by (email, product). Partial index keeps
-- it tiny since only "active" rows matter for the lookup.
create index if not exists support_quotes_customer_active_idx
  on support_quotes (customer_email, product_id)
  where status = 'active';

create index if not exists support_quotes_redeem_token_idx
  on support_quotes (redeem_token);

-- updated_at trigger
create or replace function set_support_quotes_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_support_quotes_updated_at on support_quotes;
create trigger trg_support_quotes_updated_at
  before update on support_quotes
  for each row execute function set_support_quotes_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table support_quotes enable row level security;

-- Authenticated user can read their own active, non-expired quotes.
-- Note: redeem_token is included in the row, but the policy gates access by
-- the JWT-asserted email so a customer can only read quotes addressed to them.
drop policy if exists support_quotes_user_read on support_quotes;
create policy support_quotes_user_read on support_quotes
  for select to authenticated
  using (
    status = 'active'
    and expires_at > now()
    and lower(customer_email::text) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

-- Writes are service-role only — no INSERT/UPDATE/DELETE policies for
-- authenticated / anon. Service role bypasses RLS.

-- ── orders.quote_id ─────────────────────────────────────────────────────────
alter table orders add column if not exists quote_id uuid null
  references support_quotes (id);

create index if not exists orders_quote_id_idx
  on orders (quote_id) where quote_id is not null;
