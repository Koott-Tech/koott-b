-- 0024: indexes for queries measured slow on 2026-11-18 (plans/API-PERFORMANCE.md).
-- Only adds indexes: no table, column or data changes, results stay the same.
-- CONCURRENTLY avoids locking the tables while the index builds; run each statement on its
-- own (not inside a transaction block).

-- Automatic tasks, "package has 1 session left" rule: client_packages filtered on
-- remaining_sessions = 1 took ~2.1 s.
create index concurrently if not exists client_packages_remaining_sessions_idx
  on public.client_packages (remaining_sessions);

-- Coupon checks count redemptions per coupon and per coupon + client.
create index concurrently if not exists coupon_redemptions_coupon_client_idx
  on public.coupon_redemptions (coupon_id, client_id);
