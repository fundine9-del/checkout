-- ============================================================
-- Supermarket checkout schema (Supabase / Postgres)
-- Run this once in your Supabase project: Dashboard -> SQL Editor
-- ============================================================

-- The store's product catalogue. This is the "supermarket db" the
-- checkout server stays in sync with (see POST /api/sync/items).
create table if not exists public.items (
  id          uuid primary key default gen_random_uuid(),
  barcode     text unique not null,
  name        text not null,
  price       numeric(12, 2) not null check (price >= 0),
  category    text,
  stock       integer not null default 0 check (stock >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One customer visit. 'open' while they are scanning items,
-- 'paid' once checkout completes.
create table if not exists public.orders (
  id             uuid primary key default gen_random_uuid(),
  customer_name  text,
  status         text not null default 'open'
                   check (status in ('open', 'paid', 'cancelled')),
  payment_method text check (payment_method in ('cash', 'card', 'mobile')),
  total          numeric(12, 2) not null default 0,
  created_at     timestamptz not null default now(),
  paid_at        timestamptz
);

-- Line items. Price/name/barcode are snapshotted at scan time so the
-- receipt stays correct even if the catalogue changes afterwards.
create table if not exists public.order_items (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders (id) on delete cascade,
  item_id    uuid references public.items (id) on delete set null,
  barcode    text,
  name       text not null,
  price      numeric(12, 2) not null check (price >= 0),
  quantity   integer not null default 1 check (quantity > 0),
  created_at timestamptz not null default now(),
  unique (order_id, item_id)
);

create index if not exists idx_items_barcode          on public.items (barcode);
create index if not exists idx_items_category         on public.items (category);
create index if not exists idx_orders_status          on public.orders (status);
create index if not exists idx_orders_created_at      on public.orders (created_at desc);
create index if not exists idx_order_items_order_id   on public.order_items (order_id);

-- The checkout server connects with the service_role key, which bypasses
-- RLS. RLS is still enabled so anonymous/browser clients can never read or
-- write these tables directly; all access goes through the API.
alter table public.items       enable row level security;
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;