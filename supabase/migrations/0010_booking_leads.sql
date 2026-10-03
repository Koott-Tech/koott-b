-- booking_leads: everyone who verified a mobile number in the booking flow, booked or
-- not (utils/bookingAccounts.js). One row per number; a lead only moves forward
-- verified → details → account → booked. Admin → Leads. Backend (service role) only.
create table if not exists booking_leads (
  id                uuid primary key default gen_random_uuid(),
  phone             text not null unique,        -- E.164
  name              text,
  email             text,
  age               integer,
  emergency_contact text,
  psychologist_id   uuid references psychologists(id) on delete set null,
  client_id         uuid references clients(id) on delete set null,
  status            text not null default 'verified',  -- verified | details | account | booked
  existing_account  boolean not null default false,    -- number already belonged to a client
  verified_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists booking_leads_status_idx on booking_leads (status, updated_at desc);
alter table booking_leads enable row level security;

-- "About yourself" details and when the client's number was proven by the WhatsApp code
alter table clients add column if not exists phone_verified_at timestamptz;
alter table clients add column if not exists age               integer;
alter table clients add column if not exists emergency_contact text;

notify pgrst, 'reload schema';
