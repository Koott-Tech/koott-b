-- ============================================================================
-- 0018 — the two ways a therapist blocks their own time
--
-- 1. Weekly blocks (psychologist_recurring_blocks): "every Tuesday", repeating
--    for the next six months. The table already existed but only held
--    start_time/end_time, while controllers/psychologistController.js has long
--    written block_entire_day and time_slots and upserted on
--    (psychologist_id, day_of_week) — so saving a weekly block fails today with
--    "column block_entire_day does not exist". The columns and the constraint
--    the code already assumes are added here.
--
-- 2. Date blocks (psychologist_date_blocks, new): "the 3rd of November",
--    a single date rather than a repeating weekday.
--
-- Both carry google_calendar_event_id so the block can be mirrored into the
-- therapist's Google Calendar and removed again when they unblock. Several ids
-- may be stored comma-separated, which is what the controller does when
-- non-contiguous slots need one event each.
--
-- time_slots holds 24h "HH:MM" start labels, e.g. ["09:00","10:00"]. Which
-- labels exist depends on the therapist's own working_hours (migration 0006),
-- so the choices differ per therapist rather than being a fixed 8–9 list.
--
-- Safe to re-run.
-- ============================================================================

-- --------------------------------------------------------------------------
-- 1. Weekly blocks: the columns the application already writes
-- --------------------------------------------------------------------------
alter table psychologist_recurring_blocks
  add column if not exists block_entire_day boolean not null default true;

alter table psychologist_recurring_blocks
  add column if not exists time_slots jsonb;

-- How far the repeat runs. Six months from when it was saved; the Google
-- Calendar event carries the same date as its RRULE UNTIL, so the two agree.
alter table psychologist_recurring_blocks
  add column if not exists blocked_until date;

alter table psychologist_recurring_blocks
  add column if not exists updated_at timestamptz not null default now();

-- The upsert in addRecurringBlock passes onConflict 'psychologist_id,day_of_week',
-- which needs a matching unique constraint to resolve against. Duplicates must
-- go first or the constraint cannot be created; the newest row per day wins.
delete from psychologist_recurring_blocks a
  using psychologist_recurring_blocks b
 where a.psychologist_id = b.psychologist_id
   and a.day_of_week     = b.day_of_week
   and a.created_at      < b.created_at;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'psychologist_recurring_blocks_psych_day_key'
  ) then
    alter table psychologist_recurring_blocks
      add constraint psychologist_recurring_blocks_psych_day_key
      unique (psychologist_id, day_of_week);
  end if;
end $$;

create index if not exists psychologist_recurring_blocks_psych_idx
  on psychologist_recurring_blocks (psychologist_id);

-- --------------------------------------------------------------------------
-- 2. Date blocks: one calendar date, not a repeating weekday
-- --------------------------------------------------------------------------
create table if not exists psychologist_date_blocks (
  id                       uuid primary key default gen_random_uuid(),
  psychologist_id          uuid references psychologists(id) on delete cascade,
  date                     date not null,
  block_entire_day         boolean not null default true,
  time_slots               jsonb,
  reason                   text,
  google_calendar_event_id text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (psychologist_id, date)
);

-- Availability is read a date at a time, and the blocks for a date are looked
-- up on every read, so the lookup is indexed on exactly that pair.
create index if not exists psychologist_date_blocks_psych_date_idx
  on psychologist_date_blocks (psychologist_id, date);

notify pgrst, 'reload schema';

-- ============================================================================
-- Rollback:
--   drop table if exists psychologist_date_blocks;
--   alter table psychologist_recurring_blocks
--     drop constraint if exists psychologist_recurring_blocks_psych_day_key,
--     drop column if exists block_entire_day,
--     drop column if exists time_slots,
--     drop column if exists blocked_until,
--     drop column if exists updated_at;
-- ============================================================================
