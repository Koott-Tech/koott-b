-- ============================================================================
-- 0022 — HR documents with expiry, interview dates, the urgent safety path
-- (plans/Koott dashboards and tasks plan: HR ideas + Privacy and safety)
--
--   staff_documents  licences, ID, contracts, agreements per person (therapist or staff),
--                    files in the private storage bucket "staff-documents"; an expiry date
--                    makes the "renew the document" task appear 30 days before.
--   job_applications.interview_at / interviewer — interviews on the hiring calendar.
--   safety_alerts    a therapist's urgent safety concern about a client: goes straight
--                    to the named clinical lead (email), never into the task queue.
--   app_settings     small settings (who the clinical lead is).
--
-- Additive and safe to re-run.
-- ============================================================================

create table if not exists staff_documents (
  id           uuid primary key default gen_random_uuid(),
  person_type  text not null check (person_type in ('user', 'psychologist')),
  person_id    uuid not null,
  kind         text not null default 'other'
                 check (kind in ('licence', 'id_proof', 'contract', 'agreement', 'certificate', 'other')),
  title        text not null,
  file_path    text,                 -- staff-documents/<person>/<file>
  file_name    text,
  expires_on   date,
  uploaded_by  uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists staff_documents_person_idx on staff_documents (person_type, person_id);
create index if not exists staff_documents_expiry_idx on staff_documents (expires_on) where expires_on is not null;

alter table job_applications add column if not exists interview_at timestamptz;
alter table job_applications add column if not exists interviewer  text;

create table if not exists safety_alerts (
  id               uuid primary key default gen_random_uuid(),
  raised_by_type   text not null check (raised_by_type in ('user', 'psychologist')),
  raised_by_id     uuid not null,
  client_id        uuid references clients(id) on delete set null,
  client_ref       text,             -- K-XXXXXX shown to the lead
  summary          text not null,    -- what is happening now; kept short
  contact_now      text,             -- how to reach the therapist right now
  status           text not null default 'open' check (status in ('open', 'acknowledged', 'closed')),
  acknowledged_by  uuid,
  acknowledged_at  timestamptz,
  closed_note      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists safety_alerts_status_idx on safety_alerts (status, created_at desc);

create table if not exists app_settings (
  key         text primary key,
  value       jsonb,
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);

alter table staff_documents enable row level security;
alter table safety_alerts   enable row level security;
alter table app_settings    enable row level security;

notify pgrst, 'reload schema';
