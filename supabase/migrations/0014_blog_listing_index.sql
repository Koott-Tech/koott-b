-- 0014 — the index the blog listing reads through.
--
-- The listing asks for published posts newest first. With 144 rows and no index
-- on that pair, the query took about a second every time the API's ten-minute
-- cache expired, and the page could not paint until it answered.
--
-- Run in the Supabase SQL editor. Safe to re-run.

create index if not exists blogs_status_published_at_idx
  on blogs (status, published_at desc nulls last);

-- Rollback:
-- drop index if exists blogs_status_published_at_idx;
