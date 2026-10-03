-- ============================================================================
-- 0004 — CMS columns for condition pages and blog posts
--
-- Two problems this fixes:
--
--   1. counselling_services is missing almost every column the admin CMS writes.
--      counsellingController.js reads and writes `category`, `hero_subtext`,
--      `benefits_title`, the og_*/schema_* SEO block and more, none of which
--      exist in 0001 — so creating or editing a service fails and the table has
--      stayed empty. Every column below is one the controller already sends.
--
--   2. The live site groups the 45 condition pages into three header menus
--      (INDIVIDUAL / RELATIONSHIP / SEXUAL & INTIMACY), and INDIVIDUAL nests a
--      third level (OTHER DISORDERS, OTHER CRISIS, OTHER BEHAVIOUR). `category`
--      carries the top menu, `menu_group` the nested one (null = show directly
--      under the category), `menu_label` the exact wording used in the nav,
--      which differs from the slug ("PERSONALITY DISORDER MANAGMENT").
--
-- The full page body — hero, stats, symptom cards, FAQs and the rest — lives in
-- the existing `content` jsonb as one object, which is the shape
-- ConditionPageTemplate already renders. Nothing here drops or rewrites data;
-- every statement is additive and safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- counselling_services — menu placement
-- ---------------------------------------------------------------------------
alter table counselling_services add column if not exists category    text;
alter table counselling_services add column if not exists menu_group  text;
alter table counselling_services add column if not exists menu_label  text;

-- The header queries by category and orders within it.
create index if not exists counselling_services_menu_idx
  on counselling_services (category, menu_group, menu_order);
create index if not exists counselling_services_status_idx
  on counselling_services (status);

-- ---------------------------------------------------------------------------
-- counselling_services — hero and section copy written by the admin CMS
-- ---------------------------------------------------------------------------
alter table counselling_services add column if not exists hero_subtext        text;
alter table counselling_services add column if not exists hero_image_url      text;
alter table counselling_services add column if not exists hero_cta_text       text;
alter table counselling_services add column if not exists hero_point_1        text;
alter table counselling_services add column if not exists hero_point_2        text;
alter table counselling_services add column if not exists hero_point_3        text;
alter table counselling_services add column if not exists therapists_heading  text;
alter table counselling_services add column if not exists benefits_title      text;
alter table counselling_services add column if not exists benefits_image_url  text;
alter table counselling_services add column if not exists types_title         text;
alter table counselling_services add column if not exists videos_heading      text;
alter table counselling_services add column if not exists videos_subheading   text;
alter table counselling_services add column if not exists videos_featured_index integer;
alter table counselling_services add column if not exists right_image_url     text;
alter table counselling_services add column if not exists left_image_url      text;
alter table counselling_services add column if not exists mobile_image_url    text;
alter table counselling_services add column if not exists blog_teaser_enabled boolean default true;
alter table counselling_services add column if not exists blog_teaser_tag     text;

-- ---------------------------------------------------------------------------
-- counselling_services — SEO block
-- ---------------------------------------------------------------------------
alter table counselling_services add column if not exists seo_keywords        text;
alter table counselling_services add column if not exists og_title            text;
alter table counselling_services add column if not exists og_description      text;
alter table counselling_services add column if not exists og_image            text;
alter table counselling_services add column if not exists canonical_url       text;
alter table counselling_services add column if not exists robots              text;
alter table counselling_services add column if not exists schema_enabled      boolean default false;
alter table counselling_services add column if not exists schema_service_type text;

-- ---------------------------------------------------------------------------
-- blogs — the one column blogController writes that 0001 does not define
-- ---------------------------------------------------------------------------
alter table blogs add column if not exists published_at timestamptz;

-- Backfill: anything already published gets its creation time so ordering by
-- published_at does not put existing posts last.
update blogs set published_at = created_at
  where published_at is null and status = 'published';

create index if not exists blogs_published_idx on blogs (status, published_at desc);
create index if not exists blogs_slug_idx      on blogs (slug);
