-- ============================================================
-- Fiscal receipt migration (KRA-style receipts)
-- Run in the Supabase SQL editor AFTER the other migrations.
-- Adds store receipt identity + per-item VAT rate so receipts can
-- carry VAT # / PIN / Till No and a VAT breakdown.
-- ============================================================

-- Store identity printed at the top of every receipt.
alter table public.supermarkets
  add column if not exists vat_number text;
alter table public.supermarkets
  add column if not exists pin text;
alter table public.supermarkets
  add column if not exists till_number text;

-- VAT rate for each product (default: 16 = Kenya standard rate).
-- 0 = zero-rated / exempt. Snapshot into order_items at scan time.
alter table public.items
  add column if not exists vat_rate numeric(5, 2) not null default 16
    check (vat_rate >= 0 and vat_rate <= 100);

alter table public.order_items
  add column if not exists vat_rate numeric(5, 2) not null default 16;