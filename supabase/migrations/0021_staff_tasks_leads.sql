-- ============================================================================
-- 0021 — roles and people, tasks, the Operations lead pipeline, HR
--
-- From "Koott dashboards and tasks plan" (plans/). Adds:
--   * staff roles operations / hr / staff (users.role is free text: nothing to alter)
--   * staff_profiles — one list of everyone who works at Koott (staff users and
--     therapists): job title, team, start date, salary, offboarding
--   * teams + team_members — Team A, B, C… with a team lead; people are either a
--     staff user or a therapist ("person_type" user | psychologist)
--   * tasks, task_comments, task_events (history), task_notifications
--   * leads — every kind of lead in one list with its source and five stages
--     (new → contacted → follow_up → converted | lost)
--   * job_applications — applications from the careers pages
--
-- Additive and safe to re-run. Backend (service role) only, like every table.
-- ============================================================================

-- ---------------------------------------------------------------- teams
create table if not exists teams (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,
  description      text,
  lead_person_type text check (lead_person_type in ('user', 'psychologist')),
  lead_person_id   uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists team_members (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references teams(id) on delete cascade,
  person_type text not null check (person_type in ('user', 'psychologist')),
  person_id   uuid not null,
  created_at  timestamptz not null default now(),
  unique (team_id, person_type, person_id)
);
create index if not exists team_members_person_idx on team_members (person_type, person_id);

-- The teams automatic tasks go to. Rename freely; tasks find them by name.
insert into teams (name, description) values
  ('Operations', 'Leads, bookings, sessions and rescheduling'),
  ('HR',         'Hiring, onboarding, teams and offboarding'),
  ('Marketing',  'Analytics, reports, blog, events and assessments'),
  ('Finance',    'Income, expenses, payouts, receipts and salaries'),
  ('Developers', 'Website and dashboards: bugs and features')
on conflict (name) do nothing;

-- ---------------------------------------------------------------- people
create table if not exists staff_profiles (
  id              uuid primary key default gen_random_uuid(),
  person_type     text not null check (person_type in ('user', 'psychologist')),
  person_id       uuid not null,
  job_title       text,
  start_date      date,
  salary_monthly  numeric(12,2),
  phone           text,
  notes           text,
  offboarded_at   timestamptz,
  offboarded_by   uuid,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (person_type, person_id)
);

-- ---------------------------------------------------------------- tasks
create table if not exists tasks (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null,
  details            text,
  checklist          jsonb not null default '[]'::jsonb,   -- [{ id, text, done }]
  status             text not null default 'todo'
                       check (status in ('todo', 'in_progress', 'waiting', 'done', 'cancelled')),
  priority           text not null default 'normal'
                       check (priority in ('urgent', 'high', 'normal', 'low')),
  deadline           timestamptz,
  deadline_has_time  boolean not null default false,
  assignee_type      text not null check (assignee_type in ('user', 'psychologist', 'team')),
  assignee_id        uuid not null,
  claimed_by_type    text check (claimed_by_type in ('user', 'psychologist')),  -- team task picked up
  claimed_by_id      uuid,
  creator_type       text not null check (creator_type in ('user', 'psychologist', 'system')),
  creator_id         uuid,
  link_type          text,          -- session | client | lead | therapist | blog | page | booking | payout | application | url
  link_id            text,
  link_label         text,
  link_url           text,
  recurrence         text,          -- null | weekly:<0-6> | monthly:<1-28>
  template_key       text,
  auto_key           text unique,   -- automatic tasks: one per event, never twice
  completed_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists tasks_assignee_idx on tasks (assignee_type, assignee_id, status);
create index if not exists tasks_creator_idx  on tasks (creator_type, creator_id);
create index if not exists tasks_deadline_idx on tasks (deadline) where status not in ('done', 'cancelled');

create table if not exists task_comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tasks(id) on delete cascade,
  author_type text not null check (author_type in ('user', 'psychologist', 'system')),
  author_id   uuid,
  body        text not null,
  mentions    jsonb not null default '[]'::jsonb,   -- [{ type, id }]
  created_at  timestamptz not null default now()
);
create index if not exists task_comments_task_idx on task_comments (task_id, created_at);

create table if not exists task_events (
  id          bigint generated always as identity primary key,
  task_id     uuid not null references tasks(id) on delete cascade,
  actor_type  text not null,
  actor_id    uuid,
  action      text not null,          -- created | status | priority | deadline | assignee | title | details | checklist | link | claimed | comment
  from_value  jsonb,
  to_value    jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists task_events_task_idx on task_events (task_id, created_at);

create table if not exists task_notifications (
  id              uuid primary key default gen_random_uuid(),
  recipient_type  text not null check (recipient_type in ('user', 'psychologist')),
  recipient_id    uuid not null,
  task_id         uuid references tasks(id) on delete cascade,
  kind            text not null,       -- assigned | comment | mention | status | due_tomorrow | due_today | overdue
  message         text,
  dedupe_key      text unique,
  read_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists task_notifications_recipient_idx
  on task_notifications (recipient_type, recipient_id, read_at, created_at desc);

-- ---------------------------------------------------------------- leads
create table if not exists leads (
  id                 uuid primary key default gen_random_uuid(),
  source             text not null default 'manual',   -- booking | contact | event | assessment | ad | manual | phone | whatsapp | referral
  source_ref         text,                             -- id in the source table
  source_detail      text,                             -- e.g. the event, the ad campaign, the therapist booked
  name               text,
  phone              text,
  email              text,
  stage              text not null default 'new'
                       check (stage in ('new', 'contacted', 'follow_up', 'converted', 'lost')),
  owner_type         text check (owner_type in ('user', 'psychologist')),
  owner_id           uuid,
  notes              text,
  next_follow_up_at  timestamptz,
  lost_reason        text,
  client_id          uuid references clients(id) on delete set null,
  psychologist_id    uuid references psychologists(id) on delete set null,
  contacted_at       timestamptz,
  converted_at       timestamptz,
  stage_changed_at   timestamptz not null default now(),
  meta               jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (source, source_ref)
);
create index if not exists leads_stage_idx on leads (stage, created_at desc);
create index if not exists leads_phone_idx on leads (phone);

-- The leads that already exist: booking-flow leads and event registrations.
insert into leads (source, source_ref, source_detail, name, phone, email, stage, client_id, psychologist_id,
                   converted_at, created_at, updated_at, meta)
select 'booking', bl.id::text, null, bl.name, bl.phone, bl.email,
       case when bl.status = 'booked' then 'converted' else 'new' end,
       bl.client_id, bl.psychologist_id,
       case when bl.status = 'booked' then bl.updated_at end,
       bl.created_at, bl.updated_at,
       jsonb_build_object('booking_status', bl.status, 'existing_account', bl.existing_account)
from booking_leads bl
on conflict (source, source_ref) do nothing;

insert into leads (source, source_ref, source_detail, name, phone, email, created_at, updated_at)
select 'event', er.id::text, coalesce(er.event_title, er.event_slug),
       coalesce(er.full_name, er.name), coalesce(er.whatsapp_e164, er.phone), er.email,
       er.created_at, er.updated_at
from event_registrations er
on conflict (source, source_ref) do nothing;

-- ---------------------------------------------------------------- careers
create table if not exists job_applications (
  id           uuid primary key default gen_random_uuid(),
  career_id    uuid references careers(id) on delete set null,
  career_title text,
  name         text not null,
  email        text not null,
  phone        text,
  resume_url   text,
  linkedin_url text,
  cover_note   text,
  stage        text not null default 'applied'
                 check (stage in ('applied', 'interview', 'offer', 'hired', 'rejected')),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists job_applications_stage_idx on job_applications (stage, created_at desc);

alter table teams              enable row level security;
alter table team_members       enable row level security;
alter table staff_profiles     enable row level security;
alter table tasks              enable row level security;
alter table task_comments      enable row level security;
alter table task_events        enable row level security;
alter table task_notifications enable row level security;
alter table leads              enable row level security;
alter table job_applications   enable row level security;

notify pgrst, 'reload schema';
