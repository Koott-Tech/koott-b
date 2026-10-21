-- A short intro for the therapist card (listing, home page, condition pages),
-- kept apart from `description`, which is the full About on the profile page.
-- The card shows at most three lines of it. Safe to re-run.
alter table psychologists add column if not exists card_intro text;
