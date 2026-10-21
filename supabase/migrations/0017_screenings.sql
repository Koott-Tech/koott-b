-- ============================================================================
-- 0017 — Self-administered screenings: stored submissions
--
-- A visitor picks a condition (Depression, Anxiety …), picks a test under it,
-- answers one question per screen, and the practice is emailed a scored PDF.
--
-- The INSTRUMENTS THEMSELVES LIVE IN CODE, not in the database. Each one has
-- its own item map, reverse-keying, multipliers, cut-offs, facets and report
-- wording, and those rules are the part that must not drift — a dropdown that
-- can edit a scoring key is a way to silently produce wrong clinical output.
-- They are added one at a time under backend/data/screenings/ and registered
-- in that folder's index. See data/screenings/README.md.
--
-- So the only table here is the one that has to be a table: the submissions.
--
-- This is NOT the existing `assessments` table. That one is the paid assessment
-- SERVICE — landing-page copy, a price, a booking flow, and `assessment_sessions`
-- for the appointments. These are free self-checks with no booking or payment.
--
-- Additive and safe to re-run.
-- ============================================================================

create table if not exists assessment_submissions (
  id              uuid primary key default gen_random_uuid(),
  test_slug       text not null,          -- 'dass-21' | 'big-five' | …
  test_name       text,
  condition_slug  text,
  name            text not null,
  email           text,                   -- for the psychologist to make contact
  phone           text,
  dob             text,
  sex             text,
  assessment_date text,                   -- as printed, already IST
  answers         jsonb not null,         -- raw, as submitted
  scores          jsonb,                  -- computed result
  consent         jsonb,                  -- { agreed, agreedAt, anonymisedUse }
  emailed_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists assessment_submissions_test_idx
  on assessment_submissions (test_slug, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Same rule as 0001: the backend uses the service_role key and bypasses RLS,
-- while the anon key is shipped to every visitor's browser. RLS on with no
-- policies denies anon and authenticated outright.
--
-- This matters more here than anywhere else in the schema: these rows are
-- health data — a named person's answers about depression and anxiety.
-- ---------------------------------------------------------------------------
alter table assessment_submissions enable row level security;

-- ---------------------------------------------------------------------------
-- Retention
--
-- The consent form promises responses are kept "for the period required by
-- professional and legal standards", so a period has to exist and something has
-- to enforce it. Nothing here deletes anything yet — agree the number with the
-- clinical team, then add the job.
-- ---------------------------------------------------------------------------
