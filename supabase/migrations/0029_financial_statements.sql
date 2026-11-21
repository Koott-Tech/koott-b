-- 0029 - Profit & Loss and Balance Sheet.
--
-- fixed_assets          laptops, furniture, equipment… bought for the company. They go on the
--                       Balance Sheet and are depreciated straight-line over their useful life
--                       (the depreciation is the P&L expense), instead of being an expense the
--                       day they are bought. expense_id links an asset recorded from an
--                       existing expense, so that expense is not counted twice.
-- balance_sheet_items   what the system can't work out by itself: bank / cash balances,
--                       capital, loans, deposits, GST / TDS paid… Each row is the balance of
--                       one item on one date; the Balance Sheet uses each item's latest row on
--                       or before its date.
-- expense_categories.pl_group  P&L heading for an expense category (blank = guessed from name).

create table if not exists fixed_assets (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  category             text not null default 'Other',
  purchase_date        date not null,
  cost                 numeric(14,2) not null check (cost >= 0),
  salvage_value        numeric(14,2) not null default 0 check (salvage_value >= 0),
  useful_life_months   integer not null check (useful_life_months > 0),
  vendor               text,
  invoice_ref          text,
  expense_id           uuid unique,
  disposed_date        date,
  disposal_amount      numeric(14,2),
  notes                text,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint fixed_assets_salvage_le_cost check (salvage_value <= cost)
);
create index if not exists fixed_assets_purchase_idx on fixed_assets (purchase_date);

create table if not exists balance_sheet_items (
  id          uuid primary key default gen_random_uuid(),
  section     text not null check (section in ('cash_bank', 'current_asset', 'non_current_asset',
                                                'current_liability', 'non_current_liability', 'equity')),
  name        text not null,
  amount      numeric(14,2) not null,
  as_of       date not null,
  notes       text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (section, name, as_of)
);
create index if not exists balance_sheet_items_asof_idx on balance_sheet_items (as_of);

alter table expense_categories add column if not exists pl_group text;

alter table fixed_assets enable row level security;         -- server (service role) only
alter table balance_sheet_items enable row level security;

notify pgrst, 'reload schema';
