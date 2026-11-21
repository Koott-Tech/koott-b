-- 0028 - Sales targets, one row per month.
--
-- Finance sets a target for one month, several months or a whole year; it is stored per month
-- (a period total can be split evenly over its months). The target for any period = the sum
-- of its months. Sales are the dashboard's Total Revenue (session price by IST booking date).

create table if not exists finance_targets (
  month       date primary key,                -- first day of the month
  amount      numeric(14,2) not null check (amount >= 0),
  notes       text,
  updated_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint finance_targets_first_of_month check (extract(day from month) = 1)
);

alter table finance_targets enable row level security;  -- server (service role) only

notify pgrst, 'reload schema';
