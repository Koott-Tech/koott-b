-- ============================================================================
-- 0006 — weekly working hours per therapist (set by admin)
--
-- Shape (IST, "HH:MM", end may be "24:00" = midnight):
--   { "days": { "mon": [{"start":"08:00","end":"17:00"}], ..., "sun": [] } }
-- A day can hold several shifts; an empty list is a day off. NULL = platform
-- default (08:00–22:00 every day). Bookable slots are cut from these hours by
-- backend/utils/sessionSlots.js (individual 50 min, couple 80 min, 10-min break).
--
-- Safe to re-run.
-- ============================================================================

alter table psychologists add column if not exists working_hours jsonb;

notify pgrst, 'reload schema';
