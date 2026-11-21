-- 0030 - TDS deposited to the government.
--
-- 10% TDS is deducted from every therapist payout (payouts.tds_amount). Until it is paid to the
-- government it is a liability (TDS payable). Each challan paid is one row here, against the
-- month the TDS was deducted in. TDS payable on any date = deducted − deposited up to that date.

create table if not exists tds_deposits (
  id            uuid primary key default gen_random_uuid(),
  period_month  date not null,                 -- first day of the month the TDS was deducted in
  deposit_date  date not null,
  amount        numeric(14,2) not null check (amount > 0),
  section       text not null default '194J',
  challan_no    text,                          -- challan / CIN / BSR + serial
  notes         text,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint tds_deposits_first_of_month check (extract(day from period_month) = 1)
);
create index if not exists tds_deposits_period_idx on tds_deposits (period_month);
create index if not exists tds_deposits_date_idx on tds_deposits (deposit_date);

alter table tds_deposits enable row level security;  -- server (service role) only

notify pgrst, 'reload schema';
