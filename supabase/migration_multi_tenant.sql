-- ============================================================
-- Multi-tenant migration: supermarkets
-- Run this in the Supabase SQL editor AFTER schema.sql.
-- Adds supermarket accounts and store scoping to items + orders.
-- ============================================================

-- One row per supermarket. owner_id links to a Supabase Auth user
-- (auth.users) so the dashboard can sign in with email + password.
create table if not exists public.supermarkets (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid unique references auth.users (id) on delete cascade,
  name       text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

-- Which store a product belongs to. NULL = shared catalogue (the feed
-- the checkout server syncs; visible to every scanner).
alter table public.items
  add column if not exists store_id uuid references public.supermarkets (id) on delete cascade;

-- Which store an order's sales belong to. NULL = not yet assigned
-- (the server assigns the default store when an order is created).
alter table public.orders
  add column if not exists store_id uuid references public.supermarkets (id);

create index if not exists idx_items_store          on public.items (store_id);
create index if not exists idx_orders_store         on public.orders (store_id);
create index if not exists idx_orders_store_status  on public.orders (store_id, status);

-- Let the service role manage these (RLS stays on for anonymous clients).
alter table public.supermarkets enable row level security;