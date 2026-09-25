-- ============================================================
-- Printers & print jobs migration: printer-agent feature
-- Run in the Supabase SQL editor AFTER migration_multi_tenant.sql
-- (and after migration_wallets.sql if you want the ledger counts).
--
-- Adds:
--   public.printers             - one registered receipt printer per
--                                 supermarket till (PRN-XXXXXX + agent token)
--   public.printer_connections  - which till/device is currently bonded
--                                 to a printer (last-seen heartbeat)
--   public.print_jobs           - receipt jobs queued for a printer, picked
--                                 up by the Check Out Printer Agent
--
-- Safe to re-run. RLS is enabled; the server (service role) bypasses it.
-- ============================================================

-- One registered receipt printer per till.
-- token is the secret the Printer Agent polls with (kept server-side;
-- the dashboard only shows it when generating the setup QR).
create table if not exists public.printers (
  id         text primary key,                    -- e.g. PRN-8F32A1
  store_id   uuid not null references public.supermarkets (id) on delete cascade,
  till       text not null,                       -- e.g. "Till 04" / "Till 01"
  token      text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists idx_printers_store on public.printers (store_id);

-- Which till/device is currently bonded to a printer. One row per printer
-- (unique) so the dashboard can upsert "connected here" without history.
create table if not exists public.printer_connections (
  id           uuid primary key default gen_random_uuid(),
  printer_id   text not null unique references public.printers (id) on delete cascade,
  device       text,
  connected_at timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);

-- Receipt jobs waiting for a printer agent. payload is a JSON snapshot of
-- the receipt (buildReceipt shape) so the agent never needs store auth.
create table if not exists public.print_jobs (
  id         uuid primary key default gen_random_uuid(),
  printer_id text not null references public.printers (id) on delete cascade,
  order_id   uuid not null references public.orders (id) on delete cascade,
  status     text not null default 'pending'
               check (status in ('pending', 'printing', 'done', 'failed')),
  payload    jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_print_jobs_printer
  on public.print_jobs (printer_id, status, created_at);

-- ---------------------------------------------------------------- rls
alter table public.printers             enable row level security;
alter table public.printer_connections  enable row level security;
alter table public.print_jobs           enable row level security;