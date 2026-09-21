-- ============================================================
-- Wallets & transactions migration: users, wallets, transactions
-- Run in the Supabase SQL editor AFTER migration_multi_tenant.sql.
--
-- Adds:
--   public.users        - one profile per Supabase Auth account
--   public.wallets      - one earning balance per supermarket
--   public.transactions - ledger entries (payments, withdrawals, refunds)
--   credit_wallet()     - atomic wallet credit used at checkout
--
-- Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------ users
-- Public profile, one row per Supabase Auth account. The auth.users
-- table itself is managed by Supabase, so app data lives here.
create table if not exists public.users (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  full_name  text,
  created_at timestamptz not null default now()
);

-- Keep a public profile in sync with every new auth account.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------- wallets
-- One earning balance per supermarket. Credited by credit_wallet().
create table if not exists public.wallets (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null unique references public.supermarkets (id) on delete cascade,
  currency   text not null default 'KES',
  balance    numeric(14,2) not null default 0,
  total_in   numeric(14,2) not null default 0,
  total_out  numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Every supermarket (incl. the default/demo store) gets a wallet
-- automatically when the store row is created.
create or replace function public.handle_new_supermarket()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.wallets (store_id) values (new.id)
  on conflict (store_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_supermarket_created on public.supermarkets;
create trigger on_supermarket_created
  after insert on public.supermarkets
  for each row execute function public.handle_new_supermarket();

-- ----------------------------------------------------- transactions
create table if not exists public.transactions (
  id             uuid primary key default gen_random_uuid(),
  wallet_id      uuid not null references public.wallets (id) on delete cascade,
  store_id       uuid not null references public.supermarkets (id) on delete cascade,
  order_id       uuid references public.orders (id) on delete set null,
  type           text not null default 'payment'
                   check (type in ('payment','refund','withdrawal','deposit')),
  amount         numeric(14,2) not null,
  balance_after  numeric(14,2) not null,
  payment_method text check (payment_method in ('cash','card','mobile')),
  status         text not null default 'completed'
                   check (status in ('pending','completed','failed')),
  reference      text,
  description    text,
  created_at     timestamptz not null default now()
);

create index if not exists idx_transactions_wallet on public.transactions (wallet_id, created_at desc);
create index if not exists idx_transactions_store  on public.transactions (store_id, created_at desc);
create index if not exists idx_transactions_order  on public.transactions (order_id) where order_id is not null;
-- At most one 'payment' per order -> retries and backfills are idempotent.
create unique index if not exists uq_transactions_payment_order
  on public.transactions (order_id) where type = 'payment';

-- Atomic wallet credit: locks the wallet row, appends a ledger entry and
-- updates balance/totals in one shot. Duplicate order id -> error 23505.
create or replace function public.credit_wallet(
  p_store_id        uuid,
  p_order_id        uuid,
  p_amount          numeric,
  p_payment_method  text default null,
  p_reference       text default null,
  p_description     text default null
) returns public.transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.wallets%rowtype;
  v_tx     public.transactions%rowtype;
begin
  select * into v_wallet from public.wallets where store_id = p_store_id for update;
  if not found then
    insert into public.wallets (store_id) values (p_store_id)
    returning * into v_wallet;
  end if;

  v_tx.balance_after := v_wallet.balance + p_amount;

  insert into public.transactions (
    wallet_id, store_id, order_id, type, amount, balance_after,
    payment_method, status, reference, description
  ) values (
    v_wallet.id, p_store_id, p_order_id, 'payment', p_amount, v_tx.balance_after,
    p_payment_method, 'completed', coalesce(p_reference, p_order_id::text), p_description
  )
  returning * into v_tx;

  update public.wallets set
    balance    = v_tx.balance_after,
    total_in   = v_wallet.total_in + p_amount,
    updated_at = now()
  where id = v_wallet.id;

  return v_tx;
end;
$$;

-- --------------------------------------------------------- backfill
-- Profiles for auth accounts that already exist.
insert into public.users (id, email, full_name)
select id, email, coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name')
from auth.users
on conflict (id) do nothing;

-- Wallets for existing supermarkets (incl. the default/demo store).
insert into public.wallets (store_id)
select id from public.supermarkets
on conflict (store_id) do nothing;

-- One 'payment' ledger row per historical paid order.
insert into public.transactions (
  wallet_id, store_id, order_id, type, amount, balance_after,
  payment_method, status, reference, description
)
select
  w.id,
  o.store_id,
  o.id,
  'payment',
  o.total,
  0,
  o.payment_method,
  'completed',
  o.id::text,
  'Order checkout (backfill)'
from public.orders o
join public.wallets w on w.store_id = o.store_id
where o.status = 'paid'
  and o.total > 0
  and not exists (
    select 1 from public.transactions t
    where t.order_id = o.id and t.type = 'payment'
  );

-- Recompute each transaction's running balance so the ledger is truthful.
with ordered as (
  select id,
         sum(case when type in ('payment','deposit') then amount else -amount end)
           over (partition by wallet_id order by created_at, id) as running
  from public.transactions
  where status = 'completed'
)
update public.transactions t
set balance_after = ordered.running
from ordered
where t.id = ordered.id;

-- Recompute every wallet balance from its completed ledger entries.
update public.wallets w set
  balance    = coalesce((
    select sum(case when t.type in ('payment','deposit') then t.amount else -t.amount end)
    from public.transactions t
    where t.wallet_id = w.id and t.status = 'completed'
  ), 0),
  total_in   = coalesce((
    select sum(t.amount) from public.transactions t
    where t.wallet_id = w.id and t.status = 'completed' and t.type in ('payment','deposit')
  ), 0),
  total_out  = coalesce((
    select sum(t.amount) from public.transactions t
    where t.wallet_id = w.id and t.status = 'completed' and t.type in ('refund','withdrawal')
  ), 0),
  updated_at = now();

-- ---------------------------------------------------------------- rls
-- The server (service role) bypasses RLS, so no policies are needed;
-- direct public reads via the anon key are denied.
alter table public.users        enable row level security;
alter table public.wallets      enable row level security;
alter table public.transactions enable row level security;