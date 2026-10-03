-- ============================================================================
-- 0005 — remember each client's time zone
--
-- The booking page captures the browser's IANA zone (e.g. "Asia/Dubai") and
-- sends it with the payment order. It is stored here so later messages —
-- reschedules, reminders, remaining-session bookings — can show the session in
-- the client's local time too. Sessions themselves stay stored in IST.
-- utils/clientTimeZone.js tolerates this column being absent.
--
-- Safe to re-run.
-- ============================================================================

alter table clients add column if not exists time_zone text;
