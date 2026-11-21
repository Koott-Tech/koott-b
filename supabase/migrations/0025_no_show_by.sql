-- 0025 — who didn't show up for a no-show session.
--
-- sessions.status stays 'no_show' for both kinds (package slots, finance and reports already
-- handle that status). no_show_by says whose no-show it was:
--   'client'    the client didn't join (what every no-show meant until now; NULL also means client)
--   'therapist' the therapist didn't join (a fine for this is planned)
-- Marked from Admin / Operations → Bookings → No show.

alter table sessions add column if not exists no_show_by text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sessions_no_show_by_check') then
    alter table sessions add constraint sessions_no_show_by_check
      check (no_show_by is null or no_show_by in ('client', 'therapist'));
  end if;
end $$;

create index if not exists sessions_no_show_by_idx on sessions (no_show_by) where no_show_by is not null;

notify pgrst, 'reload schema';
