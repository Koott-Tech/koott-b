-- ============================================================================
-- 0003 — discount coupons
--
-- Two tables:
--   coupons             the code and its rules, created from the admin dashboard
--   coupon_redemptions  one row per successful use, so usage limits are enforced
--                       against real data rather than a counter that can drift
--
-- Discount is either a percentage or a flat rupee amount, decided by
-- discount_type. `max_discount_amount` caps a percentage coupon so "50% off"
-- cannot take an unbounded amount off a large package.
--
-- Safe to re-run.
-- ============================================================================

create table if not exists coupons (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null,
  description           text,

  -- 'percentage' -> discount_value is 1..100
  -- 'fixed'      -> discount_value is rupees off
  discount_type         text not null default 'percentage',
  discount_value        numeric(10,2) not null,

  -- Caps a percentage discount; ignored for fixed coupons.
  max_discount_amount   numeric(10,2),
  -- Coupon only applies when the order is at least this much.
  min_order_amount      numeric(10,2) default 0,

  -- Validity window. valid_from defaults to creation time; expires_at is what
  -- the admin sets, either as a date/time or derived from "expires in N days".
  valid_from            timestamptz not null default now(),
  expires_at            timestamptz,

  -- null = unlimited. per_user_limit caps how often one client may redeem it.
  max_redemptions       integer,
  per_user_limit        integer default 1,

  -- Denormalised running total, kept in step by the redemption insert. The
  -- authoritative count is always count(*) on coupon_redemptions.
  redemption_count      integer not null default 0,

  is_active             boolean not null default true,
  created_by            uuid references users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Codes are matched case-insensitively, so uniqueness has to be too.
create unique index if not exists coupons_code_lower_key on coupons (lower(code));
create index if not exists coupons_active_idx on coupons (is_active, expires_at);

create table if not exists coupon_redemptions (
  id                uuid primary key default gen_random_uuid(),
  coupon_id         uuid not null references coupons(id) on delete cascade,
  client_id         uuid references clients(id) on delete set null,
  session_id        uuid references sessions(id) on delete set null,
  payment_id        uuid references payments(id) on delete set null,
  order_id          text,
  original_amount   numeric(10,2) not null,
  discount_amount   numeric(10,2) not null,
  final_amount      numeric(10,2) not null,
  redeemed_at       timestamptz not null default now()
);

create index if not exists coupon_redemptions_coupon_idx on coupon_redemptions (coupon_id);
create index if not exists coupon_redemptions_client_idx on coupon_redemptions (client_id);
create index if not exists coupon_redemptions_order_idx on coupon_redemptions (order_id);

-- Payments and sessions record what was applied, so finance reporting can see
-- gross vs net without joining back through redemptions every time.
alter table payments add column if not exists coupon_id       uuid references coupons(id) on delete set null;
alter table payments add column if not exists coupon_code     text;
alter table payments add column if not exists discount_amount numeric(10,2) default 0;
alter table payments add column if not exists original_amount numeric(10,2);

alter table sessions add column if not exists coupon_code     text;
alter table sessions add column if not exists discount_amount numeric(10,2) default 0;

-- Same default-deny posture as every other table in 0001: the backend uses the
-- service-role key and bypasses RLS; the anon key must not read these directly.
alter table coupons enable row level security;
alter table coupon_redemptions enable row level security;

create or replace function set_updated_at_coupons()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists coupons_set_updated_at on coupons;
create trigger coupons_set_updated_at
  before update on coupons
  for each row execute function set_updated_at_coupons();
