-- Addresses table
-- Run this in the Supabase SQL Editor for your project.

create table if not exists public.addresses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  first_name  text not null,
  last_name   text not null,
  phone       text not null,
  address_line_1 text not null,
  address_line_2 text,
  city        text not null,
  state       text not null,
  zip         text not null,
  country     text not null default 'US',
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Index for per-user lookups
create index if not exists addresses_user_id_idx on public.addresses(user_id);

-- Automatically update updated_at on row change
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists addresses_set_updated_at on public.addresses;
create trigger addresses_set_updated_at
  before update on public.addresses
  for each row execute function public.set_updated_at();

-- Row Level Security
alter table public.addresses enable row level security;

create policy "Users can view their own addresses"
  on public.addresses for select
  using (auth.uid() = user_id);

create policy "Users can insert their own addresses"
  on public.addresses for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own addresses"
  on public.addresses for update
  using (auth.uid() = user_id);

create policy "Users can delete their own addresses"
  on public.addresses for delete
  using (auth.uid() = user_id);
