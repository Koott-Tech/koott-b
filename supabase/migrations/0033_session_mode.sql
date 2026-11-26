-- 0033 — how a session is held, which the Koott 2.0 booking flow now asks for.
--
-- Figma "Koott 2.0" → Booking Flow → "6 · Session mode" asks two things on one
-- screen: Online or In-person, and then Audio call / Video call / Chat. Nothing
-- in `sessions` could hold either answer, so the choice had nowhere to go.
--
-- Both are plain text rather than enums, because the list on that screen is a
-- product decision that will change; a check constraint would turn each change
-- into a migration. The app writes the values below and reads anything.
--
-- Existing rows stay null, which reads as "not asked": every session booked
-- before this screen existed was an online video call by default, but that is
-- an assumption, so it is not written into their rows.

alter table public.sessions add column if not exists session_mode text;
alter table public.sessions add column if not exists session_place text;

comment on column public.sessions.session_mode is 'How the session is held, from the booking flow: video | audio | chat. Null on sessions booked before the question was asked.';
comment on column public.sessions.session_place is 'Where it is held, from the booking flow: online | in_person. Null on sessions booked before the question was asked.';
