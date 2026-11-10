-- 0023: refund requests (Operations approves, Razorpay refunds).
--
-- Every paid session that is cancelled — by the client in their profile, or by staff with
-- "Cancel & refund" — becomes one refund request. Operations sees them under the refund
-- icon in the dashboard header, opens one, checks the details and presses Refund: the
-- backend asks Razorpay to refund the payment, and Razorpay's webhook confirms it.
--
-- status: pending → processing → refunded | failed (can be tried again) | rejected

create table if not exists refund_requests (
  id                   uuid primary key default gen_random_uuid(),
  session_id           uuid references sessions(id) on delete set null,
  payment_id           uuid references payments(id) on delete set null,
  client_id            uuid references clients(id) on delete set null,
  psychologist_id      uuid references psychologists(id) on delete set null,
  razorpay_payment_id  text,
  currency             text not null default 'INR',
  amount_paid          numeric(10,2) not null default 0,   -- what the client paid for this session (₹)
  amount_suggested     numeric(10,2) not null default 0,   -- the refund we propose (₹)
  amount_refunded      numeric(10,2),                      -- what was actually sent back (₹)
  source               text not null default 'staff',      -- client | staff | system
  reason               text,
  requested_by_type    text,                               -- user | psychologist | client | system
  requested_by_id      uuid,
  status               text not null default 'pending',
  razorpay_refund_id   text unique,
  razorpay_status      text,
  failure_reason       text,
  decision_note        text,
  decided_by           uuid,
  decided_at           timestamptz,
  refunded_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- One open request per session (pressing cancel twice never makes two)
create unique index if not exists refund_requests_one_open_per_session
  on refund_requests (session_id) where status in ('pending', 'processing', 'failed');
create index if not exists refund_requests_status_idx on refund_requests (status, created_at desc);
create index if not exists refund_requests_payment_idx on refund_requests (razorpay_payment_id);

alter table refund_requests enable row level security;
