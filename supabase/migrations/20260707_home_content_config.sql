-- 20260707_home_content_config.sql
-- Server-controlled key/value config read by:
--   src/services/homeContentService.ts (screen='home')
--   src/services/adsConfigService.ts   (screen='ads')
-- Both filter is_active=true and fall back to code defaults on error → additive & safe.
-- Ships ads OFF: seeded ads_* flags are 'false'.
-- Idempotent: safe to re-run (create if not exists / drop-if-exists / on conflict do nothing).

-- 1. Table --------------------------------------------------------------------
create table if not exists public.home_content_config (
  id          uuid        primary key default gen_random_uuid(),
  screen      text        not null,
  key         text        not null,
  value       text,                                   -- nullable; services guard null/''
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint home_content_config_screen_key_uniq unique (screen, key)
);

comment on table public.home_content_config is
  'Server-controlled key/value config (screen,key)->value. App clients read active rows only; writes are service-role only.';

-- 2. Index for the app query pattern (screen + is_active) ----------------------
create index if not exists home_content_config_screen_active_idx
  on public.home_content_config (screen) where is_active;

-- 3. updated_at trigger (matches repo convention) -----------------------------
create or replace function public.home_content_config_touch_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_hcc_touch_updated_at on public.home_content_config;
create trigger trg_hcc_touch_updated_at
  before update on public.home_content_config
  for each row execute function public.home_content_config_touch_updated_at();

-- 4. RLS: clients read ACTIVE rows only; no client writes ----------------------
alter table public.home_content_config enable row level security;

drop policy if exists home_content_config_read_active on public.home_content_config;
create policy home_content_config_read_active on public.home_content_config
  for select to anon, authenticated
  using (is_active = true);

grant  select                 on public.home_content_config to anon, authenticated;
revoke insert, update, delete on public.home_content_config from anon, authenticated;
-- No write policies for anon/authenticated ⇒ clients cannot write.
-- service_role bypasses RLS, so server/admin writes still work.

-- 5. Seed rows: ADS (all OFF) + HOME titles (current code defaults) ------------
--    on conflict do nothing ⇒ re-running never overwrites later dashboard edits.
insert into public.home_content_config (screen, key, value, is_active) values
  ('ads',  'ads_enabled',                   'false', true),
  ('ads',  'ads_app_open_enabled',          'false', true),
  ('ads',  'ads_app_open_min_interval_sec', '14400', true),
  ('home', 'home.section.new_arrivals', 'New This Season',        true),
  ('home', 'home.section.top_picks',    'Handpicked For You',     true),
  ('home', 'home.section.best_sellers', 'Loved By Our Customers', true),
  ('home', 'home.section.all_products', 'Explore All Products',   true)
on conflict (screen, key) do nothing;

-- Rollback (manual):
--   drop table if exists public.home_content_config cascade;
--   drop function if exists public.home_content_config_touch_updated_at();
