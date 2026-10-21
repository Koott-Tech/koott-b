-- ============================================================================
-- 0016 — CMS: drafts
--
-- Phase 4. Until now a save in the page editor went straight into `cms.data`,
-- which is what the public site reads — so the live website changed as someone
-- typed. These columns add a draft alongside it:
--
--   cms.data        the published content. The public site reads only this, so
--                   its behaviour is unchanged by anything below.
--   cms.draft_data  work in progress. Null means there is no unpublished work.
--
-- Publishing copies draft_data over data and clears the draft, writing a row to
-- page_revisions first so the previous published version can be restored.
--
-- Additive and safe to re-run. Existing rows keep their published content and
-- simply start with no draft.
-- ============================================================================

alter table cms add column if not exists draft_data       jsonb;
alter table cms add column if not exists draft_updated_at timestamptz;
alter table cms add column if not exists draft_updated_by text;

-- Who last published, for the "Updated by" column in the dashboard.
alter table cms add column if not exists published_at timestamptz;
alter table cms add column if not exists published_by text;

-- Finding the pages with unpublished work is a common dashboard query.
create index if not exists cms_draft_idx on cms (draft_updated_at desc) where draft_data is not null;

-- cms already has RLS enabled from 0001; these are new columns on that same
-- table, so they inherit it and need no further statement here.
