-- ============================================================================
-- 0007 — therapist groups (A, B, C …) for internal admin / finance reporting
--
-- Each therapist is in at most one group (psychologists.therapist_group_id), so
-- group totals add up to the company total. Clients never see groups. Deleting
-- a group only un-groups its therapists. Row-level security is on with no
-- policies: only the backend (service role) can read or write the table.
--
-- Safe to re-run.
-- ============================================================================

create table if not exists therapist_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  color       text,
  description text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists therapist_groups_name_idx on therapist_groups (lower(name));
alter table therapist_groups enable row level security;

alter table psychologists
  add column if not exists therapist_group_id uuid references therapist_groups(id) on delete set null;
create index if not exists psychologists_group_idx on psychologists (therapist_group_id);

notify pgrst, 'reload schema';
