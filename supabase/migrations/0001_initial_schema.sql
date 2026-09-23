-- ============================================================================
-- Koott — initial schema
--
-- Derived from every Supabase query in the backend and frontend. Columns come
-- from the .select()/.insert()/.update()/.eq() calls the code actually makes,
-- so this covers what the application reads and writes.
--
-- Types are INFERRED from usage, not copied from the old database. Anything
-- marked "-- ?" is a judgement call worth reviewing. Money is numeric(10,2)
-- throughout (the code does parseFloat and rounds to whole rupees).
--
-- Safe to re-run: everything is IF NOT EXISTS.
-- ============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
create table if not exists users (
  id                  uuid primary key default gen_random_uuid(),
  email               text unique not null,
  password_hash       text,                        -- null for Google-only accounts
  name                text,
  role                text not null default 'client',  -- client|psychologist|admin|superadmin|finance|event_organizer
  phone_number        text,
  profile_picture_url text,
  google_id           text,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists users_email_idx on users (lower(email));
create index if not exists users_role_idx  on users (role);

create table if not exists clients (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid references users(id) on delete cascade,
  first_name                 text,
  last_name                  text,
  email                      text,
  phone_number               text,
  child_name                 text,
  child_age                  integer,
  client_message             text,
  google_id                  text,
  terms_accepted             boolean default false,
  therapy_agreement_accepted boolean default false,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);
create index if not exists clients_user_id_idx on clients (user_id);
create index if not exists clients_email_idx   on clients (lower(email));

create table if not exists psychologists (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid references users(id) on delete set null,
  first_name                  text,
  last_name                   text,
  email                       text,
  phone                       text,
  password_hash               text,
  google_id                   text,
  designation                 text,
  description                 text,
  experience_years            integer default 0,
  area_of_expertise           text[] default '{}',  -- queried with .contains()
  specialist_category         text,
  profile_picture_url         text,
  cover_image_url             text,
  display_order               integer,
  is_active                   boolean not null default true,
  individual_session_price     numeric(10,2),
  better_parent_pricing        jsonb,
  child_specialist_pricing     jsonb,
  psychiatrist_15min_price     numeric(10,2),
  psychiatrist_30min_price     numeric(10,2),
  ug_college                  text,
  pg_college                  text,
  mphil_college               text,
  phd_college                 text,
  private_note_password_hash  text,
  -- OAuth tokens live INSIDE this object (access_token, refresh_token,
  -- expiry_date, scope, token_type, oauth_email, connected_at) — the code reads
  -- them as creds.access_token, they are not columns.
  google_calendar_credentials jsonb,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create index if not exists psychologists_email_idx on psychologists (lower(email));

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
create table if not exists packages (
  id              uuid primary key default gen_random_uuid(),
  psychologist_id uuid references psychologists(id) on delete cascade,
  name            text,
  description     text,
  package_type    text,          -- individual|package|couple|couple_package_N ...
  session_count   integer not null default 1,
  price           numeric(10,2),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists packages_psych_idx on packages (psychologist_id);

-- ---------------------------------------------------------------------------
-- Payments and bookings
--
-- payments.session_id and sessions.payment_id reference each other, so the
-- payments -> sessions constraint is added at the bottom of this file.
-- ---------------------------------------------------------------------------
create table if not exists payments (
  id                           uuid primary key default gen_random_uuid(),
  client_id                    uuid references clients(id) on delete set null,
  psychologist_id              uuid references psychologists(id) on delete set null,
  package_id                   uuid references packages(id) on delete set null,
  session_id                   uuid,
  assessment_session_id        uuid,
  amount                       numeric(10,2) not null default 0,
  currency                     text not null default 'INR',
  status                       text not null default 'pending',  -- pending|success|failed|refunded
  payment_status               text,
  payment_method               text,
  provider                     text,
  provider_payment_id          text,
  transaction_id               text,
  order_id                     text,
  razorpay_order_id            text,
  razorpay_payment_id          text,
  razorpay_params              jsonb,
  razorpay_response            jsonb,
  receipt                      text,
  receipt_url                  text,
  session_type                 text,
  session_count                integer,
  package_type                 text,
  package_group_id             uuid,
  remaining_sessions           integer,
  scheduled_date               date,
  scheduled_time               time,
  notes                        text,
  admin_created                boolean default false,
  record_only                  boolean default false,
  payment_screenshot_uploaded  boolean default false,
  payment_received_date        timestamptz,
  created_by                   uuid,
  paid_at                      timestamptz,
  completed_at                 timestamptz,
  failed_at                    timestamptz,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);
create index if not exists payments_client_idx  on payments (client_id);
create index if not exists payments_status_idx  on payments (status);
create index if not exists payments_rzp_order_idx on payments (razorpay_order_id);

create table if not exists sessions (
  id                        uuid primary key default gen_random_uuid(),
  client_id                 uuid references clients(id) on delete set null,
  psychologist_id           uuid references psychologists(id) on delete set null,
  original_psychologist_id  uuid references psychologists(id) on delete set null,
  package_id                uuid references packages(id) on delete set null,
  payment_id                uuid references payments(id) on delete set null,
  package_group_id          uuid,
  package_session_number    integer,
  session_count             integer default 1,
  session_type              text,
  status                    text not null default 'booked',
  -- 'website' = the client booked it, 'admin_manual' = created by the team.
  source                    text,
  price                     numeric(10,2) default 0,
  amount                    numeric(10,2),
  therapist_commission      numeric(10,2),
  scheduled_date            date,
  scheduled_time            time,
  original_scheduled_date   date,
  original_scheduled_time   time,
  -- When the client booked. The finance dashboards group on this, NOT created_at.
  booking_created_at        timestamptz,
  completion_date           timestamptz,
  is_first_session          boolean,
  reschedule_count          integer default 0,
  rating                    integer,
  feedback                  text,
  client_feedback           text,
  notes                     text,
  summary                   text,
  summary_notes             text,
  session_summary           text,
  session_notes             text,
  report                    text,
  google_calendar_event_id  text,
  google_calendar_id        text,
  google_calendar_link      text,
  google_meet_link          text,
  google_meet_join_url      text,
  google_meet_start_url     text,
  notified_at               timestamptz,
  reminder_sent             boolean default false,
  notification_alert_sent   boolean default false,
  email_sent_at             timestamptz,
  whatsapp_sent_at          timestamptz,
  email_error               text,
  whatsapp_error            text,
  payment_verified          boolean default false,
  payment_verified_at       timestamptz,
  -- Vestigial: only ever set by the removed Wix sync. Kept because existing code
  -- still writes it; safe to drop once those writes are cleaned up.
  locally_modified          boolean default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  description                text
);
create index if not exists sessions_client_idx      on sessions (client_id);
create index if not exists sessions_psych_idx       on sessions (psychologist_id);
create index if not exists sessions_sched_date_idx  on sessions (scheduled_date);
create index if not exists sessions_status_idx      on sessions (status);
create index if not exists sessions_booking_at_idx  on sessions (booking_created_at);
create index if not exists sessions_package_idx     on sessions (package_id);
create index if not exists sessions_payment_idx     on sessions (payment_id);
-- Stops the same therapist being double-booked for one slot.
create unique index if not exists sessions_no_double_booking
  on sessions (psychologist_id, scheduled_date, scheduled_time)
  where status in ('booked','scheduled','confirmed','rescheduled');

create table if not exists client_packages (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid references clients(id) on delete cascade,
  psychologist_id    uuid references psychologists(id) on delete set null,
  package_id         uuid references packages(id) on delete set null,
  first_session_id   uuid references sessions(id) on delete set null,
  package_type       text,
  session_count      integer,
  remaining_sessions integer,
  price              numeric(10,2),
  status             text default 'active',
  purchased_at       timestamptz default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  amount_paid                numeric(10,2),
  total_amount               numeric(10,2),
  total_sessions             integer
);
create index if not exists client_packages_client_idx on client_packages (client_id);

-- ---------------------------------------------------------------------------
-- Availability and slot locking
-- ---------------------------------------------------------------------------
create table if not exists availability (
  id              uuid primary key default gen_random_uuid(),
  psychologist_id uuid references psychologists(id) on delete cascade,
  date            date not null,
  time_slots      jsonb not null default '[]',
  is_available    boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (psychologist_id, date)
);

create table if not exists psychologist_recurring_blocks (
  id                       uuid primary key default gen_random_uuid(),
  psychologist_id          uuid references psychologists(id) on delete cascade,
  day_of_week              integer not null,     -- 0=Sunday
  start_time               time,
  end_time                 time,
  reason                   text,
  google_calendar_event_id text,
  created_at               timestamptz not null default now()
);

create table if not exists slot_locks (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid references clients(id) on delete cascade,
  psychologist_id   uuid references psychologists(id) on delete cascade,
  scheduled_date    date not null,
  scheduled_time    time not null,
  order_id          text,
  status            text not null default 'held',
  slot_expires_at   timestamptz,
  recovery_attempts integer default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists slot_locks_order_idx on slot_locks (order_id);
create index if not exists slot_locks_slot_idx  on slot_locks (psychologist_id, scheduled_date, scheduled_time);

-- ---------------------------------------------------------------------------
-- Commission and payouts
-- ---------------------------------------------------------------------------
create table if not exists doctor_commissions (
  id                                       uuid primary key default gen_random_uuid(),
  psychologist_id                          uuid references psychologists(id) on delete cascade,
  commission_percentage                    numeric(5,2),
  commission_amount_individual             numeric(10,2),
  commission_amount_package                numeric(10,2),
  -- Company-facing fallback amounts keyed by package type, e.g. {"package_3": 900}
  commission_amounts                       jsonb,
  doctor_commission_individual             numeric(10,2),
  doctor_commission_first_session          numeric(10,2),
  doctor_commission_followup               numeric(10,2),
  doctor_commission_first_session_package  numeric(10,2),
  doctor_commission_followup_package       numeric(10,2),
  -- Whole-package totals keyed like "package_3_first_session", "couple_session".
  doctor_commission_packages               jsonb,
  is_active                                boolean not null default true,
  effective_from                           timestamptz default now(),
  effective_to                             timestamptz,
  created_at                               timestamptz not null default now(),
  updated_at                               timestamptz not null default now(),
  notes                      text
);
create index if not exists doctor_commissions_psych_idx on doctor_commissions (psychologist_id, is_active);

create table if not exists commission_history (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid references sessions(id) on delete cascade,
  psychologist_id     uuid references psychologists(id) on delete set null,
  payment_id          uuid references payments(id) on delete set null,
  session_amount      numeric(10,2),
  commission_amount   numeric(10,2),   -- the COMPANY's cut; doctor = session_amount - this
  company_revenue     numeric(10,2),
  net_company_revenue numeric(10,2),
  payment_status      text,
  session_date        date,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
-- One settled commission row per session (the service relies on this being unique).
create unique index if not exists commission_history_session_uniq on commission_history (session_id);

create table if not exists payouts (
  id               uuid primary key default gen_random_uuid(),
  psychologist_id  uuid references psychologists(id) on delete set null,
  amount           numeric(10,2),
  payout_amount    numeric(10,2),
  total_commission numeric(10,2),
  tds_amount       numeric(10,2),
  tds_percentage   numeric(5,2),
  net_payout       numeric(10,2),
  status           text default 'pending',
  payment_method   text,
  payout_date      date,
  notes            text,
  created_by       uuid,
  processed_by     uuid,
  processed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists payouts_psych_idx on payouts (psychologist_id);

-- ---------------------------------------------------------------------------
-- Finance ledger
-- ---------------------------------------------------------------------------
create table if not exists expense_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text unique not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists expenses (
  id              uuid primary key default gen_random_uuid(),
  category        text,
  custom_category text,
  expense_type    text,
  description     text,
  amount          numeric(10,2) not null default 0,
  total_amount    numeric(10,2),
  date            date not null default current_date,
  status          text default 'pending',
  approval_status text default 'pending',
  approved_by     uuid,
  approved_at     timestamptz,
  subscription_id uuid,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists expenses_date_idx on expenses (date);

create table if not exists income_sources (
  id                 uuid primary key default gen_random_uuid(),
  name               text unique not null,
  is_active          boolean not null default true,
  is_auto_calculated boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- The code queries `income_entries` and falls back to a legacy `income` table
-- only if this one is missing (error 42P01), so only this one is created.
create table if not exists income_entries (
  id          uuid primary key default gen_random_uuid(),
  source      text,
  description text,
  amount      numeric(10,2) not null default 0,
  date        date not null default current_date,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists income_entries_date_idx on income_entries (date);

create table if not exists finance_salary_employees (
  id          uuid primary key default gen_random_uuid(),
  employee_id text,
  name        text,
  email       text,
  designation text,
  location    text,
  salary      numeric(10,2),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists monthly_finance_dashboard (
  id              uuid primary key default gen_random_uuid(),
  year            integer not null,
  month           integer not null,
  snapshot        jsonb,
  snapshot_locked boolean not null default false,
  last_updated_at timestamptz default now(),
  created_at      timestamptz not null default now(),
  unique (year, month)
);

create table if not exists receipts (
  id                   uuid primary key default gen_random_uuid(),
  session_id           uuid references sessions(id) on delete set null,
  payment_id           uuid references payments(id) on delete set null,
  receipt_number       text unique,
  short_receipt_number text,
  transaction_id       text,
  receipt_details      jsonb,
  file_url             text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  file_path                  text,
  file_size                  integer
);

-- ---------------------------------------------------------------------------
-- Assessments
-- ---------------------------------------------------------------------------
create table if not exists assessments (
  id               uuid primary key default gen_random_uuid(),
  slug             text unique not null,
  status           text not null default 'draft',   -- draft|published
  hero_title       text,
  seo_title        text,
  seo_description  text,
  assessment_price numeric(10,2),
  content          jsonb,
  cover_image_url  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  assigned_doctor_ids        jsonb,
  benefits                   jsonb,
  benefits_image_url         text,
  benefits_title             text,
  canonical_url              text,
  category                   text,
  faqs                       jsonb,
  hero_cta_text              text,
  hero_image_url             text,
  hero_point_1               text,
  hero_point_2               text,
  hero_point_3               text,
  hero_subtext               text,
  info_cards                 jsonb,
  menu_order                 integer,
  mobile_image_url           text,
  og_description             text,
  og_image                   text,
  og_title                   text,
  reviews                    jsonb,
  right_image_url            text,
  robots                     text,
  schema_enabled             boolean,
  schema_service_type        text,
  seo_keywords               jsonb,
  therapists_heading         text,
  types                      jsonb,
  types_title                text,
  updated_by                 text,
  videos                     jsonb
);

create table if not exists assessment_sessions (
  id              uuid primary key default gen_random_uuid(),
  assessment_id   uuid references assessments(id) on delete set null,
  assessment_slug text,
  client_id       uuid references clients(id) on delete set null,
  psychologist_id uuid references psychologists(id) on delete set null,
  user_id         uuid references users(id) on delete set null,
  payment_id      uuid references payments(id) on delete set null,
  session_number  integer,
  first_name      text,
  last_name       text,
  email           text,
  phone           text,
  phone_number    text,
  child_name      text,
  child_age       integer,
  amount          numeric(10,2),
  currency        text default 'INR',
  scheduled_date  date,
  scheduled_time  time,
  status          text default 'booked',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  google_calendar_event_id   uuid,
  google_calendar_link       text,
  google_meet_link           text,
  google_meet_method         text,
  reschedule_count           integer
);
create index if not exists assessment_sessions_client_idx on assessment_sessions (client_id);

create table if not exists free_assessments (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid references clients(id) on delete set null,
  psychologist_id   uuid references psychologists(id) on delete set null,
  user_id           uuid references users(id) on delete set null,
  session_id        uuid references sessions(id) on delete set null,
  assessment_number text,
  scheduled_date    date,
  scheduled_time    time,
  status            text default 'booked',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists free_assessment_date_configs (
  id         uuid primary key default gen_random_uuid(),
  date       date unique not null,
  time_slots jsonb not null default '[]',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- CMS
-- ---------------------------------------------------------------------------
create table if not exists blogs (
  id                 uuid primary key default gen_random_uuid(),
  slug               text unique not null,
  title              text not null,
  excerpt            text,
  content            text,
  structured_content jsonb,
  content_images     jsonb default '[]',
  featured_image_url text,
  author_id          uuid references users(id) on delete set null,
  author_name        text,
  status             text not null default 'draft',
  tags               jsonb default '[]',
  categories         jsonb default '[]',
  read_time_minutes  integer default 5,
  seo_title          text,
  seo_description    text,
  focus_keyword      text,
  meta_keywords      jsonb default '[]',
  canonical_url      text,
  view_count         integer default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists blogs_status_idx on blogs (status);

create table if not exists counselling_services (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,
  status          text not null default 'draft',
  hero_title      text,
  seo_title       text,
  seo_description text,
  menu_order      integer,
  benefits        jsonb,
  info_cards      jsonb,
  faqs            jsonb,
  reviews         jsonb,
  testimonials    jsonb,
  types           jsonb,
  videos          jsonb,
  content         jsonb,
  cover_image_url text,
  updated_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists better_parenting (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,
  status          text not null default 'draft',
  hero_title      text,
  seo_title       text,
  seo_description text,
  menu_order      integer,
  content         jsonb,
  cover_image_url text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists event_pages (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,
  title           text,
  is_published    boolean not null default false,
  content         jsonb,
  cms_data        jsonb,
  seo_title       text,
  seo_description text,
  canonical_url   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists event_registrations (
  id                uuid primary key default gen_random_uuid(),
  event_slug        text not null,
  name              text,
  email             text,
  phone             text,
  attendance_status text default 'registered',
  metadata          jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  country_code               text,
  event_title                text,
  full_name                  text,
  session_join_url           text,
  status                     text,
  whatsapp_e164              text
);
create index if not exists event_registrations_slug_idx on event_registrations (event_slug);

create table if not exists careers (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text unique not null,
  title                 text,
  description           text,
  location              text,
  employment_type       text,
  min_experience_years  integer,
  max_experience_years  integer,
  status                text not null default 'draft',
  content               jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Legacy key/value store the events page reads for old CMS entries.
create table if not exists cms (
  key        text primary key,
  data       jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists newsletter_subscribers (
  id         uuid primary key default gen_random_uuid(),
  email      text unique not null,
  source     text,
  consent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Messaging and notifications
-- ---------------------------------------------------------------------------
create table if not exists conversations (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete cascade,
  psychologist_id uuid references psychologists(id) on delete cascade,
  session_id      uuid references sessions(id) on delete set null,
  is_active       boolean not null default true,
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  sender_id       uuid,
  sender_type     text,
  message_type    text default 'text',
  content         text,
  is_read         boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists messages_conversation_idx on messages (conversation_id, created_at);

create table if not exists notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references users(id) on delete cascade,
  user_role    text,
  type         text,
  title        text,
  message      text,
  related_id   uuid,
  related_type text,
  is_read      boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  assessment_id              uuid,
  assessment_session_id      uuid,
  client_id                  uuid,
  metadata                   jsonb,
  new_date                   date,
  new_time                   time,
  original_date              date,
  original_time              time,
  psychologist_id            uuid,
  reason                     text,
  request_type               text,
  session_id                 uuid,
  session_number             integer
);
create index if not exists notifications_user_idx on notifications (user_id, is_read);

-- ---------------------------------------------------------------------------
-- Auth sessions and security
-- ---------------------------------------------------------------------------
create table if not exists user_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references users(id) on delete cascade,
  token_hash    text not null,
  ip_address    text,
  user_agent    text,
  last_activity timestamptz default now(),
  expires_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists user_sessions_user_idx on user_sessions (user_id);

create table if not exists email_verifications (
  id                uuid primary key default gen_random_uuid(),
  email             text not null,
  user_role         text,
  verification_type text,
  otp_hash          text,
  is_verified       boolean not null default false,
  verified_at       timestamptz,
  expires_at        timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists email_verifications_email_idx on email_verifications (lower(email));

create table if not exists account_lockouts (
  id              uuid primary key default gen_random_uuid(),
  email           text unique not null,
  failed_attempts integer not null default 0,
  last_attempt_at timestamptz,
  last_attempt_ip text,
  locked_until    timestamptz
);

create table if not exists revoked_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid,
  token_hash text not null,
  reason     text,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists revoked_tokens_hash_idx on revoked_tokens (token_hash);

create table if not exists revoked_users (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  reason     text,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid,                 -- nullable on purpose: failed logins have none
  user_email  text,
  user_role   text,
  action      text,
  resource    text,
  resource_id text,
  endpoint    text,
  method      text,
  details     jsonb,
  ip_address  text,
  user_agent  text,
  timestamp   timestamptz not null default now()
);
create index if not exists audit_logs_ts_idx on audit_logs (timestamp);

create table if not exists security_logs (
  id         uuid primary key default gen_random_uuid(),
  event_type text,
  severity   text,
  user_id    uuid,
  ip_address text,
  user_agent text,
  details    jsonb,
  timestamp  timestamptz not null default now(),
  email                      text,
  event_data                 jsonb,
  memory_usage_mb            integer,
  method                     text,
  reason                     text,
  url                        text
);
create index if not exists security_logs_ts_idx on security_logs (timestamp);

-- ---------------------------------------------------------------------------
-- Deferred circular FK
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_session_id_fkey') then
    alter table payments
      add constraint payments_session_id_fkey
      foreign key (session_id) references sessions(id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end $$ language plpgsql;

do $$
declare t text;
begin
  foreach t in array array[
    'users','clients','psychologists','packages','payments','sessions','client_packages',
    'availability','slot_locks','doctor_commissions','commission_history','payouts',
    'expense_categories','expenses','income_sources','income_entries','finance_salary_employees',
    'receipts','assessments','assessment_sessions','free_assessments','blogs',
    'counselling_services','better_parenting','event_pages','event_registrations','careers',
    'cms','newsletter_subscribers','conversations','notifications'
  ]
  loop
    execute format(
      'drop trigger if exists trg_%1$s_updated_at on %1$I;
       create trigger trg_%1$s_updated_at before update on %1$I
       for each row execute function set_updated_at();', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- The backend talks to Postgres with the service_role key, which bypasses RLS
-- entirely, so enabling it does not affect the API. It matters because the anon
-- key is shipped to the browser: without RLS, anyone could read these tables
-- directly from the client. RLS on with no policies = deny all for anon, which
-- is the correct default here. Add policies only for tables you intend the
-- browser to read directly.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'users','clients','psychologists','packages','payments','sessions','client_packages',
    'availability','psychologist_recurring_blocks','slot_locks','doctor_commissions',
    'commission_history','payouts','expense_categories','expenses','income_sources',
    'income_entries','finance_salary_employees','monthly_finance_dashboard','receipts',
    'assessments','assessment_sessions','free_assessments','free_assessment_date_configs',
    'blogs','counselling_services','better_parenting','event_pages','event_registrations',
    'careers','cms','newsletter_subscribers','conversations','messages','notifications',
    'user_sessions','email_verifications','account_lockouts','revoked_tokens','revoked_users',
    'audit_logs','security_logs'
  ]
  loop
    execute format('alter table %I enable row level security;', t);
  end loop;
end $$;
