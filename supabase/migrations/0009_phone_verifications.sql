-- phone_verifications: one row per WhatsApp code sent by the booking flow
-- (backend/utils/phoneVerification.js). Only a keyed hash of the code is kept.
-- Backend (service role) only — RLS on with no policies. Safe to run more than once.
create table if not exists phone_verifications (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null,                 -- E.164, e.g. +918281540004
  code_hash   text not null,
  attempts    integer not null default 0,
  expires_at  timestamptz not null,
  verified_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists phone_verifications_phone_idx on phone_verifications (phone, created_at desc);
alter table phone_verifications enable row level security;

notify pgrst, 'reload schema';
