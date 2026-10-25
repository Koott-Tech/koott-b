-- ============================================================================
-- 0019 — slot lifecycle history, for the marketing dashboard
--
-- The marketing team needs to know when a therapist actually opened a slot:
-- "five slots opened on the 18th for the 25th, then two more at 8:30 on the
-- day". The availability table cannot answer that, and never could:
--
--   * it holds one row per (psychologist_id, date) with time_slots as a jsonb
--     array, so adding two hours rewrites the whole array and leaves no record
--     of which hours were added, or when;
--   * updated_at is overwritten on every change, so only the most recent one
--     survives — of 154 live rows, exactly one had updated_at <> created_at;
--   * past rows were deleted nightly, so even that was gone the next morning.
--
-- This table fixes the first two by recording each change as its own row. The
-- third is fixed alongside it, in utils/defaultAvailabilityService.js, which no
-- longer deletes past availability.
--
-- There is no backfill. Nothing in the database says when a slot that already
-- exists was opened, and inventing a timestamp would be worse than admitting
-- the gap, so reports read from the first row here onward and say so.
--
-- Safe to re-run.
-- ============================================================================

create table if not exists slot_events (
  id              bigint generated always as identity primary key,
  psychologist_id uuid not null references psychologists(id) on delete cascade,

  -- The appointment the event is about: which day, and which start time.
  slot_date       date not null,
  slot_time       time not null,

  -- created  — the slot first appeared
  -- opened   — made bookable again after being closed
  -- closed   — withdrawn (a block, or the therapist removing it)
  -- booked   — a client took it
  -- cancelled— a booking on it was cancelled, so it is bookable again
  event           text not null check (event in ('created', 'opened', 'closed', 'booked', 'cancelled')),

  -- Who caused it. Most slots are opened by the nightly job that keeps three
  -- weeks filled, so counting "slots opened" without separating these would
  -- measure the cron rather than the therapists.
  actor           text not null default 'system' check (actor in ('system', 'therapist', 'admin', 'client')),
  actor_id        uuid,

  -- The code path, for tracing a surprising number back to its cause.
  source          text,

  occurred_at     timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

-- "How far in advance was this opened?" and the therapist drill-down both read
-- by therapist and appointment date.
create index if not exists slot_events_psych_date_idx on slot_events (psychologist_id, slot_date);
-- The dashboard's date filter is on when the event happened, not the appointment.
create index if not exists slot_events_occurred_idx   on slot_events (occurred_at);
create index if not exists slot_events_event_idx      on slot_events (event, occurred_at);

-- One slot changing state twice in the same instant is the same change written
-- twice — a retry, or two code paths reacting to one action. Dropping the
-- duplicate here keeps "slots opened" honest without the readers having to
-- de-duplicate on every query.
--
-- Plain columns, not an expression: the writer reaches this through ON CONFLICT
-- with a column list, and Postgres will not match that against an index over
-- coalesce(...) — it fails with "no unique or exclusion constraint matching the
-- ON CONFLICT specification" and every event is silently dropped. The earlier
-- version of this file had that index; the drop below repairs a database that
-- already ran it.
drop index if exists slot_events_dedupe_idx;
alter table slot_events alter column slot_time set not null;
create unique index if not exists slot_events_dedupe_idx
  on slot_events (psychologist_id, slot_date, slot_time, event, occurred_at);

alter table slot_events enable row level security;

-- Where the tracked window starts. Reports show nothing before this and label
-- the period, rather than implying the earlier months were quiet.
create or replace function slot_events_tracking_since()
returns timestamptz
language sql
stable
as $$
  select min(occurred_at) from slot_events;
$$;

notify pgrst, 'reload schema';

-- ============================================================================
-- Rollback:
--   drop function if exists slot_events_tracking_since();
--   drop table if exists slot_events;
-- ============================================================================
