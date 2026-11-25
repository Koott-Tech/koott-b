-- 0032 — the two details the Koott 2.0 login asks a first-time client for.
--
-- The sign-in sheet (Figma "Koott 2.0" → Login → First time) asks for a name, a
-- year of birth and a gender. `age` already exists and is what the rest of the
-- app reads, so it is still written; the year is kept as well, because an age
-- stored once is wrong a year later.

alter table public.clients add column if not exists gender text;
alter table public.clients add column if not exists year_of_birth integer;

comment on column public.clients.gender is 'Self-described, from the login sheet: female | male | other | prefer_not_to_say, or free text.';
comment on column public.clients.year_of_birth is 'Year only (1900–current). clients.age is derived from it at sign-up.';
